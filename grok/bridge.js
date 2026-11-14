// Входящие ассистента (Grok) и GitHub PR в личный Telegram-бот.
//
// Состояние вопросов лежит в том же KV, что и остальной воркер:
//   grok:q:<id>         — сам вопрос (open | answered | resolved)
//   grok:cb:<token>     — callback-кнопка → id (token короткий, id может быть длинным)
//   grok:msg:<message>  — reply на сообщение бота → id
//   grok:pending        — id ответов, которые ассистент ещё не забрал
//   grok:pr:<repo>#<n>  — id актуального вопроса по этому pull request
//
// Секреты (wrangler secret put, в репозиторий не попадают):
//   GROK_BRIDGE_TOKEN          — bearer для /grok/*
//   GROK_ANSWER_WEBHOOK_URL    — необязательно: куда сразу POST-ить ответ
//   GROK_ANSWER_WEBHOOK_TOKEN  — необязательно: bearer для этого POST
//   GITHUB_WEBHOOK_SECRET      — секрет подписи X-Hub-Signature-256
//   GITHUB_TOKEN               — необязательно: Approve/Merge через GitHub API
// Уже существующие TG_TOKEN и OWNER_CHAT_ID нужны, чтобы писать в чат Олега.

const QUESTION_PREFIX = 'grok:q:';
const CB_PREFIX = 'grok:cb:';
const MSG_PREFIX = 'grok:msg:';
const PENDING_KEY = 'grok:pending';
const PR_PREFIX = 'grok:pr:';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const STATUSES = new Set(['open', 'answered', 'resolved']);
const TEXT_MAX = 3200;
const TITLE_MAX = 200;
const ANSWER_MAX = 2000;
const LIST_MAX = 100;

const GH_BUTTONS = {
  a: { id: 'approve', github: true },
  m: { id: 'merge', github: true },
  s: { id: 'skip', github: false },
  l: { id: 'looked', github: false },
};

const GH_LABELS = {
  approve: 'Approve',
  merge: 'Merge',
  skip: 'Пропустить',
  looked: 'Посмотрел',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function fetcher(env) {
  return typeof env.fetch === 'function' ? env.fetch.bind(env) : fetch;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const aa = enc.encode(String(a ?? ''));
  const bb = enc.encode(String(b ?? ''));
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function hex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function randomId(prefix) {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}_${hex(bytes)}`;
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return hex(new Uint8Array(sig));
}

async function kget(env, key, def = null) {
  const val = await env.KV.get(key, 'json');
  return val ?? def;
}

async function kset(env, key, val) {
  await env.KV.put(key, JSON.stringify(val));
}

function questionKey(id) { return QUESTION_PREFIX + id; }
function cbKey(token) { return CB_PREFIX + token; }
function msgKey(messageId) { return MSG_PREFIX + messageId; }
function prKey(fullName, number) { return `${PR_PREFIX}${fullName}#${number}`; }

async function load(env, id) {
  if (!id) return null;
  const q = await kget(env, questionKey(id), null);
  return q && q.id ? q : null;
}

function callbackToken(id) {
  // callback_data ≤ 64 байт: "gq:" + token + ":" + action ("i0" = 2).
  if (/^[A-Za-z0-9_.:-]{1,40}$/.test(id)) return id;
  return randomId('c');
}

function bearerOk(request, env) {
  const token = env.GROK_BRIDGE_TOKEN;
  if (!token || typeof token !== 'string') return false;
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return false;
  return safeEqual(match[1], token);
}

function chatAllowed(env, chatId) {
  if (!env.OWNER_CHAT_ID) return true;
  if (chatId == null) return false;
  return String(chatId) === String(env.OWNER_CHAT_ID);
}

function requireTelegram(env) {
  if (!env.TG_TOKEN || !env.OWNER_CHAT_ID) {
    throw new HttpError(503, 'TG_TOKEN or OWNER_CHAT_ID is not configured');
  }
}

function safeLink(link) {
  if (link == null || link === '') return null;
  const value = String(link).trim();
  if (!/^https?:\/\/[^\s<>"']+$/i.test(value) || value.length > 500) {
    throw new HttpError(400, 'link must be an http(s) URL');
  }
  return value;
}

function cleanLine(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeOptions(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'options must be an array');
  if (raw.length > 8) throw new HttpError(400, 'at most 8 options');
  const used = new Set();
  return raw.map((opt, i) => {
    let label = '';
    let id = `i${i}`;
    if (typeof opt === 'string') label = opt;
    else if (opt && typeof opt === 'object') {
      label = opt.label ?? opt.text ?? '';
      if (opt.id != null) id = String(opt.id).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 32) || id;
    } else {
      throw new HttpError(400, 'bad option');
    }
    label = cleanLine(label, 60);
    if (!label) throw new HttpError(400, 'empty option');
    let unique = id;
    let n = 2;
    while (used.has(unique)) unique = `${id}_${n++}`;
    used.add(unique);
    return { id: unique, label };
  });
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id) || id === 'resolve') {
    throw new HttpError(400, 'bad id');
  }
  return id;
}

function decodeId(raw) {
  let id;
  try { id = decodeURIComponent(raw); } catch { throw new HttpError(400, 'bad id'); }
  return assertId(id);
}

function parseSince(url) {
  const raw = url.searchParams.get('since');
  if (raw == null || raw === '') return null;
  if (!/^\d{1,16}$/.test(raw)) throw new HttpError(400, 'since must be unix milliseconds');
  return Number(raw);
}

function publicQuestion(q) {
  return {
    id: q.id,
    status: q.status,
    text: q.text,
    title: q.title || null,
    options: q.options || [],
    source: q.source || null,
    link: q.link || null,
    answer: q.answer ?? null,
    option_id: q.option_id ?? null,
    via: q.via || null,
    telegram_message_id: q.telegram_message_id ?? null,
    created_at: q.created_at,
    updated_at: q.updated_at,
    answered_at: q.answered_at ?? null,
    acked_at: q.acked_at ?? null,
    resolved_at: q.resolved_at ?? null,
    resolved_reason: q.resolved_reason ?? null,
    github: q.github || null,
    github_action: q.github_action || null,
    webhook_push: q.webhook_push || null,
  };
}

function renderQuestion(q, footer) {
  const head = q.github
    ? '🔔 <b>Pull request</b>'
    : `🤖 <b>Вопрос</b>${q.source ? ` · ${escapeHtml(q.source)}` : ''}`;
  const title = q.title ? `\n<b>${escapeHtml(q.title)}</b>` : '';
  const body = q.text ? `\n\n${escapeHtml(q.text)}` : '';
  const link = q.link ? `\n\n<a href="${q.link}">Открыть</a>` : '';
  const foot = footer
    ? `\n\n${footer}`
    : '\n\n<i>Ответьте кнопкой или ответом на это сообщение.</i>';
  return head + title + body + link + foot;
}

function keyboardFor(q) {
  let rows;
  if (q.github?.owner && q.github?.repo && q.github?.number) {
    rows = [
      [
        { text: '✅ Approve', callback_data: `gq:${q.cb}:a` },
        { text: '🔀 Merge', callback_data: `gq:${q.cb}:m` },
      ],
      [
        { text: '👀 Посмотрел', callback_data: `gq:${q.cb}:l` },
        { text: '⏭ Пропустить', callback_data: `gq:${q.cb}:s` },
      ],
    ];
    if (q.link) rows.push([{ text: '🔗 Открыть PR', url: q.link }]);
  } else {
    rows = (q.options || []).map((opt, i) => [{
      text: opt.label,
      callback_data: `gq:${q.cb}:i${i}`,
    }]);
    if (q.link) rows.push([{ text: '🔗 Открыть', url: q.link }]);
  }
  if (!rows.length) return undefined;
  for (const row of rows) {
    for (const btn of row) {
      if (btn.callback_data && byteLength(btn.callback_data) > 64) {
        throw new HttpError(500, 'callback_data exceeds 64 bytes');
      }
    }
  }
  return { inline_keyboard: rows };
}

function tgNotModified(res) {
  return /message is not modified/i.test(res?.description || '');
}

function messageGone(res) {
  return /message to edit not found|message identifier is not specified|message can't be edited|MESSAGE_ID_INVALID|message to delete not found/i.test(res?.description || '');
}

function tgError(res) {
  if (!res || res.ok) return null;
  return {
    ok: false,
    description: res.description || null,
    error_code: res.error_code || null,
  };
}

async function tg(env, method, params) {
  const res = await fetcher(env)(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json();
}

async function saveQuestion(env, q) {
  q.updated_at = Date.now();
  await kset(env, questionKey(q.id), q);
  if (q.cb) await kset(env, cbKey(q.cb), q.id);
  if (q.telegram_message_id) await kset(env, msgKey(q.telegram_message_id), q.id);
  const raw = await kget(env, PENDING_KEY, []);
  const ids = Array.isArray(raw) ? raw : [];
  const should = q.status === 'answered' && !q.acked_at;
  const has = ids.includes(q.id);
  if (should && !has) await kset(env, PENDING_KEY, [...ids, q.id]);
  else if (!should && has) await kset(env, PENDING_KEY, ids.filter((x) => x !== q.id));
}

async function deliver(env, q) {
  requireTelegram(env);
  const payload = {
    chat_id: q.chat_id || String(env.OWNER_CHAT_ID),
    text: renderQuestion(q),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  const markup = keyboardFor(q);
  if (markup) payload.reply_markup = markup;

  if (q.telegram_message_id) {
    const edited = await tg(env, 'editMessageText', { ...payload, message_id: q.telegram_message_id });
    if (edited?.ok || tgNotModified(edited)) return { ok: true, mode: 'edited' };
    if (!messageGone(edited)) return { ok: false, telegram: edited };
    q.telegram_message_id = null;
  }

  const sent = await tg(env, 'sendMessage', payload);
  if (!sent?.ok || !sent.result?.message_id) return { ok: false, telegram: sent };
  q.telegram_message_id = sent.result.message_id;
  q.chat_id = String(env.OWNER_CHAT_ID);
  return { ok: true, mode: 'sent' };
}

async function editAnswerNote(env, q) {
  if (!q.telegram_message_id || !env.TG_TOKEN) return;
  const shown = String(q.answer || '').slice(0, 700);
  const label = (q.github && GH_LABELS[q.option_id]) || shown;
  const footer = `✅ <b>Ответ:</b> ${escapeHtml(label)}`;
  await tg(env, 'editMessageText', {
    chat_id: q.chat_id || env.OWNER_CHAT_ID,
    message_id: q.telegram_message_id,
    text: renderQuestion(q, footer),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
}

async function dismissMessage(env, q, fallbackText) {
  if (!q.telegram_message_id || !env.TG_TOKEN) return 'skipped';
  const chatId = q.chat_id || env.OWNER_CHAT_ID;
  let deleted;
  try {
    deleted = await tg(env, 'deleteMessage', { chat_id: chatId, message_id: q.telegram_message_id });
  } catch {
    deleted = { ok: false, description: 'network' };
  }
  if (deleted?.ok) return 'deleted';
  if (/not found/i.test(deleted?.description || '')) return 'gone';
  try {
    const edited = await tg(env, 'editMessageText', {
      chat_id: chatId,
      message_id: q.telegram_message_id,
      text: fallbackText,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [] },
    });
    if (edited?.ok || tgNotModified(edited)) return 'edited';
  } catch { /* fall through */ }
  return 'failed';
}

async function pushAnswer(env, q) {
  if (!env.GROK_ANSWER_WEBHOOK_URL) return { pushed: false };
  const headers = {
    'Content-Type': 'application/json',
    'X-Grok-Event': 'question.answered',
    'X-Grok-Question': q.id,
  };
  if (env.GROK_ANSWER_WEBHOOK_TOKEN) headers.Authorization = `Bearer ${env.GROK_ANSWER_WEBHOOK_TOKEN}`;
  try {
    const res = await fetcher(env)(env.GROK_ANSWER_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ event: 'question.answered', question: publicQuestion(q) }),
      signal: AbortSignal.timeout(5000),
    });
    return { pushed: true, ok: res.ok, status: res.status, at: Date.now() };
  } catch (e) {
    return { pushed: true, ok: false, error: String(e.message || e).slice(0, 300), at: Date.now() };
  }
}

async function markAnswered(env, q, fields) {
  q.answer = String(fields.answer || '').slice(0, ANSWER_MAX);
  q.option_id = fields.option_id ?? null;
  q.via = fields.via || null;
  q.github_action = fields.github_action || null;
  q.status = 'answered';
  q.answered_at = Date.now();
  q.acked_at = null;
  q.resolved_at = null;
  q.resolved_reason = null;
  await editAnswerNote(env, q);
  await saveQuestion(env, q);
  q.webhook_push = await pushAnswer(env, q);
  await kset(env, questionKey(q.id), q);
  return q;
}

async function putQuestion(env, spec, { reopen = false } = {}) {
  requireTelegram(env);
  const existing = await load(env, spec.id);
  const wasOpen = existing?.status === 'open';
  let q;
  if (wasOpen) {
    q = existing;
  } else if (existing && reopen) {
    await dismissMessage(env, existing, 'Вопрос обновлён.');
    if (existing.telegram_message_id) {
      await env.KV.delete(msgKey(existing.telegram_message_id)).catch(() => {});
    }
    q = existing;
    q.status = 'open';
    q.answer = null;
    q.option_id = null;
    q.via = null;
    q.answered_at = null;
    q.acked_at = null;
    q.resolved_at = null;
    q.resolved_reason = null;
    q.github_action = null;
    q.webhook_push = null;
    q.telegram_message_id = null;
  } else if (existing) {
    return { conflict: existing };
  } else {
    q = {
      id: spec.id,
      cb: callbackToken(spec.id),
      created_at: Date.now(),
      status: 'open',
    };
  }

  q.text = spec.text;
  q.title = spec.title || null;
  q.options = spec.options || [];
  q.source = spec.source || null;
  q.link = spec.link || null;
  q.github = spec.github || null;
  q.chat_id = String(env.OWNER_CHAT_ID);
  if (!q.cb) q.cb = callbackToken(q.id);

  try {
    await saveQuestion(env, q);
    const delivered = await deliver(env, q);
    await saveQuestion(env, q);
    return { question: q, delivered, updated: wasOpen };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return {
      question: q,
      delivered: { ok: false, telegram: { description: String(e.message || e) } },
      updated: wasOpen,
    };
  }
}

async function scanQuestions(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.KV.list({ prefix: QUESTION_PREFIX, cursor });
    for (const key of page?.keys || []) {
      const q = await kget(env, key.name, null);
      if (q?.id) out.push(q);
      if (out.length >= 1000) return out;
    }
    if (!page || page.list_complete !== false) break;
    cursor = page.cursor;
  } while (cursor);
  return out;
}

async function pendingQuestions(env) {
  const raw = await kget(env, PENDING_KEY, []);
  const ids = Array.isArray(raw) ? raw : [];
  const out = [];
  const keep = [];
  for (const id of ids) {
    const q = await load(env, id);
    if (q && q.status === 'answered' && !q.acked_at) {
      out.push(q);
      keep.push(id);
    }
  }
  if (keep.length !== ids.length) await kset(env, PENDING_KEY, keep);
  return out;
}

function specFromBody(body, id) {
  if (typeof body.text !== 'string' || !body.text.trim()) throw new HttpError(400, 'text is required');
  return {
    id,
    text: String(body.text).trim().slice(0, TEXT_MAX),
    title: body.title ? cleanLine(body.title, TITLE_MAX) : null,
    options: normalizeOptions(body.options),
    source: body.source ? cleanLine(body.source, 80) : null,
    link: safeLink(body.link),
    github: null,
  };
}

async function readJson(request, limit) {
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, 'payload too large');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'invalid json'); }
}

async function createQuestion(request, env) {
  const body = await readJson(request, 100_000);
  const id = body.id == null || body.id === '' ? randomId('q') : assertId(String(body.id));
  const existing = await load(env, id);
  if (existing && existing.status !== 'open') {
    return json({ ok: false, error: 'question exists', question: publicQuestion(existing) }, 409);
  }
  const result = await putQuestion(env, specFromBody(body, id));
  if (result.conflict) {
    return json({ ok: false, error: 'question exists', question: publicQuestion(result.conflict) }, 409);
  }
  const payload = { ok: result.delivered.ok, updated: result.updated, question: publicQuestion(result.question) };
  if (!result.delivered.ok) {
    return json({ ...payload, error: 'telegram', telegram: tgError(result.delivered.telegram) }, 502);
  }
  return json(payload, result.updated ? 200 : 201);
}

async function listQuestions(env, url) {
  const since = parseSince(url);
  const unacked = url.searchParams.get('unacked') === '1';
  const status = url.searchParams.get('status');
  if (status && !STATUSES.has(status)) throw new HttpError(400, 'bad status');
  let questions = unacked ? await pendingQuestions(env) : await scanQuestions(env);
  if (!unacked) {
    questions = questions.filter((q) => {
      if (status && q.status !== status) return false;
      if (since != null && (q.updated_at || 0) < since) return false;
      return true;
    });
  } else if (since != null) {
    questions = questions.filter((q) => (q.answered_at || 0) >= since);
  }
  questions.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return json({
    ok: true,
    questions: questions.slice(0, LIST_MAX).map(publicQuestion),
    truncated: questions.length > LIST_MAX,
  });
}

async function getQuestion(env, id) {
  const q = await load(env, id);
  if (!q) return json({ ok: false, error: 'not found' }, 404);
  return json({ ok: true, question: publicQuestion(q) });
}

async function listAnswers(env, url) {
  const since = parseSince(url);
  const unackedOnly = since == null
    ? url.searchParams.get('unacked') !== '0'
    : url.searchParams.get('unacked') === '1';
  let questions = unackedOnly ? await pendingQuestions(env) : await scanQuestions(env);
  if (!unackedOnly) {
    questions = questions.filter((q) => q.status === 'answered' && (since == null || (q.answered_at || 0) >= since));
  } else if (since != null) {
    questions = questions.filter((q) => (q.answered_at || 0) >= since);
  }
  questions.sort((a, b) => (a.answered_at || 0) - (b.answered_at || 0));
  return json({
    ok: true,
    answers: questions.slice(0, LIST_MAX).map(publicQuestion),
    truncated: questions.length > LIST_MAX,
  });
}

function parseIds(body) {
  if (!body || !Array.isArray(body.ids) || body.ids.length === 0) throw new HttpError(400, 'ids required');
  if (body.ids.length > 50) throw new HttpError(400, 'at most 50 ids');
  return body.ids.map((id) => (typeof id === 'string' ? id : String(id ?? '')));
}

async function ackIds(env, ids) {
  const acked = [];
  const missing = [];
  const skipped = [];
  for (const raw of ids) {
    if (!ID_RE.test(raw) || raw === 'resolve') { missing.push(raw); continue; }
    const q = await load(env, raw);
    if (!q) { missing.push(raw); continue; }
    if (q.status !== 'answered') { skipped.push(raw); continue; }
    if (!q.acked_at) {
      q.acked_at = Date.now();
      await saveQuestion(env, q);
    }
    acked.push(raw);
  }
  return { ok: true, acked, missing, skipped };
}

async function ackAnswers(request, env) {
  const body = await readJson(request, 20_000);
  return json(await ackIds(env, parseIds(body)));
}

async function ackOne(env, id) {
  const result = await ackIds(env, [id]);
  if (result.missing.length) return json({ ok: false, error: 'not found' }, 404);
  if (result.skipped.length) return json({ ok: false, error: 'not answered', id }, 409);
  const q = await load(env, id);
  return json({ ok: true, question: publicQuestion(q) });
}

function resolveReason(reason) {
  const value = reason == null || reason === '' ? 'answered_elsewhere' : String(reason);
  if (!/^[a-z0-9_]{1,40}$/.test(value)) throw new HttpError(400, 'bad reason');
  return value;
}

function resolvedFallback(q) {
  if (q.resolved_reason === 'github_merged') {
    return `✅ <b>PR смёржен</b>\n${escapeHtml(q.title || q.text || '')}`;
  }
  if (q.resolved_reason === 'github_closed') {
    return `✅ <b>PR закрыт</b>\n${escapeHtml(q.title || q.text || '')}`;
  }
  return 'Отвечено в другом месте.\nanswered elsewhere';
}

async function resolveQuestion(env, id, { answer, reason } = {}) {
  const q = await load(env, id);
  if (!q) return { id, ok: false, error: 'not found' };
  if (q.status === 'resolved') {
    return { id, ok: true, already: true, telegram: 'already_resolved', status: q.status, question: publicQuestion(q) };
  }
  if (answer != null && String(answer).trim()) q.answer = String(answer).trim().slice(0, ANSWER_MAX);
  q.status = 'resolved';
  q.resolved_at = Date.now();
  q.resolved_reason = reason || 'answered_elsewhere';
  const telegram = await dismissMessage(env, q, resolvedFallback(q));
  await saveQuestion(env, q);
  return { id, ok: true, already: false, telegram, status: q.status, question: publicQuestion(q) };
}

async function resolveOne(request, env, id) {
  const body = await readJson(request, 20_000);
  const result = await resolveQuestion(env, id, {
    answer: body.answer,
    reason: resolveReason(body.reason),
  });
  if (!result.ok && result.error === 'not found') return json({ ok: false, error: 'not found' }, 404);
  return json({ ok: true, ...result });
}

async function bulkResolve(request, env) {
  const body = await readJson(request, 20_000);
  const ids = parseIds(body);
  const reason = resolveReason(body.reason);
  const results = [];
  for (const raw of ids) {
    if (!ID_RE.test(raw) || raw === 'resolve') {
      results.push({ id: raw, ok: false, error: 'bad id' });
      continue;
    }
    results.push(await resolveQuestion(env, raw, { answer: body.answer, reason }));
  }
  return json({ ok: true, results });
}

function parseCallback(data) {
  if (typeof data !== 'string' || !data.startsWith('gq:')) return null;
  const rest = data.slice(3);
  const cut = rest.lastIndexOf(':');
  if (cut <= 0) return null;
  const cb = rest.slice(0, cut);
  const action = rest.slice(cut + 1);
  if (!cb || !/^(?:[amsl]|i\d)$/.test(action)) return null;
  return { cb, action };
}

async function githubApi(env, method, path, body) {
  const res = await fetcher(env)(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'tasktracker-grok-bridge',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function runGithubAction(env, q, action) {
  const gh = q.github;
  if (!gh?.owner || !gh?.repo || !gh?.number) {
    return { action, attempted: false, ok: false, skipped_reason: 'no_target' };
  }
  if (!env.GITHUB_TOKEN) {
    return { action, attempted: false, ok: false, skipped_reason: 'no_token' };
  }
  const base = `/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/pulls/${encodeURIComponent(gh.number)}`;
  try {
    const res = action === 'merge'
      ? await githubApi(env, 'PUT', `${base}/merge`, { merge_method: 'merge' })
      : await githubApi(env, 'POST', `${base}/reviews`, { event: 'APPROVE', body: 'Approved from Telegram' });
    return {
      action,
      attempted: true,
      ok: !!res.ok,
      status: res.status,
      error: res.ok ? null : String(res.data?.message || '').slice(0, 300) || null,
    };
  } catch (e) {
    return { action, attempted: true, ok: false, error: String(e.message || e).slice(0, 300) };
  }
}

async function applyButton(env, q, action) {
  if (action.startsWith('i')) {
    const opt = q.options?.[Number(action.slice(1))];
    if (!opt) return { error: 'Нет такого варианта' };
    return { option_id: opt.id, answer: opt.label, via: 'button', toast: 'Записал' };
  }
  const spec = GH_BUTTONS[action];
  if (!spec) return { error: 'Неизвестная кнопка' };
  if ((action === 'a' || action === 'm') && !q.github) return { error: 'Недоступно' };
  const github_action = spec.github ? await runGithubAction(env, q, spec.id) : null;
  let toast = 'Записал';
  if (github_action?.skipped_reason === 'no_token') toast = 'Записал. GitHub не настроен';
  else if (github_action?.ok) toast = spec.id === 'merge' ? 'Merge отправлен' : 'Approve отправлен';
  else if (github_action?.attempted) toast = 'В GitHub не вышло, выбор записан';
  return { option_id: spec.id, answer: spec.id, via: 'button', toast, github_action };
}

async function answerCallback(env, query, text, alert = false) {
  if (!query?.id || !env.TG_TOKEN) return;
  await tg(env, 'answerCallbackQuery', {
    callback_query_id: query.id,
    text: text || undefined,
    show_alert: alert || undefined,
  }).catch(() => {});
}

export async function handleGrokCallback(env, query) {
  try {
    const parsed = parseCallback(query?.data);
    if (!parsed) {
      await answerCallback(env, query, 'Неизвестная кнопка');
      return;
    }
    if (!chatAllowed(env, query?.message?.chat?.id)) {
      await answerCallback(env, query, 'Этот бот личный.', true);
      return;
    }
    const id = await kget(env, cbKey(parsed.cb), null);
    const q = typeof id === 'string' ? await load(env, id) : null;
    if (!q) {
      await answerCallback(env, query, 'Вопрос уже неактуален');
      return;
    }
    if (q.status !== 'open') {
      await answerCallback(env, query, 'Уже закрыто');
      return;
    }
    const applied = await applyButton(env, q, parsed.action);
    if (applied.error) {
      await answerCallback(env, query, applied.error);
      return;
    }
    await markAnswered(env, q, applied);
    await answerCallback(env, query, applied.toast);
  } catch (e) {
    console.error('Grok callback failed:', e);
    await answerCallback(env, query, 'Ошибка, попробуйте ещё раз');
  }
}

export async function grokReplyQuestionId(env, msg) {
  const replyId = msg?.reply_to_message?.message_id;
  if (replyId == null || !env?.KV) return null;
  const id = await kget(env, msgKey(replyId), null);
  return typeof id === 'string' ? id : null;
}

export async function submitGrokReply(env, id, text, msg) {
  if (msg && !chatAllowed(env, msg.chat?.id)) return { ok: false, error: 'forbidden' };
  const q = await load(env, id);
  const chatId = q?.chat_id || env.OWNER_CHAT_ID;
  const tell = async (value) => {
    if (!env.TG_TOKEN || !chatId) return;
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: value,
      reply_to_message_id: msg?.message_id,
    }).catch(() => {});
  };
  if (!q) {
    await tell('Не нашёл этот вопрос.');
    return { ok: false, error: 'not found' };
  }
  if (q.status !== 'open') {
    await tell('Этот вопрос уже закрыт.');
    return { ok: false, error: 'closed' };
  }
  const answer = String(text || '').trim().slice(0, ANSWER_MAX);
  if (!answer) {
    await tell('Не разобрал ответ. Напишите текстом или нажмите кнопку.');
    return { ok: false, error: 'empty' };
  }
  await markAnswered(env, q, { answer, option_id: null, via: 'reply', github_action: null });
  await tell('Записал ответ.');
  return { ok: true, question: publicQuestion(q) };
}

export async function handleGrokApi(request, env, url) {
  try {
    if (!bearerOk(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
    if (!env.KV) return json({ ok: false, error: 'KV binding is not configured' }, 503);
    const path = url.pathname.replace(/\/+$/, '');
    if (path === '/grok/questions' && request.method === 'POST') return await createQuestion(request, env);
    if (path === '/grok/questions' && request.method === 'GET') return await listQuestions(env, url);
    if (path === '/grok/questions/resolve' && request.method === 'POST') return await bulkResolve(request, env);
    if (path === '/grok/answers' && request.method === 'GET') return await listAnswers(env, url);
    if (path === '/grok/answers/ack' && request.method === 'POST') return await ackAnswers(request, env);

    const match = path.match(/^\/grok\/questions\/([^/]+)(?:\/(resolve|ack))?$/);
    if (!match) return json({ ok: false, error: 'not found' }, 404);
    const id = decodeId(match[1]);
    const action = match[2] || '';
    if (request.method === 'GET' && !action) return await getQuestion(env, id);
    if (request.method === 'DELETE' && !action) return await resolveOne(request, env, id);
    if (request.method === 'POST' && action === 'resolve') return await resolveOne(request, env, id);
    if (request.method === 'POST' && action === 'ack') return await ackOne(env, id);
    return json({ ok: false, error: 'method not allowed' }, 405);
  } catch (e) {
    if (e instanceof HttpError) return json({ ok: false, error: e.message }, e.status);
    throw e;
  }
}

function githubQuestionId(fullName, number) {
  const slug = String(fullName || '').replace(/\//g, '__').replace(/[^A-Za-z0-9_.:-]/g, '');
  return `gh:${slug}__${number}`;
}

function githubText(pr, repo, action, reviewer) {
  const labels = {
    opened: 'новый PR',
    reopened: 'PR снова открыт',
    ready_for_review: 'готов к ревью',
    review_requested: 'запрошено ревью',
  };
  const lines = [
    `${repo.full_name} #${pr.number} · ${labels[action] || action}`,
    `Автор: ${pr.user?.login || '?'}`,
  ];
  if (reviewer) lines.push(`Ревьюер: ${reviewer}`);
  return lines.join('\n');
}

function cycleId(baseId) {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return `${baseId}--${Date.now().toString(36)}${hex(bytes)}`;
}

// A later GitHub event must not erase an answer the agent has not fetched yet.
// `opened` is also not replayed into a new message once the PR was already seen.
function notifyPlan(existing, action, baseId) {
  if (!existing) return { mode: 'create', id: baseId };
  if (action === 'opened') {
    return existing.status === 'open'
      ? { mode: 'update', id: existing.id }
      : { mode: 'keep', reason: 'already_seen', question: existing };
  }
  if (existing.status === 'open') return { mode: 'update', id: existing.id };
  if (existing.status === 'answered' && !existing.acked_at) {
    return { mode: 'create', id: cycleId(baseId) };
  }
  const closed = existing.resolved_reason === 'github_merged' || existing.resolved_reason === 'github_closed';
  if (closed && action !== 'reopened' && action !== 'ready_for_review') {
    return { mode: 'keep', reason: 'already_closed', question: existing };
  }
  return { mode: 'reopen', id: existing.id };
}

async function activeQuestion(env, fullName, number, baseId) {
  const pointed = await kget(env, prKey(fullName, number), null);
  if (typeof pointed === 'string') {
    const q = await load(env, pointed);
    if (q) return q;
  }
  return load(env, baseId);
}

async function noteGithubClosed(env, q, merged) {
  if (q.status === 'resolved') {
    return { kept_answer: false, telegram: 'already_resolved', question: q };
  }
  q.github = { ...(q.github || {}), state: merged ? 'merged' : 'closed' };
  const fallback = merged
    ? `✅ <b>PR смёржен</b>\n${escapeHtml(q.title || '')}`
    : `✅ <b>PR закрыт</b>\n${escapeHtml(q.title || '')}`;
  const telegram = await dismissMessage(env, q, fallback);
  if (q.status === 'answered' && !q.acked_at) {
    await saveQuestion(env, q);
    return { kept_answer: true, telegram, question: q };
  }
  q.status = 'resolved';
  q.resolved_at = Date.now();
  q.resolved_reason = merged ? 'github_merged' : 'github_closed';
  await saveQuestion(env, q);
  return { kept_answer: false, telegram, question: q };
}

export async function handleGithubWebhook(request, env) {
  try {
    return await githubWebhook(request, env);
  } catch (e) {
    if (e instanceof HttpError) return json({ ok: false, error: e.message }, e.status);
    throw e;
  }
}

async function githubWebhook(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
  if (!env.GITHUB_WEBHOOK_SECRET) return json({ ok: false, error: 'GITHUB_WEBHOOK_SECRET is not configured' }, 503);
  const raw = await request.text();
  if (raw.length > 2_000_000) return json({ ok: false, error: 'payload too large' }, 413);
  const header = (request.headers.get('x-hub-signature-256') || '').trim().toLowerCase();
  const expected = `sha256=${await hmacSha256Hex(env.GITHUB_WEBHOOK_SECRET, raw)}`;
  if (!safeEqual(header, expected)) return json({ ok: false, error: 'invalid signature' }, 401);
  if (!env.KV) return json({ ok: false, error: 'KV binding is not configured' }, 503);

  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return json({ ok: false, error: 'invalid json' }, 400); }

  const event = request.headers.get('x-github-event') || '';
  if (event === 'ping' || body.zen) return json({ ok: true, pong: true });
  if (event && event !== 'pull_request') {
    return json({ ok: true, ignored: true, reason: `event:${event.slice(0, 40)}` });
  }

  const action = body.action;
  const pr = body.pull_request;
  const repo = body.repository;
  if (!pr || !repo?.full_name || !repo.owner?.login || !pr.number) {
    return json({ ok: false, error: 'missing pull_request' }, 400);
  }

  const id = githubQuestionId(repo.full_name, pr.number);
  if (!ID_RE.test(id)) return json({ ok: false, error: 'bad repository name' }, 400);

  if (action === 'closed') {
    const ids = new Set([id]);
    const pointed = await kget(env, prKey(repo.full_name, pr.number), null);
    if (typeof pointed === 'string') ids.add(pointed);
    let primary = null;
    for (const qid of ids) {
      const q = await load(env, qid);
      if (!q || q.status === 'resolved') continue;
      const wasOpen = q.status === 'open';
      const result = await noteGithubClosed(env, q, !!pr.merged);
      if (!primary || wasOpen) primary = result;
    }
    if (!primary) {
      const q = await load(env, typeof pointed === 'string' ? pointed : id) || await load(env, id);
      if (!q) return json({ ok: true, ignored: true, reason: 'no_question' });
      return json({ ok: true, action, telegram: 'already_resolved', kept_answer: false, question: publicQuestion(q) });
    }
    return json({
      ok: true,
      action,
      telegram: primary.telegram,
      kept_answer: primary.kept_answer,
      question: publicQuestion(primary.question),
    });
  }

  const notify = action === 'opened' || action === 'reopened' || action === 'ready_for_review' || action === 'review_requested';
  if (!notify) return json({ ok: true, ignored: true, reason: `action:${String(action || '').slice(0, 40)}` });
  if ((action === 'opened' || action === 'reopened') && pr.draft) {
    return json({ ok: true, ignored: true, reason: 'draft' });
  }

  const reviewer = body.requested_reviewer?.login || body.requested_team?.name || null;
  let link = null;
  try { link = safeLink(pr.html_url); } catch { link = null; }
  const base = await load(env, id);
  const active = await activeQuestion(env, repo.full_name, pr.number, id);
  const plan = notifyPlan(action === 'opened' ? base : active, action, id);
  if (plan.mode === 'keep') {
    return json({
      ok: true,
      ignored: true,
      reason: plan.reason,
      action,
      question: publicQuestion(plan.question),
    });
  }
  const result = await putQuestion(env, {
    id: plan.id,
    title: cleanLine(pr.title || `PR #${pr.number}`, TITLE_MAX),
    text: githubText(pr, repo, action, reviewer).slice(0, TEXT_MAX),
    options: [],
    source: 'github',
    link,
    github: {
      owner: repo.owner.login,
      repo: repo.name,
      full_name: repo.full_name,
      number: pr.number,
      html_url: link,
      action,
      sender: body.sender?.login || null,
      reviewer,
      state: 'open',
    },
  }, { reopen: plan.mode === 'reopen' });

  if (result.conflict) {
    return json({ ok: false, error: 'question exists', question: publicQuestion(result.conflict) }, 409);
  }
  await kset(env, prKey(repo.full_name, pr.number), result.question.id);
  const payload = {
    ok: result.delivered.ok,
    action,
    updated: result.updated,
    question: publicQuestion(result.question),
  };
  if (!result.delivered.ok) {
    return json({ ...payload, error: 'telegram', telegram: tgError(result.delivered.telegram) }, 502);
  }
  return json(payload, result.updated ? 200 : 201);
}
