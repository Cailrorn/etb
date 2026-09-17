const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
];

export const pickUserAgent = (custom) =>
  custom ?? UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

function headersFor(site) {
  return {
    'User-Agent': pickUserAgent(site.user_agent),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    ...(site.headers ?? {}),
  };
}

/** Recupere le HTML via un simple fetch. Rapide, suffisant pour la majorite des e-commerces. */
export async function fetchHttp(site) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), site.timeout_ms);
  try {
    const res = await fetch(site.url, {
      headers: headersFor(site),
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return { html: body, source: 'http', status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Endpoint JSON natif de Shopify : /products/<handle>.js expose variants[].available.
 * C'est la source la plus fiable quand elle existe (pas de scraping de texte).
 */
export async function fetchShopify(site) {
  const url = new URL(site.url);
  if (!/\/products\/[^/]+/.test(url.pathname)) {
    throw new Error("URL non reconnue comme fiche produit Shopify (attendu .../products/<handle>)");
  }
  const jsonUrl = `${url.origin}${url.pathname.replace(/\/+$/, '')}.js`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), site.timeout_ms);
  try {
    const res = await fetch(jsonUrl, { headers: headersFor(site), signal: ctrl.signal });
    if (!res.ok) throw new Error(`Shopify JSON : HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.variants)) throw new Error('Shopify JSON : pas de variants');

    const variants = site.variant ? selectVariants(data.variants, site.variant) : data.variants;

    if (variants.length === 0) {
      throw new Error(
        `Variante "${site.variant}" introuvable. Disponibles : ${data.variants.map((v) => v.title).join(' | ')}`
      );
    }

    const available = variants.filter((v) => v.available);
    return {
      source: 'shopify',
      structured: {
        inStock: available.length > 0,
        detail: available.length > 0
          ? `Disponible : ${available.map((v) => v.title).join(', ')}`
          : `Toutes les variantes indisponibles (${variants.length} verifiees)`,
        price: data.price != null ? (data.price / 100).toFixed(2) : null,
        title: data.title,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Selectionne les variantes demandees.
 * L'appariement est exact sur le titre complet ("XL / Noir") ou sur une de ses
 * options ("XL") : une comparaison par sous-chaine ferait matcher "XL" avec "XXL".
 * Accepte aussi un id numerique de variante, ou une liste.
 */
export function selectVariants(variants, wanted) {
  const targets = (Array.isArray(wanted) ? wanted : [wanted]).map((w) => normVariant(w));

  return variants.filter((v) => {
    if (targets.includes(String(v.id))) return true;
    const title = normVariant(v.title);
    if (targets.includes(title)) return true;
    const options = title.split('/').map((o) => o.trim()).filter(Boolean);
    return targets.some((t) => options.includes(t));
  });
}

const normVariant = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Rendu complet via Chromium headless, pour les boutiques qui affichent le stock en JS. */
export async function fetchBrowser(site) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  try {
    const context = await browser.newContext({
      userAgent: pickUserAgent(site.user_agent),
      locale: 'fr-FR',
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: site.headers ?? {},
    });
    const page = await context.newPage();
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: site.timeout_ms });

    if (site.wait_for_selector) {
      await page.waitForSelector(site.wait_for_selector, { timeout: site.timeout_ms }).catch(() => {});
    }
    await page.waitForTimeout(site.wait_ms ?? 2000);

    const html = await page.content();
    return { html, source: 'browser' };
  } finally {
    await browser.close();
  }
}

/** Choisit la strategie, avec repli automatique en mode "auto". */
export async function fetchSite(site) {
  if (site.mode === 'shopify') return fetchShopify(site);
  if (site.mode === 'browser') return fetchBrowser(site);
  if (site.mode === 'http') return fetchHttp(site);

  // mode auto : Shopify si l'URL colle, sinon HTTP, puis navigateur en dernier recours.
  if (/\/products\/[^/]+/.test(new URL(site.url).pathname)) {
    try {
      return await fetchShopify(site);
    } catch { /* pas du Shopify, on continue */ }
  }
  try {
    const res = await fetchHttp(site);
    if (looksLikeJsShell(res.html)) return fetchBrowser(site);
    return res;
  } catch (err) {
    return fetchBrowser(site).catch(() => {
      throw err;
    });
  }
}

/** Heuristique : page quasi vide cote HTML => l'appli est rendue cote client. */
function looksLikeJsShell(html) {
  if (!html) return true;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length < 400;
}
