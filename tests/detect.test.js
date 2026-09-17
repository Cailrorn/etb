import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect } from '../src/detect.js';
import { selectVariants, isChallengePage } from '../src/fetchers.js';

const page = (body) => ({ html: `<html><body>${body}</body></html>` });
const site = (extra = {}) => ({ url: 'https://x.fr/p/1', rules: null, ...extra });

test('schema.org InStock fait autorite sur le texte de la page', () => {
  const html = page('<div>Bientot de retour</div>').html +
    '<script type="application/ld+json">{"availability":"https://schema.org/InStock"}</script>';
  const r = detect(site(), { html });
  assert.equal(r.inStock, true);
  assert.equal(r.confidence, 'high');
});

test('schema.org OutOfStock est detecte', () => {
  const html = `<html><body><p>Ajouter au panier</p></body></html>
    <script type="application/ld+json">{"availability":"http://schema.org/OutOfStock"}</script>`;
  assert.equal(detect(site(), { html }).inStock, false);
});

test('rupture de stock detectee malgre les accents et la casse', () => {
  const r = detect(site(), page('<h1>Article</h1><p>RUPTURE DE STOCK</p>'));
  assert.equal(r.inStock, false);
});

test('bouton panier actif => en stock', () => {
  const r = detect(site(), page('<button class="add-to-cart">Ajouter au panier</button>'));
  assert.equal(r.inStock, true);
});

test('bouton panier desactive avec mention rupture => indisponible', () => {
  const r = detect(site(), page('<button class="add-to-cart" disabled>Ajouter au panier</button><span>Epuise</span>'));
  assert.equal(r.inStock, false);
});

test('page sans signal reconnu reste indeterminee plutot que de mentir', () => {
  const r = detect(site(), page('<p>Bienvenue sur notre boutique</p>'));
  assert.equal(r.inStock, null);
  assert.equal(r.confidence, 'none');
});

test('les scripts ne polluent pas la detection textuelle', () => {
  const html = '<html><body><script>var msg="rupture de stock";</script><button class="add-to-cart">Ajouter au panier</button></body></html>';
  assert.equal(detect(site(), { html }).inStock, true);
});

test('les regles explicites priment sur l heuristique', () => {
  const rules = { present: ['Livraison sous 48h'], absent: [], selector_exists: [], selector_absent: [], regex: null };
  const r = detect(site({ rules }), page('<p>Ajouter au panier</p>'));
  assert.equal(r.inStock, false);
  assert.match(r.reason, /texte requis absent/);
});

test('scope limite l analyse a une zone de la page', () => {
  const html = page('<aside>Rupture de stock sur un autre article</aside><main id="p"><button class="add-to-cart">Ajouter au panier</button></main>').html;
  assert.equal(detect(site({ scope: '#p' }), { html }).inStock, true);
  assert.equal(detect(site(), { html }).inStock, false);
});

test('scope introuvable => indetermine, pas de faux positif', () => {
  const r = detect(site({ scope: '#absent' }), page('<button class="add-to-cart">Ajouter au panier</button>'));
  assert.equal(r.inStock, null);
});

test('donnees structurees Shopify court-circuitent l analyse HTML', () => {
  const r = detect(site(), { structured: { inStock: true, detail: 'Disponible : M', price: '115.00' } });
  assert.equal(r.inStock, true);
  assert.equal(r.price, '115.00');
});

test('selectVariants n apparie pas XL avec XXL', () => {
  const vs = [{ id: 1, title: 'XL' }, { id: 2, title: 'XXL' }, { id: 3, title: 'XL / Noir' }];
  assert.deepEqual(selectVariants(vs, 'XL').map((v) => v.title), ['XL', 'XL / Noir']);
  assert.deepEqual(selectVariants(vs, 'XXL').map((v) => v.title), ['XXL']);
});

test('selectVariants accepte une liste et un id', () => {
  const vs = [{ id: 11, title: 'S' }, { id: 12, title: 'M' }];
  assert.deepEqual(selectVariants(vs, ['S', 'M']).length, 2);
  assert.deepEqual(selectVariants(vs, '12')[0].title, 'M');
});

test('isChallengePage reconnait un mur anti-bot', () => {
  const cloudflare = '<html><body>Vérifions ensemble que vous n’êtes pas un robot. Ray ID : abc</body></html>';
  const datadome = '<html><body><script>var dd={host:"geo.captcha-delivery.com"}</script></body></html>';
  assert.equal(isChallengePage(cloudflare), true);
  assert.equal(isChallengePage(datadome), true);
});

test('isChallengePage ne se declenche pas sur une vraie fiche produit', () => {
  const page = '<html><body><h1>Coffret Dresseur d\'Élite</h1><p>Rupture de stock</p></body></html>';
  assert.equal(isChallengePage(page), false);
  assert.equal(isChallengePage(''), false);
  assert.equal(isChallengePage(null), false);
});

test('isChallengePage reconnait les murs anti-bot en francais', () => {
  assert.equal(isChallengePage('<html><head><title>Un instant…</title></head><body></body></html>'), true);
  assert.equal(isChallengePage('<html><head><title>Accès bloqué</title></head><body></body></html>'), true);
  // Titre compose : non reconnu par le titre seul, mais le marqueur DataDome
  // present dans le corps de la page Fnac le rattrape.
  assert.equal(isChallengePage('<html><head><title>FNAC DARTY - Maintenance</title></head><body></body></html>'), false);
  assert.equal(isChallengePage('<html><head><title>Maintenance</title></head><body></body></html>'), true);
});

test('un titre de fiche produit contenant un mot de challenge ne declenche pas', () => {
  const p = '<html><head><title>Coffret Collection Poster Pokémon 30e Anniversaire - La Grande Récré</title></head><body>Rupture de stock</body></html>';
  assert.equal(isChallengePage(p), false);
  const v = '<html><head><title>Verification du produit : kit de test</title></head><body>En stock</body></html>';
  assert.equal(isChallengePage(v), false);
});

test('hasUsableSignal ne confond pas une page vide avec une page prete', async () => {
  const { __test } = await import('../src/fetchers.js');
  assert.equal(__test.hasUsableSignal('<html><body>chargement…</body></html>'), false);
  assert.equal(__test.hasUsableSignal('<script>{"availability":"https://schema.org/InStock"}</script>'), true);
  assert.equal(__test.hasUsableSignal('<link itemprop="availability" href="http://schema.org/OutOfStock">'), true);
});

// --- Robustesse du rapprochement de termes ---------------------------------

const heur = (body) => detect(site(), page(body));

test('"indisponible" n est jamais lu comme "disponible"', () => {
  assert.equal(heur('<p>Produit indisponible</p>').inStock, false);
  assert.equal(heur('<p>Non disponible</p>').inStock, false);
  assert.equal(heur('<p>Ce produit n est plus disponible</p>').inStock, false);
});

test('"bientot en stock" n est pas lu comme une disponibilite', () => {
  assert.notEqual(heur('<p>Bientôt en stock</p>').inStock, true);
  assert.notEqual(heur('<p>Prochainement en stock</p>').inStock, true);
  assert.notEqual(heur('<p>Ce produit n est plus en stock</p>').inStock, true);
});

test('"en stock" sans negation reste une disponibilite', () => {
  assert.equal(heur('<p>Article en stock, expedition immediate</p>').inStock, true);
});

test('la casse et les accents sont ignores', () => {
  assert.equal(heur('<p>RUPTURE DE STOCK</p>').inStock, false);
  assert.equal(heur('<p>Épuisé</p>').inStock, false);
  assert.equal(heur('<p>epuise</p>').inStock, false);
  assert.equal(heur('<p>ÉPUISÉ</p>').inStock, false);
});

test('le pluriel et le feminin sont reconnus sans les enumerer', () => {
  assert.equal(heur('<p>Articles épuisés</p>').inStock, false);
  assert.equal(heur('<p>Piece épuisée</p>').inStock, false);
  assert.equal(heur('<p>Produits indisponibles</p>').inStock, false);
});

test('un mot ne matche pas au milieu d un autre', () => {
  // "destockage" contient "stock", "predisponible" contient "disponible" :
  // une recherche de sous-chaine s y laisserait prendre.
  assert.equal(heur('<p>Rayon destockage et antistock</p>').inStock, null);
});
