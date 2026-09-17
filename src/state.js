import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const EMPTY = { version: 1, lastHeartbeat: null, sites: {} };

export function loadState(path = 'state.json') {
  if (!existsSync(path)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { ...structuredClone(EMPTY), ...parsed, sites: parsed.sites ?? {} };
  } catch (err) {
    // Un state corrompu ne doit pas bloquer la surveillance : on repart de zero.
    console.warn(`state.json illisible (${err.message}), reinitialisation.`);
    return structuredClone(EMPTY);
  }
}

export function saveState(state, path = 'state.json') {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function siteState(state, id) {
  return state.sites[id] ?? { inStock: null, since: null, failures: 0, lastError: null, lastCheck: null };
}
