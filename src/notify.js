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

export function backInStockMessage(site, result) {
  const lines = [
    '🟢 <b>DE NOUVEAU EN STOCK</b>',
    '',
    `<b>${escapeHtml(site.name)}</b>`,
  ];
  if (result.price) lines.push(`Prix : ${escapeHtml(result.price)} ${escapeHtml(site.currency ?? '€')}`);
  lines.push(`Detecte via : ${escapeHtml(result.reason)}`);
  lines.push('', `<a href="${escapeHtml(site.url)}">Ouvrir la page produit</a>`);
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
  const lines = ['💓 <b>Surveillance active</b>', ''];
  for (const site of sites) {
    const r = results.get(site.id);
    const icon = r?.inStock === true ? '🟢' : r?.inStock === false ? '⚪' : '❓';
    lines.push(`${icon} ${escapeHtml(site.name)}`);
  }
  lines.push('', `<i>${sites.length} article(s) surveille(s).</i>`);
  return lines.join('\n');
}

export { escapeHtml };
