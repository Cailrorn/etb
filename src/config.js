import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';

const DEFAULTS = {
  mode: 'auto',
  timeout_ms: 25000,
  retries: 2,
  notify_on_back_in_stock: true,
  notify_on_out_of_stock: false,
  enabled: true,
};

/**
 * Charge et valide sites.yaml. Toute erreur de config est fatale et explicite :
 * mieux vaut un crash au demarrage qu'une surveillance silencieusement cassee.
 */
export function loadConfig(path = 'sites.yaml') {
  if (!existsSync(path)) {
    throw new Error(`Fichier de configuration introuvable : ${path}`);
  }
  const raw = parse(readFileSync(path, 'utf8')) ?? {};
  const globals = raw.settings ?? {};
  const sites = raw.sites ?? [];

  if (!Array.isArray(sites) || sites.length === 0) {
    throw new Error('sites.yaml : la cle "sites" doit contenir au moins un site.');
  }

  const seen = new Set();
  const parsed = sites.map((site, i) => {
    const where = `sites[${i}]${site?.name ? ` (${site.name})` : ''}`;
    if (!site?.url) throw new Error(`${where} : la cle "url" est obligatoire.`);
    if (!site?.name) throw new Error(`${where} : la cle "name" est obligatoire.`);
    try {
      new URL(site.url);
    } catch {
      throw new Error(`${where} : url invalide "${site.url}".`);
    }

    const id = site.id ?? slugify(site.name);
    if (seen.has(id)) throw new Error(`${where} : identifiant duplique "${id}". Ajoute une cle "id" unique.`);
    seen.add(id);

    const mode = site.mode ?? globals.mode ?? DEFAULTS.mode;
    if (!['auto', 'http', 'browser', 'shopify'].includes(mode)) {
      throw new Error(`${where} : mode "${mode}" inconnu (auto | http | browser | shopify).`);
    }

    return {
      ...DEFAULTS,
      ...globals,
      ...site,
      id,
      mode,
      rules: normalizeRules(site.in_stock_when, where),
    };
  });

  return {
    settings: {
      concurrency: globals.concurrency ?? 4,
      user_agent: globals.user_agent ?? null,
      heartbeat_hours: globals.heartbeat_hours ?? 24,
      error_alert_after: globals.error_alert_after ?? 3,
      ...globals,
    },
    sites: parsed.filter((s) => s.enabled !== false),
  };
}

function normalizeRules(rules, where) {
  if (!rules) return null;
  const out = {
    present: toArray(rules.present),
    absent: toArray(rules.absent),
    selector_exists: toArray(rules.selector_exists),
    selector_absent: toArray(rules.selector_absent),
    regex: rules.regex ?? null,
  };
  const hasAny = out.present.length || out.absent.length || out.selector_exists.length ||
    out.selector_absent.length || out.regex;
  if (!hasAny) throw new Error(`${where} : "in_stock_when" est vide. Retire-le ou ajoute au moins une regle.`);
  if (out.regex) {
    try {
      new RegExp(out.regex, 'i');
    } catch {
      throw new Error(`${where} : regex invalide "${out.regex}".`);
    }
  }
  return out;
}

const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function slugify(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}
