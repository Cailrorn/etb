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
