import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Ces tests pilotent le binaire complet en --dry-run : ils verifient les
// decisions d'alerte de bout en bout, la ou une erreur coute une notification
// manquee.

const dir = mkdtempSync(join(tmpdir(), 'sw-'));

function run(config, state) {
  const cfgPath = join(dir, `${Math.random().toString(36).slice(2)}.yaml`);
  const statePath = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(cfgPath, config);
  writeFileSync(statePath, JSON.stringify(state));
  const out = execFileSync(process.execPath,
    ['src/index.js', '--dry-run', `--config=${cfgPath}`, `--state=${statePath}`],
    { encoding: 'utf8' });
  return { out, state: JSON.parse(readFileSync(statePath, 'utf8')) };
}

const CONFIG = `
settings:
  heartbeat_hours: 0
  error_alert_after: 3
  error_repeat_hours: 12
  retries: 0
sites:
  - name: "Site injoignable"
    url: "https://domaine-qui-nexiste-pas-du-tout-12345.invalid/p"
    mode: http
`;

const siteState = (o) => ({ version: 1, lastHeartbeat: null, sites: { 'site-injoignable': o } });

test('aucune alerte avant le seuil d echecs', () => {
  const { out, state } = run(CONFIG, siteState({ inStock: null, failures: 1, lastProblemAlert: null }));
  assert.equal(out.includes('Aucun changement'), true);
  assert.equal(state.sites['site-injoignable'].failures, 2);
});

test('alerte au franchissement du seuil', () => {
  const { out, state } = run(CONFIG, siteState({ inStock: null, failures: 2, lastProblemAlert: null }));
  assert.match(out, /Surveillance en echec/);
  assert.equal(state.sites['site-injoignable'].failures, 3);
  assert.notEqual(state.sites['site-injoignable'].lastProblemAlert, null);
});

test('pas de rappel avant l intervalle, pour ne pas spammer', () => {
  const recent = new Date(Date.now() - 60_000).toISOString();
  const { out } = run(CONFIG, siteState({ inStock: null, failures: 9, lastProblemAlert: recent }));
  assert.equal(out.includes('Surveillance en echec'), false);
});

test('rappel une fois l intervalle ecoule : une panne installee ne s oublie pas', () => {
  const old = new Date(Date.now() - 13 * 3600_000).toISOString();
  const { out } = run(CONFIG, siteState({ inStock: null, failures: 40, lastProblemAlert: old }));
  assert.match(out, /Surveillance en echec/);
});

test('l apercu n envoie rien sans --send', () => {
  // Pas de secrets dans l'environnement : si l'apercu tentait un envoi, il
  // echouerait. C'est precisement la garantie qu'on veut verrouiller.
  const out = execFileSync(process.execPath, ['src/index.js', '--preview-alert=stock'], {
    encoding: 'utf8',
    env: { ...process.env, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' },
  });
  assert.match(out, /affichage seul/);
  assert.match(out, /EN STOCK/);
});

test('le message de retour en stock porte l URL en clair, cliquable', () => {
  const out = execFileSync(process.execPath, ['src/index.js', '--preview-alert=stock'], { encoding: 'utf8' });
  assert.match(out, /https:\/\/www\.carrefour\.fr\/p\//);
});

test('une detection peu sure est signalee dans l alerte', () => {
  const sure = execFileSync(process.execPath, ['src/index.js', '--preview-alert=stock'], { encoding: 'utf8' });
  const doute = execFileSync(process.execPath, ['src/index.js', '--preview-alert=doute'], { encoding: 'utf8' });
  assert.equal(sure.includes('Detection peu sure'), false);
  assert.match(doute, /Detection peu sure/);
});

test('le marqueur DEMO est en premiere ligne, la ou l apercu du telephone le montre', () => {
  const out = execFileSync(process.execPath, ['src/index.js', '--preview-alert=stock'], { encoding: 'utf8' });
  const lines = out.split('\n').filter((l) => l.trim() && !l.startsWith('---'));
  assert.match(lines[0], /DEMO/);
  assert.equal(lines[0].includes('EN STOCK'), false);
});

// --- Nettoyage de l'etat ---------------------------------------------------

const ONE_SITE = `
settings:
  heartbeat_hours: 0
  retries: 0
sites:
  - name: "Livre en stock"
    url: "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html"
    mode: http
    in_stock_when:
      present: ["In stock"]
`;

test('un site retire de la config disparait de l etat', () => {
  const state = {
    version: 1,
    lastHeartbeat: null,
    sites: {
      'livre-en-stock': { inStock: true, failures: 0 },
      'marchand-retire': { inStock: false, failures: 3, lastError: 'HTTP 403' },
      'entree-obsolete': { inStock: null, failures: 0 },
    },
  };
  const { out, state: after } = run(ONE_SITE, state);
  assert.match(out, /Etat nettoye : 2 entree/);
  assert.deepEqual(Object.keys(after.sites), ['livre-en-stock']);
});

test('--only ne purge pas les autres sites', () => {
  // Un passage cible ne voit qu'un site : purger ici effacerait tout le reste.
  const cfgPath = join(dir, 'only.yaml');
  const statePath = join(dir, 'only.json');
  writeFileSync(cfgPath, ONE_SITE);
  writeFileSync(statePath, JSON.stringify({
    version: 1, lastHeartbeat: null,
    sites: { 'livre-en-stock': { inStock: true, failures: 0 }, 'autre-site': { inStock: false, failures: 0 } },
  }));
  execFileSync(process.execPath, ['src/index.js', '--dry-run', '--only=livre-en-stock',
    `--config=${cfgPath}`, `--state=${statePath}`], { encoding: 'utf8' });
  const after = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.ok(after.sites['autre-site'], 'l historique des autres sites doit survivre');
});

// --- Temoins de detection --------------------------------------------------

const TEMOIN = `
settings:
  heartbeat_hours: 0
  error_alert_after: 3
  error_repeat_hours: 12
  retries: 0
sites:
  - name: "Temoin livre"
    url: "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html"
    mode: http
    expect: in_stock
    in_stock_when:
      present: ["In stock"]
`;

const TEMOIN_CASSE = TEMOIN.replace('present: ["In stock"]', 'present: ["Texte qui n existe pas"]');
const etatTemoin = (o) => ({ version: 1, lastHeartbeat: null, sites: { 'temoin-livre': o } });

test('un temoin conforme n envoie aucune alerte d achat', () => {
  // Le temoin est disponible en permanence : sans traitement particulier, il
  // declencherait une alerte "de nouveau en stock" a chaque nouvelle install.
  const { out, state } = run(TEMOIN, etatTemoin({ inStock: null, failures: 0 }));
  assert.equal(out.includes('EN STOCK'), true, 'il doit bien etre vu disponible');
  assert.equal(out.includes('DE NOUVEAU EN STOCK'), false, 'mais ne jamais alerter');
  assert.match(out, /Aucun changement/);
  assert.equal(state.sites['temoin-livre'].mismatches, 0);
});

test('un temoin qui cesse d etre disponible finit par alerter', () => {
  // Regle volontairement cassee : c'est la panne silencieuse qu'on veut voir.
  const { out } = run(TEMOIN_CASSE, etatTemoin({ inStock: true, mismatches: 2, lastProblemAlert: null }));
  assert.match(out, /DETECTION PEUT-ETRE CASSEE/);
});

test('un temoin casse n alerte pas avant le seuil', () => {
  const { out, state } = run(TEMOIN_CASSE, etatTemoin({ inStock: true, mismatches: 0, lastProblemAlert: null }));
  assert.equal(out.includes('DETECTION PEUT-ETRE CASSEE'), false);
  assert.equal(state.sites['temoin-livre'].mismatches, 1);
});

test('un temoin redevenu conforme remet son compteur a zero', () => {
  const { state } = run(TEMOIN, etatTemoin({ inStock: false, mismatches: 7, lastProblemAlert: new Date().toISOString() }));
  assert.equal(state.sites['temoin-livre'].mismatches, 0);
});

// --- Volume de notifications -----------------------------------------------

const TROIS_SITES = `
settings:
  heartbeat_hours: 0
  error_alert_after: 3
  error_repeat_hours: 12
  retries: 0
sites:
  - name: "Marchand A — article 1"
    url: "https://domaine-inexistant-aaa-111.invalid/p1"
    mode: http
  - name: "Marchand A — article 2"
    url: "https://domaine-inexistant-aaa-111.invalid/p2"
    mode: http
  - name: "Marchand A — article 3"
    url: "https://domaine-inexistant-aaa-111.invalid/p3"
    mode: http
`;

test('un incident touchant plusieurs fiches ne fait qu une notification', () => {
  // Cas reel : une panne chez un marchand donnait autant de messages qu'il a
  // d'articles surveilles. Cinq notifications pour une seule cause noient
  // l'alerte de stock qu'on attend vraiment.
  const etat = {
    version: 1, lastHeartbeat: null,
    sites: {
      'marchand-a-article-1': { inStock: null, failures: 2, lastProblemAlert: null },
      'marchand-a-article-2': { inStock: null, failures: 2, lastProblemAlert: null },
      'marchand-a-article-3': { inStock: null, failures: 2, lastProblemAlert: null },
    },
  };
  const { out } = run(TROIS_SITES, etat);
  assert.equal(out.match(/Surveillance en difficulte/g).length, 1, 'un seul message');
  assert.match(out, /3 fiche\(s\)/);
  for (const n of ['article 1', 'article 2', 'article 3']) assert.match(out, new RegExp(n));
});

test('le seuil par defaut laisse passer une coupure d un quart d heure', async () => {
  // Les murs anti-bot echouent par a-coups puis se remettent seuls. Alerter
  // au bout de 3 passages produisait des dizaines de messages pour rien ;
  // 12 passages, soit une heure, ne retiennent que les pannes installees.
  const { loadConfig } = await import('../src/config.js');
  const cfgPath = join(dir, 'seuil.yaml');
  writeFileSync(cfgPath, 'sites:\n  - name: "X"\n    url: "https://exemple.fr/p"\n');
  assert.equal(loadConfig(cfgPath).settings.error_alert_after, 12);
});
