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

// Lancer Chromium coute quelques secondes. Avec un site par navigateur, ce cout
// est paye autant de fois qu'il y a de sites ; on le paie une seule fois par
// passage. Chaque site garde son propre contexte : cookies et session restent
// cloisonnes, seul le processus est partage.
let sharedBrowser = null;
let launching = null;

async function getBrowser() {
  if (sharedBrowser?.isConnected()) return sharedBrowser;

  // Un navigateur ferme ou plante entre deux sites doit etre relance, sinon
  // tous les sites suivants echoueraient en cascade.
  sharedBrowser = null;
  if (!launching) {
    launching = (async () => {
      const { chromium } = await import('playwright');
      return chromium.launch({
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      });
    })().then(
      (b) => { sharedBrowser = b; launching = null; return b; },
      (err) => { launching = null; throw err; },
    );
  }
  return launching;
}

/** Ferme le navigateur partage. A appeler une fois le passage termine. */
export async function closeBrowser() {
  const browser = sharedBrowser;
  sharedBrowser = null;
  launching = null;
  if (browser) await browser.close().catch(() => {});
}

/** Rendu complet via Chromium headless, pour les boutiques qui affichent le stock en JS. */
export async function fetchBrowser(site) {
  const browser = await getBrowser();
  let context;
  try {
    context = await browser.newContext({
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

    // wait_ms est un plafond, pas une pause systematique : on rend la main des
    // que la page porte un signal exploitable. Une attente fixe coutait ici
    // plusieurs secondes par site, a chaque passage, pour rien.
    const html = await waitForSignal(page, {
      maxMs: site.wait_ms ?? 2000,
      challengeMs: site.challenge_timeout_ms ?? 25000,
    });

    if (isChallengePage(html)) {
      throw new Error(
        'Challenge anti-bot non resolu (page de verification affichee). ' +
        'Ce site refuse probablement les IP de datacenter.'
      );
    }

    // Filet generique : les murs anti-bot se renouvellent et ne peuvent pas
    // tous etre reconnus nommement. Une page rendue sans contenu n'est jamais
    // une fiche produit valide ; mieux vaut un echec explicite qu'un
    // "indetermine" silencieux qui laisserait l'article sans surveillance.
    if (visibleTextLength(html) < 200) {
      throw new Error(
        `Page vide apres rendu (${visibleTextLength(html)} caracteres visibles). ` +
        'Blocage probable, ou selecteur d attente mal choisi.'
      );
    }

    return { html, source: 'browser' };
  } finally {
    // On ferme le contexte, jamais le navigateur : il sert aux autres sites.
    if (context) await context.close().catch(() => {});
  }
}

/**
 * Verifie que la page recuperee est bien celle du produit attendu.
 *
 * Quand un marchand retire une fiche, son URL ne renvoie pas une erreur : elle
 * redirige vers la liste de la categorie. Cette page contient d'autres produits,
 * donc des boutons "Ajouter au panier" et des availability InStock. Sans ce
 * controle, la detection y lit la disponibilite d'un article que l'utilisateur
 * ne cherche pas, et peut annoncer un faux retour en stock.
 *
 * On ne se contente pas de comparer l'URL finale : une categorie renommee
 * redirige legitimement vers la meme fiche.
 */
function assertIdentity(site, result) {
  if (!site.identity) return;

  const attendus = Array.isArray(site.identity) ? site.identity : [site.identity];
  const foin = stripAccents(result.html ?? JSON.stringify(result.structured ?? {}))
    .replace(/\s+/g, ' ');

  const absents = attendus.filter((t) => !foin.includes(stripAccents(String(t))));
  if (absents.length === 0) return;

  // Deux causes tres differentes donnent la meme absence : la fiche a ete
  // retiree, ou le marchand a servi autre chose que la fiche (page d'erreur,
  // blocage passager). Le titre et la taille de la page tranchent d'un coup
  // d'oeil, sans quoi on croit a tort qu'un produit a disparu du catalogue.
  const titre = /<title[^>]*>([\s\S]{0,120}?)<\/title>/i.exec(result.html ?? '')?.[1]
    ?.replace(/\s+/g, ' ').trim();

  throw new Error(
    `Fiche produit introuvable : ${absents.map((t) => `"${t}"`).join(', ')} absent(s) de la page. ` +
    'Le produit a ete retire du catalogue, ou le marchand a servi une autre page. ' +
    `Page recue : ${visibleTextLength(result.html ?? '')} caracteres visibles` +
    (titre ? `, titre "${titre}"` : ', sans titre') + '.'
  );
}

/** Choisit la strategie, avec repli automatique en mode "auto". */
export async function fetchSite(site) {
  const result = await fetchByMode(site);
  assertIdentity(site, result);
  return result;
}

async function fetchByMode(site) {
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

/** Un signal de disponibilite exploitable est-il deja present dans la page ? */
const hasUsableSignal = (html) =>
  /"availability"\s*:\s*"/i.test(html) || /itemprop=["']availability["']/i.test(html);

/**
 * Attend que la page soit exploitable, puis rend la main immediatement.
 *
 * Deux attentes distinctes se superposent ici : le rendu JavaScript du site, et
 * la resolution d'un eventuel challenge anti-bot, bien plus lente. On sort des
 * que l'une aboutit plutot que d'attendre un delai fixe calibre sur le pire cas.
 */
async function waitForSignal(page, { maxMs, challengeMs, pollMs = 250 }) {
  let html = await readContent(page);
  const start = Date.now();

  while (true) {
    const challenged = isChallengePage(html);
    if (!challenged && hasUsableSignal(html)) return html;

    // Un challenge merite beaucoup plus de patience qu'un simple rendu.
    const budget = challenged ? challengeMs : maxMs;
    if (Date.now() - start >= budget) return html;

    await page.waitForTimeout(pollMs);
    html = await readContent(page);
  }
}

/**
 * Lit le HTML courant en tolerant une navigation en cours.
 * Les pages anti-bot se redirigent d'elles-memes : lire pendant la bascule
 * leve une erreur Playwright qui n'a rien a dire a l'utilisateur.
 */
async function readContent(page) {
  try {
    return await page.content();
  } catch {
    return '';
  }
}

// Marqueurs presents dans le corps de la page : suffisamment distinctifs pour
// ne pas apparaitre dans une vraie fiche produit.
const CHALLENGE_MARKERS = [
  'vous n’etes pas un robot', "vous n'etes pas un robot", 'verifions ensemble',
  'checking your browser', 'verification de votre navigateur',
  'enable javascript and cookies to continue',
  'geo.captcha-delivery.com', 'cf-challenge', 'cf_chl_opt', '__cf_chl',
  // Imperva / Distil / Incapsula : pages servies par Smyths Toys.
  'made us think you were a bot', 'distil_r_blocked', 'distil_referrer',
  'incapsula incident id', '_incapsula_resource', 'request unsuccessful',
];

// Titres de pages d'attente. Compares au <title> entier et non au corps :
// "un instant" isole apparaitrait dans trop de pages legitimes.
const CHALLENGE_TITLES = [
  'un instant', 'just a moment', 'acces bloque', 'attention required',
  'veuillez patienter', 'please wait', 'access denied', 'acces refuse',
  'security check', 'verification', 'maintenance', 'pardon our interruption',
];

const stripAccents = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Reconnait une page d'attente ou de blocage anti-bot plutot qu'un vrai contenu.
 * Distinguer ce cas d'un "aucun signal trouve" evite qu'un site bloque passe
 * pour un site simplement illisible, et silencieux de surcroit.
 */
export function isChallengePage(html) {
  if (!html) return false;
  const haystack = stripAccents(html);
  if (CHALLENGE_MARKERS.some((m) => haystack.includes(m))) return true;

  // Comparaison exacte, jamais par prefixe : une fiche produit intitulee
  // "Verification du kit" ne doit pas passer pour une page de blocage.
  const title = stripAccents((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1])
    .replace(/[\s.…·|—-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return title.length > 0 && CHALLENGE_TITLES.includes(title);
}

/** Longueur du texte reellement visible, hors balises, scripts et styles. */
export function visibleTextLength(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
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

// Expose les helpers internes pour les tests, sans elargir l API publique.
export const __test = { hasUsableSignal, waitForSignal, assertIdentity };
