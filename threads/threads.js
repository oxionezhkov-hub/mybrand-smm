// Автопостинг в Threads: воркер сам публикует посты из threads/queue.json,
// хранит статусы в KV и пишет отчёты в Telegram.
//
// Секрет THREADS_TOKEN — долгоживущий токен Threads. Воркер раз в неделю
// продлевает его сам и хранит свежий в KV (ключ threads:token).

import QUEUE from './queue.json';

const API = 'https://graph.threads.net/v1.0';
const MAX_LATE_MS = 3 * 60 * 60 * 1000;      // опоздал больше чем на 3 часа — не публикуем
const REFRESH_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const REPORT_HOUR_MSK = 22;
const STATE_KEY = 'threads:state';
const TOKEN_KEY = 'threads:token';
const USER_KEY = 'threads:user_id';
const METRICS_KEY = 'threads:metrics';   // { posts: {id: {views,likes,replies,reposts,quotes,at}}, profile: {...}, daily: {date: {followers}} }
const METRICS_BATCH = 8;                  // постов за один тик: держим мало подзапросов на вызов
const METRICS_EVERY_MS = 20 * 60 * 1000;  // один и тот же пост обновляем не чаще раза в 20 минут

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
const mskTime = iso => new Date(new Date(iso).getTime() + 3 * 3600e3).toISOString().slice(11, 16);
const mskDate = ms => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);

async function loadState(env) {
  return (await env.KV.get(STATE_KEY, 'json')) || { posts: {}, report_date: '', token_refreshed_at: 0 };
}
async function saveState(env, state) {
  await env.KV.put(STATE_KEY, JSON.stringify(state));
}
async function getToken(env) {
  return (await env.KV.get(TOKEN_KEY)) || env.THREADS_TOKEN || '';
}

async function api(token, method, path, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(method === 'GET' ? `${API}/${path}?${qs}` : `${API}/${path}`, {
    method,
    ...(method === 'POST' ? { body: qs, headers: { 'content-type': 'application/x-www-form-urlencoded' } } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Threads ${path}: ${res.status} ${body?.error?.message || JSON.stringify(body).slice(0, 200)}`);
  return body;
}

async function publishText(token, text) {
  const { id: creation } = await api(token, 'POST', 'me/threads', { media_type: 'TEXT', text });
  await new Promise(r => setTimeout(r, 3000)); // Meta советует подождать обработку контейнера
  const { id } = await api(token, 'POST', 'me/threads_publish', { creation_id: creation });
  let permalink = '';
  try { permalink = (await api(token, 'GET', id, { fields: 'permalink' })).permalink || ''; } catch {}
  return { id, permalink };
}

function postStatus(post, state) {
  const s = state.posts[post.id];
  if (s?.status) return s.status;
  if (post.published_id) return 'published';
  return post.status;
}

async function maybeRefreshToken(env, state, token, now, send) {
  if (!state.token_refreshed_at) { state.token_refreshed_at = now; return; }
  if (now - state.token_refreshed_at < REFRESH_EVERY_MS) return;
  const res = await fetch(`https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    await send(env, `⚠️ <b>Threads:</b> не удалось продлить токен. ${esc(body?.error?.message || res.status)}`);
    state.token_refreshed_at = now - REFRESH_EVERY_MS + 24 * 3600e3; // повторим через сутки
    return;
  }
  await env.KV.put(TOKEN_KEY, body.access_token);
  state.token_refreshed_at = now;
}

// Вызывается из cron "*/5 * * * *".
export async function threadsTick(env, send, now = Date.now()) {
  const token = await getToken(env);
  if (!token) return { skipped: 'нет THREADS_TOKEN' };
  const state = await loadState(env);
  const log = [];

  const due = QUEUE.filter(p => postStatus(p, state) === 'approved' && Date.parse(p.scheduled_at) <= now);
  let recent = null; // последние посты аккаунта — защита от дублей

  for (const p of due) {
    const time = mskTime(p.scheduled_at);
    if (now - Date.parse(p.scheduled_at) > MAX_LATE_MS) {
      state.posts[p.id] = { status: 'missed' };
      await saveState(env, state);
      await send(env, `⏭ <b>Threads:</b> пост на ${time} пропущен, опоздание больше 3 часов.\n\n${esc(p.text.slice(0, 200))}`);
      log.push(`${p.id}: missed`);
      continue;
    }
    try {
      if (!recent) {
        const r = await api(token, 'GET', 'me/threads', { fields: 'id,text,permalink', limit: '50' });
        recent = r.data || [];
      }
      const dup = recent.find(t => norm(t.text) === norm(p.text));
      const res = dup ? { id: dup.id, permalink: dup.permalink || '' } : await publishText(token, p.text);
      state.posts[p.id] = { status: 'published', published_id: res.id, permalink: res.permalink, published_at: new Date(now).toISOString() };
      await saveState(env, state);
      if (!dup) {
        await send(env, `🧵 <b>Threads:</b> вышел пост на ${time}\n\n${esc(p.text.slice(0, 300))}${res.permalink ? `\n\n${res.permalink}` : ''}`,
          { disable_web_page_preview: true });
      }
      log.push(`${p.id}: ${dup ? 'уже был опубликован' : 'опубликован'} ${res.id}`);
    } catch (e) {
      const prev = state.posts[p.id] || {};
      state.posts[p.id] = { ...prev, status: 'approved', attempts: (prev.attempts || 0) + 1, last_error: e.message };
      await saveState(env, state);
      if (state.posts[p.id].attempts === 1) {
        await send(env, `⚠️ <b>Threads:</b> не вышел пост на ${time}, попробую ещё раз через 5 минут.\n<code>${esc(e.message.slice(0, 300))}</code>`);
      }
      log.push(`${p.id}: ошибка ${e.message}`);
    }
  }

  await maybeRefreshToken(env, state, token, now, send);
  try { await collectMetrics(env, state, token, now); } catch (e) { log.push('метрики: ' + e.message); }
  const today = mskDate(now);
  const hourMsk = new Date(now + 3 * 3600e3).getUTCHours();
  if (hourMsk === REPORT_HOUR_MSK && state.report_date !== today) {
    state.report_date = today;
    await saveState(env, state);
    await send(env, await threadsReportText(env, state, token, today), { disable_web_page_preview: true });
    log.push('отчёт отправлен');
  } else {
    await saveState(env, state);
  }
  return { log };
}

async function insights(token, id) {
  try {
    const r = await api(token, 'GET', `${id}/insights`, { metric: 'views,likes,replies,reposts,quotes' });
    const m = {};
    for (const x of r.data || []) m[x.name] = x.values?.[0]?.value ?? x.total_value?.value ?? 0;
    return m;
  } catch { return null; }
}

async function collectMetrics(env, state, token, now) {
  const m = (await env.KV.get(METRICS_KEY, 'json')) || { posts: {}, profile: {}, daily: {} };
  const published = QUEUE.map(p => ({ p, s: state.posts[p.id] || (p.published_id ? { status: 'published', published_id: p.published_id } : null) }))
    .filter(x => x.s?.status === 'published');
  const stale = published
    .filter(x => now - (m.posts[x.p.id]?.at || 0) > METRICS_EVERY_MS)
    .sort((a, b) => (m.posts[a.p.id]?.at || 0) - (m.posts[b.p.id]?.at || 0))
    .slice(0, METRICS_BATCH);
  for (const { p, s } of stale) {
    const v = await insights(token, s.published_id);
    if (v) m.posts[p.id] = { ...v, at: now };
  }
  if (now - (m.profile.at || 0) > METRICS_EVERY_MS) {
    try {
      const r = await api(token, 'GET', 'me/threads_insights', { metric: 'followers_count' });
      const f = r.data?.find(x => x.name === 'followers_count');
      const followers = f?.total_value?.value ?? f?.values?.[0]?.value;
      if (followers != null) {
        m.profile = { followers, at: now };
        m.daily[mskDate(now)] = { followers };
      }
    } catch {}
  }
  if (stale.length || m.profile.at === now) await env.KV.put(METRICS_KEY, JSON.stringify(m));
}

export async function threadsReportText(env, state, token, day) {
  state = state || await loadState(env);
  token = token || await getToken(env);
  day = day || mskDate(Date.now());
  const todays = QUEUE.filter(p => mskDate(Date.parse(p.scheduled_at)) === day && p.status === 'approved');
  const lines = [];
  let views = 0, replies = 0;
  for (const p of todays) {
    const s = state.posts[p.id] || (p.published_id ? { status: 'published', published_id: p.published_id } : {});
    const t = mskTime(p.scheduled_at);
    const head = esc(norm(p.text).slice(0, 60));
    if (s.status === 'published') {
      const m = await insights(token, s.published_id);
      if (m) { views += m.views || 0; replies += m.replies || 0; }
      lines.push(`✅ ${t} ${head}…${m ? `\n     👁 ${m.views || 0} · ❤️ ${m.likes || 0} · 💬 ${m.replies || 0} · 🔁 ${m.reposts || 0}` : ''}`);
    } else if (s.status === 'missed') {
      lines.push(`⏭ ${t} ${head}… — пропущен`);
    } else {
      lines.push(`⏳ ${t} ${head}… — ${s.last_error ? 'ошибка: ' + esc(s.last_error.slice(0, 80)) : 'ждёт'}`);
    }
  }
  const tomorrow = mskDate(Date.parse(day + 'T12:00:00Z') + 24 * 3600e3);
  const nextCount = QUEUE.filter(p => mskDate(Date.parse(p.scheduled_at)) === tomorrow && postStatus(p, state) === 'approved').length;
  const left = QUEUE.filter(p => postStatus(p, state) === 'approved').length;
  return [
    `📊 <b>Threads за ${day}</b>`,
    todays.length ? `Постов: ${todays.length} · просмотров: ${views} · ответов: ${replies}` : 'Сегодня постов не было.',
    '',
    ...lines,
    '',
    `Завтра в очереди: ${nextCount}. Всего осталось: ${left}.`,
    left === 0 ? '⚠️ Очередь закончилась — пора готовить новые посты.' : '',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

export async function threadsStatus(env) {
  const state = await loadState(env);
  return QUEUE.map(p => ({ id: p.id, at: p.scheduled_at, status: postStatus(p, state), ...(state.posts[p.id] || {}) }));
}

// POST /threads/token — принять токен Threads (его присылает GitHub Actions из своего секрета).
// Токен проверяется у самого Threads. Первый принятый токен закрепляет аккаунт:
// дальше принимаются только токены этого же аккаунта.
export async function threadsAcceptToken(env, send, request) {
  let token = '';
  try {
    const ct = request.headers.get('content-type') || '';
    token = ct.includes('json') ? (await request.json()).token : (await request.formData()).get('token');
  } catch {}
  token = String(token || '').trim();
  if (!token) return { status: 400, body: { ok: false, error: 'нет token' } };
  let me;
  try { me = await api(token, 'GET', 'me', { fields: 'id,username' }); }
  catch (e) { return { status: 401, body: { ok: false, error: 'Threads не принял токен' } }; }
  const locked = await env.KV.get(USER_KEY);
  if (locked && locked !== me.id) return { status: 403, body: { ok: false, error: 'токен другого аккаунта' } };
  await env.KV.put(TOKEN_KEY, token);
  if (!locked) await env.KV.put(USER_KEY, me.id);
  await send(env, `🔑 <b>Threads подключён</b> к воркеру: @${esc(me.username)}. Посты будут выходить по расписанию, отчёт в 22:00.`);
  return { status: 200, body: { ok: true, username: me.username } };
}

// GET /threads/status — открытая страница: статус автопостинга и аналитика по вышедшим постам.
// Тексты будущих постов не показываются.
export async function threadsPublicStatus(env) {
  const state = await loadState(env);
  const token = await getToken(env);
  const m = (await env.KV.get(METRICS_KEY, 'json')) || { posts: {}, profile: {}, daily: {} };
  const now = Date.now();
  const rows = QUEUE.map(p => ({ p, st: postStatus(p, state), s: state.posts[p.id] || {}, v: m.posts[p.id] }));
  const pub = rows.filter(r => r.st === 'published').sort((a, b) => Date.parse(a.p.scheduled_at) - Date.parse(b.p.scheduled_at));
  const waiting = rows.filter(r => r.st === 'approved');
  const next = waiting.filter(r => Date.parse(r.p.scheduled_at) > now).sort((a, b) => Date.parse(a.p.scheduled_at) - Date.parse(b.p.scheduled_at))[0];
  const withV = pub.filter(r => r.v);
  const sum = k => withV.reduce((a, r) => a + (r.v[k] || 0), 0);
  const views = sum('views'), likes = sum('likes'), replies = sum('replies'), reposts = sum('reposts') + sum('quotes');
  const avg = withV.length ? Math.round(views / withV.length) : 0;
  const er = views ? ((likes + replies + reposts) / views * 100).toFixed(1) : '0';
  const fmtN = n => Number(n || 0).toLocaleString('ru-RU');
  const fmtT = iso => new Date(Date.parse(iso) + 3 * 3600e3).toISOString().slice(5, 16).replace('T', ' ').replace(/^(\d\d)-(\d\d)/, '$2.$1');
  const group = key => {
    const g = {};
    for (const r of withV) { const k = key(r); (g[k] ??= { n: 0, views: 0, replies: 0 }); g[k].n++; g[k].views += r.v.views || 0; g[k].replies += r.v.replies || 0; }
    return Object.entries(g).map(([k, x]) => ({ k, n: x.n, avg: Math.round(x.views / x.n), rep: (x.replies / x.n).toFixed(1) })).sort((a, b) => b.avg - a.avg);
  };
  const byHour = group(r => mskTime(r.p.scheduled_at));
  const byTheme = group(r => r.p.theme || '—');
  const top = [...withV].sort((a, b) => (b.v.views || 0) - (a.v.views || 0)).slice(0, 5);
  const maxV = Math.max(1, ...withV.map(r => r.v.views || 0));
  const bars = pub.map(r => {
    const h = r.v ? Math.max(2, Math.round((r.v.views || 0) / maxV * 100)) : 2;
    return `<div class="bar" style="height:${h}%" title="${fmtT(r.p.scheduled_at)} · ${fmtN(r.v?.views)} просмотров"></div>`;
  }).join('');
  const groupTable = (title, list, label) => list.length ? `<section><h2>${title}</h2><div class="wrap"><table><tr><th>${label}</th><th class="n">Постов</th><th class="n">👁 в среднем</th><th class="n">💬 в среднем</th></tr>
${list.map(x => `<tr><td>${esc(x.k)}</td><td class="n">${x.n}</td><td class="n">${fmtN(x.avg)}</td><td class="n">${x.rep}</td></tr>`).join('')}</table></div></section>` : '';
  const postLink = r => r.s.permalink ? `<a href="${esc(r.s.permalink)}">${esc(norm(r.p.text).slice(0, 70))}…</a>` : esc(norm(r.p.text).slice(0, 70)) + '…';
  const updated = m.profile.at ? fmtT(new Date(m.profile.at).toISOString()) : '—';
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Threads: аналитика</title><style>
:root{--bg:#f5f5f3;--card:#fff;--fg:#141414;--muted:#6b6b68;--line:#e5e5e1;--accent:#3b3bd6}
@media(prefers-color-scheme:dark){:root{--bg:#111;--card:#1c1c1c;--fg:#eee;--muted:#9a9a95;--line:#2c2c2a;--accent:#8f8fff}}
*{box-sizing:border-box}body{font:15px/1.5 system-ui,-apple-system,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px 48px;color:var(--fg);background:var(--bg)}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}.sub{color:var(--muted);margin:0 0 18px;font-size:14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.kpi b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.kpi span{color:var(--muted);font-size:13px}
.chart{display:flex;align-items:flex-end;gap:3px;height:140px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}
.bar{flex:1;min-width:3px;background:var(--accent);border-radius:3px 3px 0 0;opacity:.85}.bar:hover{opacity:1}
.wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:14px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:500;color:var(--muted)}.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
a{color:var(--accent)}.t{display:block;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}td:first-child{min-width:0}.note{color:var(--muted);font-size:13px;margin-top:8px}</style>
<h1>Threads: аналитика</h1>
<p class="sub">${token ? '✅ Автопостинг работает' : '❌ Токен не подключён'} · опубликовано ${pub.length}, ждут ${waiting.length}${rows.some(r => r.st === 'missed') ? `, пропущено ${rows.filter(r => r.st === 'missed').length}` : ''} · следующий пост ${next ? fmtT(next.p.scheduled_at) + ' МСК' : '—'}</p>
<div class="kpis">
<div class="kpi"><b>${m.profile.followers != null ? fmtN(m.profile.followers) : '—'}</b><span>подписчиков</span></div>
<div class="kpi"><b>${fmtN(views)}</b><span>просмотров</span></div>
<div class="kpi"><b>${fmtN(avg)}</b><span>в среднем на пост</span></div>
<div class="kpi"><b>${fmtN(replies)}</b><span>ответов</span></div>
<div class="kpi"><b>${er}%</b><span>вовлечённость</span></div>
</div>
${pub.length ? `<h2>Просмотры по постам</h2><div class="chart">${bars}</div><p class="note">Столбик — один пост, по порядку выхода. Наведите, чтобы увидеть дату и просмотры.</p>` : ''}
${top.length ? `<section><h2>Лучшие посты</h2><div class="wrap"><table><tr><th>Пост</th><th class="n">👁</th><th class="n">❤️</th><th class="n">💬</th></tr>
${top.map(r => `<tr><td>${postLink(r)}</td><td class="n">${fmtN(r.v.views)}</td><td class="n">${fmtN(r.v.likes)}</td><td class="n">${fmtN(r.v.replies)}</td></tr>`).join('')}</table></div></section>` : ''}
${groupTable('Лучшее время', byHour, 'Время МСК')}
${groupTable('Темы', byTheme, 'Тема')}
${pub.length ? `<section><h2>Все вышедшие посты</h2><div class="wrap"><table><tr><th>Пост</th><th class="n">👁</th><th class="n">❤️</th><th class="n">💬</th><th class="n">🔁</th></tr>
${[...pub].reverse().map(r => `<tr><td><span class="t">${fmtT(r.p.scheduled_at)}</span>${postLink(r)}</td><td class="n">${r.v ? fmtN(r.v.views) : '…'}</td><td class="n">${r.v ? fmtN(r.v.likes) : '…'}</td><td class="n">${r.v ? fmtN(r.v.replies) : '…'}</td><td class="n">${r.v ? fmtN((r.v.reposts || 0) + (r.v.quotes || 0)) : '…'}</td></tr>`).join('')}</table></div></section>` : ''}
<p class="note">Статистика обновляется каждые 20 минут, последнее обновление ${updated} МСК. Вовлечённость — лайки, ответы и репосты к просмотрам.</p>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
