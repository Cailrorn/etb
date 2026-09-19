#!/usr/bin/env node
import { loadConfig } from './config.js';
import { fetchSite, closeBrowser } from './fetchers.js';
import { detect } from './detect.js';
import { loadState, saveState, siteState } from './state.js';
import {
  sendTelegram, backInStockMessage, outOfStockMessage, errorMessage, heartbeatMessage,
  undetectableMessage, canaryMessage,
} from './notify.js';

const args = new Set(process.argv.slice(2));
const flag = (name) => args.has(`--${name}`);
const value = (name) => {
  const hit = [...args].find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const DRY_RUN = flag('dry-run');
const VERBOSE = flag('verbose');
const STATE_PATH = value('state') ?? 'state.json';

const log = (...m) => console.log(...m);
const debug = (...m) => VERBOSE && console.log('   ', ...m);

async function main() {
  // Exemple de notification : affiche par defaut, envoye avec --send.
  const preview = value('preview-alert');
  if (preview !== null) return previewAlert(preview, flag('send'));

  if (flag('test-alert')) {
    await sendTelegram('✅ <b>Test de configuration</b>\n\nLe bot est bien relie a ce salon. La surveillance peut demarrer.');
    log('Message de test envoye. Verifie Telegram.');
    return;
  }

  const config = loadConfig(value('config') ?? 'sites.yaml');
  const only = value('only');
  const sites = only ? config.sites.filter((s) => s.id === only || s.name === only) : config.sites;

  if (sites.length === 0) {
    throw new Error(only ? `Aucun site ne correspond a --only=${only}` : 'Aucun site actif dans sites.yaml');
  }

  const state = loadState(STATE_PATH);
  const results = new Map();
  const alerts = [];

  log(`Verification de ${sites.length} article(s)${DRY_RUN ? ' [dry-run]' : ''}…\n`);

  try {
    await checkAll(sites, config, state, results, alerts);
  } finally {
    // Sans cette fermeture, le processus resterait vivant apres le dernier site.
    await closeBrowser();
  }

  // Uniquement sur un passage complet : avec --only, tous les autres sites
  // seraient pris pour des orphelins et leur historique efface.
  if (!only) pruneOrphans(state, config.sites);

  await finish(config, sites, state, results, alerts);
}

/**
 * Supprime de l'etat les sites qui ne sont plus dans la configuration.
 *
 * Sans cela, un site retire ou desactive garde son entree indefiniment, avec
 * son dernier statut et ses compteurs d'echec : state.json finit par decrire
 * une surveillance qui n'existe plus, et un diagnostic y lit de faux problemes.
 */
function pruneOrphans(state, activeSites) {
  const active = new Set(activeSites.map((s) => s.id));
  const orphans = Object.keys(state.sites).filter((id) => !active.has(id));

  for (const id of orphans) delete state.sites[id];

  if (orphans.length > 0) {
    log(`\nEtat nettoye : ${orphans.length} entree(s) obsolete(s) retiree(s) — ${orphans.join(', ')}`);
  }
  return orphans;
}

async function checkAll(sites, config, state, results, alerts) {
  await runPool(sites, config.settings.concurrency, async (site) => {
    const prev = siteState(state, site.id);
    let result;

    try {
      result = await withRetries(site, () => fetchSite(site));
    } catch (err) {
      const failures = prev.failures + 1;
      log(`⚠️  ${site.name} — echec (${failures}) : ${err.message}`);

      // On laisse passer les coupures breves, puis on alerte et on rappelle
      // regulierement tant que le site reste casse : une alerte unique se
      // perdrait dans l'historique et le site resterait aveugle sans le dire.
      const due = problemAlertDue(prev, failures, config.settings);
      if (due) {
        alerts.push({ id: site.id, prev, message: errorMessage(site, failures, err.message) });
      }

      state.sites[site.id] = {
        ...prev,
        failures,
        lastError: String(err.message),
        lastCheck: nowIso(),
        lastProblemAlert: due ? nowIso() : prev.lastProblemAlert ?? null,
      };
      return;
    }

    const verdict = detect(site, result);
    results.set(site.id, verdict);

    const icon = verdict.inStock === true ? '🟢' : verdict.inStock === false ? '⚪' : '❓';
    log(`${icon} ${site.name} — ${verdict.inStock === null ? 'indetermine' : verdict.inStock ? 'EN STOCK' : 'indisponible'}`);
    debug(`source=${result.source} confiance=${verdict.confidence} · ${verdict.reason}`);

    // Un temoin ne declenche jamais d'alerte d'achat : il est cense etre
    // disponible en permanence. Sa seule raison d'etre est de crier quand il
    // cesse de l'etre, car c'est alors la detection qui est cassee, pas le
    // stock. C'est le seul garde-fou contre une regle devenue incapable de
    // repondre "disponible" — panne totalement silencieuse autrement.
    if (site.expect) {
      const attendu = site.expect === 'in_stock';
      const conforme = verdict.inStock === attendu;
      const ecarts = conforme ? 0 : (prev.mismatches ?? 0) + 1;
      const due = !conforme && problemAlertDue(prev, ecarts, config.settings);

      if (due) {
        alerts.push({ id: site.id, prev, message: canaryMessage(site, verdict, ecarts) });
      }

      state.sites[site.id] = {
        ...prev,
        inStock: verdict.inStock,
        mismatches: ecarts,
        failures: 0,
        unknowns: 0,
        lastError: null,
        lastCheck: nowIso(),
        lastReason: verdict.reason,
        confidence: verdict.confidence,
        lastProblemAlert: due ? nowIso() : ecarts > 0 ? prev.lastProblemAlert ?? null : null,
        url: site.url,
      };
      return;
    }

    const changed = verdict.inStock !== null && verdict.inStock !== prev.inStock;

    if (changed && verdict.inStock === true && site.notify_on_back_in_stock) {
      // Premiere observation : on n'alerte que si l'article est reellement dispo,
      // sinon chaque nouveau site declencherait une notification au demarrage.
      if (prev.inStock !== null || site.notify_on_first_check !== false) {
        alerts.push({ id: site.id, prev, message: backInStockMessage(site, verdict) });
      }
    }
    if (changed && verdict.inStock === false && prev.inStock === true && site.notify_on_out_of_stock) {
      alerts.push({ id: site.id, prev, message: outOfStockMessage(site, verdict) });
    }

    // Un verdict "indetermine" ne casse rien et n'alerte rien : c'est un angle
    // mort. On le compte pour finir par le signaler, comme une panne.
    const unknowns = verdict.inStock === null ? (prev.unknowns ?? 0) + 1 : 0;
    const due = unknowns > 0 && problemAlertDue(prev, unknowns, config.settings);
    if (due) {
      alerts.push({ id: site.id, prev, message: undetectableMessage(site, unknowns, verdict.reason) });
    }

    state.sites[site.id] = {
      inStock: verdict.inStock,
      since: changed || !prev.since ? nowIso() : prev.since,
      failures: 0,
      unknowns,
      lastError: null,
      lastCheck: nowIso(),
      lastReason: verdict.reason,
      confidence: verdict.confidence,
      lastProblemAlert: due ? nowIso() : unknowns > 0 ? prev.lastProblemAlert ?? null : null,
      url: site.url,
    };
  });
}

/** Heartbeat, envoi des alertes, sauvegarde de l'etat et ping du watchdog. */
async function finish(config, sites, state, results, alerts) {
  const hb = config.settings.heartbeat_hours;
  const previousHeartbeat = state.lastHeartbeat;
  if (hb > 0 && isDue(state.lastHeartbeat, hb)) {
    alerts.push({ id: null, message: heartbeatMessage(sites, results) });
    state.lastHeartbeat = nowIso();
  }

  if (alerts.length === 0) {
    log('\nAucun changement.');
  } else if (DRY_RUN) {
    log(`\n[dry-run] ${alerts.length} alerte(s) qui auraient ete envoyees :\n`);
    alerts.forEach((a) => log(`${a.message.replace(/<[^>]+>/g, '')}\n---`));
  } else {
    await deliver(alerts, state, previousHeartbeat);
  }

  // L'etat est toujours ecrit, meme si Telegram est tombe : sinon une panne de
  // notification ferait perdre le resultat de toute la verification.
  saveState(state, STATE_PATH);

  if (!DRY_RUN) await pingWatchdog(process.exitCode === 1 ? 'fail' : 'success');
}

/**
 * Signale au service de surveillance externe que ce passage a eu lieu.
 *
 * C'est le seul mecanisme capable de detecter que le robot ne tourne plus du
 * tout : un programme mort ne peut pas prevenir de sa propre mort. Si les pings
 * cessent, c'est le service externe qui alerte. On ne pingue pas en cas
 * d'echec, pour que ce service serve aussi de second canal si Telegram tombe.
 */
async function pingWatchdog(outcome) {
  const url = process.env.HEALTHCHECK_URL;
  if (!url) return;

  const target = outcome === 'fail' ? `${url.replace(/\/+$/, '')}/fail` : url;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    await fetch(target, { method: 'POST', signal: ctrl.signal }).finally(() => clearTimeout(timer));
    debug(`watchdog pingue (${outcome})`);
  } catch (err) {
    // Un watchdog injoignable ne doit jamais faire echouer une verification
    // par ailleurs reussie.
    console.error(`Watchdog injoignable : ${err.message}`);
  }
}

/**
 * Envoie les alertes une par une.
 * Si l'envoi echoue, l'etat du site concerne est remis a sa valeur precedente :
 * le changement sera redetecte au prochain passage et l'alerte rejouee. Sans
 * cela, une panne de Telegram ferait manquer definitivement un retour en stock.
 */
async function deliver(alerts, state, previousHeartbeat) {
  let sent = 0;
  const failed = [];

  for (const alert of alerts) {
    try {
      await sendTelegram(alert.message, { silent: alert.message.startsWith('💓') });
      sent++;
    } catch (err) {
      failed.push(err.message);
      if (alert.id) {
        state.sites[alert.id] = alert.prev;
      } else {
        state.lastHeartbeat = previousHeartbeat;
      }
    }
  }

  if (sent > 0) log(`\n${sent} alerte(s) envoyee(s) sur Telegram.`);
  if (failed.length > 0) {
    console.error(`\n${failed.length} alerte(s) non remise(s) — elles seront rejouees au prochain passage.`);
    console.error(`Cause : ${failed[0]}`);
    process.exitCode = 1;
  }
}

/**
 * Faut-il (re)signaler qu'un site est en panne ?
 * Oui au franchissement du seuil, puis a intervalle regulier tant que dure le
 * probleme. Sinon une panne installee ne serait signalee qu'une fois, le
 * premier jour, et passerait ensuite inapercue.
 */
function problemAlertDue(prev, count, settings) {
  if (count < settings.error_alert_after) return false;
  if (!prev.lastProblemAlert) return true;
  const repeatMs = (settings.error_repeat_hours ?? 12) * 3600_000;
  return Date.now() - new Date(prev.lastProblemAlert).getTime() >= repeatMs;
}

/**
 * Affiche un exemple de notification, et l'envoie sur Telegram si --send.
 *
 * Le marqueur DEMO est place en toute premiere ligne, jamais en bas : sur un
 * ecran verrouille, l'apercu ne montre que les premieres lignes, et c'est la
 * qu'il faut lever le doute. Un marqueur en pied de message serait lu apres
 * s'etre deplace chez le marchand.
 */
async function previewAlert(kind, send) {
  const site = {
    name: 'Carrefour — Coffret Poster',
    url: 'https://www.carrefour.fr/p/exemple-de-fiche-produit',
    currency: '€',
  };
  const verdict = { price: '39.99', confidence: 'high', reason: 'schema.org availability = InStock' };

  const samples = {
    stock: () => backInStockMessage(site, verdict),
    rupture: () => outOfStockMessage(site, { reason: 'schema.org availability = OutOfStock' }),
    echec: () => errorMessage(site, 3, 'HTTP 403 Forbidden'),
    illisible: () => undetectableMessage(site, 3, 'Aucun signal de disponibilite reconnu'),
    doute: () => backInStockMessage(site, { ...verdict, confidence: 'low', reason: 'Bouton panier actif' }),
  };

  const make = samples[kind];
  if (!make) {
    console.error(`Apercu inconnu : "${kind}". Disponibles : ${Object.keys(samples).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const message = [
    '🧪 <b>DEMO — ceci n\'est pas une vraie alerte</b>',
    '➖➖➖➖➖➖➖➖➖➖',
    make(),
  ].join('\n');

  log(`--- apercu "${kind}"${send ? ' (envoi Telegram)' : ' (affichage seul)'} ---`);
  log(message.replace(/<[^>]+>/g, ''));

  if (send) {
    await sendTelegram(message);
    log('\nEnvoye sur Telegram, marque DEMO.');
  }
}

async function withRetries(site, fn) {
  let lastErr;
  for (let attempt = 0; attempt <= site.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < site.retries) {
        await sleep(1500 * 2 ** attempt + Math.random() * 500);
      }
    }
  }
  throw lastErr;
}

/** Execute les taches avec un parallelisme borne (evite de se faire bloquer par les sites). */
async function runPool(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      await worker(queue.shift());
    }
  });
  await Promise.all(workers);
}

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isDue = (last, hours) => !last || Date.now() - new Date(last).getTime() >= hours * 3600_000;

main().catch((err) => {
  console.error(`\nErreur fatale : ${err.message}`);
  process.exit(1);
});
