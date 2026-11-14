// node --import ./grok/test-register.mjs --test grok/bridge.test.mjs
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  handleGrokApi,
  handleGithubWebhook,
  handleGrokCallback,
  grokReplyQuestionId,
  submitGrokReply,
} from './bridge.js';

function httpJson(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return obj; },
    async text() { return JSON.stringify(obj); },
  };
}

function makeEnv(overrides = {}) {
  const store = new Map();
  const calls = [];
  let seq = 1000;
  const env = {
    GROK_BRIDGE_TOKEN: 'secret',
    TG_TOKEN: 'tg-token',
    OWNER_CHAT_ID: '111',
    GITHUB_WEBHOOK_SECRET: 'gh-secret',
    calls,
    store,
    failDelete: false,
    githubStatus: 200,
    KV: {
      async get(key, type) {
        if (!store.has(key)) return null;
        const raw = store.get(key);
        if (type === 'json') {
          try { return JSON.parse(raw); } catch { return null; }
        }
        return raw;
      },
      async put(key, value) { store.set(key, String(value)); },
      async delete(key) { store.delete(key); },
      async list({ prefix }) {
        const keys = [...store.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name }));
        return { keys, list_complete: true };
      },
    },
    async fetch(url, init) {
      const target = String(url);
      let body = null;
      if (init?.body) {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
      }
      calls.push({ url: target, method: init?.method || 'GET', body, headers: init?.headers || {} });
      if (target.includes('api.telegram.org')) {
        const method = target.slice(target.lastIndexOf('/') + 1);
        if (method === 'sendMessage') return httpJson({ ok: true, result: { message_id: ++seq } });
        if (method === 'editMessageText') return httpJson({ ok: true, result: { message_id: body?.message_id || seq } });
        if (method === 'deleteMessage') {
          if (env.failDelete) return httpJson({ ok: false, error_code: 400, description: "Bad Request: message can't be deleted for everyone" });
          return httpJson({ ok: true, result: true });
        }
        if (method === 'answerCallbackQuery') return httpJson({ ok: true, result: true });
        return httpJson({ ok: false, description: `unexpected telegram method ${method}` }, 404);
      }
      if (target.includes('api.github.com')) {
        const status = env.githubStatus;
        return httpJson(status >= 200 && status < 300 ? { id: 1, merged: true } : { message: 'Merge conflict' }, status);
      }
      if (target === env.GROK_ANSWER_WEBHOOK_URL) return httpJson({ ok: true });
      return httpJson({ ok: false, error: 'unexpected url ' + target }, 404);
    },
  };
  Object.assign(env, overrides);
  return env;
}

async function api(env, path, { method = 'GET', body, token = 'secret' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await handleGrokApi(new Request('https://bot.example' + path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  }), env, new URL('https://bot.example' + path));
  return { status: res.status, data: await res.json() };
}

function sign(secret, body) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

async function github(env, payload, { event = 'pull_request', secret = 'gh-secret' } = {}) {
  const raw = JSON.stringify(payload);
  const res = await handleGithubWebhook(new Request('https://bot.example/github/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-Hub-Signature-256': sign(secret, raw),
    },
    body: raw,
  }), env);
  return { status: res.status, data: await res.json() };
}

function prPayload(action, extra = {}) {
  return {
    action,
    pull_request: {
      number: extra.number || 72,
      title: extra.title || 'Fix login',
      html_url: extra.html_url || 'https://github.com/octocat/hello/pull/72',
      draft: !!extra.draft,
      merged: !!extra.merged,
      user: { login: extra.author || 'oleg' },
    },
    repository: {
      full_name: extra.full_name || 'octocat/hello',
      name: extra.repo || 'hello',
      owner: { login: extra.owner || 'octocat' },
    },
    sender: { login: 'oleg' },
    requested_reviewer: extra.reviewer ? { login: extra.reviewer } : undefined,
  };
}

function tgCalls(env, method) {
  return env.calls.filter((call) => call.url.includes(`/${method}`));
}

describe('grok bridge', { concurrency: 1 }, () => {
  it('rejects missing and wrong bearer tokens', async () => {
    const env = makeEnv();
    const missing = await api(env, '/grok/answers', { token: '' });
    assert.equal(missing.status, 401);
    assert.equal(missing.data.error, 'unauthorized');
    const wrong = await api(env, '/grok/answers', { token: 'nope' });
    assert.equal(wrong.status, 401);
  });

  it('creates a question, accepts a button and a reply, then ack clears the queue', async () => {
    const env = makeEnv({
      GROK_ANSWER_WEBHOOK_URL: 'https://agent.example/hook',
      GROK_ANSWER_WEBHOOK_TOKEN: 'hook-secret',
    });
    const created = await api(env, '/grok/questions', {
      method: 'POST',
      body: {
        id: 'choice1',
        text: 'Какой вариант? <b>',
        title: 'Выбор',
        source: 'grok',
        link: 'https://example.com/q',
        options: ['Да', { id: 'no', label: 'Нет' }],
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.question.status, 'open');
    assert.equal(created.data.question.telegram_message_id, 1001);
    assert.deepEqual(created.data.question.options.map((opt) => opt.id), ['i0', 'no']);

    const sent = tgCalls(env, 'sendMessage')[0].body;
    assert.match(sent.text, /&lt;b&gt;/);
    assert.equal(sent.reply_markup.inline_keyboard[0][0].callback_data, 'gq:choice1:i0');
    assert.equal(sent.reply_markup.inline_keyboard[2][0].url, 'https://example.com/q');
    assert.equal(await grokReplyQuestionId(env, { reply_to_message: { message_id: 1001 } }), 'choice1');

    const updated = await api(env, '/grok/questions', {
      method: 'POST',
      body: { id: 'choice1', text: 'Обновлённый текст', options: ['Да'] },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.updated, true);
    assert.equal(tgCalls(env, 'sendMessage').length, 1);
    assert.match(tgCalls(env, 'editMessageText').at(-1).body.text, /Обновлённый текст/);

    await handleGrokCallback(env, {
      id: 'cb1',
      data: 'gq:choice1:i0',
      from: { id: 111 },
      message: { message_id: 1001, chat: { id: 111 } },
    });
    let answers = await api(env, '/grok/answers');
    assert.equal(answers.data.answers.length, 1);
    assert.equal(answers.data.answers[0].option_id, 'i0');
    assert.equal(answers.data.answers[0].answer, 'Да');
    assert.equal(answers.data.answers[0].via, 'button');
    assert.equal(answers.data.answers[0].status, 'answered');

    const pushed = env.calls.find((call) => call.url === 'https://agent.example/hook');
    assert.equal(pushed.headers.Authorization, 'Bearer hook-secret');
    assert.equal(pushed.headers['X-Grok-Event'], 'question.answered');
    assert.equal(pushed.body.event, 'question.answered');
    assert.equal(pushed.body.question.id, 'choice1');

    const again = await api(env, '/grok/questions', {
      method: 'POST',
      body: { id: 'choice1', text: 'ещё раз' },
    });
    assert.equal(again.status, 409);

    const acked = await api(env, '/grok/answers/ack', { method: 'POST', body: { ids: ['choice1', 'missing'] } });
    assert.deepEqual(acked.data.acked, ['choice1']);
    assert.deepEqual(acked.data.missing, ['missing']);
    answers = await api(env, '/grok/answers');
    assert.deepEqual(answers.data.answers, []);
    const since = await api(env, `/grok/answers?since=${created.data.question.created_at}`);
    assert.equal(since.data.answers.length, 1);
    assert.equal(since.data.answers[0].acked_at > 0, true);
    const later = await api(env, `/grok/answers?since=${since.data.answers[0].answered_at + 1}`);
    assert.deepEqual(later.data.answers, []);

    const second = await api(env, '/grok/questions/ack-nope');
    assert.equal(second.status, 404);
  });

  it('records a free-text reply and escapes it', async () => {
    const env = makeEnv();
    const created = await api(env, '/grok/questions', {
      method: 'POST',
      body: { id: 'free1', text: 'Что думаешь?' },
    });
    const messageId = created.data.question.telegram_message_id;
    const foreign = await submitGrokReply(env, 'free1', 'нет', { message_id: 9, chat: { id: 999 } });
    assert.equal(foreign.error, 'forbidden');
    assert.equal((await api(env, '/grok/questions/free1')).data.question.status, 'open');

    const reply = await submitGrokReply(env, 'free1', '  <ok>  ', {
      message_id: 9,
      chat: { id: '111' },
      reply_to_message: { message_id: messageId },
    });
    assert.equal(reply.ok, true);
    assert.equal(reply.question.via, 'reply');
    assert.equal(reply.question.answer, '<ok>');
    assert.match(tgCalls(env, 'editMessageText').at(-1).body.text, /&lt;ok&gt;/);
    assert.equal(tgCalls(env, 'sendMessage').at(-1).body.text, 'Записал ответ.');
    const empty = await submitGrokReply(env, 'free1', '   ', { message_id: 10, chat: { id: 111 } });
    assert.equal(empty.error, 'closed');
  });

  it('rejects a button press from another chat', async () => {
    const env = makeEnv();
    await api(env, '/grok/questions', { method: 'POST', body: { id: 'own1', text: 'Только Олег', options: ['Ок'] } });
    await handleGrokCallback(env, {
      id: 'cb-foreign',
      data: 'gq:own1:i0',
      message: { message_id: 1001, chat: { id: 999 } },
    });
    const q = await api(env, '/grok/questions/own1');
    assert.equal(q.data.question.status, 'open');
    assert.match(tgCalls(env, 'answerCallbackQuery').at(-1).body.text, /личный/);
  });

  it('resolves one question, falls back when delete fails, and resolves a set', async () => {
    const env = makeEnv();
    await api(env, '/grok/questions', { method: 'POST', body: { id: 'r1', text: 'Первый' } });
    await api(env, '/grok/questions', { method: 'POST', body: { id: 'r2', text: 'Второй' } });
    const gone = await api(env, '/grok/questions/r1/resolve', {
      method: 'POST',
      body: { answer: 'уже в приложении', reason: 'answered_elsewhere' },
    });
    assert.equal(gone.status, 200);
    assert.equal(gone.data.telegram, 'deleted');
    assert.equal(gone.data.question.status, 'resolved');
    assert.equal(gone.data.question.answer, 'уже в приложении');
    assert.equal(gone.data.question.resolved_reason, 'answered_elsewhere');
    const repeat = await api(env, '/grok/questions/r1/resolve', { method: 'POST', body: {} });
    assert.equal(repeat.data.already, true);

    env.failDelete = true;
    const edited = await api(env, '/grok/questions/r2', { method: 'DELETE' });
    assert.equal(edited.data.telegram, 'edited');
    assert.match(tgCalls(env, 'editMessageText').at(-1).body.text, /answered elsewhere/);
    assert.match(tgCalls(env, 'editMessageText').at(-1).body.text, /Отвечено в другом месте/);

    await api(env, '/grok/questions', { method: 'POST', body: { id: 'r3', text: 'Третий' } });
    const bulk = await api(env, '/grok/questions/resolve', {
      method: 'POST',
      body: { ids: ['r3', 'nope'], reason: 'sync' },
    });
    assert.equal(bulk.data.results[0].ok, true);
    assert.equal(bulk.data.results[0].question.resolved_reason, 'sync');
    assert.equal(bulk.data.results[1].error, 'not found');
    const open = await api(env, '/grok/questions?status=open');
    assert.deepEqual(open.data.questions, []);
  });

  it('validates input', async () => {
    const env = makeEnv();
    assert.equal((await api(env, '/grok/questions', { method: 'POST', body: {} })).status, 400);
    assert.equal((await api(env, '/grok/questions', { method: 'POST', body: { text: 'x', link: 'javascript:alert(1)' } })).status, 400);
    assert.equal((await api(env, '/grok/questions/bad!id')).status, 400);
    assert.equal((await api(env, '/grok/answers?since=yesterday')).status, 400);
    assert.equal((await api(env, '/grok/questions/missing')).status, 404);
  });

  it('verifies the GitHub signature and ignores drafts', async () => {
    const env = makeEnv();
    const bad = await github(env, prPayload('opened'), { secret: 'wrong' });
    assert.equal(bad.status, 401);
    assert.equal(env.store.size, 0);

    const ping = await github(env, { zen: 'keep-alive' }, { event: 'ping' });
    assert.equal(ping.data.pong, true);

    const other = await github(env, { action: 'created' }, { event: 'issues' });
    assert.equal(other.data.ignored, true);

    const draft = await github(env, prPayload('opened', { draft: true }));
    assert.equal(draft.data.reason, 'draft');
    assert.equal(tgCalls(env, 'sendMessage').length, 0);

    const get = await handleGithubWebhook(new Request('https://bot.example/github/webhook'), env);
    assert.equal(get.status, 405);
  });

  it('posts a PR with short callback buttons and review text', async () => {
    const env = makeEnv();
    const repo = 'r'.repeat(80);
    const coords = {
      full_name: `octocat/${repo}`,
      repo,
      title: 'Long repo PR',
      html_url: 'https://github.com/octocat/hello/pull/72',
    };
    const opened = await github(env, prPayload('opened', coords));
    assert.equal(opened.status, 201);
    assert.equal(opened.data.question.source, 'github');
    assert.equal(opened.data.question.github.number, 72);
    const markup = tgCalls(env, 'sendMessage')[0].body.reply_markup.inline_keyboard;
    const labels = markup.flat().map((btn) => btn.text);
    assert.deepEqual(labels, ['✅ Approve', '🔀 Merge', '👀 Посмотрел', '⏭ Пропустить', '🔗 Открыть PR']);
    for (const btn of markup.flat()) {
      if (btn.callback_data) assert.ok(Buffer.byteLength(btn.callback_data) <= 64, btn.callback_data);
    }

    const review = await github(env, prPayload('review_requested', { ...coords, reviewer: 'oleg' }));
    assert.equal(review.data.updated, true);
    assert.match(tgCalls(env, 'editMessageText').at(-1).body.text, /Ревьюер: oleg/);
  });

  it('records Approve without a token and calls GitHub when a token is set', async () => {
    const env = makeEnv();
    const opened = await github(env, prPayload('opened', { title: 'Needs review' }));
    const cb = tgCalls(env, 'sendMessage')[0].body.reply_markup.inline_keyboard[0][0].callback_data;
    assert.match(cb, /:a$/);
    await handleGrokCallback(env, {
      id: 'ap1',
      data: cb,
      message: { message_id: opened.data.question.telegram_message_id, chat: { id: 111 } },
    });
    let q = (await api(env, `/grok/questions/${encodeURIComponent(opened.data.question.id)}`)).data.question;
    assert.equal(q.option_id, 'approve');
    assert.equal(q.answer, 'approve');
    assert.equal(q.github_action.skipped_reason, 'no_token');
    assert.equal(env.calls.some((call) => call.url.includes('api.github.com')), false);
    assert.match(tgCalls(env, 'editMessageText').at(-1).body.text, /Approve/);

    await handleGrokCallback(env, {
      id: 'ap2',
      data: cb,
      message: { message_id: q.telegram_message_id, chat: { id: 111 } },
    });
    q = (await api(env, `/grok/questions/${encodeURIComponent(q.id)}`)).data.question;
    assert.equal(q.github_action.skipped_reason, 'no_token');

    const env2 = makeEnv({ GITHUB_TOKEN: 'ghp_test' });
    const opened2 = await github(env2, prPayload('opened'));
    const buttons = tgCalls(env2, 'sendMessage')[0].body.reply_markup.inline_keyboard;
    await handleGrokCallback(env2, {
      id: 'mg',
      data: buttons[0][1].callback_data,
      message: { message_id: opened2.data.question.telegram_message_id, chat: { id: 111 } },
    });
    const mergeCall = env2.calls.find((call) => call.url.includes('api.github.com'));
    assert.equal(mergeCall.method, 'PUT');
    assert.equal(mergeCall.url, 'https://api.github.com/repos/octocat/hello/pulls/72/merge');
    assert.equal(mergeCall.headers.Authorization, 'Bearer ghp_test');
    assert.equal(mergeCall.body.merge_method, 'merge');
    const merged = (await api(env2, `/grok/questions/${encodeURIComponent(opened2.data.question.id)}`)).data.question;
    assert.equal(merged.github_action.ok, true);
    assert.equal(merged.option_id, 'merge');

    const env3 = makeEnv({ GITHUB_TOKEN: 'ghp_test', githubStatus: 422 });
    const opened3 = await github(env3, prPayload('opened', { number: 8, html_url: 'https://github.com/octocat/hello/pull/8' }));
    const approve = tgCalls(env3, 'sendMessage')[0].body.reply_markup.inline_keyboard[0][0].callback_data;
    await handleGrokCallback(env3, {
      id: 'bad',
      data: approve,
      message: { message_id: opened3.data.question.telegram_message_id, chat: { id: 111 } },
    });
    const failed = (await api(env3, `/grok/questions/${encodeURIComponent(opened3.data.question.id)}`)).data.question;
    assert.equal(failed.status, 'answered');
    assert.equal(failed.github_action.ok, false);
    assert.equal(failed.github_action.status, 422);
    const reviewCall = env3.calls.find((call) => call.url.includes('/reviews'));
    assert.equal(reviewCall.method, 'POST');
    assert.equal(reviewCall.body.event, 'APPROVE');
  });

  it('deletes the PR message when GitHub closes it, but keeps an unacked answer', async () => {
    const env = makeEnv();
    const opened = await github(env, prPayload('opened'));
    const id = opened.data.question.id;
    const closed = await github(env, prPayload('closed', { merged: true }));
    assert.equal(closed.data.telegram, 'deleted');
    assert.equal(closed.data.question.status, 'resolved');
    assert.equal(closed.data.question.resolved_reason, 'github_merged');
    assert.equal((await api(env, '/grok/answers')).data.answers.length, 0);

    const env2 = makeEnv();
    const opened2 = await github(env2, prPayload('opened'));
    const skip = tgCalls(env2, 'sendMessage')[0].body.reply_markup.inline_keyboard[1][1].callback_data;
    assert.match(skip, /:s$/);
    await handleGrokCallback(env2, {
      id: 'sk',
      data: skip,
      message: { message_id: opened2.data.question.telegram_message_id, chat: { id: 111 } },
    });
    const after = await github(env2, prPayload('closed', { merged: false }));
    assert.equal(after.data.kept_answer, true);
    assert.equal(after.data.question.status, 'answered');
    assert.equal(after.data.question.github.state, 'closed');
    const queued = await api(env2, '/grok/answers');
    assert.equal(queued.data.answers.length, 1);
    assert.equal(queued.data.answers[0].option_id, 'skip');
    assert.equal(id.startsWith('gh:'), true);
  });

  it('does not drop an unacked answer when another PR event arrives', async () => {
    const env = makeEnv();
    const opened = await github(env, prPayload('opened'));
    const skip = tgCalls(env, 'sendMessage')[0].body.reply_markup.inline_keyboard[1][1].callback_data;
    await handleGrokCallback(env, {
      id: 'sk2',
      data: skip,
      message: { message_id: opened.data.question.telegram_message_id, chat: { id: 111 } },
    });
    const review = await github(env, prPayload('review_requested', { reviewer: 'oleg' }));
    assert.notEqual(review.data.question.id, opened.data.question.id);
    assert.equal(review.data.question.status, 'open');
    const answers = await api(env, '/grok/answers');
    assert.equal(answers.data.answers.length, 1);
    assert.equal(answers.data.answers[0].id, opened.data.question.id);
    assert.equal(answers.data.answers[0].option_id, 'skip');

    const replay = await github(env, prPayload('opened'));
    assert.equal(replay.data.reason, 'already_seen');
    assert.equal(tgCalls(env, 'sendMessage').length, 2);

    const closed = await github(env, prPayload('closed', { merged: true }));
    assert.equal(closed.data.question.status, 'resolved');
    const still = await api(env, '/grok/answers');
    assert.equal(still.data.answers.length, 1);
    assert.equal(still.data.answers[0].github.state, 'merged');
  });

  it('posts again when a closed PR is reopened', async () => {
    const env = makeEnv();
    const opened = await github(env, prPayload('opened'));
    await github(env, prPayload('closed', { merged: false }));
    const again = await github(env, prPayload('opened'));
    assert.equal(again.data.reason, 'already_seen');
    assert.equal(tgCalls(env, 'sendMessage').length, 1);
    const reopened = await github(env, prPayload('reopened'));
    assert.equal(reopened.data.question.status, 'open');
    assert.equal(reopened.data.question.id, opened.data.question.id);
    assert.equal(tgCalls(env, 'sendMessage').length, 2);
  });
});

describe('worker wiring', { concurrency: 1 }, () => {
  it('serves the inbox through the worker and leaves existing callbacks alone', async () => {
    const worker = (await import('../worker.js')).default;
    const env = makeEnv();
    const denied = await worker.fetch(new Request('https://bot.example/grok/answers'), env, {});
    assert.equal(denied.status, 401);

    const createdRes = await worker.fetch(new Request('https://bot.example/grok/questions', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'viaworker', text: 'Из воркера', options: ['Ок'] }),
    }), env, {});
    const created = await createdRes.json();
    assert.equal(createdRes.status, 201);
    const messageId = created.question.telegram_message_id;

    const callbackRes = await worker.fetch(new Request('https://bot.example/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query: {
          id: 'wcb',
          data: 'gq:viaworker:i0',
          message: { message_id: messageId, chat: { id: 111 } },
        },
      }),
    }), env, {});
    assert.equal(callbackRes.status, 200);
    assert.equal((await api(env, '/grok/questions/viaworker')).data.question.answer, 'Ок');

    const env2 = makeEnv();
    const created2Res = await worker.fetch(new Request('https://bot.example/grok/questions', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'reply1', text: 'Ответь реплаем' }),
    }), env2, {});
    const created2 = await created2Res.json();
    const replyRes = await worker.fetch(new Request('https://bot.example/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          message_id: 50,
          chat: { id: 111 },
          text: 'текстом',
          reply_to_message: { message_id: created2.question.telegram_message_id },
        },
      }),
    }), env2, {});
    assert.equal(replyRes.status, 200);
    assert.equal((await api(env2, '/grok/questions/reply1')).data.question.answer, 'текстом');

    const prev = globalThis.fetch;
    const outside = [];
    globalThis.fetch = async (url, init) => {
      outside.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      return httpJson({ ok: true, result: { message_id: 1 } });
    };
    try {
      await worker.fetch(new Request('https://bot.example/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            message_id: 51,
            chat: { id: 999 },
            text: 'чужой',
            reply_to_message: { message_id: created2.question.telegram_message_id },
          },
        }),
      }), env2, {});
      assert.equal((await api(env2, '/grok/questions/reply1')).data.question.answer, 'текстом');
      assert.match(outside.at(-1).body.text, /личный/);

      outside.length = 0;
      await worker.fetch(new Request('https://bot.example/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query: { id: 'task1', data: 'taskdone:yes', message: { chat: { id: 111 }, message_id: 3 } },
        }),
      }), env2, {});
      assert.equal(outside.some((call) => call.url.includes('answerCallbackQuery')), true);
      assert.equal(outside.some((call) => String(call.body?.text || '').includes('Отметил')), false);

      await env2.KV.put('reelmsg:77', JSON.stringify({ id: 'reel1', version: '1', title: 'Demo' }));
      outside.length = 0;
      await worker.fetch(new Request('https://bot.example/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            message_id: 80,
            chat: { id: 111 },
            text: 'поправь цвет',
            reply_to_message: { message_id: 77 },
          },
        }),
      }), env2, {});
      assert.match(outside.at(-1).body.text, /Принял правки/);

      outside.length = 0;
      await worker.fetch(new Request('https://bot.example/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { message_id: 81, chat: { id: 111 }, text: '/help' } }),
      }), env2, {});
      assert.match(outside.at(-1).body.text, /Ассистент и PR/);
    } finally {
      globalThis.fetch = prev;
    }
  });
});
