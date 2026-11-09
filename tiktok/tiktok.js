// Статистика TikTok: вход через Login Kit (Sandbox, свой аккаунт в Target users),
// дальше воркер раз в час забирает подписчиков и показатели роликов через
// Display API и раз в день присылает сводку в Telegram.
//
// 1. Ключи приложения (Client key / Client secret) присылает workflow
//    «TikTok — передать ключи воркеру» из ai-zarabotok-sales (секреты
//    TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET) на POST /tiktok/keys.
//    Первые принятые ключи закрепляются; сменить —
//    /debug/tiktok?token=<TG_TOKEN>&reset_keys=1 и снова запустить workflow.
// 2. Владелец открывает /tiktok/connect, входит в TikTok, TikTok возвращает
//    на /tiktok/callback/. Первый вошедший аккаунт закрепляется.
// 3. Access token живёт сутки, refresh token — год; воркер продлевает сам.
//
// Scopes: user.info.basic, user.info.stats, video.list.
// Комментарии Display API не отдаёт, поэтому кодовые слова в TikTok не считаются.
//
// Открытая статистика: GET /tiktok/status (HTML) и /tiktok/status?format=json.
// Отладка: /debug/tiktok?token=<TG_TOKEN>, ?run=1 — собрать сейчас, ?report=1 — прислать отчёт.

const OAUTH = 'https://open.tiktokapis.com/v2/oauth/token/';
const API = 'https://open.tiktokapis.com/v2';
const SCOPES = 'user.info.basic,user.info.stats,video.list';
const KEYS_KEY = 'tiktok:keys';       // { client_key, client_secret }
const AUTH_KEY = 'tiktok:auth';       // { access_token, exp, refresh_token, refresh_exp, open_id, scope }
const OPENID_KEY = 'tiktok:open_id';
const STATE_KEY = 'tiktok:state';
const METRICS_KEY = 'tiktok:metrics'; // { user: {...}, videos: {id: {...}}, daily: {date: {...}} }

const LIST_EVERY_MS = 60 * 60e3;
const PAGES = 3;                       // до 60 последних роликов
const REPORT_HOUR_MSK = 21;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
const mskDate = ms => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);
const num = n => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const plus = n => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : '0');

function redirectUri(url) {
  return `${url.origin}/tiktok/callback/`;
}
async function loadState(env) {
  return { list_at: 0, report_date: '', error_notified: false, ...((await env.KV.get(STATE_KEY, 'json')) || {}) };
}
async function loadMetrics(env) {
  return { user: {}, videos: {}, daily: {}, ...((await env.KV.get(METRICS_KEY, 'json')) || {}) };
}

async function oauth(params) {
  const res = await fetch(OAUTH, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cache-control': 'no-cache' },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const err = new Error(`TikTok token: ${res.status} ${body.error || ''} ${body.error_description || ''}`.trim());
    err.auth = true;
    throw err;
  }
  const now = Date.now();
  return {
    access_token: body.access_token, exp: now + (body.expires_in || 86400) * 1000 - 300e3,
    refresh_token: body.refresh_token, refresh_exp: now + (body.refresh_expires_in || 365 * 86400) * 1000,
    open_id: body.open_id, scope: body.scope,
  };
}

async function accessToken(env) {
  const auth = await env.KV.get(AUTH_KEY, 'json');
  if (!auth) return '';
  if (auth.exp > Date.now()) return auth.access_token;
  const keys = await env.KV.get(KEYS_KEY, 'json');
  if (!keys) return '';
  const fresh = await oauth({ client_key: keys.client_key, client_secret: keys.client_secret, grant_type: 'refresh_token', refresh_token: auth.refresh_token });
  const next = { ...auth, ...fresh, open_id: fresh.open_id || auth.open_id };
  await env.KV.put(AUTH_KEY, JSON.stringify(next));
  return next.access_token;
}

async function call(token, method, path, query, json) {
  const res = await fetch(`${API}/${path}?${new URLSearchParams(query)}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) },
    ...(json ? { body: JSON.stringify(json) } : {}),
  });
  const body = await res.json().catch(() => ({}));
  const code = body?.error?.code;
  if (!res.ok || (code && code !== 'ok')) {
    const err = new Error(`TikTok ${path}: ${res.status} ${code || ''} ${body?.error?.message || ''}`.trim());
    err.auth = res.status === 401 || code === 'access_token_invalid';
    throw err;
  }
  return body.data || {};
}

async function refreshAll(token, m, now) {
  const u = (await call(token, 'GET', 'user/info/', {
    fields: 'open_id,display_name,avatar_url,follower_count,following_count,likes_count,video_count',
  })).user || {};
  m.user = {
    name: u.display_name, avatar: u.avatar_url,
    followers: u.follower_count, following: u.following_count, likes: u.likes_count, videos: u.video_count, at: now,
  };
  const day = mskDate(now);
  m.daily[day] = { followers: u.follower_count, likes: u.likes_count };
  const keys = Object.keys(m.daily).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 120))) delete m.daily[k];

  let cursor, n = 0;
  for (let page = 0; page < PAGES; page++) {
    const d = await call(token, 'POST', 'video/list/', {
      fields: 'id,title,video_description,create_time,share_url,duration,view_count,like_count,comment_count,share_count',
    }, { max_count: 20, ...(cursor ? { cursor } : {}) });
    for (const v of d.videos || []) {
      n++;
      m.videos[v.id] = {
        title: norm(v.title || v.video_description).slice(0, 140), published_at: (v.create_time || 0) * 1000,
        duration: v.duration, url: v.share_url, views: v.view_count, likes: v.like_count,
        comments: v.comment_count, shares: v.share_count, at: now,
      };
    }
    if (!d.has_more) break;
    cursor = d.cursor;
  }
  // храним не больше 100 последних роликов
  const ids = Object.keys(m.videos).sort((a, b) => m.videos[b].published_at - m.videos[a].published_at);
  for (const id of ids.slice(100)) delete m.videos[id];
  return n;
}

// Вызывается из cron "*/5 * * * *". Работает раз в час.
export async function tiktokTick(env, send, now = Date.now()) {
  if (!(await env.KV.get(AUTH_KEY))) return { skipped: 'TikTok не подключён' };
  const state = await loadState(env);
  const m = await loadMetrics(env);
  const log = [];
  if (now - state.list_at >= LIST_EVERY_MS) {
    try {
      const token = await accessToken(env);
      log.push(`роликов: ${await refreshAll(token, m, now)}, подписчиков ${m.user.followers}`);
      await env.KV.put(METRICS_KEY, JSON.stringify(m));
      state.list_at = now;
      state.error_notified = false;
    } catch (e) {
      log.push('ошибка: ' + e.message);
      state.list_at = now - LIST_EVERY_MS + 15 * 60e3; // повторим через 15 минут
      if (e.auth && !state.error_notified) {
        state.error_notified = true;
        await send(env, `⚠️ <b>TikTok:</b> доступ не работает, статистика на паузе. Откройте /tiktok/connect и войдите заново.\n<code>${esc(e.message.slice(0, 200))}</code>`);
      }
    }
  }
  const auth = await env.KV.get(AUTH_KEY, 'json');
  if (auth?.refresh_exp && auth.refresh_exp - now < 14 * 86400e3 && state.refresh_warned !== mskDate(now).slice(0, 7)) {
    state.refresh_warned = mskDate(now).slice(0, 7);
    await send(env, '⚠️ <b>TikTok:</b> вход истекает меньше чем через 2 недели. Откройте /tiktok/connect и войдите заново.');
  }
  const today = mskDate(now);
  const hourMsk = new Date(now + 3 * 3600e3).getUTCHours();
  if (hourMsk === REPORT_HOUR_MSK && state.report_date !== today && m.user.at) {
    state.report_date = today;
    await env.KV.put(STATE_KEY, JSON.stringify(state));
    await send(env, tiktokReportText(m, now), { disable_web_page_preview: true });
    log.push('отчёт отправлен');
  }
  await env.KV.put(STATE_KEY, JSON.stringify(state));
  return { log };
}

export function tiktokReportText(m, now = Date.now()) {
  const week = Object.values(m.videos).filter(v => now - v.published_at < 7 * 86400e3);
  const s = k => week.reduce((a, v) => a + (v[k] || 0), 0);
  const ago = m.daily[mskDate(now - 7 * 86400e3)];
  const top = [...week].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 3);
  const lines = [
    `🎵 <b>TikTok</b>${m.user.username ? ` @${esc(m.user.username)}` : m.user.name ? ` · ${esc(m.user.name)}` : ''}`,
    `👥 Подписчики: ${num(m.user.followers)}${ago?.followers != null ? ` (${plus(m.user.followers - ago.followers)} за неделю)` : ''}`,
    `❤️ Лайков за всё время: ${num(m.user.likes)}`,
    '',
    `<b>Ролики за 7 дней: ${week.length}</b>`,
    `👁 ${num(s('views'))} · ❤️ ${num(s('likes'))} · 💬 ${num(s('comments'))} · ↗️ ${num(s('shares'))}`,
    '',
    top.length ? '🔥 <b>Лучшие за неделю</b>' : '',
    ...top.map((v, i) => `${i + 1}. <a href="${esc(v.url || '')}">${esc((v.title || 'без подписи').slice(0, 50))}</a>\n     👁 ${num(v.views)} · ❤️ ${num(v.likes)} · 💬 ${num(v.comments)}`),
  ];
  return lines.filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n').trim();
}

// POST /tiktok/keys — ключи приложения из GitHub Actions. Первые принятые закрепляются.
export async function tiktokAcceptKeys(env, request) {
  let b = {};
  try { b = await request.json(); } catch {}
  const keys = { client_key: String(b.client_key || '').trim(), client_secret: String(b.client_secret || '').trim() };
  if (!keys.client_key || !keys.client_secret) return { status: 400, body: { ok: false, error: 'нужны client_key и client_secret' } };
  const cur = await env.KV.get(KEYS_KEY, 'json');
  if (cur && cur.client_key === keys.client_key && cur.client_secret === keys.client_secret) return { status: 200, body: { ok: true, unchanged: true } };
  if (cur) return { status: 403, body: { ok: false, error: 'ключи уже заданы; сбросить — /debug/tiktok?token=<TG_TOKEN>&reset_keys=1' } };
  // проверяем, что TikTok знает такие ключи
  try { await oauth({ client_key: keys.client_key, client_secret: keys.client_secret, grant_type: 'client_credentials' }); }
  catch (e) { if (/invalid_client|unauthorized_client/i.test(e.message)) return { status: 401, body: { ok: false, error: e.message.slice(0, 300) } }; }
  await env.KV.put(KEYS_KEY, JSON.stringify(keys));
  return { status: 200, body: { ok: true, next: 'откройте /tiktok/connect' } };
}

// GET /tiktok/connect — отправить владельца на вход в TikTok.
export async function tiktokConnect(env, url) {
  const keys = await env.KV.get(KEYS_KEY, 'json');
  if (!keys) return page('TikTok не настроен', 'Сначала запустите workflow «TikTok — передать ключи воркеру» в репозитории ai-zarabotok-sales.', 503);
  const state = crypto.randomUUID();
  await env.KV.put(`tiktok:oauth_state:${state}`, '1', { expirationTtl: 600 });
  const q = new URLSearchParams({ client_key: keys.client_key, scope: SCOPES, response_type: 'code', redirect_uri: redirectUri(url), state });
  return Response.redirect(`https://www.tiktok.com/v2/auth/authorize/?${q}`, 302);
}

// GET /tiktok/callback/ — TikTok вернул code после входа.
export async function tiktokCallback(env, send, url) {
  const p = url.searchParams;
  if (p.get('error')) return page('Вход отменён', esc(p.get('error_description') || p.get('error')), 400);
  const state = p.get('state') || '';
  if (!state || !(await env.KV.get(`tiktok:oauth_state:${state}`))) return page('Ссылка устарела', 'Откройте <a href="/tiktok/connect">/tiktok/connect</a> ещё раз.', 400);
  await env.KV.delete(`tiktok:oauth_state:${state}`);
  const keys = await env.KV.get(KEYS_KEY, 'json');
  let auth;
  try {
    auth = await oauth({ client_key: keys.client_key, client_secret: keys.client_secret, code: p.get('code') || '', grant_type: 'authorization_code', redirect_uri: redirectUri(url) });
  } catch (e) { return page('TikTok не выдал доступ', esc(e.message), 502); }
  const locked = await env.KV.get(OPENID_KEY);
  if (locked && locked !== auth.open_id) return page('Это другой аккаунт', 'Статистика уже привязана к другому аккаунту TikTok.', 403);
  await env.KV.put(AUTH_KEY, JSON.stringify(auth));
  if (!locked) await env.KV.put(OPENID_KEY, auth.open_id);
  const st = await loadState(env);
  Object.assign(st, { list_at: 0, error_notified: false });
  await env.KV.put(STATE_KEY, JSON.stringify(st));
  const missing = SCOPES.split(',').filter(s => !String(auth.scope || '').split(',').includes(s));
  await send(env, `🔑 <b>TikTok подключён</b> к воркеру. Статистику собираю раз в час, сводка — каждый день в ${REPORT_HOUR_MSK}:00.${missing.length ? `\n⚠️ Не выданы права: ${missing.join(', ')}` : ''}`);
  return page('TikTok подключён', `Статистика появится через 5–10 минут на странице <a href="/tiktok/status">/tiktok/status</a>.${missing.length ? `<br>⚠️ Не выданы права: ${esc(missing.join(', '))}` : ''}`);
}

export async function tiktokDebug(env, send, url) {
  if (url.searchParams.get('reset_keys') === '1') {
    await env.KV.delete(KEYS_KEY);
    return { ok: true, reset: 'keys' };
  }
  if (url.searchParams.get('report') === '1') {
    await send(env, tiktokReportText(await loadMetrics(env)), { disable_web_page_preview: true });
    return { ok: true, report: 'sent' };
  }
  const tick = url.searchParams.get('run') === '1' ? await tiktokTick(env, send) : null;
  const auth = await env.KV.get(AUTH_KEY, 'json');
  return {
    tick, keys: !!(await env.KV.get(KEYS_KEY)), connected: !!auth, scope: auth?.scope,
    access_exp: auth?.exp && new Date(auth.exp).toISOString(), refresh_exp: auth?.refresh_exp && new Date(auth.refresh_exp).toISOString(),
    state: await loadState(env), metrics: await loadMetrics(env),
  };
}

function page(title, html, status = 200) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;color:#141414;background:#fff}@media(prefers-color-scheme:dark){body{color:#eee;background:#111}a{color:#8fd}}h1{font-size:22px}</style>
<h1>${esc(title)}</h1><p>${html}</p>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

// GET /tiktok/status — открытая страница со статистикой. ?format=json — данные для Claude.
export async function tiktokPublicStatus(env, url) {
  const m = await loadMetrics(env);
  const rows = Object.entries(m.videos).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.published_at - a.published_at);
  if (url.searchParams.get('format') === 'json') {
    const { avatar, ...user } = m.user;
    return new Response(JSON.stringify({ user, daily: m.daily, videos: rows }, null, 2), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    });
  }
  const fmtN = n => (n == null ? '…' : Number(n).toLocaleString('ru-RU'));
  const fmtD = ms => new Date(ms + 3 * 3600e3).toISOString().slice(5, 16).replace('T', ' ').replace(/^(\d\d)-(\d\d)/, '$2.$1');
  const now = Date.now();
  const week = rows.filter(v => now - v.published_at < 7 * 86400e3);
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TikTok: аналитика</title><style>
:root{--bg:#f5f5f3;--card:#fff;--fg:#141414;--muted:#6b6b68;--line:#e5e5e1;--accent:#e11d48}
@media(prefers-color-scheme:dark){:root{--bg:#111;--card:#1c1c1c;--fg:#eee;--muted:#9a9a95;--line:#2c2c2a;--accent:#25f4ee}}
*{box-sizing:border-box}body{font:15px/1.5 system-ui,-apple-system,sans-serif;max-width:860px;margin:0 auto;padding:24px 16px 48px;color:var(--fg);background:var(--bg)}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}.sub{color:var(--muted);margin:0 0 18px;font-size:14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.kpi b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.kpi span{color:var(--muted);font-size:13px}
.wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:500;color:var(--muted)}.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
a{color:var(--accent)}.t{display:block;color:var(--muted);font-size:12px}.note{color:var(--muted);font-size:13px;margin-top:8px}</style>
<h1>TikTok: аналитика</h1>
<p class="sub">${m.user.at ? esc(m.user.username ? '@' + m.user.username : m.user.name || '') + ' · обновлено ' + fmtD(m.user.at) + ' МСК' : '❌ Не подключён — <a href="/tiktok/connect">подключить</a>'}</p>
<div class="kpis">
<div class="kpi"><b>${fmtN(m.user.followers)}</b><span>подписчиков</span></div>
<div class="kpi"><b>${fmtN(m.user.likes)}</b><span>лайков за всё время</span></div>
<div class="kpi"><b>${fmtN(week.reduce((a, v) => a + (v.views || 0), 0))}</b><span>просмотров роликов за 7 дней</span></div>
<div class="kpi"><b>${fmtN(week.length)}</b><span>роликов за 7 дней</span></div>
</div>
<h2>Ролики</h2><div class="wrap"><table><tr><th>Ролик</th><th class="n">👁</th><th class="n">❤️</th><th class="n">💬</th><th class="n">↗️</th></tr>
${rows.map(v => `<tr><td><span class="t">${fmtD(v.published_at)} · ${v.duration || '?'} с</span><a href="${esc(v.url || '')}">${esc((v.title || 'без подписи').slice(0, 70))}</a></td><td class="n">${fmtN(v.views)}</td><td class="n">${fmtN(v.likes)}</td><td class="n">${fmtN(v.comments)}</td><td class="n">${fmtN(v.shares)}</td></tr>`).join('')}
</table></div>
<p class="note">Обновляется раз в час. Комментарии TikTok через API не отдаёт, поэтому кодовые слова здесь не считаются.</p>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
