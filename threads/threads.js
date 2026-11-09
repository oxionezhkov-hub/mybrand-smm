// Автопостинг в Threads: воркер сам публикует посты из threads/queue.json,
// хранит статусы в KV, сам отвечает на комментарии и раз в день присылает
// в Telegram статистику аккаунта за всё время.
//
// Секрет THREADS_TOKEN — долгоживущий токен Threads. Воркер раз в неделю
// продлевает его сам и хранит свежий в KV (ключ threads:token).
//
// Автоответы пишет бесплатная Llama на Workers AI (binding AI). Для них токену
// нужны права threads_read_replies и threads_manage_replies.
//   THREADS_AUTOREPLY = "off"  — выключить автоответы (переменная в wrangler.toml)
//   THREADS_CHAT_URL           — ссылка на бесплатный чат «Заработок с AI». ИИ ставит
//                                метку [ЧАТ], воркер подставляет ссылку, так ИИ не может
//                                её исказить. Не задано — ИИ никуда не зовёт.


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

const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const REPLY_POST_WINDOW_MS = 7 * 24 * 3600e3;     // отвечаем под постами младше недели
const REPLY_COMMENT_MAX_AGE_MS = 3 * 24 * 3600e3; // и на комментарии младше трёх дней
const REPLY_POSTS_PER_TICK = 3;                   // сколько постов проверяем за тик (раз в 5 минут)
const REPLIES_PER_TICK = 2;
const REPLIES_PER_DAY = 60;
const REPLIES_PER_USER_PER_POST = 3;              // чтобы не уйти в бесконечную переписку
const INSIGHTS_SINCE = 1712991600;                // раньше этой даты Threads статистику не отдаёт

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
const mskTime = iso => new Date(new Date(iso).getTime() + 3 * 3600e3).toISOString().slice(11, 16);
const mskDate = ms => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);
const num = n => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const plus = n => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : '0');

async function loadState(env) {
  const s = (await env.KV.get(STATE_KEY, 'json')) || {};
  return {
    posts: {}, report_date: '', token_refreshed_at: 0,
    replied: {}, reply_checked: {}, reply_log: [], needs_owner: [], metrics: {},
    reply_total: 0, replies_since_report: 0, reply_day: { date: '', count: 0 },
    ...s,
  };
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
  if (!res.ok) {
    const err = new Error(`Threads ${path}: ${res.status} ${body?.error?.message || JSON.stringify(body).slice(0, 200)}`);
    err.status = res.status;
    err.code = body?.error?.code;
    throw err;
  }
  return body;
}

async function publishText(token, text, extra = {}) {
  const { id: creation } = await api(token, 'POST', 'me/threads', { media_type: 'TEXT', text, ...extra });
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

// Все опубликованные посты очереди: { id, published_id, permalink, published_at(ms), text }
function publishedPosts(state) {
  const out = [];
  for (const p of QUEUE) {
    if (postStatus(p, state) !== 'published') continue;
    const s = state.posts[p.id] || {};
    const pid = s.published_id || p.published_id;
    if (!pid) continue;
    const at = Date.parse(s.published_at || p.published_at || p.scheduled_at);
    out.push({ id: p.id, published_id: pid, permalink: s.permalink || '', published_at: at, text: p.text });
  }
  return out;
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

  try { log.push(...await autoReplyTick(env, state, token, now, send)); }
  catch (e) { log.push(`автоответы: ошибка ${e.message}`); }
  await saveState(env, state);

  await maybeRefreshToken(env, state, token, now, send);
  try { await collectMetrics(env, state, token, now); } catch (e) { log.push('метрики: ' + e.message); }
  const today = mskDate(now);
  const hourMsk = new Date(now + 3 * 3600e3).getUTCHours();
  if (hourMsk === REPORT_HOUR_MSK && state.report_date !== today) {
    state.report_date = today;
    await saveState(env, state);
    await send(env, await threadsReportText(env, state, token, now), { disable_web_page_preview: true });
    await saveState(env, state); // отчёт запомнил итоги для разницы «с прошлого отчёта»
    log.push('отчёт отправлен');
  } else {
    await saveState(env, state);
  }
  return { log };
}

// ── Автоответы на комментарии ────────────────────────────────────────────────

function replySystemPrompt(env) {
  const chat = String(env.THREADS_CHAT_URL || '').trim();
  return [
    'Ты ведёшь аккаунт в Threads и отвечаешь на комментарии под своими постами от первого лица.',
    'Темы аккаунта: поиск работы и как сделать нейросети основным источником дохода: какие задачи с ИИ уже покупают, где брать первые заказы, как собрать портфолио.',
    'Позиция: это новая профессия, а не подработка. Путь простой: один способ, одна работа в портфолио, один клиент.',
    'Аудитория: люди, которым нужны деньги или работа: помощники, ассистенты, уволенные, студенты, мамы в декрете.',
    '',
    'Как отвечать:',
    '- по-русски, на «вы», живо и просто, как человек в соцсети, без канцелярита и без пафоса;',
    '- 1–2 коротких предложения, не длиннее 250 символов;',
    '- по делу комментария: согласиться, поддержать, добавить мысль или конкретный совет;',
    '- иногда заканчивай коротким встречным вопросом, чтобы разговор продолжился;',
    '- без ссылок, хэштегов и списков, максимум один эмодзи, лучше без него;',
    '- не обещай заработок и не называй суммы, не продавай в лоб;',
    '- о себе пиши без указания рода: вместо «согласна» или «согласен» — «да, так и есть», «полностью поддерживаю».',
    chat
      ? '- если человек спрашивает, где научиться, с чего начать, где брать заказы, или пишет, что не может найти работу, позови в бесплатный чат «Заработок с AI»: там в закрепе 10 нейросетей для старта, 50 промптов под заказы и шаблон отклика. Вместо ссылки поставь метку [ЧАТ], ссылку подставят сами. Не зови в чат, если человек просто делится мнением.'
      : '- если человек спрашивает, где научиться, ответь, что скоро расскажете подробнее, и спроси, что ему интереснее всего.',
    '',
    'Ответь ровно словом SKIP, если комментарий — спам, реклама, бессмыслица, набор эмодзи, явный бот, оскорбление, агрессия, политика или религия.',
    'Ответь ровно словом OWNER, если комментарий спрашивает лично про автора (сколько зарабатываете, где живёте, кто вы, вы бот?), предлагает сотрудничество или просит то, что нельзя ответить коротко и честно.',
    '',
    'Выведи только текст ответа, SKIP или OWNER, без кавычек и пояснений.',
  ].join('\n');
}

// Возвращает { text } или { skip: 'spam' | 'owner' }.
function cleanReply(raw) {
  const unquote = x => x.replace(/^["«„“']+|["»“”']+$/g, '').trim();
  let t = unquote(String(raw || '').trim());
  if (/^OWNER\b/i.test(t)) return { skip: 'owner' };
  if (!t || /\bSKIP\b/i.test(t)) return { skip: 'spam' };
  t = unquote(t.replace(/^(ответ|reply)\s*:\s*/i, ''));
  if (/https?:\/\/|www\.|#\S/.test(t)) return { skip: 'owner' };
  if (t.length > 480) {
    const cut = t.slice(0, 480);
    t = cut.slice(0, Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! ')) + 1) || cut;
  }
  return { text: t.trim() };
}

async function generateReply(env, post, chain) {
  const chat = String(env.THREADS_CHAT_URL || '').trim();
  const dialog = chain.map(c => `${c.mine ? 'Вы' : '@' + (c.username || 'гость')}: ${norm(c.text)}`).join('\n');
  const user = `Ваш пост:\n${norm(post.text)}\n\nПереписка под постом (последнее сообщение — то, на которое отвечаете):\n${dialog}\n\nВаш ответ:`;
  const r = await env.AI.run(AI_MODEL, {
    messages: [{ role: 'system', content: replySystemPrompt(env) }, { role: 'user', content: user }],
    max_tokens: 200,
    temperature: 0.7,
  });
  const res = cleanReply(r?.response);
  if (res.text?.includes('[ЧАТ]')) {
    if (!chat) return { skip: 'owner' };
    let first = true; // ссылку ставим один раз, лишние метки убираем
    res.text = res.text.replace(/\s*\[ЧАТ\]/g, m => (first ? (first = false, m.replace('[ЧАТ]', chat)) : '')).trim();
  }
  return res;
}

function isPermissionError(e) {
  return e?.status === 403 || e?.code === 10 || e?.code === 200 || /permission|scope/i.test(e?.message || '');
}

async function autoReplyTick(env, state, token, now, send) {
  if (String(env.THREADS_AUTOREPLY || '').toLowerCase() === 'off' || !env.AI) return [];
  // нет прав на комментарии — пробуем снова раз в сутки
  if (state.autoreply_error_at && now - state.autoreply_error_at < 24 * 3600e3) return [];

  const today = mskDate(now);
  if (state.reply_day.date !== today) state.reply_day = { date: today, count: 0 };
  // чистим память об отвеченных комментариях старше двух недель
  for (const [k, v] of Object.entries(state.replied)) if (now - (v.at || 0) > 14 * 24 * 3600e3) delete state.replied[k];

  const posts = publishedPosts(state)
    .filter(p => now - p.published_at < REPLY_POST_WINDOW_MS)
    .filter(p => now - (state.reply_checked[p.published_id] || 0) >= (now - p.published_at < 24 * 3600e3 ? 10 * 60e3 : 2 * 3600e3))
    .sort((a, b) => (state.reply_checked[a.published_id] || 0) - (state.reply_checked[b.published_id] || 0))
    .slice(0, REPLY_POSTS_PER_TICK);
  for (const k of Object.keys(state.reply_checked)) if (now - state.reply_checked[k] > REPLY_POST_WINDOW_MS + 24 * 3600e3) delete state.reply_checked[k];

  const log = [];
  let sent = 0;
  for (const post of posts) {
    let items;
    try {
      const r = await api(token, 'GET', `${post.published_id}/conversation`, {
        fields: 'id,text,username,timestamp,permalink,replied_to,is_reply_owned_by_me,hide_status',
        reverse: 'false', limit: '100',
      });
      items = r.data || [];
    } catch (e) {
      if (isPermissionError(e)) {
        const first = !state.autoreply_error_notified;
        state.autoreply_error_at = now;
        state.autoreply_error_notified = true;
        if (first) {
          await send(env, `⚠️ <b>Threads:</b> не могу читать комментарии, автоответы на паузе. Токену нужны права <code>threads_read_replies</code> и <code>threads_manage_replies</code>: выпустите новый токен с ними и запустите workflow «Threads — передать токен воркеру».\n<code>${esc(e.message.slice(0, 200))}</code>`);
        }
        return [`автоответы: нет прав — ${e.message}`];
      }
      log.push(`${post.id}: комментарии не загрузились — ${e.message}`);
      continue;
    }
    state.reply_checked[post.published_id] = now;
    state.autoreply_error_at = 0;
    state.autoreply_error_notified = false;

    const byId = new Map(items.map(i => [i.id, i]));
    const mine = new Set([post.published_id, ...items.filter(i => i.is_reply_owned_by_me).map(i => i.id)]);
    const answered = new Set(items.filter(i => i.is_reply_owned_by_me).map(i => i.replied_to?.id).filter(Boolean));
    const myRepliesTo = name => items.filter(i => i.is_reply_owned_by_me && byId.get(i.replied_to?.id)?.username === name).length;

    for (const c of items) {
      if (sent >= REPLIES_PER_TICK || state.reply_day.count >= REPLIES_PER_DAY) break;
      if (c.is_reply_owned_by_me || !c.text) continue;
      if (!mine.has(c.replied_to?.id)) continue;          // отвечаем только на то, что адресовано нам
      if (answered.has(c.id) || state.replied[c.id]) continue;
      if (c.hide_status && !['NOT_HUSHED', 'UNHUSHED'].includes(c.hide_status)) continue;
      if (now - Date.parse(c.timestamp) > REPLY_COMMENT_MAX_AGE_MS) continue;
      if (myRepliesTo(c.username) >= REPLIES_PER_USER_PER_POST) continue;

      // цепочка от поста до этого комментария, чтобы ИИ видел контекст
      const chain = [];
      for (let cur = c; cur && chain.length < 6; cur = byId.get(cur.replied_to?.id)) {
        chain.unshift({ text: cur.text, username: cur.username, mine: !!cur.is_reply_owned_by_me });
      }

      let gen;
      try { gen = await generateReply(env, post, chain); }
      catch (e) { log.push(`${c.id}: ИИ не ответил — ${e.message}`); continue; }

      if (gen.skip) {
        state.replied[c.id] = { at: now, skip: gen.skip };
        if (gen.skip === 'owner') {
          state.needs_owner = [...state.needs_owner, {
            at: now, username: c.username, text: norm(c.text).slice(0, 120), permalink: c.permalink || post.permalink,
          }].slice(-15);
        }
        log.push(`${c.id}: пропущен (${gen.skip === 'owner' ? 'оставил вам' : 'спам'})`);
        continue;
      }
      const text = gen.text;
      try {
        state.replied[c.id] = { at: now, pending: true };
        await saveState(env, state); // сначала запоминаем, чтобы не ответить дважды при сбое
        const res = await publishText(token, text, { reply_to_id: c.id });
        state.replied[c.id] = { at: now, reply_id: res.id };
        state.reply_total += 1;
        state.replies_since_report += 1;
        state.reply_day.count += 1;
        state.reply_log = [...state.reply_log, {
          at: new Date(now).toISOString(), post: post.id, username: c.username,
          comment: norm(c.text).slice(0, 200), reply: text, permalink: res.permalink,
        }].slice(-30);
        answered.add(c.id);
        sent += 1;
        log.push(`${c.id}: ответил`);
      } catch (e) {
        delete state.replied[c.id]; // ответ не ушёл — попробуем в следующий раз
        if (isPermissionError(e)) {
          state.autoreply_error_at = now;
          if (!state.autoreply_error_notified) {
            state.autoreply_error_notified = true;
            await send(env, `⚠️ <b>Threads:</b> не могу отвечать на комментарии, автоответы на паузе. Токену нужно право <code>threads_manage_replies</code>.\n<code>${esc(e.message.slice(0, 200))}</code>`);
          }
          return [...log, `автоответы: нет прав — ${e.message}`];
        }
        log.push(`${c.id}: ответ не ушёл — ${e.message}`);
      }
      await saveState(env, state);
    }
  }
  return log;
}

// ── Статистика ───────────────────────────────────────────────────────────────

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

// Итоги всего аккаунта (включая посты, опубликованные не воркером).
async function accountTotals(token, now) {
  try {
    const r = await api(token, 'GET', 'me/threads_insights', {
      metric: 'views,likes,replies,reposts,quotes,followers_count',
      since: String(INSIGHTS_SINCE), until: String(Math.floor(now / 1000)),
    });
    const t = {};
    for (const x of r.data || []) {
      t[x.name === 'followers_count' ? 'followers' : x.name] = x.total_value?.value
        ?? (x.values || []).reduce((s, v) => s + (v.value || 0), 0);
    }
    return t;
  } catch { return null; }
}

export async function threadsReportText(env, state, token, now = Date.now()) {
  state = state || await loadState(env);
  token = token || await getToken(env);
  if (typeof now === 'string') now = Date.parse(now + 'T19:00:00Z'); // старый вызов с датой

  const published = publishedPosts(state);
  const metrics = (await env.KV.get(METRICS_KEY, 'json')) || { posts: {}, profile: {} };
  const cached = published.map(p => ({ ...p, m: metrics.posts?.[p.id] || {} }));
  const sum = k => cached.reduce((s, p) => s + (p.m[k] || 0), 0);
  const totals = (await accountTotals(token, now))
    || { views: sum('views'), likes: sum('likes'), replies: sum('replies'), reposts: sum('reposts'), quotes: sum('quotes'),
         followers: metrics.profile?.followers };
  const prev = state.report_prev?.totals;
  const d = k => (prev && prev[k] != null && totals[k] != null ? ` (${plus(totals[k] - prev[k])})` : '');

  const top = cached.filter(p => p.m.views).sort((a, b) => b.m.views - a.m.views).slice(0, 3);
  const nextPost = QUEUE.filter(p => postStatus(p, state) === 'approved' && Date.parse(p.scheduled_at) > now)
    .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))[0];
  const left = QUEUE.filter(p => postStatus(p, state) === 'approved').length;
  const owner = state.needs_owner || [];

  const lines = [
    '📊 <b>Threads за всё время</b>',
    totals.followers != null ? `👥 Подписчики: ${num(totals.followers)}${d('followers')}` : '',
    `📝 Постов вышло: ${published.length}`,
    `👁 Просмотры: ${num(totals.views)}${d('views')}`,
    `❤️ Лайки: ${num(totals.likes)}${d('likes')}`,
    `💬 Комментарии: ${num(totals.replies)}${d('replies')}`,
    `🔁 Репосты: ${num(totals.reposts)}${d('reposts')}${totals.quotes ? ` · цитаты: ${num(totals.quotes)}${d('quotes')}` : ''}`,
    `🤖 Автоответов: ${num(state.reply_total)}${state.replies_since_report ? ` (+${state.replies_since_report})` : ''}`,
    prev ? `<i>в скобках — изменение с прошлого отчёта</i>` : '',
    '',
    top.length ? '🔥 <b>Лучшие посты</b>' : '',
    ...top.map((p, i) => `${i + 1}. ${p.permalink ? `<a href="${p.permalink}">${esc(norm(p.text).slice(0, 50))}…</a>` : esc(norm(p.text).slice(0, 50)) + '…'}\n     👁 ${num(p.m.views)} · ❤️ ${num(p.m.likes)} · 💬 ${num(p.m.replies)}`),
    '',
    owner.length ? `🙋 <b>Ждут вашего ответа</b> (ИИ не стал отвечать)` : '',
    ...owner.map(o => `• @${esc(o.username || '?')}: ${esc(o.text)}${o.permalink ? ` — <a href="${o.permalink}">открыть</a>` : ''}`),
    owner.length ? ' ' : '',
    `В очереди: ${left}${nextPost ? `, следующий ${mskDate(Date.parse(nextPost.scheduled_at)).slice(5).split('-').reverse().join('.')} в ${mskTime(nextPost.scheduled_at)}` : ''}.`,
    left === 0 ? '⚠️ Очередь закончилась — пора готовить новые посты.' : '',
  ];

  state.report_prev = { date: mskDate(now), totals };
  state.replies_since_report = 0;
  state.needs_owner = [];
  return lines.filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n').trim();
}

export async function threadsStatus(env) {
  const state = await loadState(env);
  return QUEUE.map(p => ({ id: p.id, at: p.scheduled_at, status: postStatus(p, state), ...(state.posts[p.id] || {}) }));
}

// Для /debug/threads?replies=1 — последние автоответы и комментарии, оставленные владельцу.
export async function threadsRepliesLog(env) {
  const state = await loadState(env);
  return {
    enabled: String(env.THREADS_AUTOREPLY || '').toLowerCase() !== 'off',
    paused_until: state.autoreply_error_at ? new Date(state.autoreply_error_at + 24 * 3600e3).toISOString() : null,
    total: state.reply_total, today: state.reply_day,
    last: state.reply_log, needs_owner: state.needs_owner,
  };
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
  // новый токен — снимаем паузу автоответов, если она была из-за прав
  const state = await loadState(env);
  state.autoreply_error_at = 0;
  state.autoreply_error_notified = false;
  await saveState(env, state);
  await send(env, `🔑 <b>Threads подключён</b> к воркеру: @${esc(me.username)}. Посты выходят по расписанию, на комментарии отвечаю сам, статистика за всё время — в 22:00.`);
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
<div class="kpi"><b>${fmtN(state.reply_total)}</b><span>автоответов</span></div>
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
