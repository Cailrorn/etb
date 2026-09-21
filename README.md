# stock-watcher

Surveillance de la disponibilité / remise en vente d'articles sur plusieurs sites, avec alerte **Telegram** instantanée. Tourne gratuitement sur **GitHub Actions**, sans serveur.

- Vérification toutes les 5 minutes (cron GitHub Actions)
- Détection automatique : API JSON Shopify → données schema.org → heuristique texte/bouton
- Règles explicites par site quand l'automatique ne suffit pas
- Mode navigateur (Playwright) pour les boutiques rendues en JavaScript
- Alerte **uniquement au changement d'état** — pas de spam
- Suivi d'une taille / variante précise

---

## 1. Créer le bot Telegram (3 minutes)

1. Sur Telegram, ouvre une conversation avec **@BotFather**.
2. Envoie `/newbot`, choisis un nom puis un identifiant. BotFather répond avec un **token** du type `8123456789:AAH...`.
3. Ouvre une conversation avec **ton nouveau bot** et envoie-lui n'importe quel message (obligatoire : un bot ne peut pas écrire en premier).
4. Récupère ton `chat_id` en ouvrant dans un navigateur :
   `https://api.telegram.org/bot<TON_TOKEN>/getUpdates`
   Cherche `"chat":{"id":123456789` → c'est ton **chat_id**.

> Pour recevoir les alertes dans un groupe : ajoute le bot au groupe, écris un message, puis relis `getUpdates`. L'id d'un groupe est négatif (`-100...`).

## 2. Mettre le projet en ligne

```bash
cd stock-watcher
git add -A
git commit -m "init"
gh repo create stock-watcher --public --source=. --push
```

Sans la CLI `gh` : crée un dépôt **public** sur github.com, puis

```bash
git remote add origin https://github.com/<ton-compte>/stock-watcher.git
git push -u origin main
```

> Le dépôt doit être **public** : les minutes GitHub Actions y sont illimitées et gratuites. En privé, tu consommerais le quota mensuel (2 000 min) en environ une semaine à ce rythme.

## 3. Déclarer les secrets

Dans le dépôt : **Settings → Secrets and variables → Actions → New repository secret**

| Nom | Valeur |
|---|---|
| `TELEGRAM_BOT_TOKEN` | le token de BotFather |
| `TELEGRAM_CHAT_ID` | ton chat_id |
| `HEALTHCHECK_URL` | *(optionnel)* URL de ping healthchecks.io — voir « Détecter que le robot ne tourne plus » |

Puis, dans l'onglet **Actions**, active les workflows si GitHub le demande.

## 4. Vérifier que tout marche

Onglet **Actions → Surveillance stock → Run workflow**. Tu dois voir la liste des articles vérifiés dans les logs, et recevoir un message Telegram si un article est disponible.

Pour tester juste la connexion Telegram :

```bash
npm install
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... npm run test-alert
```

---

## Configurer les articles à surveiller

Tout se passe dans [`sites.yaml`](sites.yaml). Le cas le plus simple :

```yaml
sites:
  - name: "Nike Dunk Low — taille 42"
    url: "https://boutique.com/products/dunk-low"
    mode: auto
```

### Les modes

| Mode | Quand l'utiliser |
|---|---|
| `auto` *(défaut)* | Laisse le script choisir : API Shopify si disponible, sinon HTTP, sinon navigateur. À essayer en premier. |
| `shopify` | Force l'API JSON Shopify (`/products/<handle>.js`). Le plus fiable — donne l'état réel de chaque taille. |
| `http` | Simple téléchargement du HTML. Rapide et léger. |
| `browser` | Chromium headless : pour les sites qui affichent le stock en JavaScript. |

### Surveiller une taille précise (Shopify)

```yaml
  - name: "Sneaker — taille 42 uniquement"
    url: "https://boutique.com/products/sneaker"
    mode: shopify
    variant: "42"          # ou une liste : ["42", "42.5"], ou un id de variante
```

L'appariement est **exact** : `"XL"` ne déclenche pas sur `XXL`.

### Écrire ses propres règles

Quand la détection automatique se trompe, décris toi-même ce que « en stock » veut dire. L'article est considéré disponible si **toutes** les règles passent :

```yaml
  - name: "Article difficile"
    url: "https://boutique.com/article/123"
    mode: http
    scope: "#product-main"        # optionnel : n'analyser que cette zone de la page
    in_stock_when:
      absent:                     # aucun de ces textes ne doit apparaître
        - "Rupture de stock"
        - "Me prévenir par e-mail"
      present:                    # tous ces textes doivent apparaître
        - "Ajouter au panier"
      selector_exists: "button.add-to-cart:not([disabled])"
      selector_absent: ".badge-epuise"
      regex: '"availability"\s*:\s*"[^"]*InStock"'
```

La comparaison de texte ignore la casse **et** les accents : `"épuisé"` correspond aussi à `EPUISE`.

**Comment trouver la bonne règle :** ouvre la page produit quand l'article est en rupture, `Ctrl+U` (code source), et repère la phrase ou la classe CSS qui n'apparaît *que* dans cet état. Mets-la dans `absent`.

### Site rendu en JavaScript

```yaml
  - name: "Boutique en React"
    url: "https://boutique.com/p/article"
    mode: browser
    wait_for_selector: ".product-availability"   # attend cet élément
    wait_ms: 3000
    in_stock_when:
      absent: ["Indisponible"]
```

### Options par site

| Clé | Défaut | Rôle |
|---|---|---|
| `enabled` | `true` | `false` met le site en pause sans le supprimer |
| `timeout_ms` | `25000` | Délai max par requête |
| `retries` | `2` | Tentatives supplémentaires en cas d'échec |
| `notify_on_out_of_stock` | `false` | Alerter aussi quand l'article repart en rupture |
| `notify_on_first_check` | `true` | Alerter si l'article est déjà dispo à la toute première vérification |
| `headers` | — | En-têtes HTTP supplémentaires (cookie de session, etc.) |
| `currency` | `€` | Symbole affiché dans l'alerte |

### Réglages globaux

```yaml
settings:
  concurrency: 4          # sites vérifiés en parallèle
  heartbeat_hours: 24     # message "je suis vivant" toutes les 24h (0 = désactivé)
  error_alert_after: 3    # alerte après N échecs consécutifs sur un site
```

---

## Utilisation en local

```bash
npm install
npm run check:dry        # vérifie sans envoyer d'alerte — à utiliser pour régler un site
npm run check:verbose    # affiche la source et le motif de chaque décision
npm test                 # suite de tests
npm run preview          # voir un exemple d'alerte (affichage seul)
npm run preview:send     # l'envoyer sur Telegram, marqué DEMO en première ligne
node src/index.js --only=mon-article --dry-run --verbose   # un seul site
```

Pour le mode `browser` en local : `npm run browsers` une fois.

Crée un `.env` (copie de `.env.example`) pour les tests réels, ou passe les variables en ligne de commande.

---

## Comment ça marche

```
cron GitHub Actions (toutes les 5 min)
        │
        ▼
  sites.yaml ──► fetch (shopify / http / browser)
                        │
                        ▼
                  détection de l'état
                        │
          compare avec state.json (commité dans le dépôt)
                        │
              changement ? ──► alerte Telegram
                        │
                  écrit state.json
```

`state.json` est commité automatiquement par le workflow : c'est la mémoire entre deux exécutions, et il te sert aussi d'historique (`git log state.json` montre chaque changement de stock).

## Quand le bot t'écrit

| Message | Déclencheur | Répétition |
|---|---|---|
| 🟢 **De nouveau en stock** | un article passe de rupture à disponible | à chaque retour en stock |
| ⚠️ **Surveillance en échec** | 3 échecs réseau consécutifs sur un site | puis rappel toutes les 12 h tant que ça dure |
| 🟠 **Site illisible** | 3 verdicts « indéterminé » consécutifs | puis rappel toutes les 12 h |
| 🔥 **Le robot a planté** | le job GitHub échoue avant de pouvoir vérifier | à chaque échec |
| 💓 **Surveillance active** | toutes les 24 h, en silencieux | 1×/jour |
| 🔴 **De nouveau indisponible** | retour en rupture | désactivé par défaut |

Les alertes produit ne partent qu'aux **changements d'état** : tant que tout reste en rupture, aucun message.

### Détecter que le robot ne tourne plus

Les cinq premiers messages supposent que le job s'exécute. Si GitHub Actions s'arrête — cron désactivé après 60 jours d'inactivité, dépôt suspendu, panne — **personne ne prévient**, et le silence ressemble exactement à « rien n'est en stock ». Un programme mort ne peut pas signaler sa propre mort : il faut un observateur extérieur.

C'est le rôle de `HEALTHCHECK_URL`. À chaque passage réussi, le script appelle une URL ; si les appels cessent, le service extérieur t'alerte.

**Mise en place (gratuit, 5 minutes) :**

1. Crée un compte sur [healthchecks.io](https://healthchecks.io) (20 checks gratuits, pas de carte)
2. **Add Check** → nomme-le `stock-watcher`
3. Règle **Period** sur `15 minutes` et **Grace Time** sur `20 minutes` — assez large pour absorber les retards du cron GitHub
4. Copie l'**URL de ping** (`https://hc-ping.com/xxxxxxxx-...`)
5. Ajoute-la en secret GitHub sous le nom `HEALTHCHECK_URL`
6. Dans healthchecks.io, onglet **Integrations**, branche **Telegram** (ou e-mail)

Sans ce secret, tout fonctionne à l'identique — tu perds seulement la détection d'arrêt complet.

Le script ne pingue **pas** quand un envoi Telegram a échoué. Le watchdog sert alors de second canal : si Telegram tombe, c'est healthchecks.io qui te prévient.

## Sites actuellement surveillés

Quatre articles Pokémon 30ᵉ anniversaire :

| Article | EAN |
|---|---|
| Coffret Dresseur d'Élite (ETB) | `196214144835` |
| Coffret Collection Poster | `196214147225` |
| Coffret 4 boosters Nymphali-ex | `196214147102` |
| Coffret 4 boosters Amphinobi-ex | `196214147164` |

### Couverture par boutique

| Boutique | ETB | Poster | Nymphali-ex | Amphinobi-ex |
|---|---|---|---|---|
| **1001hobbies** | [✅ actif](https://www.1001hobbies.fr/jeux-de-cartes-a-jouer/892561-pokemon-company-bm-258861-pokemon-30eme-anniversaire-elite-trainer-196214144835.html) | [✅ actif](https://www.1001hobbies.fr/jeux-de-cartes-a-jouer/892555-pokemon-company-bm-258860-pokemon-30eme-anniversaire-collection-po-196214147225.html) | [✅ actif](https://www.1001hobbies.fr/jeux-de-cartes-a-jouer/892558-pokemon-company-bm-258858-pokemon-30eme-anniversaire-coffret-nymph-196214147102.html) | [✅ actif](https://www.1001hobbies.fr/jeux-de-cartes-a-jouer/892559-pokemon-company-bm-258857-pokemon-30eme-anniversaire-coffret-amphi-196214147164.html) |
| **Carrefour** | [✅ actif](https://www.carrefour.fr/p/cartes-a-jouer-et-a-collectionner-coffret-dresseur-d-elite-30e-anniversaire-pokemon-0196214144835) | [✅ actif](https://www.carrefour.fr/p/coffret-pokemon-collection-poster-30e-anniversaire-pokemon-0196214147225) | [✅ actif](https://www.carrefour.fr/p/coffret-pokemon-nymphali-ex-30e-anniversaire-pokemon-0196214147102) | [✅ actif](https://www.carrefour.fr/p/coffret-pokemon-amphinobi-ex-30e-anniversaire-pokemon-0196214147164) |
| **Caverne du Gobelin** | [✅ actif](https://cavernedugobelin.fr/products/6aaa2fd9972b8) | [✅ actif](https://cavernedugobelin.fr/products/6aaa2b2ad856d) | [✅ actif](https://cavernedugobelin.fr/products/6aaa2ec07ee97) | [✅ actif](https://cavernedugobelin.fr/products/6aaa2f67e7df5) |
| **DestockTCG** | [✅ actif](https://www.destocktcg.fr/product/30e-anniversaire-coffret-dresseur-delite-etb-pokemon-fr-1750) | [✅ actif](https://www.destocktcg.fr/product/30e-anniversaire-collection-poster-pokemon-fr-1751) | [✅ actif](https://www.destocktcg.fr/product/30e-anniversaire-coffret-nymphali-ex-pokemon-fr-1748) | [✅ actif](https://www.destocktcg.fr/product/30e-anniversaire-coffret-amphinobi-ex-pokemon-fr-1747) |
| **Hikaru** | [✅ actif](https://hikarudistribution.com/products/elite-trainer-box-30th-celebration-francais) | [✅ actif](https://hikarudistribution.com/products/coffret-collection-poster-30e-anniversaire) | [✅ actif](https://hikarudistribution.com/products/coffret-nymphali-ex-30e-anniversaire) | [✅ actif](https://hikarudistribution.com/products/coffret-amphinobi-ex-30e-anniversaire) |
| **JouéClub** | [✅ actif](https://www.joueclub.fr/pokemon/pokemon-30eme-anniversaire-coffret-dresseur-d-elite-0196214144835.html) | [✅ actif](https://www.joueclub.fr/pokemon/pokemon-30eme-anniversaire-coffret-collection-poster-0196214147225.html) | [✅ actif](https://www.joueclub.fr/pokemon/pokemon-30eme-anniversaire-coffret-4-boosters-nymphali-ex-0196214147102.html) | [✅ actif](https://www.joueclub.fr/pokemon/pokemon-30eme-anniversaire-coffret-4-boosters-amphinobi-ex-0196214147164.html) |
| **Pokelite** | [✅ actif](https://www.pokelite.fr/produit/etb-30%e1%b5%89-anniversaire-pokemon-me5-5/) | [✅ actif](https://www.pokelite.fr/produit/coffret-poster-30%e1%b5%89-anniversaire-pokemon-me5-5/) | [✅ actif](https://www.pokelite.fr/produit/coffret-nymphali-ex-30%e1%b5%89-anniversaire-pokemon-me5-5/) | [✅ actif](https://www.pokelite.fr/produit/coffret-amphinobi-ex-30%e1%b5%89-anniversaire-pokemon-me5-5/) |
| **Cdiscount** | [✅ actif](https://www.cdiscount.com/juniors/jeux-de-societe-cartes/pokemon-etb-coffret-dresseur-d-elite-30e-anniv/f-120791604-pok196214144835.html) | [✅ actif](https://www.cdiscount.com/juniors/jeux-de-societe-cartes/pokemon-30-ans-coffret-poster-30eme-anniversaire/f-120791604-pok196214147225.html) | — | — |
| **King Jouet** | [⚠️ peu fiable](https://www.king-jouet.com/jeu-jouet/jeux-societes/cartes-a-collectionner/ref-1034916-pokemon-30-ans-coffret-dresseur-d-elite.htm) | [⚠️ peu fiable](https://www.king-jouet.com/jeu-jouet/jeux-societes/cartes-a-collectionner/ref-1034914-pokemon-30-ans-coffret-poster.htm) | [⚠️ peu fiable](https://www.king-jouet.com/jeu-jouet/jeux-societes/cartes-a-collectionner/ref-1034912-pokemon-30-ans-coffret-nymphali-ex.htm) | [⚠️ peu fiable](https://www.king-jouet.com/jeu-jouet/jeux-societes/cartes-a-collectionner/ref-1034913-pokemon-30-ans-coffret-amphinobi-ex.htm) |
| **La Grande Récré** | [⛔ retiré](https://www.lagranderecre.fr/cartes-a-collectionner/) | [⛔ retiré](https://www.lagranderecre.fr/cartes-a-collectionner/) | [⛔ retiré](https://www.lagranderecre.fr/cartes-a-collectionner/) | [⛔ retiré](https://www.lagranderecre.fr/cartes-a-collectionner/) |
| **Philibert** | — | — | [⛔ retiré](https://www.philibertnet.com/fr/212-pokemon) | [⛔ retiré](https://www.philibertnet.com/fr/212-pokemon) |
| **Fnac** | [🚫 bloqué](https://www.fnac.com/Cartes-a-collectionner-Pokemon-30A-Coffret-Dresseur-d-Elite/a23200296/w-4) | — | — | — |
| **Smyths** | [🚫 bloqué](https://www.smythstoys.com/fr/fr-fr/jouets/jeux-de-societe-et-puzzles/cartes-a-collectionner/cartes-pokemon/pokemon-coffret-dresseur-delite-30eme-anniversaire/p/261821) | [🚫 bloqué](https://www.smythstoys.com/fr/fr-fr/jouets/jeux-de-societe-et-puzzles/cartes-a-collectionner/cartes-pokemon/pokemon-coffret-collection-poster-30eme-anniversaire/p/261814) | [🚫 bloqué](https://www.smythstoys.com/fr/fr-fr/jouets/jeux-de-societe-et-puzzles/cartes-a-collectionner/cartes-pokemon/pokemon-coffret-nymphali-ex-30eme-anniversaire/p/261788) | [🚫 bloqué](https://www.smythstoys.com/fr/fr-fr/jouets/jeux-de-societe-et-puzzles/cartes-a-collectionner/cartes-pokemon/pokemon-coffret-amphinobi-ex-30eme-anniversaire/p/261830) |

Chaque statut est un lien : ✅ et 🚫 mènent à la fiche produit, ⛔ à la catégorie du marchand, là où la fiche réapparaîtra.

✅ surveillé · ⚠️ surveillé, mais peu fiable · ⛔ fiche supprimée du catalogue · 🚫 mur anti-bot · — non référencé

**34 fiches actives**, réparties sur 9 boutiques.

### Ce qui est inactif, et pourquoi

**⚠️ King Jouet — surveillance peu fiable.** Le site est protégé par DataDome, comme la Fnac. Les 4 fiches ne passent que parce qu'elles sont servies par le cache Cloudflare : la requête n'atteint jamais le serveur protégé. Au constat du 21/09/2026, cette copie avait **~3 h 30**, et le CDN est autorisé à la servir **30 jours**. Un réappro peut donc être détecté en retard, voire pas du tout ; et si le marchand purge son cache au moment du réappro, la requête tombe sur DataDome et remonte un échec au lieu d'une alerte de stock. Aucun correctif propre n'existe, contourner DataDome étant exclu. **Active en parallèle le bouton « Alerte disponibilité » sur chaque fiche King Jouet** et considère notre surveillance comme un signal d'appoint. Seul King Jouet est touché : 1001hobbies, JouéClub et Hikaru servent des pages fraîches à chaque requête.

**⛔ La Grande Récré et Philibert — fiches supprimées.** Constaté le 21/09/2026 : ces URL ne renvoient plus d'erreur, elles redirigent vers la liste de la catégorie. Les produits ne figurent plus à leur catalogue. Une fiche supprimée ne revient pas forcément à la même adresse, donc surveiller l'ancienne URL ne servirait à rien. **Quand une fiche réapparaît, ajoute simplement la nouvelle URL comme n'importe quel autre site.** Les deux boutiques gardent un témoin actif : la détection y fonctionne toujours, ce sont bien les produits qui ont disparu.

**🚫 Fnac et Smyths — murs anti-bot.** La Fnac sert une page DataDome (`geo.captcha-delivery.com`), Smyths une page Imperva/Incapsula, à la place de la fiche produit — en HTTP comme en navigateur, y compris depuis une IP résidentielle. Passer ces murs reviendrait à contourner un captcha : ce n'est pas fait ici. Leurs pages produit proposent un bouton **« Alerte disponibilité »** qui envoie un mail au restock, c'est la bonne solution pour ces marchands. Les entrées restent en `enabled: false`, prêtes à être réactivées si la protection s'assouplit.

### Témoins de détection

| Boutique | Témoin | Articles protégés |
|---|---|---|
| 1001hobbies | ✅ | 4 |
| Carrefour | ✅ | 4 |
| Caverne du Gobelin | ✅ | 4 |
| DestockTCG | ✅ | 4 |
| Hikaru | ✅ *(fragile)* | 4 |
| JouéClub | ✅ | 4 |
| Pokelite | ✅ | 4 |
| Cdiscount | ✅ | 2 |
| La Grande Récré | ✅ | 0 *(en attente de retour des fiches)* |
| Philibert | ✅ | 0 *(idem)* |
| King Jouet | ❌ impossible *(cache, voir plus haut)* | 4 |

**30 des 34 fiches** sont protégées par un témoin. Les 4 restantes sont celles de King Jouet.

Voir *Détecter une détection cassée* pour ce que couvrent les témoins.

### Particularités à connaître

**1001hobbies** publie un balisage `schema.org` peu fiable : le 18/09/2026 il annonçait `InStock` sur quatre fiches affichant « Non disponible actuellement », ce qui a déclenché une fausse alerte d'achat. Les quatre entrées de ce marchand utilisent donc une règle explicite sur le texte visible. **Ne pas revenir aux données structurées pour ce site.**

**Carrefour** renvoie `403` en HTTP simple et sert un challenge Cloudflare aux IP de datacenter. Le mode navigateur lui laisse 30 secondes pour se résoudre seul, ce qui suffit depuis les runners GitHub.

**Cdiscount** renvoie une page « activez JavaScript » en HTTP. Pas de captcha, simple rendu client : le mode navigateur suffit.

**King Jouet** ne publie pas l'EAN sur ses fiches. Le contrôle d'identité y repose sur un fragment de titre, un cran moins strict qu'un code-barres.

**DestockTCG** laisse le bouton « Ajouter au panier » dans le HTML même en rupture : il est seulement masqué par la classe CSS `d-none`. Une règle sur le texte le verrait partout et annoncerait du stock en permanence, et leur `schema.org` (`InStoreOnly`) ne dit rien d'utile. La règle vise donc le bouton **visible** : `#submitBasketAdd:not(.d-none)`. Elle répond aussi « indisponible » sur une précommande pas encore ouverte (aucun bouton).

**Pokelite** affiche sur chaque fiche des produits similaires avec leur propre bouton « Ajouter au panier » : une règle sur le texte annoncerait du stock en permanence. La règle vise le bouton d'achat **principal** de WooCommerce (`button.single_add_to_cart_button`), rendu seulement quand l'article est commandable, précommande ouverte comprise. Pas d'EAN publié : l'identité repose sur l'identifiant WordPress de la fiche (`postid-…`). À noter : l'ETB y est vendu en lot avec une Acrylic Case Phoenix Shield.

**Hikaru** est une boutique Shopify : la disponibilité est lue dans leur API, variante par variante, sans analyse de texte. C'est la source la plus fiable du lot.

## Limites à connaître

- **Le cron GitHub n'est pas à la seconde.** Aux heures de forte charge, une exécution prévue à 5 min peut partir avec 5 à 15 minutes de retard. Pour un drop très concurrentiel, c'est insuffisant — il faudrait un process permanent (Fly.io, Render) ou un VPS.
- **Un cron GitHub est désactivé après 60 jours sans activité** sur le dépôt. Un commit suffit à le relancer ; les commits automatiques de `state.json` y contribuent déjà.
- **Protections anti-bot.** Certains sites (Cloudflare, Akamai, DataDome) bloquent les requêtes venant de datacenters. Si un site échoue systématiquement, essaie `mode: browser`, puis des `headers` personnalisés. Certains resteront hors de portée depuis une IP GitHub.
- **Reste raisonnable sur la fréquence.** 5 minutes est poli ; descendre plus bas augmente le risque de blocage et n'apporte pas grand-chose vu la latence du cron.
- Respecte les CGU et le `robots.txt` des sites surveillés.

## Dépannage

| Symptôme | Piste |
|---|---|
| Aucune alerte reçue | `npm run test-alert` ; vérifie que tu as bien écrit au bot en premier |
| « indéterminé » sur un site | Ajoute un bloc `in_stock_when` — voir *Écrire ses propres règles* |
| Fausse alerte | Le texte cherché existe ailleurs dans la page : ajoute `scope` pour restreindre la zone |
| Échecs répétés (HTTP 403) | `mode: browser`, ou ajoute des `headers` |
| Le workflow ne se lance pas | Onglet Actions → les workflows sont-ils activés ? le dépôt a-t-il eu un commit récemment ? |
| `git push` échoue dans le workflow | Settings → Actions → General → Workflow permissions → **Read and write** |
