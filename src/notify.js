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
 * Un seul message pour tous les problemes d'un passage.
 *
 * Un incident chez un marchand touche ses articles en meme temps : Carrefour
 * en compte cinq. Une notification par fiche noyait le canal, au point de
 * rendre invisible la seule qui compte, celle d'un retour en stock. Ici tout
 * tient dans un message, groupe par nature de probleme.
 */
export function problemsMessage(problems) {
  const lien = (p) => `<a href="${escapeHtml(p.site.url)}">${escapeHtml(p.site.name)}</a>`;
  const echecs = problems.filter((p) => p.kind === 'echec');
  const illisibles = problems.filter((p) => p.kind === 'illisible');
  const temoins = problems.filter((p) => p.kind === 'temoin');

  const lignes = [
    `⚠️ <b>Surveillance en difficulte</b> — ${problems.length} fiche(s)`,
    '',
  ];

  if (echecs.length > 0) {
    lignes.push(`⚠️ <b>Surveillance en echec</b> (${echecs.length})`);
    for (const p of echecs) {
      lignes.push(`· ${lien(p)} — ${p.count} passages`);
      lignes.push(`  <code>${escapeHtml(String(p.detail).slice(0, 160))}</code>`);
    }
    lignes.push('');
  }

  if (illisibles.length > 0) {
    lignes.push(`🟠 <b>Site illisible</b> (${illisibles.length})`);
    for (const p of illisibles) {
      lignes.push(`· ${lien(p)} — ${p.count} passages : ${escapeHtml(p.detail)}`);
    }
    lignes.push('');
  }

  if (temoins.length > 0) {
    lignes.push(`🧭 <b>DETECTION PEUT-ETRE CASSEE</b> (${temoins.length})`);
    for (const p of temoins) {
      lignes.push(`· ${lien(p)} — vu « ${escapeHtml(p.detail)} » depuis ${p.count} passages`);
    }
    lignes.push(
      'Le temoin est cense rester disponible : soit ce produit est reellement',
      'parti en rupture et il faut le remplacer, soit la detection ne fonctionne',
      'plus chez ce marchand et aucun retour en stock n\'y sera signale.',
      '',
    );
  }

  lignes.push('Ces fiches ne signaleront pas de retour en stock tant que ce n\'est pas corrige.');
  return lignes.join('\n');
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

