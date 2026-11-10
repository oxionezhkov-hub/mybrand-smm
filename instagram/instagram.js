// Статистика Instagram: воркер раз в несколько часов забирает показатели рилсов
// и постов через Instagram API (вход через Instagram), считает комментарии
// с кодовым словом и раз в день присылает сводку в Telegram.
//
// Токен присылает workflow «Instagram — передать токен воркеру» из репозитория
// ai-zarabotok-sales (секрет INSTAGRAM_TOKEN) на POST /instagram/token.
// Воркер хранит его в KV (instagram:token) и раз в неделю продлевает сам:
// токен живёт 60 дней.
//
// Права токена: instagram_business_basic, instagram_business_manage_insights,
// instagram_business_manage_comments (без последнего не считаются кодовые слова).
//
//   INSTAGRAM_CODEWORD — кодовое слово (переменная в wrangler.toml), по умолчанию «ИИ».
//
// Открытая статистика: GET /instagram/status (HTML) и /instagram/status?format=json.
// Отладка: /debug/instagram?token=<TG_TOKEN>, ?run=1 — собрать сейчас, ?force=1 — перезапросить все публикации, ?report=1 — прислать отчёт.

const API = 'https://graph.instagram.com';        // токены IGAA… (вход через Instagram)
const FB_API = 'https://graph.facebook.com/v23.0'; // токены EAA…/EAG… (единый вход Meta, вход через Facebook)
const CONN_KEY = 'instagram:conn';                 // { base, ig_id } — куда и от чьего имени ходить
const TOKEN_KEY = 'instagram:token';
const USER_KEY = 'instagram:user_id';
const STATE_KEY = 'instagram:state';
const METRICS_KEY = 'instagram:metrics'; // { media: {id: {...}}, profile: {...}, daily: {date: {...}} }

const REFRESH_EVERY_MS = 7 * 24 * 3600e3;
const LIST_EVERY_MS = 60 * 60e3;          // список публикаций — раз в час
const FRESH_EVERY_MS = 2 * 3600e3;        // публикации младше 7 дней обновляем раз в 2 часа
const OLD_EVERY_MS = 24 * 3600e3;         // старше — раз в сутки
const OLD_AFTER_MS = 7 * 24 * 3600e3;
const TRACK_DAYS = 60;                    // публикации старше 60 дней не обновляем
const MEDIA_PER_TICK = 4;                 // по 2 запроса на публикацию: держим мало подзапросов
const REPORT_HOUR_MSK = 21;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
const mskDate = ms => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);
const num = n => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const plus = n => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : '0');

async function getToken(env) {
  return (await env.KV.get(TOKEN_KEY)) || env.INSTAGRAM_TOKEN || '';
}
async function loadState(env) {
  return { token_refreshed_at: 0, report_date: '', list_at: 0, error_notified: false, ...((await env.KV.get(STATE_KEY, 'json')) || {}) };
}
async function loadMetrics(env) {
  return { media: {}, profile: {}, daily: {}, ...((await env.KV.get(METRICS_KEY, 'json')) || {}) };
}

// conn = { token, base, acct }: acct — 'me' для токенов Instagram, id аккаунта для токенов Facebook.
async function getConn(env) {
  const token = await getToken(env);
  const c = (await env.KV.get(CONN_KEY, 'json')) || {};
  const base = c.base || API;
  return { token, base, acct: base === API ? 'me' : c.ig_id };
}

async function api(conn, path, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: conn.token });
  const res = await fetch(`${conn.base}/${path}?${qs}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const err = new Error(`Instagram ${path.split('?')[0]}: ${res.status} ${body?.error?.message || JSON.stringify(body).slice(0, 200)}`);
    err.status = res.status;
    err.code = body?.error?.code;
    throw err;
  }
  return body;
}

function codewordRe(env) {
  const w = String(env.INSTAGRAM_CODEWORD || 'ИИ').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${w}([^\\p{L}\\p{N}]|$)`, 'iu');
}

// Показатели одной публикации. Набор метрик зависит от типа, поэтому при отказе
// пробуем более короткий список.
async function mediaInsights(token, m) {
  const sets = m.media_product_type === 'REELS'
    ? ['views,reach,likes,comments,shares,saved,total_interactions,ig_reels_avg_watch_time', 'views,reach,likes,comments,shares,saved', 'reach,saved']
    : m.media_product_type === 'STORY'
      ? ['views,reach,replies,shares', 'reach']
      : ['views,reach,likes,comments,shares,saved,total_interactions', 'reach,saved'];
  let last = '';
  for (const metric of sets) {
    try {
      const r = await api(token, `${m.id}/insights`, { metric });
      const out = { insights_error: null };
      for (const x of r.data || []) out[x.name] = x.values?.[0]?.value ?? x.total_value?.value ?? 0;
      return out;
    } catch (e) {
      if (e.status === 401 || e.code === 190) throw e;
      last = e.message;
    }
  }
  return { insights_error: last.slice(0, 300) }; // видно в /instagram/status?format=json
}

async function countCodewords(token, mediaId, re) {
  let n = 0, total = 0, after = '';
  for (let page = 0; page < 3; page++) {
    const r = await api(token, `${mediaId}/comments`, { fields: 'id,text', limit: '50', ...(after ? { after } : {}) });
    for (const c of r.data || []) { total++; if (re.test(c.text || '')) n++; }
    after = r.paging?.cursors?.after;
    if (!r.paging?.next || !after) break;
  }
  return { codewords: n, comments_read: total };
}

async function maybeRefreshToken(env, state, conn, now, send) {
  if (conn.base !== API) return; // токены Facebook из кабинета так не продлеваются
  const token = conn.token;
  if (!state.token_refreshed_at) { state.token_refreshed_at = now; return; }
  if (now - state.token_refreshed_at < REFRESH_EVERY_MS) return;
  const res = await fetch(`${API}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    await send(env, `⚠️ <b>Instagram:</b> не удалось продлить токен. ${esc(body?.error?.message || res.status)}`);
    state.token_refreshed_at = now - REFRESH_EVERY_MS + 24 * 3600e3; // повторим через сутки
    return;
  }
  await env.KV.put(TOKEN_KEY, body.access_token);
  state.token_refreshed_at = now;
}

// Вызывается из cron "*/5 * * * *". Почти всегда ничего не делает: работает,
// только когда подошло время обновить список или показатели.
export async function instagramTick(env, send, now = Date.now()) {
  const conn = await getConn(env);
  if (!conn.token) return { skipped: 'нет токена Instagram' };
  if (!conn.acct) return { skipped: 'не найден аккаунт Instagram для токена' };
  const state = await loadState(env);
  const m = await loadMetrics(env);
  const log = [];
  let changed = false;

  try {
    if (now - state.list_at >= LIST_EVERY_MS) {
      const me = await api(conn, conn.acct, { fields: 'username,followers_count,follows_count,media_count' });
      m.profile = { username: me.username, followers: me.followers_count, follows: me.follows_count, media_count: me.media_count, at: now };
      const day = mskDate(now);
      m.daily[day] = { ...(m.daily[day] || {}), followers: me.followers_count };
      const keys = Object.keys(m.daily).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - 120))) delete m.daily[k];

      const r = await api(conn, `${conn.acct}/media`, {
        fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url',
        limit: '50',
      });
      for (const x of r.data || []) {
        const prev = m.media[x.id] || {};
        m.media[x.id] = {
          ...prev,
          caption: norm(x.caption).slice(0, 140), type: x.media_product_type || x.media_type, permalink: x.permalink,
          published_at: Date.parse(x.timestamp), likes: x.like_count ?? prev.likes, comments: x.comments_count ?? prev.comments,
        };
      }
      state.list_at = now;
      changed = true;
      log.push(`список: ${(r.data || []).length} публикаций, подписчиков ${me.followers_count}`);
    }

    const re = codewordRe(env);
    const due = Object.entries(m.media)
      .filter(([, v]) => now - v.published_at < TRACK_DAYS * 24 * 3600e3)
      .filter(([, v]) => now - (v.at || 0) >= (now - v.published_at < OLD_AFTER_MS ? FRESH_EVERY_MS : OLD_EVERY_MS))
      .sort((a, b) => (a[1].at || 0) - (b[1].at || 0))
      .slice(0, MEDIA_PER_TICK);
    for (const [id, v] of due) {
      const ins = await mediaInsights(conn, { id, media_product_type: v.type });
      let cw = {};
      if (v.type !== 'STORY' && (v.comments || 0) > 0) {
        try { cw = { ...(await countCodewords(conn, id, re)), comments_error: null }; } catch (e) { cw = { comments_error: e.message.slice(0, 300) }; log.push(`${id}: комментарии — ${e.message}`); }
      } else cw = { codewords: 0 };
      m.media[id] = { ...v, ...(ins || {}), ...cw, at: now };
      changed = true;
    }
    if (due.length) log.push(`обновлено публикаций: ${due.length}`);
    state.error_notified = false;
  } catch (e) {
    log.push('ошибка: ' + e.message);
    if ((e.status === 401 || e.code === 190) && !state.error_notified) {
      state.error_notified = true;
      await send(env, `⚠️ <b>Instagram:</b> токен не работает, статистика на паузе. Выпустите новый токен, обновите секрет INSTAGRAM_TOKEN и запустите workflow «Instagram — передать токен воркеру».\n<code>${esc(e.message.slice(0, 200))}</code>`);
    }
  }

  if (changed) await env.KV.put(METRICS_KEY, JSON.stringify(m));
  await maybeRefreshToken(env, state, conn, now, send);

  const today = mskDate(now);
  const hourMsk = new Date(now + 3 * 3600e3).getUTCHours();
  if (hourMsk === REPORT_HOUR_MSK && state.report_date !== today && m.profile.at) {
    state.report_date = today;
    await env.KV.put(STATE_KEY, JSON.stringify(state));
    await send(env, instagramReportText(env, m, state, now), { disable_web_page_preview: true });
    log.push('отчёт отправлен');
  }
  await env.KV.put(STATE_KEY, JSON.stringify(state));
  return { log };
}

function summarize(list) {
  const s = k => list.reduce((a, x) => a + (x[k] || 0), 0);
  return { n: list.length, views: s('views'), reach: s('reach'), likes: s('likes'), comments: s('comments'), shares: s('shares'), saved: s('saved'), codewords: s('codewords') };
}

export function instagramReportText(env, m, state, now = Date.now()) {
  const word = String(env.INSTAGRAM_CODEWORD || 'ИИ').trim();
  const all = Object.values(m.media).filter(x => x.type !== 'STORY');
  const week = all.filter(x => now - x.published_at < 7 * 24 * 3600e3);
  const w = summarize(week);
  const t = summarize(all);
  const weekAgo = m.daily[mskDate(now - 7 * 24 * 3600e3)]?.followers;
  const top = [...week].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 3);
  const lines = [
    `📸 <b>Instagram</b>${m.profile.username ? ` @${esc(m.profile.username)}` : ''}`,
    `👥 Подписчики: ${num(m.profile.followers)}${weekAgo != null ? ` (${plus(m.profile.followers - weekAgo)} за неделю)` : ''}`,
    '',
    `<b>Публикации за 7 дней: ${w.n}</b>`,
    `👁 Просмотры: ${num(w.views)} · охват ${num(w.reach)}`,
    `❤️ ${num(w.likes)} · 💬 ${num(w.comments)} · ↗️ ${num(w.shares)} · 🔖 ${num(w.saved)}`,
    `🔑 Кодовое слово «${esc(word)}»: ${num(w.codewords)}`,
    '',
    top.length ? '🔥 <b>Лучшие за неделю</b>' : '',
    ...top.map((x, i) => `${i + 1}. <a href="${esc(x.permalink || '')}">${esc((x.caption || 'без подписи').slice(0, 50))}</a>\n     👁 ${num(x.views)} · ❤️ ${num(x.likes)} · 💬 ${num(x.comments)} · 🔑 ${num(x.codewords)}`),
    '',
    `За ${TRACK_DAYS} дней — публикаций: ${t.n}, просмотров: ${num(t.views)}, кодовых слов: ${num(t.codewords)}.`,
  ];
  return lines.filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n').trim();
}

export async function instagramDebug(env, send, url) {
  if (url.searchParams.get('report') === '1') {
    const m = await loadMetrics(env);
    await send(env, instagramReportText(env, m, await loadState(env)), { disable_web_page_preview: true });
    return { ok: true, report: 'sent' };
  }
  if (url.searchParams.get('force') === '1') { // перезапросить статистику всех публикаций
    const m = await loadMetrics(env);
    for (const v of Object.values(m.media)) v.at = 0;
    await env.KV.put(METRICS_KEY, JSON.stringify(m));
    const st = await loadState(env);
    st.list_at = 0;
    await env.KV.put(STATE_KEY, JSON.stringify(st));
  }
  const tick = url.searchParams.get('run') === '1' ? await instagramTick(env, send) : null;
  const state = await loadState(env);
  return { tick, connected: !!(await getToken(env)), token_refreshed_at: state.token_refreshed_at, list_at: state.list_at, metrics: await loadMetrics(env) };
}

// Определить, какой это токен и к какому аккаунту Instagram он относится.
// Токен Instagram (IG…) — graph.instagram.com/me. Токен Facebook (EA…) —
// graph.facebook.com: аккаунт по ig_user_id, иначе сам /me, иначе через страницы.
async function discover(token, igUserId) {
  if (/^IG/.test(token)) {
    const me = await api({ token, base: API }, 'me', { fields: 'user_id,username' });
    return { base: API, ig_id: String(me.user_id), username: me.username };
  }
  const fb = { token, base: FB_API };
  const errors = [];
  if (igUserId) {
    try {
      const u = await api(fb, igUserId, { fields: 'id,username' });
      if (u.username) return { base: FB_API, ig_id: String(u.id), username: u.username };
    } catch (e) { errors.push(e.message); }
  }
  try {
    const u = await api(fb, 'me', { fields: 'id,username' });
    if (u.username) return { base: FB_API, ig_id: String(u.id), username: u.username };
  } catch (e) { errors.push(e.message); }
  try {
    const r = await api(fb, 'me/accounts', { fields: 'instagram_business_account{id,username}', limit: '50' });
    const ig = (r.data || []).map(p => p.instagram_business_account).find(Boolean);
    if (ig) return { base: FB_API, ig_id: String(ig.id), username: ig.username };
    errors.push('у страниц Facebook нет связанного Instagram');
  } catch (e) { errors.push(e.message); }
  throw new Error(errors.join(' | '));
}

// POST /instagram/token — принять токен (его присылает GitHub Actions из секрета).
// Первый принятый токен закрепляет аккаунт: дальше принимаются только токены этого же аккаунта.
export async function instagramAcceptToken(env, send, request) {
  let token = '', igUserId = '';
  try {
    const ct = request.headers.get('content-type') || '';
    const b = ct.includes('json') ? await request.json() : Object.fromEntries(await request.formData());
    token = b.token;
    igUserId = String(b.ig_user_id || '').trim();
  } catch {}
  token = String(token || '').trim();
  if (!token) return { status: 400, body: { ok: false, error: 'нет token' } };
  let me;
  try { me = await discover(token, igUserId); }
  catch (e) { return { status: 401, body: { ok: false, error: 'Instagram не принял токен: ' + e.message.slice(0, 300) } }; }
  const locked = await env.KV.get(USER_KEY);
  if (locked && locked !== String(me.ig_id)) return { status: 403, body: { ok: false, error: 'токен другого аккаунта' } };
  await env.KV.put(TOKEN_KEY, token);
  await env.KV.put(CONN_KEY, JSON.stringify({ base: me.base, ig_id: me.ig_id }));
  if (!locked) await env.KV.put(USER_KEY, String(me.ig_id));
  const state = await loadState(env);
  state.token_refreshed_at = Date.now();
  state.list_at = 0; // сразу собрать статистику на ближайшем тике
  // новый токен — перезапросить статистику всех публикаций, не дожидаясь их очереди
  const m = await loadMetrics(env);
  for (const v of Object.values(m.media)) v.at = 0;
  await env.KV.put(METRICS_KEY, JSON.stringify(m));
  state.error_notified = false;
  await env.KV.put(STATE_KEY, JSON.stringify(state));
  await send(env, `🔑 <b>Instagram подключён</b> к воркеру: @${esc(me.username)}. Статистику собираю сам, сводка — каждый день в ${REPORT_HOUR_MSK}:00.`);
  return { status: 200, body: { ok: true, username: me.username } };
}

// GET /instagram/status — открытая страница со статистикой опубликованного
// (то же видно в самом Instagram). ?format=json — данные для Claude.
export async function instagramPublicStatus(env, url) {
  const m = await loadMetrics(env);
  const word = String(env.INSTAGRAM_CODEWORD || 'ИИ').trim();
  const rows = Object.entries(m.media).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.published_at - a.published_at);
  if (url.searchParams.get('format') === 'json') {
    return new Response(JSON.stringify({ codeword: word, profile: m.profile, daily: m.daily, media: rows }, null, 2), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    });
  }
  const fmtN = n => (n == null ? '…' : Number(n).toLocaleString('ru-RU'));
  const fmtD = ms => new Date(ms + 3 * 3600e3).toISOString().slice(5, 16).replace('T', ' ').replace(/^(\d\d)-(\d\d)/, '$2.$1');
  const now = Date.now();
  const w = summarize(rows.filter(x => x.type !== 'STORY' && now - x.published_at < 7 * 24 * 3600e3));
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Instagram: аналитика</title><style>
:root{--bg:#f5f5f3;--card:#fff;--fg:#141414;--muted:#6b6b68;--line:#e5e5e1;--accent:#c13584}
@media(prefers-color-scheme:dark){:root{--bg:#111;--card:#1c1c1c;--fg:#eee;--muted:#9a9a95;--line:#2c2c2a;--accent:#ff6fb5}}
*{box-sizing:border-box}body{font:15px/1.5 system-ui,-apple-system,sans-serif;max-width:860px;margin:0 auto;padding:24px 16px 48px;color:var(--fg);background:var(--bg)}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}.sub{color:var(--muted);margin:0 0 18px;font-size:14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.kpi b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.kpi span{color:var(--muted);font-size:13px}
.wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:500;color:var(--muted)}.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
a{color:var(--accent)}.t{display:block;color:var(--muted);font-size:12px}.note{color:var(--muted);font-size:13px;margin-top:8px}</style>
<h1>Instagram: аналитика</h1>
<p class="sub">${m.profile.username ? '@' + esc(m.profile.username) : '❌ Токен не подключён'} · обновлено ${m.profile.at ? fmtD(m.profile.at) + ' МСК' : '—'}</p>
<div class="kpis">
<div class="kpi"><b>${fmtN(m.profile.followers)}</b><span>подписчиков</span></div>
<div class="kpi"><b>${fmtN(w.views)}</b><span>просмотров за 7 дней</span></div>
<div class="kpi"><b>${fmtN(w.n)}</b><span>публикаций за 7 дней</span></div>
<div class="kpi"><b>${fmtN(w.codewords)}</b><span>кодовых слов «${esc(word)}» за 7 дней</span></div>
</div>
<h2>Публикации</h2><div class="wrap"><table><tr><th>Публикация</th><th class="n">👁</th><th class="n">Охват</th><th class="n">❤️</th><th class="n">💬</th><th class="n">↗️</th><th class="n">🔖</th><th class="n">🔑</th></tr>
${rows.map(x => `<tr><td><span class="t">${fmtD(x.published_at)} · ${esc(x.type || '')}</span><a href="${esc(x.permalink || '')}">${esc((x.caption || 'без подписи').slice(0, 70))}</a></td><td class="n">${fmtN(x.views)}</td><td class="n">${fmtN(x.reach)}</td><td class="n">${fmtN(x.likes)}</td><td class="n">${fmtN(x.comments)}</td><td class="n">${fmtN(x.shares)}</td><td class="n">${fmtN(x.saved)}</td><td class="n">${fmtN(x.codewords)}</td></tr>`).join('')}
</table></div>
<p class="note">Свежие публикации обновляются раз в 2 часа, старше недели — раз в сутки. 🔑 — комментарии с кодовым словом «${esc(word)}».</p>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
