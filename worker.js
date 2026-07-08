// Personal brand Reels coach bot — Cloudflare Worker
// Telegram bot only, no Mini App

// ── Constants ────────────────────────────────────────────────────────────────

const TZ_OFFSET = 3; // Moscow UTC+3
const FORMATS = ['история', 'мнение', 'туториал', 'разоблачение', 'лайфхак'];

const LEVELS = [
  { xp: 0,    emoji: '🌱', name: 'Новичок' },
  { xp: 200,  emoji: '⚡', name: 'Контентщик' },
  { xp: 500,  emoji: '🎬', name: 'Режиссёр' },
  { xp: 1000, emoji: '🔥', name: 'Инфлюенсер' },
  { xp: 2000, emoji: '💎', name: 'Эксперт' },
  { xp: 4000, emoji: '👑', name: 'Легенда' },
];

const ONBOARDING_STEPS = [
  {
    key: 'niche',
    q: 'Привет! Я твой личный тренер по Reels и личному бренду 🎬\n\nНачнём с профиля.\n\n<b>Какая твоя ниша?</b> Чем занимаешься, о чём будешь снимать?',
  },
  {
    key: 'interests',
    q: '<b>Что тебе интересно рассказывать?</b>\nТемы, которые тебя зажигают — перечисли через запятую.',
  },
  {
    key: 'goals',
    q: '<b>Какова главная цель через Reels?</b>\nНапример: клиенты, узнаваемость, нетворкинг — или что-то своё.',
  },
  {
    key: 'tone',
    q: '<b>Выбери тон общения:</b>',
    keyboard: {
      inline_keyboard: [[
        { text: '⚡ Прямой и честный', callback_data: 'ob:direct' },
        { text: '😊 Дружелюбный', callback_data: 'ob:friendly' },
      ]],
    },
  },
];

// ── KV helpers ────────────────────────────────────────────────────────────────

async function kget(env, key, def = null) {
  const val = await env.KV.get(key, 'json');
  return val ?? def;
}

async function kset(env, key, val, opts = {}) {
  await env.KV.put(key, JSON.stringify(val), opts);
}

// ── Profile ───────────────────────────────────────────────────────────────────

function defaultProfile() {
  return {
    niche: null,
    interests: [],
    goals: null,
    tone: 'direct',
    instructions: [], // user-editable via natural language
    formatIndex: 0,
    xp: 0,
    streak: 0,
    lastReelDate: null,
    totalReels: 0,
    onboardingDone: false,
  };
}

function getLevel(xp) {
  let level = LEVELS[0];
  for (const l of LEVELS) {
    if (xp >= l.xp) level = l;
    else break;
  }
  return level;
}

function getNextLevel(xp) {
  return LEVELS.find(l => l.xp > xp) ?? null;
}

// Returns new level object if levelled up, otherwise null
function applyXP(profile, amount) {
  const oldLevel = getLevel(profile.xp);
  profile.xp += amount;
  const newLevel = getLevel(profile.xp);
  return oldLevel.name !== newLevel.name ? newLevel : null;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function todayMSK() {
  const d = new Date(Date.now() + TZ_OFFSET * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function prevDay(dateStr) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── Claude ────────────────────────────────────────────────────────────────────

const CLAUDE_BASE_SYSTEM = `Ты коуч по личному бренду и Reels в Telegram-боте.
Форматирование — только HTML для Telegram: <b>жирный</b>, <i>курсив</i>, <code>код</code>, <pre>таблица</pre>. Не используй Markdown-звёздочки (**), решётки (#) и другие markdown-символы.
Отвечай кратко и конкретно. Не задавай уточняющих вопросов — просто выполни задачу. Не добавляй «если хочешь», «дай знать», «готов помочь» и подобные фразы.`;

// Non-streaming call — for JSON parsing, short utility calls
async function callClaude(env, { system = '', user, search = false, json = false } = {}) {
  const fullSystem = system ? `${CLAUDE_BASE_SYSTEM}\n\n${system}` : CLAUDE_BASE_SYSTEM;
  const reqBody = {
    model: 'claude-opus-4-8',
    max_tokens: 2048,
    system: fullSystem,
    messages: [{ role: 'user', content: user }],
  };

  if (search) {
    reqBody.tools = [{ type: 'web_search_20260209', name: 'web_search' }];
  }

  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.CLAUDE_API,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(reqBody),
      });

      if (res.status === 429 && attempts < 3) {
        await new Promise(r => setTimeout(r, 1000 * attempts));
        continue;
      }

      if (!res.ok) throw new Error(`Claude ${res.status}`);

      const data = await res.json();
      const text = data.content
        ?.filter(b => b.type === 'text')
        ?.map(b => b.text)
        ?.join('') ?? '';

      if (json) {
        try {
          return JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
        } catch {
          return null;
        }
      }
      return text.trim();
    } catch (e) {
      if (attempts >= 3) throw e;
    }
  }
}

// Streaming call — sends initial Telegram message, then edits it progressively
async function callClaudeStreaming(env, { system = '', user }, msgId) {
  const fullSystem = system ? `${CLAUDE_BASE_SYSTEM}\n\n${system}` : CLAUDE_BASE_SYSTEM;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.CLAUDE_API,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 2048,
      stream: true,
      system: fullSystem,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!res.ok) throw new Error(`Claude stream ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let lastEditAt = 0;
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]' || !payload) continue;
      try {
        const ev = JSON.parse(payload);
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          fullText += ev.delta.text;
          const now = Date.now();
          if (msgId && now - lastEditAt > 1200) {
            lastEditAt = now;
            await tgEdit(env, msgId, fullText + ' ▍');
          }
        }
      } catch {}
    }
  }

  // Final edit without cursor
  if (msgId && fullText) await tgEdit(env, msgId, fullText);
  return fullText.trim();
}

async function transcribeVoice(env, fileUrl) {
  // Claude does not support audio transcription — voice messages are not available
  console.log('Voice transcription not supported with Claude API, fileUrl:', fileUrl);
  return '';
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function tgReq(env, method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json();
}

async function send(env, text, extra = {}) {
  return tgReq(env, 'sendMessage', {
    chat_id: env.OWNER_CHAT_ID,
    text,
    parse_mode: 'HTML',
    ...extra,
  });
}

// Returns message_id from sent message
async function sendGetId(env, text, extra = {}) {
  const res = await send(env, text, extra);
  return res?.result?.message_id ?? null;
}

async function editMsg(env, messageId, text, extra = {}) {
  return tgReq(env, 'editMessageText', {
    chat_id: env.OWNER_CHAT_ID,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...extra,
  });
}

// Silent edit used during streaming — ignores errors (e.g. "message not modified")
async function tgEdit(env, messageId, text) {
  try {
    await tgReq(env, 'editMessageText', {
      chat_id: env.OWNER_CHAT_ID,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
    });
  } catch {}
}

async function typing(env) {
  return tgReq(env, 'sendChatAction', { chat_id: env.OWNER_CHAT_ID, action: 'typing' });
}

async function getVoiceFileUrl(env, fileId) {
  const res = await tgReq(env, 'getFile', { file_id: fileId });
  const path = res.result?.file_path;
  return path ? `https://api.telegram.org/file/bot${env.TG_TOKEN}/${path}` : null;
}

// ── Content generation ────────────────────────────────────────────────────────

function buildProfileContext(profile) {
  const lines = [
    `Ниша: ${profile.niche || 'предприниматель, личный бренд'}`,
    `Интересы: ${profile.interests.join(', ') || 'бизнес, продуктивность'}`,
    `Цель: ${profile.goals || 'развитие личного бренда'}`,
    `Тон: ${profile.tone === 'friendly' ? 'дружелюбный' : 'прямой и честный'}`,
  ];
  if (profile.instructions.length) {
    lines.push(`Предпочтения:\n${profile.instructions.map(i => `- ${i}`).join('\n')}`);
  }
  return lines.join('\n');
}

async function generateQuestion(env, profile) {
  const format = FORMATS[profile.formatIndex % FORMATS.length];

  const ideas = await kget(env, 'ideas', []);
  const ideasCtx = ideas.length
    ? `\nИдеи из банка тем (можно использовать):\n${ideas.slice(-10).map(i => `- ${i.summary}`).join('\n')}`
    : '';

  const history = await kget(env, 'questions:log', []);
  const histCtx = history.length
    ? `\nУже заданные вопросы (не повторять):\n${history.slice(-30).join('\n')}`
    : '';

  const question = await callClaude(env, {
    user: `Ты помогаешь создавать контент для Instagram Reels.\n\nПрофиль:\n${buildProfileContext(profile)}\n${ideasCtx}\n${histCtx}\n\nФормат рилса на сегодня: "${format}"\n\nЗадача: найди актуальный тренд или новость (используй поиск) и сформулируй ОДИН вопрос для размышления вслух. Вопрос должен:\n- Быть связан с нишей пользователя и актуальным трендом/событием\n- Провоцировать личную историю, мнение или опыт\n- Быть коротким (1–2 предложения)\n\nОтветь ТОЛЬКО вопросом, без предисловий и объяснений.`,
    search: true,
  });

  // Save to history
  history.push(question);
  if (history.length > 100) history.shift();
  await kset(env, 'questions:log', history);

  return { question, format };
}

async function generateScenario(env, profile, question, answer, format, msgId = null) {
  return callClaudeStreaming(env, {
    user: `Профиль:\n${buildProfileContext(profile)}\n\nФормат: ${format}\nВопрос дня: ${question}\nОтвет пользователя: ${answer}\n\nСценарий Reel до 60 сек:\n\n🎣 <b>КРЮЧОК</b> — фраза для первых 3 секунд\n💡 <b>СУТЬ</b> — 2–3 тезиса\n📢 <b>ПРИЗЫВ</b> — что сделать зрителю\n\nТолько сценарий, без предисловий.`,
  }, msgId);
}

// ── Checklist ─────────────────────────────────────────────────────────────────

function checklistText(cl) {
  const { recorded, edited, posted } = cl.steps;
  return `📋 <b>Чек-лист</b>\n\n${recorded ? '✅' : '⬜'} Записал рилс\n${edited ? '✅' : '⬜'} Смонтировал\n${posted ? '✅' : '⬜'} Выложил в Instagram`;
}

function checklistKeyboard(cl) {
  const { recorded, edited, posted } = cl.steps;
  const rows = [];
  if (!recorded) rows.push([{ text: '🎬 Записал', callback_data: 'cl:recorded' }]);
  if (recorded && !edited) rows.push([{ text: '✂️ Смонтировал', callback_data: 'cl:edited' }]);
  if (edited && !posted) rows.push([{ text: '📤 Выложил в Instagram', callback_data: 'cl:posted' }]);
  return { inline_keyboard: rows };
}

// ── Main message handler ──────────────────────────────────────────────────────

async function handleMessage(env, msg) {
  const chatId = String(msg.chat?.id);

  // Owner-only guard
  if (env.OWNER_CHAT_ID && chatId !== String(env.OWNER_CHAT_ID)) {
    await tgReq(env, 'sendMessage', { chat_id: chatId, text: 'Этот бот личный.' });
    return;
  }

  // Dedup
  const dedupKey = `dedup:${msg.message_id}`;
  if (await env.KV.get(dedupKey)) return;
  await env.KV.put(dedupKey, '1', { expirationTtl: 300 });

  let text = msg.text || msg.caption || '';

  // Transcribe voice if present
  if (msg.voice) {
    await typing(env);
    const url = await getVoiceFileUrl(env, msg.voice.file_id);
    if (url) {
      const transcribed = await transcribeVoice(env, url);
      if (!transcribed) {
        await send(env, 'Не смог распознать голосовое, попробуй ещё раз.');
        return;
      }
      text = transcribed;
    }
  }

  const profile = await kget(env, 'profile', defaultProfile());

  // /start always triggers onboarding welcome (resets state too)
  if (text === '/start') {
    await kset(env, 'onboarding:state', { step: 0 });
    await send(env, ONBOARDING_STEPS[0].q, { parse_mode: 'HTML' });
    return;
  }

  // Onboarding in progress
  if (!profile.onboardingDone) {
    await handleOnboarding(env, profile, text, msg);
    return;
  }

  // Commands
  if (text.startsWith('/')) {
    await handleCommand(env, profile, text);
    return;
  }

  const session = await kget(env, 'session', { state: 'idle' });

  // State machine
  if (session.state === 'awaiting_idea') {
    await handleIdeaInput(env, text);
    return;
  }

  if (session.state === 'awaiting_answer') {
    await handleAnswer(env, profile, session, text);
    return;
  }

  if (session.state === 'awaiting_edit') {
    await handleScenarioEdit(env, profile, session, text);
    return;
  }

  // Check if it's a profile instruction (natural language settings)
  if (await isInstruction(env, text)) {
    const updated = await applyProfileInstruction(env, profile, text);
    await kset(env, 'profile', updated);
    await send(env, '✅ Принял. Буду учитывать при генерации вопросов и сценариев.');
    return;
  }

  // General chat about content
  await handleChat(env, profile, text);
}

async function isInstruction(env, text) {
  const triggers = [/больше про/i, /меньше про/i, /не надо/i, /хочу чтобы/i, /давай.*вместо/i, /измени/i, /фокус на/i, /убери/i, /добавь/i];
  if (!triggers.some(p => p.test(text))) return false;

  const answer = await callClaude(env, {
    user: `Это инструкция по настройке бота (изменить тон, тематику, предпочтения) или обычный вопрос/сообщение?\nОтветь только "да" или "нет".\n\nСообщение: "${text}"`,
  });
  return answer.toLowerCase().startsWith('да');
}

async function applyProfileInstruction(env, profile, text) {
  const result = await callClaude(env, {
    user: `Пользователь хочет обновить свой профиль. Сообщение: "${text}"\n\nТекущий профиль:\nНиша: ${profile.niche}\nИнтересы: ${profile.interests.join(', ')}\nЦель: ${profile.goals}\n\nОпредели что нужно обновить и верни JSON:\n{"field": "niche"|"interests"|"goals"|"instruction", "value": "...новое значение..."}\n\nЕсли это общее пожелание (не ниша/интересы/цель) — field="instruction".`,
    json: true,
  });

  if (result?.field === 'niche' && result.value) {
    profile.niche = result.value;
  } else if (result?.field === 'interests' && result.value) {
    profile.interests = result.value.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  } else if (result?.field === 'goals' && result.value) {
    profile.goals = result.value;
  } else {
    profile.instructions.push(text);
    if (profile.instructions.length > 20) profile.instructions.shift();
  }

  return profile;
}

// ── Onboarding ────────────────────────────────────────────────────────────────

async function handleOnboarding(env, profile, text, msg) {
  const ob = await kget(env, 'onboarding:state', { step: 0 });

  // Ignore commands during onboarding
  if (text.startsWith('/')) {
    const step = ONBOARDING_STEPS[ob.step];
    await send(env, step.q, { parse_mode: 'HTML', reply_markup: step.keyboard });
    return;
  }

  const step = ONBOARDING_STEPS[ob.step];

  // Save answer and advance
  if (step.key === 'niche') profile.niche = text;
  if (step.key === 'interests') profile.interests = text.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  if (step.key === 'goals') profile.goals = text;

  const nextStep = ob.step + 1;
  if (nextStep < ONBOARDING_STEPS.length) {
    const next = ONBOARDING_STEPS[nextStep];
    await kset(env, 'onboarding:state', { step: nextStep });
    await kset(env, 'profile', profile);
    await send(env, next.q, { parse_mode: 'HTML', reply_markup: next.keyboard });
  }
}

// ── Callback handler ──────────────────────────────────────────────────────────

async function handleCallback(env, query) {
  const data = query.data;
  const msgId = query.message?.message_id;

  await tgReq(env, 'answerCallbackQuery', { callback_query_id: query.id });

  const profile = await kget(env, 'profile', defaultProfile());

  // Onboarding: tone selection
  if (data.startsWith('ob:')) {
    profile.tone = data.replace('ob:', '');
    profile.onboardingDone = true;
    await kset(env, 'profile', profile);
    await env.KV.delete('onboarding:state');
    await send(env, `✅ Отлично, профиль готов!\n\nЗавтра в 7:00 получишь первый вопрос. Пока можешь:\n• Добавить идеи → /idea\n• Посмотреть профиль → /profile`);
    return;
  }

  // Reroll morning question
  if (data === 'reroll') {
    const rerollDate = await kget(env, 'reroll:date', null);
    if (rerollDate === todayMSK()) {
      await tgReq(env, 'answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Замену уже использовал сегодня',
        show_alert: true,
      });
      return;
    }

    await kset(env, 'reroll:date', todayMSK());
    await typing(env);
    const { question, format } = await generateQuestion(env, profile);

    profile.formatIndex = (profile.formatIndex + 1) % FORMATS.length;
    await kset(env, 'profile', profile);
    await kset(env, 'session', { state: 'awaiting_answer', question, format });

    await editMsg(env, msgId,
      `🌅 <b>Вопрос дня</b> [${format}]\n\n${question}`,
      { reply_markup: { inline_keyboard: [] } }
    );
    return;
  }

  // Scenario: confirm OK → start checklist
  if (data === 'confirm:ok') {
    const session = await kget(env, 'session', {});
    const levelUp = applyXP(profile, 5);
    await kset(env, 'profile', profile);
    await startChecklist(env, session);
    if (levelUp) await send(env, `${levelUp.emoji} <b>Новый уровень: ${levelUp.name}!</b>`);
    return;
  }

  // Scenario: want to edit
  if (data === 'confirm:edit') {
    await kset(env, 'session', { ...(await kget(env, 'session', {})), state: 'awaiting_edit' });
    await send(env, 'Напиши что изменить в сценарии:');
    return;
  }

  // Checklist steps
  if (data.startsWith('cl:')) {
    await handleChecklistStep(env, profile, data.replace('cl:', ''));
    return;
  }
}

// ── Answer to morning question ────────────────────────────────────────────────

async function handleAnswer(env, profile, session, text) {
  const levelUp = applyXP(profile, 10);
  const msgId = await sendGetId(env, '…');
  const scenario = await generateScenario(env, profile, session.question, text, session.format, msgId);

  const seriesNudge = profile.totalReels > 0 && profile.totalReels % 5 === 0
    ? '\n\n💡 <i>У тебя уже ' + profile.totalReels + ' рилсов — снять серию?</i>'
    : '';

  // Streaming already wrote the scenario to msgId — now add header + buttons via edit
  const finalText = `🎬 <b>Сценарий</b> [${session.format}]\n\n${scenario}${seriesNudge}`;
  await tgEdit(env, msgId, finalText);

  await send(env, 'Подходит или изменить?', {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Подходит, дай чек-лист', callback_data: 'confirm:ok' },
        { text: '✏️ Изменить', callback_data: 'confirm:edit' },
      ]],
    },
  });

  await kset(env, 'session', {
    state: 'awaiting_confirmation',
    question: session.question,
    format: session.format,
    answer: text,
    scenario,
  });

  await kset(env, 'profile', profile);

  if (levelUp) await send(env, `${levelUp.emoji} <b>Новый уровень: ${levelUp.name}!</b>`);
}

async function handleScenarioEdit(env, profile, session, text) {
  const msgId = await sendGetId(env, '…');

  const updated = await callClaudeStreaming(env, {
    user: `Текущий сценарий:\n${session.scenario}\n\nПравки: ${text}\n\nОбнови сценарий. Структура: КРЮЧОК / СУТЬ / ПРИЗЫВ.`,
  }, msgId);

  await tgEdit(env, msgId, `🎬 <b>Обновлённый сценарий</b> [${session.format}]\n\n${updated}`);

  await send(env, 'Подходит или ещё раз?', {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Подходит, дай чек-лист', callback_data: 'confirm:ok' },
        { text: '✏️ Ещё раз', callback_data: 'confirm:edit' },
      ]],
    },
  });

  await kset(env, 'session', { ...session, state: 'awaiting_confirmation', scenario: updated });
}

// ── Checklist ─────────────────────────────────────────────────────────────────

async function startChecklist(env, session) {
  const cl = {
    date: todayMSK(),
    topic: session.question,
    format: session.format,
    scenario: session.scenario,
    steps: { recorded: false, edited: false, posted: false },
  };
  await kset(env, 'checklist:current', cl);
  await kset(env, 'session', { state: 'in_checklist' });
  await send(env, checklistText(cl), { reply_markup: checklistKeyboard(cl) });
}

async function handleChecklistStep(env, profile, step) {
  const cl = await kget(env, 'checklist:current', null);
  if (!cl || cl.steps[step]) return;

  cl.steps[step] = true;

  const xpMap = { recorded: 15, edited: 20, posted: 30 };
  const gained = xpMap[step] ?? 0;
  const levelUp = applyXP(profile, gained);

  if (step === 'posted') {
    // Update streak
    const yesterday = prevDay(todayMSK());
    profile.streak = profile.lastReelDate === yesterday ? profile.streak + 1 : 1;
    profile.lastReelDate = todayMSK();
    profile.totalReels++;

    // Save to reels log
    const reels = await kget(env, 'reels', []);
    reels.push({ date: todayMSK(), topic: cl.topic, format: cl.format });
    await kset(env, 'reels', reels);

    await kset(env, 'checklist:current', cl);
    await kset(env, 'profile', profile);
    await kset(env, 'session', { state: 'idle' });

    const streakEmoji = profile.streak >= 7 ? '🔥' : profile.streak >= 3 ? '⚡' : '📅';
    let txt = `✅ <b>Рилс выложен!</b> +${gained} XP\n\n${streakEmoji} Стрик: ${profile.streak} дней\n🎬 Всего рилсов: ${profile.totalReels}`;
    if (levelUp) txt += `\n\n${levelUp.emoji} <b>Новый уровень: ${levelUp.name}!</b>`;
    await send(env, txt);
  } else {
    await kset(env, 'checklist:current', cl);
    await kset(env, 'profile', profile);

    const txt = checklistText(cl) + `\n\n+${gained} XP`;
    await send(env, txt, { reply_markup: checklistKeyboard(cl) });
    if (levelUp) await send(env, `${levelUp.emoji} <b>Новый уровень: ${levelUp.name}!</b>`);
  }
}

// ── Ideas ─────────────────────────────────────────────────────────────────────

async function handleIdeaInput(env, text) {
  await typing(env);

  // If URL — summarize with Gemini
  let summary = text;
  const isUrl = /https?:\/\/\S+/.test(text);
  if (isUrl) {
    try {
      summary = await callClaude(env, {
        user: `Проанализируй этот материал и кратко (2–3 предложения) извлеки главную идею для контента про личный бренд: ${text}`,
      });
    } catch {
      summary = text;
    }
  }

  const ideas = await kget(env, 'ideas', []);
  ideas.push({ date: todayMSK(), summary, original: text });
  if (ideas.length > 100) ideas.shift();
  await kset(env, 'ideas', ideas);

  await kset(env, 'session', { state: 'idle' });

  const reply = isUrl
    ? `💡 Сохранил идею:\n\n<i>${summary}</i>`
    : '💡 Идея добавлена в банк тем.';
  await send(env, reply);
}

// ── General chat ──────────────────────────────────────────────────────────────

async function handleChat(env, profile, text) {
  const history = await kget(env, 'conv:history', []);
  history.push({ role: 'user', content: text });
  if (history.length > 20) history.shift();

  const historyText = history.slice(-10)
    .map(m => `${m.role === 'user' ? 'Пользователь' : 'Бот'}: ${m.content}`)
    .join('\n');

  const msgId = await sendGetId(env, '…');

  const reply = await callClaudeStreaming(env, {
    system: `Коуч по личному бренду. Профиль:\n${buildProfileContext(profile)}\n\nЕсли пользователь называет тему — сразу пиши сценарий Reel: КРЮЧОК / СУТЬ / ПРИЗЫВ. Без вводных слов и уточнений.`,
    user: `История:\n${historyText}\n\nОтветь кратко.`,
  }, msgId);

  history.push({ role: 'assistant', content: reply });
  await kset(env, 'conv:history', history);
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function handleCommand(env, profile, text) {
  const cmd = text.split(/\s+/)[0].toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    await send(env, `<b>Команды</b>\n\n/profile — профиль и статистика\n/idea — добавить идею в банк тем\n/stats — ввести аналитику из Instagram\n/skip — пропустить сегодня (стрик сгорит)\n/help — справка`);
    return;
  }

  if (cmd === '/profile') {
    const level = getLevel(profile.xp);
    const next = getNextLevel(profile.xp);
    const nextText = next ? ` · до ${next.name}: ${next.xp - profile.xp} XP` : '';
    const streakEmoji = profile.streak >= 7 ? '🔥' : profile.streak >= 3 ? '⚡' : '📅';

    let txt = `${level.emoji} <b>${level.name}</b> · ${profile.xp} XP${nextText}\n${streakEmoji} Стрик: ${profile.streak} дней\n🎬 Рилсов всего: ${profile.totalReels}\n\n<b>Ниша:</b> ${profile.niche || '—'}\n<b>Интересы:</b> ${profile.interests.join(', ') || '—'}\n<b>Цель:</b> ${profile.goals || '—'}`;

    if (profile.instructions.length) {
      txt += `\n\n<b>Мои настройки:</b>\n${profile.instructions.map(i => `• ${i}`).join('\n')}`;
    }

    await send(env, txt);
    return;
  }

  if (cmd === '/idea') {
    await kset(env, 'session', { state: 'awaiting_idea' });
    await send(env, '💡 Отправь идею — текст, ссылку или голосовое:');
    return;
  }

  if (cmd === '/stats') {
    await handleStatsCommand(env, text);
    return;
  }

  if (cmd === '/skip') {
    profile.streak = 0;
    profile.lastReelDate = todayMSK();
    await kset(env, 'profile', profile);
    await kset(env, 'session', { state: 'idle' });
    await send(env, '⏭ Пропустил сегодня. Стрик сгорел.\nЗавтра в 7:00 — новый шанс.');
    return;
  }

  await send(env, 'Неизвестная команда. /help');
}

async function handleStatsCommand(env, text) {
  const args = text.replace('/stats', '').trim();

  if (!args) {
    const analytics = await kget(env, 'analytics', []);
    if (!analytics.length) {
      await send(env, `📊 Статистики пока нет.\n\nВведи через пробел:\n<code>/stats [просмотры] [охват] [+/-подписчики]</code>\n\nПример: <code>/stats 1200 800 +15</code>`);
      return;
    }

    const last5 = analytics.slice(-5).reverse();
    const rows = last5.map(e => `${e.date} — 👁 ${e.views} · 📡 ${e.reach} · 👥 ${e.followers}`).join('\n');
    await send(env, `📊 <b>Последние записи:</b>\n\n${rows}`);
    return;
  }

  const parts = args.split(/\s+/);
  const entry = {
    date: todayMSK(),
    views: parts[0] || '—',
    reach: parts[1] || '—',
    followers: parts[2] || '—',
  };

  const analytics = await kget(env, 'analytics', []);
  analytics.push(entry);
  await kset(env, 'analytics', analytics);

  await send(env, `✅ Сохранено:\n👁 ${entry.views} просмотров · 📡 ${entry.reach} охват · 👥 ${entry.followers} подписчики`);
}

// ── Scheduled jobs ────────────────────────────────────────────────────────────

async function handleScheduled(env, cron) {
  // 7:00 MSK = 4:00 UTC
  if (cron === '0 4 * * *') {
    await sendMorningQuestion(env);
    return;
  }

  // 13:00 MSK = 10:00 UTC — daytime nudge if not answered
  if (cron === '0 10 * * *') {
    await sendDaytimeNudge(env);
    return;
  }

  // 18:00 MSK Sunday = 15:00 UTC Sunday
  if (cron === '0 15 * * 0') {
    await sendWeeklyReflection(env);
    return;
  }
}

async function sendMorningQuestion(env) {
  const profile = await kget(env, 'profile', defaultProfile());
  if (!profile.onboardingDone) return;

  const { question, format } = await generateQuestion(env, profile);

  // Advance format for next time
  profile.formatIndex = (profile.formatIndex + 1) % FORMATS.length;
  await kset(env, 'profile', profile);
  await kset(env, 'session', { state: 'awaiting_answer', question, format });

  await send(env, `🌅 <b>Вопрос дня</b> [${format}]\n\n${question}`, {
    reply_markup: {
      inline_keyboard: [[
        { text: '🔄 Другая тема', callback_data: 'reroll' },
      ]],
    },
  });
}

async function sendDaytimeNudge(env) {
  const session = await kget(env, 'session', { state: 'idle' });
  if (session.state === 'awaiting_answer') {
    await send(env, '👀 Утренний вопрос ещё ждёт ответа.\nЗапиши голосовое — хватит 2–3 минуты.');
  }
}

async function sendWeeklyReflection(env) {
  const profile = await kget(env, 'profile', defaultProfile());
  if (!profile.onboardingDone) return;

  const reels = await kget(env, 'reels', []);
  const analytics = await kget(env, 'analytics', []);

  // Last 7 days
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const weekReels = reels.filter(r => r.date >= weekAgo);
  const weekAnalytics = analytics.filter(a => a.date >= weekAgo);

  const level = getLevel(profile.xp);
  const streakEmoji = profile.streak >= 7 ? '🔥' : profile.streak >= 3 ? '⚡' : '📅';

  let txt = `📊 <b>Итоги недели</b>\n\n`;
  txt += `🎬 Рилсов: <b>${weekReels.length}/7</b>\n`;
  txt += `${streakEmoji} Стрик: <b>${profile.streak} дней</b>\n`;
  txt += `${level.emoji} Уровень: <b>${level.name}</b> · ${profile.xp} XP\n`;

  if (weekReels.length) {
    txt += `\n<b>Форматы недели:</b>\n`;
    txt += weekReels.map(r => `• ${r.format} — ${(r.topic || '').slice(0, 50)}…`).join('\n');
  }

  if (weekAnalytics.length) {
    const totalViews = weekAnalytics.reduce((s, a) => s + (parseInt(a.views) || 0), 0);
    txt += `\n\n📈 Просмотров за неделю: <b>${totalViews}</b>`;
  }

  txt += `\n\n<b>Что сработало лучше всего на этой неделе?</b>`;

  await send(env, txt);
}

// ── Entry point ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('OK');

    const url = new URL(request.url);
    if (url.pathname !== '/webhook' && url.pathname !== '/') {
      return new Response('Not found', { status: 404 });
    }

    try {
      const body = await request.json();
      if (body.message) {
        await handleMessage(env, body.message);
      } else if (body.callback_query) {
        await handleCallback(env, body.callback_query);
      }
    } catch (e) {
      console.error('Worker error:', e);
    }

    return new Response('OK');
  },

  async scheduled(event, env) {
    await handleScheduled(env, event.cron);
  },
};
