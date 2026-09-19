const API = 'https://api.telegram.org';

function credentials() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID sont requis. ' +
      'En local : copie .env.example vers .env. Sur GitHub : Settings > Secrets and variables > Actions.'
    );
  }
  return { token, chatId };
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Envoie un message Telegram (HTML), avec un retry sur les erreurs reseau et le rate limit. */
export async function sendTelegram(text, { disablePreview = true, silent = false } = {}) {
  const { token, chatId } = credentials();

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: disablePreview,
        disable_notification: silent,
      }),
    });

    if (res.ok) return true;

    const body = await res.text();
    if (res.status === 429 && attempt < 3) {
      const retryAfter = Number(JSON.parse(body)?.parameters?.retry_after ?? 2);
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      continue;
    }
    if (attempt === 3) throw new Error(`Telegram a repondu ${res.status} : ${body}`);
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  return false;
}

/**
 * Message de retour en stock.
 *
 * C'est la seule notification ou chaque seconde compte : elle est construite
 * pour etre lisible sur un ecran verrouille et cliquable sans rien chercher.
 * L'essentiel tient donc sur les deux premieres lignes, que l'apercu affiche,
 * et l'URL apparait en clair — un lien nu se touche directement, montre le
 * marchand avant d'ouvrir, et se copie d'un appui long.
 */
export function backInStockMessage(site, result) {
  const lines = [`🟢 <b>EN STOCK</b> — ${escapeHtml(site.name)}`];

  if (result.price) {
    lines.push(`💶 ${escapeHtml(result.price)} ${escapeHtml(site.currency ?? '€')}`);
  }

  lines.push('', escapeHtml(site.url));

  if (result.confidence && result.confidence !== 'high') {
    lines.push('', `<i>⚠️ Detection peu sure (${escapeHtml(result.reason)}) — verifie avant d'acheter.</i>`);
  }

  return lines.join('\n');
}

export function outOfStockMessage(site, result) {
  return [
    '🔴 <b>De nouveau indisponible</b>',
    '',
    `<b>${escapeHtml(site.name)}</b>`,
    escapeHtml(result.reason),
    '',
    `<a href="${escapeHtml(site.url)}">Voir la page</a>`,
  ].join('\n');
}

export function errorMessage(site, failures, lastError) {
  return [
    '⚠️ <b>Surveillance en echec</b>',
    '',
    `<b>${escapeHtml(site.name)}</b>`,
    `${failures} echecs consecutifs.`,
    `Derniere erreur : <code>${escapeHtml(String(lastError).slice(0, 300))}</code>`,
    '',
    `<a href="${escapeHtml(site.url)}">Verifier la page manuellement</a>`,
  ].join('\n');
}

export function heartbeatMessage(sites, results) {
  const articles = sites.filter((s) => !s.expect);
  const temoins = sites.filter((s) => s.expect);

  const lines = ['💓 <b>Surveillance active</b>', ''];
  for (const site of articles) {
    const r = results.get(site.id);
    const icon = r?.inStock === true ? '🟢' : r?.inStock === false ? '⚪' : '❓';
    lines.push(`${icon} ${escapeHtml(site.name)}`);
  }
  lines.push('', `<i>${articles.length} article(s) surveille(s).</i>`);

  // Les temoins ne sont pas des articles a acheter : on ne les liste pas, on
  // resume leur sante. C'est la ligne qui dit si la detection marche encore.
  if (temoins.length > 0) {
    const ok = temoins.filter((s) => results.get(s.id)?.inStock === (s.expect === 'in_stock'));
    const icon = ok.length === temoins.length ? '✅' : '🧭';
    lines.push(`<i>${icon} Temoins de detection : ${ok.length}/${temoins.length} conformes.</i>`);
    for (const s of temoins.filter((t) => !ok.includes(t))) {
      lines.push(`   ⚠️ ${escapeHtml(s.name)}`);
    }
  }

  return lines.join('\n');
}

export { escapeHtml };

export function undetectableMessage(site, count, reason) {
  return [
    '🟠 <b>Site illisible</b>',
    '',
    `<b>${escapeHtml(site.name)}</b>`,
    `La page se charge mais la disponibilite n'est pas detectable (${count} passages).`,
    `Motif : ${escapeHtml(reason)}`,
    '',
    'Ce site ne te previendra pas d\'un retour en stock tant que ce n\'est pas corrige.',
    `<a href="${escapeHtml(site.url)}">Verifier la page manuellement</a>`,
  ].join('\n');
}

/**
 * Un temoin de detection a cesse de repondre comme attendu.
 *
 * Ce message ne parle pas de stock mais de fiabilite : si la detection ne sait
 * plus dire "disponible" chez un marchand, aucun retour en stock n'y sera
 * jamais signale, et rien d'autre ne le ferait savoir.
 */
export function canaryMessage(site, result, count) {
  const etat = result.inStock === true ? 'disponible'
    : result.inStock === false ? 'indisponible' : 'indetermine';

  return [
    '🧭 <b>DETECTION PEUT-ETRE CASSEE</b>',
    '',
    `Le temoin <b>${escapeHtml(site.name)}</b> devrait etre disponible en permanence.`,
    `Il est vu « ${escapeHtml(etat)} » depuis ${count} passage(s).`,
    '',
    `Motif : ${escapeHtml(result.reason)}`,
    '',
    'Deux explications : ce produit temoin est reellement parti en rupture, et il',
    'faut le remplacer ; ou la detection ne fonctionne plus chez ce marchand, et',
    'aucun retour en stock n\'y sera signale.',
    '',
    `<a href="${escapeHtml(site.url)}">Verifier la page du temoin</a>`,
  ].join('\n');
}
