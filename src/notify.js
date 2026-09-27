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

/**
 * Le message quotidien : etat des articles, sante des temoins, et resume des
 * problemes rencontres depuis la veille.
 *
 * Les problemes ne partent plus a chaud. Les murs anti-bot echouent par
 * a-coups et se remettent seuls : alerter a chaud produisait des dizaines de
 * notifications par jour, au risque de masquer la seule qui compte, celle d'un
 * retour en stock. Ici tout tient dans un message par jour.
 */
export function heartbeatMessage(sites, results, problems = []) {
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

  lines.push('', ...problemLines(problems));
  return lines.join('\n');
}

/**
 * Resume des problemes du jour, separes selon ce qu'ils demandent.
 *
 * Une fiche encore en panne au moment du resume reclame une action : c'est
 * elle qui ne signalera pas un retour en stock. Une fiche rentree dans l'ordre
 * n'est la que pour information, et ne merite pas qu'on s'y attarde.
 */
function problemLines(problems) {
  if (problems.length === 0) {
    return ['<i>✅ Aucune erreur depuis le dernier resume.</i>'];
  }

  const encore = problems.filter((p) => p.ongoing);
  const passes = problems.filter((p) => !p.ongoing);
  const lignes = [`⚠️ <b>Erreurs depuis le dernier resume</b> — ${problems.length} fiche(s)`];
  const lien = (p) => `<a href="${escapeHtml(p.url)}">${escapeHtml(p.name)}</a>`;

  if (encore.length > 0) {
    lignes.push('', `<b>Toujours en panne (${encore.length})</b> — a corriger :`);
    for (const p of encore) {
      lignes.push(`· ${lien(p)} — ${describe(p)}`);
      lignes.push(`  <code>${escapeHtml(String(p.detail).slice(0, 160))}</code>`);
    }
  }

  if (passes.length > 0) {
    lignes.push('', `<i>Rentre dans l'ordre (${passes.length}), pour information :</i>`);
    for (const p of passes) {
      lignes.push(`<i>· ${escapeHtml(p.name)} — ${describe(p)}</i>`);
    }
  }

  return lignes;
}

function describe(p) {
  const nature = p.kind === 'illisible' ? 'illisible'
    : p.kind === 'temoin' ? 'temoin non conforme'
      : 'echec';
  return `${nature}, ${p.passes} passage(s)`;
}

export { escapeHtml };

