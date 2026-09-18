import * as cheerio from 'cheerio';

const OUT_OF_STOCK_PHRASES = [
  'rupture de stock', 'en rupture', 'victime de son succes', 'produit epuise', 'epuise',
  'indisponible', 'non disponible', 'actuellement indisponible', 'plus disponible',
  'me prevenir', 'prevenez-moi', 'alertez-moi quand', 'etre alerte de la disponibilite',
  'out of stock', 'sold out', 'currently unavailable', 'no longer available',
  'notify me when available', 'email when available', 'back in stock soon',
  'agotado', 'nicht verfugbar', 'ausverkauft', 'esaurito',
];

const IN_STOCK_PHRASES = [
  'ajouter au panier', 'ajouter a mon panier', 'mettre au panier', 'acheter maintenant',
  'add to cart', 'add to bag', 'add to basket', 'buy now', 'in stock', 'en stock',
  'disponible immediatement', 'expedie sous',
];

const CART_SELECTORS = [
  'button[name="add"]', 'button#AddToCart', 'form[action*="/cart/add"] button[type="submit"]',
  'button.add-to-cart', 'button.single_add_to_cart_button', '[data-testid*="add-to-cart"]',
  '#add-to-cart', '.btn-add-to-cart', 'button[id*="add-to-cart" i]',
];

/** Normalise pour comparer du texte sans se soucier des accents ni de la casse. */
const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');

/**
 * Racine grossiere d'un mot francais : retire le pluriel et le feminin.
 * "epuises", "epuisee" et "epuise" se ramenent ainsi a la meme forme, ce qui
 * evite d'enumerer toutes les variantes dans les listes de termes.
 */
const stem = (w) => w.replace(/(s|x)$/, '').replace(/e+$/, '');

/** Decoupe un texte en mots normalises et deracines. */
const words = (s) => norm(s).split(/[^a-z0-9]+/).filter(Boolean).map(stem);

/**
 * Cherche une expression comme une suite de mots entiers, et renvoie sa
 * position (ou -1).
 *
 * La comparaison mot a mot est indispensable : en cherchant une sous-chaine,
 * "disponible" se trouve a l'interieur d'"indisponible", et un article en
 * rupture serait annonce comme disponible.
 */
function findPhrase(textWords, phrase) {
  const needle = words(phrase);
  if (needle.length === 0) return -1;

  outer:
  for (let i = 0; i + needle.length <= textWords.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (textWords[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const hasPhrase = (textWords, phrase) => findPhrase(textWords, phrase) !== -1;

// "bientot en stock" ou "plus en stock" annoncent une indisponibilite tout en
// contenant l'expression "en stock". On inspecte donc ce qui precede.
const NEGATORS = ['bientot', 'prochainement', 'plus', 'pas', 'non', 'jamais', 'sans'].map(stem);

/** Trouve une expression de disponibilite qui ne soit pas niee juste avant. */
function findPositive(textWords, phrases) {
  for (const phrase of phrases) {
    const needle = words(phrase);
    if (needle.length === 0) continue;

    for (let i = 0; i + needle.length <= textWords.length; i++) {
      let hit = true;
      for (let j = 0; j < needle.length; j++) {
        if (textWords[i + j] !== needle[j]) { hit = false; break; }
      }
      if (!hit) continue;

      const before = textWords.slice(Math.max(0, i - 3), i);
      if (!before.some((w) => NEGATORS.includes(w))) return phrase;
    }
  }
  return null;
}

/**
 * Determine la disponibilite d'un article.
 * Retourne { inStock, reason, confidence } ; inStock vaut null si indeterminable.
 */
export function detect(site, fetched) {
  if (fetched.structured) {
    return {
      inStock: fetched.structured.inStock,
      reason: fetched.structured.detail,
      confidence: 'high',
      price: fetched.structured.price,
    };
  }

  const $ = cheerio.load(fetched.html);
  $('script, style, noscript, template, header nav, footer').remove();

  const scoped = site.scope ? $(site.scope) : $.root();
  if (site.scope && scoped.length === 0) {
    return { inStock: null, reason: `Selecteur "scope" introuvable : ${site.scope}`, confidence: 'none' };
  }
  // cheerio colle le texte des elements voisins : <h1>Article</h1><p>Rupture</p>
  // donnerait "ArticleRupture". On remplace donc les balises par des espaces.
  const scopedHtml = site.scope ? scoped.map((i, el) => $.html(el)).get().join(' ') : $.html();
  const textWords = words(scopedHtml.replace(/<[^>]+>/g, ' '));

  // 1. Regles explicites definies dans sites.yaml : elles font autorite.
  if (site.rules) return applyRules(site.rules, $, textWords, fetched.html);

  // 2. Donnees structurees schema.org : la source la plus fiable apres l'API du
  // site, mais pas une parole d'evangile. Un marchand peut publier InStock sur
  // une fiche qui affiche "Non disponible actuellement" : c'est arrive, et cela
  // a declenche une fausse alerte d'achat. On ne tranche pas a sa place quand
  // sa propre page le contredit.
  const schema = readSchemaAvailability(fetched.html);
  if (schema === true) {
    const contradiction = OUT_OF_STOCK_PHRASES.find((p) => hasPhrase(textWords, p));
    if (contradiction) {
      return {
        inStock: null,
        reason:
          `Donnees du marchand contradictoires : schema.org annonce InStock ` +
          `mais la page affiche "${contradiction}". Ajoute "in_stock_when" pour ce site.`,
        confidence: 'none',
      };
    }
  }
  if (schema !== null) {
    return {
      inStock: schema,
      reason: `schema.org availability = ${schema ? 'InStock' : 'OutOfStock'}`,
      confidence: 'high',
    };
  }

  // 3. Heuristique textuelle.
  const outHit = OUT_OF_STOCK_PHRASES.find((p) => hasPhrase(textWords, p));
  const inHit = findPositive(textWords, IN_STOCK_PHRASES);
  const cartActive = CART_SELECTORS.some((sel) => {
    const el = $(sel).first();
    return el.length > 0 && el.attr('disabled') === undefined && !norm(el.attr('class')).includes('disabled');
  });

  if (outHit && !cartActive) {
    return { inStock: false, reason: `Mention "${outHit}" detectee`, confidence: 'medium' };
  }
  if (cartActive && !outHit) {
    return { inStock: true, reason: 'Bouton "ajouter au panier" actif', confidence: 'medium' };
  }
  if (inHit && !outHit) {
    return { inStock: true, reason: `Mention "${inHit}" detectee`, confidence: 'low' };
  }
  if (outHit) {
    return { inStock: false, reason: `Mention "${outHit}" detectee (bouton panier present)`, confidence: 'low' };
  }

  return {
    inStock: null,
    reason: 'Aucun signal de disponibilite reconnu. Ajoute "in_stock_when" pour ce site.',
    confidence: 'none',
  };
}

function applyRules(rules, $, textWords, rawHtml) {
  const failures = [];

  for (const phrase of rules.present) {
    if (!hasPhrase(textWords, phrase)) failures.push(`texte requis absent : "${phrase}"`);
  }
  for (const phrase of rules.absent) {
    if (hasPhrase(textWords, phrase)) failures.push(`texte interdit present : "${phrase}"`);
  }
  for (const sel of rules.selector_exists) {
    if ($(sel).length === 0) failures.push(`selecteur requis absent : "${sel}"`);
  }
  for (const sel of rules.selector_absent) {
    if ($(sel).length > 0) failures.push(`selecteur interdit present : "${sel}"`);
  }
  if (rules.regex && !new RegExp(rules.regex, 'i').test(rawHtml)) {
    failures.push(`regex non satisfaite : /${rules.regex}/i`);
  }

  return failures.length === 0
    ? { inStock: true, reason: 'Toutes les regles in_stock_when sont satisfaites', confidence: 'high' }
    : { inStock: false, reason: failures.join(' ; '), confidence: 'high' };
}

/** Lit la disponibilite dans le JSON-LD ou les microdonnees de la page. */
function readSchemaAvailability(html) {
  const matches = [...html.matchAll(/"availability"\s*:\s*"([^"]+)"/gi)]
    .concat([...html.matchAll(/itemprop=["']availability["'][^>]*(?:href|content)=["']([^"']+)["']/gi)]);
  if (matches.length === 0) return null;

  const values = matches.map((m) => m[1].toLowerCase());
  if (values.some((v) => v.includes('instock') || v.includes('limitedavailability') || v.includes('presale'))) {
    return true;
  }
  if (values.some((v) => v.includes('outofstock') || v.includes('soldout') || v.includes('discontinued') || v.includes('backorder'))) {
    return false;
  }
  return null;
}
