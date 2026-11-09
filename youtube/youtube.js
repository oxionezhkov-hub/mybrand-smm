// Статистика YouTube: воркер сам собирает показатели роликов канала (Shorts и
// обычных), досмотры и подписки из YouTube Analytics, считает комментарии
// с кодовым словом и раз в день присылает сводку в Telegram.
//
// Ключи присылает workflow «YouTube — передать ключи воркеру» из репозитория
// ai-zarabotok-sales (секреты YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN)
// на POST /youtube/token. Воркер хранит их в KV (youtube:creds) и сам получает
// короткие access-токены. Первый принятый набор закрепляет канал.
//
// Права: youtube.readonly, yt-analytics.readonly (youtube.upload и
// youtube.force-ssl здесь не используются).
//
//   YOUTUBE_CODEWORD — кодовое слово (wrangler.toml), по умолчанию берётся
//                      INSTAGRAM_CODEWORD, иначе «ИИ».
//
// Открытая статистика: GET /youtube/status (HTML) и /youtube/status?format=json.
// Отладка: /debug/youtube?token=<TG_TOKEN>, ?run=1 — собрать сейчас, ?report=1 — прислать отчёт.

const DATA_API = 'https://www.googleapis.com/youtube/v3';
const ANALYTICS_API = 'https://youtubeanalytics.googleapis.com/v2/reports';
const CREDS_KEY = 'youtube:creds';       // { client_id, client_secret, refresh_token }
const ACCESS_KEY = 'youtube:access';     // { token, exp }
const CHANNEL_KEY = 'youtube:channel_id';
const STATE_KEY = 'youtube:state';
const METRICS_KEY = 'youtube:metrics';   // { channel: {...}, videos: {id: {...}}, daily: {date: {...}} }

const LIST_EVERY_MS = 60 * 60e3;          // список роликов и счётчики — раз в час
const ANALYTICS_EVERY_MS = 6 * 3600e3;    // досмотры и подписки — раз в 6 часов (данные YouTube отстают на 1–2 дня)
const COMMENTS_FRESH_MS = 2 * 3600e3;     // комментарии свежих роликов — раз в 2 часа
const COMMENTS_OLD_MS = 24 * 3600e3;
const OLD_AFTER_MS = 7 * 24 * 3600e3;
const TRACK_DAYS = 60;
const COMMENTS_PER_TICK = 4;
const SHORTS_MAX_SEC = 180;
const REPORT_HOUR_MSK = 21;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
const mskDate = ms => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);
const num = n => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const plus = n => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : '0');

function isoDurationSec(d) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || '');
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
}
function codeword(env) {
  return String(env.YOUTUBE_CODEWORD || env.INSTAGRAM_CODEWORD || 'ИИ').trim();
}
function codewordRe(env) {
  const w = codeword(env).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${w}([^\\p{L}\\p{N}]|$)`, 'iu');
}
async function loadState(env) {
  return { list_at: 0, analytics_at: 0, report_date: '', error_notified: false, ...((await env.KV.get(STATE_KEY, 'json')) || {}) };
}
async function loadMetrics(env) {
  return { channel: {}, videos: {}, daily: {}, ...((await env.KV.get(METRICS_KEY, 'json')) || {}) };
}

async function exchange(creds) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: creds.client_id, client_secret: creds.client_secret, refresh_token: creds.refresh_token, grant_type: 'refresh_token' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const err = new Error(`Google token: ${res.status} ${body.error || ''} ${body.error_description || ''}`.trim());
    err.auth = true;
    throw err;
  }
  return { token: body.access_token, exp: Date.now() + (body.expires_in || 3600) * 1000 - 120e3 };
}

async function accessToken(env) {
  const cached = await env.KV.get(ACCESS_KEY, 'json');
  if (cached?.token && cached.exp > Date.now()) return cached.token;
  const creds = await env.KV.get(CREDS_KEY, 'json');
  if (!creds) return '';
  const a = await exchange(creds);
  await env.KV.put(ACCESS_KEY, JSON.stringify(a));
  return a.token;
}

async function get(token, base, params) {
  const res = await fetch(`${base}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`YouTube ${base.split('/').pop()}: ${res.status} ${body?.error?.message || JSON.stringify(body).slice(0, 200)}`);
    err.status = res.status;
    err.auth = res.status === 401;
    throw err;
  }
  return body;
}

async function refreshList(token, m, now) {
  const ch = (await get(token, `${DATA_API}/channels`, { part: 'snippet,statistics,contentDetails', mine: 'true' })).items?.[0];
  if (!ch) throw new Error('YouTube: у аккаунта нет канала');
  const st = ch.statistics || {};
  m.channel = {
    id: ch.id, title: ch.snippet?.title, subscribers: +st.subscriberCount || 0, views: +st.viewCount || 0,
    videos: +st.videoCount || 0, uploads: ch.contentDetails?.relatedPlaylists?.uploads, at: now,
  };
  const day = mskDate(now);
  m.daily[day] = { ...(m.daily[day] || {}), subscribers: m.channel.subscribers, views: m.channel.views };
  const keys = Object.keys(m.daily).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 120))) delete m.daily[k];

  const pl = await get(token, `${DATA_API}/playlistItems`, { part: 'contentDetails', playlistId: m.channel.uploads, maxResults: '50' });
  const ids = (pl.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);
  if (!ids.length) return 0;
  const vs = await get(token, `${DATA_API}/videos`, { part: 'snippet,statistics,contentDetails,status', id: ids.join(','), maxResults: '50' });
  for (const v of vs.items || []) {
    const prev = m.videos[v.id] || {};
    const sec = isoDurationSec(v.contentDetails?.duration);
    m.videos[v.id] = {
      ...prev,
      title: norm(v.snippet?.title).slice(0, 140),
      published_at: Date.parse(v.snippet?.publishedAt),
      duration: sec,
      short: sec > 0 && sec <= SHORTS_MAX_SEC,
      privacy: v.status?.privacyStatus,
      views: +v.statistics?.viewCount || 0,
      likes: +v.statistics?.likeCount || 0,
      comments: +v.statistics?.commentCount || 0,
      url: sec > 0 && sec <= SHORTS_MAX_SEC ? `https://youtube.com/shorts/${v.id}` : `https://youtu.be/${v.id}`,
    };
  }
  return ids.length;
}

async function refreshAnalytics(token, m, now) {
  const ids = Object.entries(m.videos)
    .filter(([, v]) => now - v.published_at < TRACK_DAYS * 24 * 3600e3)
    .map(([id]) => id);
  if (!ids.length) return 0;
  const r = await get(token, ANALYTICS_API, {
    ids: 'channel==MINE', startDate: '2005-01-01', endDate: mskDate(now),
    metrics: 'views,averageViewDuration,averageViewPercentage,subscribersGained,shares',
    dimensions: 'video', filters: `video==${ids.join(',')}`, sort: '-views', maxResults: '200',
  });
  const cols = (r.columnHeaders || []).map(c => c.name);
  for (const row of r.rows || []) {
    const o = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
    const v = m.videos[o.video];
    if (!v) continue;
    v.avg_view_sec = o.averageViewDuration;
    v.avg_view_pct = o.averageViewPercentage;
    v.subs_gained = o.subscribersGained;
    v.shares = o.shares;
    v.analytics_at = now;
  }
  return (r.rows || []).length;
}

async function countCodewords(token, videoId, re) {
  let n = 0, total = 0, pageToken = '';
  for (let page = 0; page < 3; page++) {
    const r = await get(token, `${DATA_API}/commentThreads`, {
      part: 'snippet', videoId, maxResults: '100', textFormat: 'plainText', ...(pageToken ? { pageToken } : {}),
    });
    for (const t of r.items || []) {
      total++;
      if (re.test(t.snippet?.topLevelComment?.snippet?.textOriginal || '')) n++;
    }
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  return { codewords: n, comments_read: total };
}

// Вызывается из cron "*/5 * * * *". Работает, только когда подошло время обновить данные.
export async function youtubeTick(env, send, now = Date.now()) {
  if (!(await env.KV.get(CREDS_KEY))) return { skipped: 'нет ключей YouTube' };
  const state = await loadState(env);
  const m = await loadMetrics(env);
  const log = [];
  let changed = false;
  try {
    const token = await accessToken(env);
    if (now - state.list_at >= LIST_EVERY_MS) {
      log.push(`список: ${await refreshList(token, m, now)} роликов, подписчиков ${m.channel.subscribers}`);
      state.list_at = now;
      changed = true;
    }
    if (now - state.analytics_at >= ANALYTICS_EVERY_MS && Object.keys(m.videos).length) {
      try { log.push(`аналитика: ${await refreshAnalytics(token, m, now)} роликов`); }
      catch (e) { if (e.auth) throw e; log.push('аналитика: ' + e.message); }
      state.analytics_at = now;
      changed = true;
    }
    const re = codewordRe(env);
    const due = Object.entries(m.videos)
      .filter(([, v]) => v.comments > 0 && now - v.published_at < TRACK_DAYS * 24 * 3600e3)
      .filter(([, v]) => v.comments !== v.comments_seen || now - (v.comments_at || 0) >= (now - v.published_at < OLD_AFTER_MS ? COMMENTS_FRESH_MS : COMMENTS_OLD_MS))
      .filter(([, v]) => now - (v.comments_at || 0) >= 30 * 60e3)
      .sort((a, b) => (a[1].comments_at || 0) - (b[1].comments_at || 0))
      .slice(0, COMMENTS_PER_TICK);
    for (const [id, v] of due) {
      try { Object.assign(v, await countCodewords(token, id, re)); }
      catch (e) { if (e.auth) throw e; log.push(`${id}: комментарии — ${e.message}`); }
      v.comments_at = now;
      v.comments_seen = v.comments;
      changed = true;
    }
    if (due.length) log.push(`комментарии: ${due.length} роликов`);
    state.error_notified = false;
  } catch (e) {
    log.push('ошибка: ' + e.message);
    if (e.auth && !state.error_notified) {
      state.error_notified = true;
      await send(env, `⚠️ <b>YouTube:</b> Google не пускает по ключам, статистика на паузе. Получите новый refresh token в OAuth Playground, обновите секрет YT_REFRESH_TOKEN и запустите workflow «YouTube — передать ключи воркеру».\n<code>${esc(e.message.slice(0, 200))}</code>`);
    }
  }
  if (changed) await env.KV.put(METRICS_KEY, JSON.stringify(m));

  const today = mskDate(now);
  const hourMsk = new Date(now + 3 * 3600e3).getUTCHours();
  if (hourMsk === REPORT_HOUR_MSK && state.report_date !== today && m.channel.at) {
    state.report_date = today;
    await env.KV.put(STATE_KEY, JSON.stringify(state));
    await send(env, youtubeReportText(env, m, now), { disable_web_page_preview: true });
    log.push('отчёт отправлен');
  }
  await env.KV.put(STATE_KEY, JSON.stringify(state));
  return { log };
}

function summarize(list) {
  const s = k => list.reduce((a, x) => a + (x[k] || 0), 0);
  return { n: list.length, views: s('views'), likes: s('likes'), comments: s('comments'), shares: s('shares'), subs: s('subs_gained'), codewords: s('codewords') };
}

export function youtubeReportText(env, m, now = Date.now()) {
  const vids = Object.values(m.videos).filter(v => v.privacy !== 'private');
  const week = vids.filter(v => now - v.published_at < 7 * 24 * 3600e3);
  const w = summarize(week);
  const ago = m.daily[mskDate(now - 7 * 24 * 3600e3)];
  const top = [...week].sort((a, b) => b.views - a.views).slice(0, 3);
  const lines = [
    `▶️ <b>YouTube</b>${m.channel.title ? ` · ${esc(m.channel.title)}` : ''}`,
    `👥 Подписчики: ${num(m.channel.subscribers)}${ago?.subscribers != null ? ` (${plus(m.channel.subscribers - ago.subscribers)} за неделю)` : ''}`,
    `👁 Просмотры канала: ${num(m.channel.views)}${ago?.views != null ? ` (${plus(m.channel.views - ago.views)} за неделю)` : ''}`,
    '',
    `<b>Ролики за 7 дней: ${w.n}</b>`,
    `👁 ${num(w.views)} · 👍 ${num(w.likes)} · 💬 ${num(w.comments)} · ↗️ ${num(w.shares)}`,
    `➕ Подписок с роликов: ${num(w.subs)}`,
    `🔑 Кодовое слово «${esc(codeword(env))}»: ${num(w.codewords)}`,
    '',
    top.length ? '🔥 <b>Лучшие за неделю</b>' : '',
    ...top.map((v, i) => `${i + 1}. <a href="${esc(v.url)}">${esc(v.title.slice(0, 50))}</a>\n     👁 ${num(v.views)} · 👍 ${num(v.likes)} · 💬 ${num(v.comments)}${v.avg_view_pct != null ? ` · досмотр ${Math.round(v.avg_view_pct)}%` : ''} · 🔑 ${num(v.codewords)}`),
    '',
    '<i>Досмотры и подписки YouTube отдаёт с задержкой 1–2 дня.</i>',
  ];
  return lines.filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n').trim();
}

export async function youtubeDebug(env, send, url) {
  if (url.searchParams.get('report') === '1') {
    await send(env, youtubeReportText(env, await loadMetrics(env)), { disable_web_page_preview: true });
    return { ok: true, report: 'sent' };
  }
  const tick = url.searchParams.get('run') === '1' ? await youtubeTick(env, send) : null;
  const state = await loadState(env);
  return { tick, connected: !!(await env.KV.get(CREDS_KEY)), state, metrics: await loadMetrics(env) };
}

// POST /youtube/token — принять ключи { client_id, client_secret, refresh_token }.
// Проверяет их у Google, первый принятый набор закрепляет канал.
export async function youtubeAcceptToken(env, send, request) {
  let b = {};
  try { b = await request.json(); } catch {}
  const creds = { client_id: String(b.client_id || '').trim(), client_secret: String(b.client_secret || '').trim(), refresh_token: String(b.refresh_token || '').trim() };
  if (!creds.client_id || !creds.client_secret || !creds.refresh_token) return { status: 400, body: { ok: false, error: 'нужны client_id, client_secret и refresh_token' } };
  let a, ch;
  try {
    a = await exchange(creds);
    ch = (await get(a.token, `${DATA_API}/channels`, { part: 'snippet', mine: 'true' })).items?.[0];
  } catch (e) { return { status: 401, body: { ok: false, error: e.message.slice(0, 300) } }; }
  if (!ch) return { status: 404, body: { ok: false, error: 'у этого Google-аккаунта нет канала (возможно, при входе выбран не тот канал)' } };
  const locked = await env.KV.get(CHANNEL_KEY);
  if (locked && locked !== ch.id) return { status: 403, body: { ok: false, error: 'ключи другого канала' } };
  await env.KV.put(CREDS_KEY, JSON.stringify(creds));
  await env.KV.put(ACCESS_KEY, JSON.stringify(a));
  if (!locked) await env.KV.put(CHANNEL_KEY, ch.id);
  const state = await loadState(env);
  Object.assign(state, { list_at: 0, analytics_at: 0, error_notified: false });
  await env.KV.put(STATE_KEY, JSON.stringify(state));
  await send(env, `🔑 <b>YouTube подключён</b> к воркеру: ${esc(ch.snippet?.title || ch.id)}. Статистику собираю сам, сводка — каждый день в ${REPORT_HOUR_MSK}:00.`);
  return { status: 200, body: { ok: true, channel: ch.snippet?.title } };
}

// GET /youtube/status — открытая страница со статистикой публичных роликов. ?format=json — данные для Claude.
export async function youtubePublicStatus(env, url) {
  const m = await loadMetrics(env);
  const rows = Object.entries(m.videos).map(([id, v]) => ({ id, ...v })).filter(v => v.privacy !== 'private')
    .sort((a, b) => b.published_at - a.published_at);
  if (url.searchParams.get('format') === 'json') {
    const { uploads, ...channel } = m.channel;
    return new Response(JSON.stringify({ codeword: codeword(env), channel, daily: m.daily, videos: rows }, null, 2), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    });
  }
  const fmtN = n => (n == null ? '…' : Number(n).toLocaleString('ru-RU'));
  const fmtD = ms => new Date(ms + 3 * 3600e3).toISOString().slice(5, 16).replace('T', ' ').replace(/^(\d\d)-(\d\d)/, '$2.$1');
  const now = Date.now();
  const w = summarize(rows.filter(v => now - v.published_at < 7 * 24 * 3600e3));
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>YouTube: аналитика</title><style>
:root{--bg:#f5f5f3;--card:#fff;--fg:#141414;--muted:#6b6b68;--line:#e5e5e1;--accent:#cc0000}
@media(prefers-color-scheme:dark){:root{--bg:#111;--card:#1c1c1c;--fg:#eee;--muted:#9a9a95;--line:#2c2c2a;--accent:#ff5c5c}}
*{box-sizing:border-box}body{font:15px/1.5 system-ui,-apple-system,sans-serif;max-width:900px;margin:0 auto;padding:24px 16px 48px;color:var(--fg);background:var(--bg)}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}.sub{color:var(--muted);margin:0 0 18px;font-size:14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.kpi b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.kpi span{color:var(--muted);font-size:13px}
.wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:500;color:var(--muted)}.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
a{color:var(--accent)}.t{display:block;color:var(--muted);font-size:12px}.note{color:var(--muted);font-size:13px;margin-top:8px}</style>
<h1>YouTube: аналитика</h1>
<p class="sub">${m.channel.title ? esc(m.channel.title) : '❌ Ключи не подключены'} · обновлено ${m.channel.at ? fmtD(m.channel.at) + ' МСК' : '—'}</p>
<div class="kpis">
<div class="kpi"><b>${fmtN(m.channel.subscribers)}</b><span>подписчиков</span></div>
<div class="kpi"><b>${fmtN(m.channel.views)}</b><span>просмотров канала</span></div>
<div class="kpi"><b>${fmtN(w.views)}</b><span>просмотров роликов за 7 дней</span></div>
<div class="kpi"><b>${fmtN(w.codewords)}</b><span>кодовых слов «${esc(codeword(env))}» за 7 дней</span></div>
</div>
<h2>Ролики</h2><div class="wrap"><table><tr><th>Ролик</th><th class="n">👁</th><th class="n">👍</th><th class="n">💬</th><th class="n">↗️</th><th class="n">Досмотр</th><th class="n">➕</th><th class="n">🔑</th></tr>
${rows.map(v => `<tr><td><span class="t">${fmtD(v.published_at)} · ${v.short ? 'Shorts' : 'видео'} · ${v.duration} с</span><a href="${esc(v.url)}">${esc(v.title.slice(0, 70))}</a></td><td class="n">${fmtN(v.views)}</td><td class="n">${fmtN(v.likes)}</td><td class="n">${fmtN(v.comments)}</td><td class="n">${fmtN(v.shares)}</td><td class="n">${v.avg_view_pct != null ? Math.round(v.avg_view_pct) + '%' : '…'}</td><td class="n">${fmtN(v.subs_gained)}</td><td class="n">${fmtN(v.codewords)}</td></tr>`).join('')}
</table></div>
<p class="note">Просмотры и лайки обновляются раз в час, досмотр и подписки (➕) — раз в 6 часов, YouTube отдаёт их с задержкой 1–2 дня. 🔑 — комментарии с кодовым словом.</p>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
