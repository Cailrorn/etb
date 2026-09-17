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
npm test                 # suite de tests de la détection
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

## Sites actuellement surveillés

Coffret Dresseur d'Élite Pokémon 30e anniversaire (EAN `196214144835`). Chaque site a été testé en conditions réelles le 17/09/2026 — tous en rupture à cette date.

| Site | Mode | Détection | État |
|---|---|---|---|
| King Jouet | `http` | schema.org `OutOfStock` | ✅ fiable |
| 1001hobbies | `http` | schema.org `OutOfStock` | ✅ fiable |
| Carrefour | `browser` | schema.org `OutOfStock` | ✅ fiable (403 en HTTP simple) |
| Fnac | — | — | ❌ désactivé, mur anti-bot |

**Pourquoi la Fnac est désactivée.** Le site sert une page de challenge DataDome (`geo.captcha-delivery.com`) à la place de la fiche produit — en HTTP simple comme en navigateur, et y compris depuis une IP résidentielle. Passer ce mur reviendrait à contourner un captcha : ce n'est pas fait ici. La page produit Fnac propose un bouton **« Alerte disponibilité »** qui envoie un mail au restock — c'est la bonne solution pour ce marchand.

> **À vérifier au premier run :** Carrefour a été validé depuis une connexion résidentielle. Les runners GitHub sortent sur des IP de datacenter, souvent filtrées plus durement. Lance le workflow à la main une fois et regarde les logs : si Carrefour remonte en `403`, c'est ce filtrage. Les deux autres sites, eux, ne posent aucune difficulté.

**Le piège de 1001hobbies** mérite d'être signalé : la page affiche « Ajouter au panier » *même en rupture*, et le mot « Indisponible » se trouve ailleurs dans le DOM. Une règle naïve sur le bouton se serait trompée dans les deux sens. Ce sont les données structurées schema.org qui donnent la bonne réponse — d'où leur priorité sur l'heuristique texte.

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
