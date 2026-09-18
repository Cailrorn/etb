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
