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

const INJOIGNABLE = `
settings:
  heartbeat_hours: 24
  retries: 0
sites:
  - name: "Site injoignable"
    url: "https://domaine-qui-nexiste-pas-du-tout-12345.invalid/p"
    mode: http
`;

const SANS_RESUME = INJOIGNABLE.replace('heartbeat_hours: 24', 'heartbeat_hours: 0');

const siteState = (o, lastHeartbeat = null) =>
  ({ version: 1, lastHeartbeat, sites: { 'site-injoignable': o } });

const recent = () => new Date(Date.now() - 3600_000).toISOString();

test('un echec ne notifie rien sur le moment, mais est journalise', () => {
  // Les murs anti-bot echouent par a-coups et se remettent seuls : alerter a
  // chaud produisait des dizaines de messages par jour.
  const { out, state } = run(SANS_RESUME, siteState({ inStock: null, failures: 1 }));
  assert.match(out, /Aucun changement/);
  const apres = state.sites['site-injoignable'];
  assert.equal(apres.failures, 2);
  assert.equal(apres.journal.passes, 1, 'le probleme doit etre garde pour le resume');
});

test('les echecs s accumulent dans le journal sans notifier', () => {
  const { out, state } = run(SANS_RESUME,
    siteState({ inStock: null, failures: 8, journal: { passes: 8, kind: 'echec', detail: 'x' } }));
  assert.equal(out.includes('Erreurs depuis le dernier resume'), false);
  assert.equal(state.sites['site-injoignable'].journal.passes, 9);
});

test('le resume quotidien porte les erreurs et vide le journal', () => {
  const { out, state } = run(INJOIGNABLE,
    siteState({ inStock: null, failures: 4, journal: { passes: 4, kind: 'echec', detail: 'ECONNREFUSED' } }));
  assert.match(out, /Surveillance active/);
  assert.match(out, /Erreurs depuis le dernier resume/);
  assert.match(out, /Toujours en panne/);
  assert.match(out, /Site injoignable/);
  assert.equal(state.sites['site-injoignable'].journal, null, 'le journal repart de zero');
  assert.notEqual(state.lastHeartbeat, null);
});

test('pas de second resume avant 24 h', () => {
  const { out } = run(INJOIGNABLE,
    siteState({ inStock: null, failures: 4, journal: { passes: 4, kind: 'echec', detail: 'x' } }, recent()));
  assert.equal(out.includes('Surveillance active'), false);
  assert.match(out, /Aucun changement/);
});

test('une panne reparee est signalee pour information, pas comme a corriger', () => {
  // Le site repond de nouveau : ses echecs de la journee restent visibles une
  // fois, sans laisser croire qu'il y a quelque chose a faire.
  const config = `
settings:
  heartbeat_hours: 24
  retries: 0
sites:
  - name: "Livre en stock"
    url: "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html"
    mode: http
    in_stock_when:
      present: ["In stock"]
`;
  const { out } = run(config, {
    version: 1, lastHeartbeat: null,
    sites: { 'livre-en-stock': { inStock: true, failures: 0, journal: { passes: 3, kind: 'echec', detail: 'HTTP 503' } } },
  });
  assert.match(out, /Rentre dans l'ordre/);
  assert.equal(out.includes('Toujours en panne'), false);
});

test('un resume sans aucune erreur le dit explicitement', () => {
  const config = `
settings:
  heartbeat_hours: 24
  retries: 0
sites:
  - name: "Livre en stock"
    url: "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html"
    mode: http
    in_stock_when:
      present: ["In stock"]
`;
  const { out } = run(config, { version: 1, lastHeartbeat: null, sites: {} });
  assert.match(out, /Aucune erreur depuis le dernier resume/);
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
  heartbeat_hours: 24
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
  const { out, state } = run(TEMOIN.replace('heartbeat_hours: 24', 'heartbeat_hours: 0'),
    etatTemoin({ inStock: null, failures: 0 }));
  assert.equal(out.includes('EN STOCK'), true, 'il doit bien etre vu disponible');
  assert.equal(out.includes('DE NOUVEAU EN STOCK'), false, 'mais ne jamais alerter');
  assert.match(out, /Aucun changement/);
  assert.equal(state.sites['temoin-livre'].mismatches, 0);
});

test('un temoin devie est signale dans le resume quotidien', () => {
  // Regle volontairement cassee : c'est la panne silencieuse qu'on veut voir.
  const { out } = run(TEMOIN_CASSE, etatTemoin({ inStock: true, mismatches: 2 }));
  assert.match(out, /temoin non conforme/);
  assert.match(out, /Toujours en panne/);
});

test('un temoin devie ne notifie rien hors du resume', () => {
  const { out, state } = run(TEMOIN_CASSE.replace('heartbeat_hours: 24', 'heartbeat_hours: 0'),
    etatTemoin({ inStock: true, mismatches: 0 }));
  assert.match(out, /Aucun changement/);
  assert.equal(state.sites['temoin-livre'].mismatches, 1);
  assert.equal(state.sites['temoin-livre'].journal.kind, 'temoin');
});

test('un temoin redevenu conforme remet son compteur a zero', () => {
  const { state } = run(TEMOIN, etatTemoin({ inStock: false, mismatches: 7 }));
  assert.equal(state.sites['temoin-livre'].mismatches, 0);
});

// --- Volume de notifications -----------------------------------------------

const TROIS_SITES = `
settings:
  heartbeat_hours: 24
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
  const journal = (n) => ({ inStock: null, failures: n, journal: { passes: n, kind: 'echec', detail: 'x' } });
  const etat = {
    version: 1, lastHeartbeat: null,
    sites: {
      'marchand-a-article-1': journal(2),
      'marchand-a-article-2': journal(2),
      'marchand-a-article-3': journal(2),
    },
  };
  const { out } = run(TROIS_SITES, etat);
  assert.equal(out.match(/Erreurs depuis le dernier resume/g).length, 1, 'un seul message');
  assert.match(out, /3 fiche\(s\)/);
  for (const n of ['article 1', 'article 2', 'article 3']) assert.match(out, new RegExp(n));
});
