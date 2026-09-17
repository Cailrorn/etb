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
