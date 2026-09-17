#!/usr/bin/env node
import { loadConfig } from './config.js';
import { fetchSite } from './fetchers.js';
import { detect } from './detect.js';
import { loadState, saveState, siteState } from './state.js';
import {
  sendTelegram, backInStockMessage, outOfStockMessage, errorMessage, heartbeatMessage,
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

  await runPool(sites, config.settings.concurrency, async (site) => {
    const prev = siteState(state, site.id);
    let result;

    try {
      result = await withRetries(site, () => fetchSite(site));
    } catch (err) {
      const failures = prev.failures + 1;
      state.sites[site.id] = { ...prev, failures, lastError: String(err.message), lastCheck: nowIso() };
      log(`⚠️  ${site.name} — echec (${failures}) : ${err.message}`);

      // On n'alerte qu'a partir du seuil, et une seule fois, pour ne pas spammer
      // sur une coupure reseau passagere.
      if (failures === config.settings.error_alert_after) {
        alerts.push(errorMessage(site, failures, err.message));
      }
      return;
    }

    const verdict = detect(site, result);
    results.set(site.id, verdict);

    const icon = verdict.inStock === true ? '🟢' : verdict.inStock === false ? '⚪' : '❓';
    log(`${icon} ${site.name} — ${verdict.inStock === null ? 'indetermine' : verdict.inStock ? 'EN STOCK' : 'indisponible'}`);
    debug(`source=${result.source} confiance=${verdict.confidence} · ${verdict.reason}`);

    const changed = verdict.inStock !== null && verdict.inStock !== prev.inStock;

    if (changed && verdict.inStock === true && site.notify_on_back_in_stock) {
      // Premiere observation : on n'alerte que si l'article est reellement dispo,
      // sinon chaque nouveau site declencherait une notification au demarrage.
      if (prev.inStock !== null || site.notify_on_first_check !== false) {
        alerts.push(backInStockMessage(site, verdict));
      }
    }
    if (changed && verdict.inStock === false && prev.inStock === true && site.notify_on_out_of_stock) {
      alerts.push(outOfStockMessage(site, verdict));
    }

    state.sites[site.id] = {
      inStock: verdict.inStock,
      since: changed || !prev.since ? nowIso() : prev.since,
      failures: 0,
      lastError: null,
      lastCheck: nowIso(),
      lastReason: verdict.reason,
      confidence: verdict.confidence,
      url: site.url,
    };
  });

  const hb = config.settings.heartbeat_hours;
  if (hb > 0 && isDue(state.lastHeartbeat, hb)) {
    alerts.push(heartbeatMessage(sites, results));
    state.lastHeartbeat = nowIso();
  }

  if (alerts.length === 0) {
    log('\nAucun changement.');
  } else if (DRY_RUN) {
    log(`\n[dry-run] ${alerts.length} alerte(s) qui auraient ete envoyees :\n`);
    alerts.forEach((a) => log(`${a.replace(/<[^>]+>/g, '')}\n---`));
  } else {
    for (const message of alerts) {
      await sendTelegram(message, { silent: message.startsWith('💓') });
    }
    log(`\n${alerts.length} alerte(s) envoyee(s) sur Telegram.`);
  }

  saveState(state, STATE_PATH);
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
