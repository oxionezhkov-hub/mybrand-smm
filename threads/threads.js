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
    const r = await api(token, 'GET', `${id}/insights`, { metric: 'views,likes,replies,reposts' });
    const m = {};
    for (const x of r.data || []) m[x.name] = x.values?.[0]?.value ?? x.total_value?.value ?? 0;
    return m;
  } catch { return null; }
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

// GET /threads/status — открытая сводка без текстов постов: подключён ли токен и что в очереди.
export async function threadsPublicStatus(env) {
  const state = await loadState(env);
  const token = await getToken(env);
  const now = Date.now();
  const st = QUEUE.map(p => ({ at: p.scheduled_at, status: postStatus(p, state) }));
  const count = s => st.filter(x => x.status === s).length;
  const next = st.filter(x => x.status === 'approved' && Date.parse(x.at) > now).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  const last = Object.values(state.posts).filter(x => x.status === 'published' && x.published_at)
    .sort((a, b) => b.published_at.localeCompare(a.published_at))[0];
  const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  const fmt = iso => iso ? new Date(Date.parse(iso) + 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' МСК' : '—';
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Threads: статус</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:480px;margin:32px auto;padding:0 16px;color:#141414;background:#f5f5f3}
h1{font-size:20px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden}th,td{text-align:left;padding:10px 14px;border-bottom:1px solid #e5e5e1}th{font-weight:500;color:#666}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}table{background:#1c1c1c}th,td{border-color:#2c2c2a}th{color:#999}}</style>
<h1>Threads: автопостинг</h1><table>
${row('Токен', token ? '✅ подключён' : '❌ не подключён')}
${row('Опубликовано', count('published'))}
${row('Ждут публикации', count('approved'))}
${row('Пропущено', count('missed'))}
${row('Следующий пост', fmt(next?.at))}
${row('Последний вышел', fmt(last?.published_at))}
${last?.permalink ? row('Ссылка', `<a href="${last.permalink}">открыть пост</a>`) : ''}
</table>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
