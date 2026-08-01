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

// ── Sell-First Builder: content-ops constants ─────────────────────────────────
// Funnel: IG/FB Reels → YouTube → Telegram free → Telegram paid.
// See section 3 of the playbook for pillar definitions.

const SFB_PILLARS = [
  { key: 'sell_first', label: 'Продавай, потом строй' },
  { key: 'validate', label: 'Как валидировать по-настоящему' },
  { key: 'fund_build', label: 'Финансируй разработку клиентами' },
  { key: 'case_studies', label: 'Кейсы (свои и чужие)' },
  { key: 'bts', label: 'Закулисье / proof-of-work' },
  { key: 'tactical', label: 'Тактика: хуки, офферы, лендинги' },
];

const SFB_PLATFORMS = ['IG', 'FB', 'YouTube', 'Telegram'];
const SFB_TYPES = ['trial reel', 'grid', 'carousel', 'long-form'];
const SFB_HOOK_VARIANTS = ['A', 'B', 'C', 'D', 'n/a'];

const SFB_TRIAL_DAILY_CEILING = 5;
const SFB_TRIAL_WEEKLY_TARGET = [3, 5];
const SFB_GRID_WEEKLY_MIN = 3;
const SFB_PUSH_WINDOW_HOURS = 48;
const SFB_COOLDOWN_GROWTH_PCT = 25;

// ── KV helpers ────────────────────────────────────────────────────────────────

async function kget(env, key, def = null) {
  const val = await env.KV.get(key, 'json');
  return val ?? def;
}

async function kset(env, key, val, opts = {}) {
  await env.KV.put(key, JSON.stringify(val), opts);
}

// ── MyLife task diary ────────────────────────────────────────────────────────

const MYLIFE_GENERAL_PROJECT = 'general';

function mlDefaultPriorities() {
  return [
    { id: 'high', name: 'Высокий', color: '#F29AA3', order: 0 },
    { id: 'medium', name: 'Средний', color: '#F6D57A', order: 1 },
    { id: 'low', name: 'Низкий', color: '#A9D7B8', order: 2 },
  ];
}

function mlDefaultProjects() {
  return [{ id: MYLIFE_GENERAL_PROJECT, name: 'Общие', order: 0, createdAt: Date.now() }];
}

async function mlLoadAll(env) {
  const [tasks, projects, priorities, habits, extraLogs, focus] = await Promise.all([
    kget(env, 'mylife:tasks', []),
    kget(env, 'mylife:projects', null),
    kget(env, 'mylife:priorities', null),
    kget(env, 'mylife:habits', []),
    kget(env, 'mylife:extra-logs', []),
    kget(env, 'mylife:focus', {}),
  ]);
  let proj = projects;
  if (!proj) {
    proj = mlDefaultProjects();
    await kset(env, 'mylife:projects', proj);
  }
  let pri = priorities;
  if (!pri) {
    pri = mlDefaultPriorities();
    await kset(env, 'mylife:priorities', pri);
  }
  return { tasks, projects: proj, priorities: pri, habits, extraLogs, focus };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function handleMylifeApi(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['mylife', 'api', resource, id?]
  const resource = parts[2];
  const id = parts[3];

  if (resource === 'data' && request.method === 'GET') {
    return jsonResponse(await mlLoadAll(env));
  }

  if (resource === 'tasks') {
    if (id === 'reorder' && request.method === 'POST') return mlReorderTasks(env, await readJson(request));
    if (request.method === 'POST') return mlCreateTask(env, await readJson(request));
    if (request.method === 'PATCH' && id) return mlUpdateTask(env, id, await readJson(request));
    if (request.method === 'DELETE' && id) return mlDeleteTask(env, id);
  }

  if (resource === 'priorities') {
    if (request.method === 'POST') return mlCreatePriority(env, await readJson(request));
    if (request.method === 'PATCH' && id) return mlUpdatePriority(env, id, await readJson(request));
    if (request.method === 'DELETE' && id) return mlDeletePriority(env, id);
  }

  if (resource === 'projects') {
    if (request.method === 'DELETE' && id) return mlDeleteProject(env, id);
  }

  if (resource === 'habits') {
    if (request.method === 'POST') return mlCreateHabit(env, await readJson(request));
    if (request.method === 'PATCH' && id) return mlUpdateHabit(env, id, await readJson(request));
    if (request.method === 'DELETE' && id) return mlDeleteHabit(env, id);
  }

  if (resource === 'extra-logs') {
    if (request.method === 'POST') return mlCreateExtraLog(env, await readJson(request));
    if (request.method === 'DELETE' && id) return mlDeleteExtraLog(env, id);
  }

  if (resource === 'focus') {
    if (request.method === 'POST') return mlSetFocusDay(env, await readJson(request));
    if (request.method === 'PATCH' && id) return mlUpdateFocusTask(env, id, await readJson(request));
  }

  if (resource === 'link-preview' && request.method === 'POST') {
    const body = await readJson(request);
    return mlLinkPreview(env, body.url);
  }

  return jsonResponse({ error: 'not found' }, 404);
}

async function mlCreateExtraLog(env, body) {
  const logs = await kget(env, 'mylife:extra-logs', []);
  const text = (body.text || '').trim();
  if (!text) return jsonResponse({ error: 'text required' }, 400);
  const entry = {
    id: crypto.randomUUID(),
    dateKey: /^\d{4}-\d{2}-\d{2}$/.test(body.dateKey || '') ? body.dateKey : new Date().toISOString().slice(0, 10),
    text,
    createdAt: Date.now(),
  };
  logs.push(entry);
  await kset(env, 'mylife:extra-logs', logs);
  return jsonResponse({ entry, extraLogs: logs });
}

async function mlDeleteExtraLog(env, id) {
  const logs = await kget(env, 'mylife:extra-logs', []);
  const next = logs.filter(l => l.id !== id);
  await kset(env, 'mylife:extra-logs', next);
  return jsonResponse({ extraLogs: next });
}

function isValidDateKey(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s || '');
}

async function mlSetFocusDay(env, body) {
  if (!isValidDateKey(body.dateKey)) return jsonResponse({ error: 'dateKey required' }, 400);
  const rawTasks = Array.isArray(body.tasks) ? body.tasks.slice(0, 3) : [];
  const tasks = rawTasks
    .map(t => ({
      id: crypto.randomUUID(),
      name: (t.name || '').trim(),
      estimatedMinutes: Number.isFinite(t.estimatedMinutes) && t.estimatedMinutes > 0 ? Math.round(t.estimatedMinutes) : null,
      status: 'pending',
      startedAt: null,
      completedAt: null,
      actualMinutes: null,
      pausedAt: null,
      pausedMs: 0,
      pausedMinutes: null,
    }))
    .filter(t => t.name);
  if (!tasks.length) return jsonResponse({ error: 'at least one task required' }, 400);

  const focus = await kget(env, 'mylife:focus', {});
  focus[body.dateKey] = { tasks };
  await kset(env, 'mylife:focus', focus);
  return jsonResponse({ focus });
}

async function mlUpdateFocusTask(env, dateKey, body) {
  if (!isValidDateKey(dateKey)) return jsonResponse({ error: 'invalid dateKey' }, 400);
  const focus = await kget(env, 'mylife:focus', {});
  const day = focus[dateKey];
  const task = day && day.tasks.find(t => t.id === body.taskId);
  if (!task) return jsonResponse({ error: 'not found' }, 404);

  const patch = body.patch || {};
  const fields = ['status', 'startedAt', 'completedAt', 'actualMinutes', 'pausedAt', 'pausedMs', 'pausedMinutes'];
  for (const f of fields) {
    if (patch[f] !== undefined) task[f] = patch[f];
  }

  await kset(env, 'mylife:focus', focus);
  return jsonResponse({ focus });
}

async function mlCreateProject(env, body) {
  const projects = await kget(env, 'mylife:projects', mlDefaultProjects());
  const name = (body.name || '').trim();
  if (!name) return jsonResponse({ error: 'name required' }, 400);
  const existing = projects.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing) return jsonResponse({ project: existing, projects });
  const project = { id: crypto.randomUUID(), name, order: projects.length, createdAt: Date.now() };
  projects.push(project);
  await kset(env, 'mylife:projects', projects);
  return jsonResponse({ project, projects });
}

async function mlDeleteProject(env, id) {
  if (id === MYLIFE_GENERAL_PROJECT) return jsonResponse({ error: 'cannot delete default project' }, 400);

  const { projects, tasks } = await mlLoadAll(env);
  const nextProjects = projects.filter(p => p.id !== id);
  await kset(env, 'mylife:projects', nextProjects);

  let reassigned = false;
  for (const t of tasks) {
    if (t.projectId === id) { t.projectId = MYLIFE_GENERAL_PROJECT; reassigned = true; }
  }
  if (reassigned) {
    const activeInGeneral = tasks
      .filter(t => t.projectId === MYLIFE_GENERAL_PROJECT && t.status === 'active')
      .sort((a, b) => a.order - b.order);
    activeInGeneral.forEach((t, i) => { t.order = i; });
    await kset(env, 'mylife:tasks', tasks);
  }

  return jsonResponse({ projects: nextProjects });
}

function mlDefaultHabits() {
  return [];
}

function sanitizeDaysOfWeek(days) {
  if (!Array.isArray(days)) return null;
  const clean = [...new Set(days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return clean.length ? clean : null;
}

async function mlCreateHabit(env, body) {
  const habits = await kget(env, 'mylife:habits', mlDefaultHabits());
  const habit = {
    id: crypto.randomUUID(),
    name: (body.name || '').trim() || 'Привычка',
    periodDays: [1, 7, 30].includes(body.periodDays) ? body.periodDays : 1,
    daysOfWeek: sanitizeDaysOfWeek(body.daysOfWeek),
    order: habits.length,
    createdAt: Date.now(),
    log: [],
  };
  habits.push(habit);
  await kset(env, 'mylife:habits', habits);
  return jsonResponse({ habit, habits });
}

async function mlUpdateHabit(env, id, patch) {
  const habits = await kget(env, 'mylife:habits', mlDefaultHabits());
  const habit = habits.find(h => h.id === id);
  if (!habit) return jsonResponse({ error: 'not found' }, 404);

  if (patch.name !== undefined) habit.name = patch.name;
  if (patch.periodDays !== undefined && [1, 7, 30].includes(patch.periodDays)) habit.periodDays = patch.periodDays;
  if (patch.daysOfWeek !== undefined) habit.daysOfWeek = sanitizeDaysOfWeek(patch.daysOfWeek);
  if (patch.order !== undefined) habit.order = patch.order;

  if (patch.toggleDate) {
    const idx = habit.log.indexOf(patch.toggleDate);
    if (idx === -1) habit.log.push(patch.toggleDate);
    else habit.log.splice(idx, 1);
  }

  await kset(env, 'mylife:habits', habits);
  return jsonResponse({ habit });
}

async function mlDeleteHabit(env, id) {
  const habits = await kget(env, 'mylife:habits', mlDefaultHabits());
  const next = habits.filter(h => h.id !== id);
  await kset(env, 'mylife:habits', next);
  return jsonResponse({ habits: next });
}

async function mlCreateTask(env, body) {
  const { tasks, projects } = await mlLoadAll(env);

  let projectId = body.projectId || MYLIFE_GENERAL_PROJECT;
  if (body.newProjectName && body.newProjectName.trim()) {
    const name = body.newProjectName.trim();
    const existing = projects.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      projectId = existing.id;
    } else {
      const newProject = { id: crypto.randomUUID(), name, order: projects.length, createdAt: Date.now() };
      projects.push(newProject);
      projectId = newProject.id;
      await kset(env, 'mylife:projects', projects);
    }
  } else if (!projects.find(p => p.id === projectId)) {
    projectId = MYLIFE_GENERAL_PROJECT;
  }

  const siblingCount = tasks.filter(t => t.projectId === projectId && t.status === 'active').length;

  const task = {
    id: crypto.randomUUID(),
    title: (body.title || '').trim() || 'Без названия',
    description: body.description || '',
    projectId,
    priorityId: body.priorityId || null,
    dueDate: body.dueDate || null,
    plannedMinutes: null,
    status: 'active',
    order: siblingCount,
    createdAt: Date.now(),
    completedAt: null,
    archivedAt: null,
  };

  tasks.push(task);
  await kset(env, 'mylife:tasks', tasks);

  return jsonResponse({ task, projects });
}

async function mlUpdateTask(env, id, patch) {
  const tasks = await kget(env, 'mylife:tasks', []);
  const task = tasks.find(t => t.id === id);
  if (!task) return jsonResponse({ error: 'not found' }, 404);

  const fields = ['title', 'description', 'projectId', 'priorityId', 'dueDate', 'order', 'plannedMinutes'];
  for (const f of fields) {
    if (patch[f] !== undefined) task[f] = patch[f];
  }

  if (patch.status && patch.status !== task.status) {
    task.status = patch.status;
    if (patch.status === 'done') task.completedAt = Date.now();
    if (patch.status === 'archived') task.archivedAt = Date.now();
    if (patch.status === 'active') {
      task.completedAt = null;
      task.archivedAt = null;
    }
  }

  await kset(env, 'mylife:tasks', tasks);
  return jsonResponse({ task });
}

async function mlReorderTasks(env, body) {
  const updates = Array.isArray(body.updates) ? body.updates : [];
  const tasks = await kget(env, 'mylife:tasks', []);

  for (const u of updates) {
    const task = tasks.find(t => t.id === u.id);
    if (!task || !u.patch) continue;
    if (u.patch.projectId !== undefined) task.projectId = u.patch.projectId;
    if (u.patch.order !== undefined) task.order = u.patch.order;
  }

  await kset(env, 'mylife:tasks', tasks);
  return jsonResponse({ tasks });
}

async function mlDeleteTask(env, id) {
  const tasks = await kget(env, 'mylife:tasks', []);
  const next = tasks.filter(t => t.id !== id);
  await kset(env, 'mylife:tasks', next);
  return jsonResponse({ ok: true });
}

async function mlCreatePriority(env, body) {
  const priorities = await kget(env, 'mylife:priorities', mlDefaultPriorities());
  const priority = {
    id: crypto.randomUUID(),
    name: (body.name || '').trim() || 'Приоритет',
    color: body.color || '#CCCCCC',
    order: priorities.length,
  };
  priorities.push(priority);
  await kset(env, 'mylife:priorities', priorities);
  return jsonResponse({ priority, priorities });
}

async function mlUpdatePriority(env, id, patch) {
  const priorities = await kget(env, 'mylife:priorities', mlDefaultPriorities());
  const p = priorities.find(x => x.id === id);
  if (!p) return jsonResponse({ error: 'not found' }, 404);
  if (patch.name !== undefined) p.name = patch.name;
  if (patch.color !== undefined) p.color = patch.color;
  await kset(env, 'mylife:priorities', priorities);
  return jsonResponse({ priority: p, priorities });
}

async function mlDeletePriority(env, id) {
  const priorities = await kget(env, 'mylife:priorities', mlDefaultPriorities());
  const next = priorities.filter(p => p.id !== id);
  await kset(env, 'mylife:priorities', next);

  const tasks = await kget(env, 'mylife:tasks', []);
  let changed = false;
  for (const t of tasks) {
    if (t.priorityId === id) {
      t.priorityId = null;
      changed = true;
    }
  }
  if (changed) await kset(env, 'mylife:tasks', tasks);

  return jsonResponse({ priorities: next });
}

async function mlLinkPreview(env, targetUrl) {
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return jsonResponse({ error: 'invalid url' }, 400);
  }

  const cacheKey = `mylife:preview:${targetUrl}`;
  const cached = await kget(env, cacheKey, null);
  if (cached) return jsonResponse(cached);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(targetUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MyLifeBot/1.0)' },
    });
    clearTimeout(timeout);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    while (html.length < 100000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
    try { await reader.cancel(); } catch {}

    const titleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<title>([^<]+)<\/title>/i);
    const imageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);

    const preview = {
      url: targetUrl,
      title: titleMatch ? titleMatch[1].trim().slice(0, 200) : targetUrl,
      image: imageMatch ? imageMatch[1] : null,
    };

    await kset(env, cacheKey, preview, { expirationTtl: 604800 });
    return jsonResponse(preview);
  } catch {
    return jsonResponse({ url: targetUrl, title: targetUrl, image: null });
  }
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

// ── AI helpers ────────────────────────────────────────────────────────────────

const CLAUDE_BASE_SYSTEM = `Ты коуч по личному бренду и Reels в Telegram-боте.
Форматирование — только HTML для Telegram: <b>жирный</b>, <i>курсив</i>, <code>код</code>, <pre>таблица</pre>. Не используй Markdown-звёздочки (**), решётки (#) и другие markdown-символы.
Отвечай кратко и конкретно. Не задавай уточняющих вопросов — просто выполни задачу. Не добавляй «если хочешь», «дай знать», «готов помочь» и подобные фразы.`;

// Llama via Cloudflare AI — free, used for cheap classification + fallback
async function callLlama(env, { system = '', user } = {}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages });
  return result?.response?.trim() ?? '';
}

async function callLlamaStreaming(env, { system = '', user }, msgId) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: `${CLAUDE_BASE_SYSTEM}\n\n${system}` });
  else messages.push({ role: 'system', content: CLAUDE_BASE_SYSTEM });
  messages.push({ role: 'user', content: user });

  const stream = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages, stream: true });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let lastEditAt = 0;
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]' || !payload) continue;
      try {
        const ev = JSON.parse(payload);
        if (ev.response) {
          fullText += ev.response;
          const now = Date.now();
          if (msgId && now - lastEditAt > 1200) {
            lastEditAt = now;
            await tgEdit(env, msgId, fullText + ' ▍');
          }
        }
      } catch {}
    }
  }

  if (msgId && fullText) await tgEdit(env, msgId, fullText);
  return fullText.trim();
}

// Non-streaming Claude call — for JSON parsing, short utility calls
async function callClaude(env, { system = '', user, search = false, json = false } = {}) {
  const fullSystem = system ? `${CLAUDE_BASE_SYSTEM}\n\n${system}` : CLAUDE_BASE_SYSTEM;
  const reqBody = {
    model: 'claude-haiku-4-5-20251001',
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

// Streaming Claude call with Llama fallback on error
async function callClaudeStreaming(env, { system = '', user }, msgId) {
  const fullSystem = system ? `${CLAUDE_BASE_SYSTEM}\n\n${system}` : CLAUDE_BASE_SYSTEM;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.CLAUDE_API,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        stream: true,
        system: fullSystem,
        messages: [{ role: 'user', content: user }],
      }),
    });

    if (!res.ok) throw new Error(`Claude ${res.status}`);

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
      buf = lines.pop();
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

    if (msgId && fullText) await tgEdit(env, msgId, fullText);
    return fullText.trim();

  } catch (e) {
    console.error('Claude failed, switching to Llama:', e.message);
    if (msgId) await tgEdit(env, msgId, '⚠️ <i>Claude недоступен, переключаюсь на резервную модель…</i>');
    else await send(env, '⚠️ <i>Claude недоступен, переключаюсь на резервную модель…</i>');
    return callLlamaStreaming(env, { system, user }, msgId);
  }
}

async function transcribeVoice(env, fileUrl) {
  const audioRes = await fetch(fileUrl);
  const audioBuffer = await audioRes.arrayBuffer();
  try {
    const result = await env.AI.run('@cf/openai/whisper', {
      audio: [...new Uint8Array(audioBuffer)],
    });
    return result?.text?.trim() ?? '';
  } catch (e) {
    console.error('Whisper error:', e);
    return '';
  }
}

// ── YouTube transcription ────────────────────────────────────────────────────
// No yt-dlp/ffmpeg is available in a Worker, so we pull YouTube's own caption
// tracks (manual or auto-generated) instead of downloading + transcribing audio.

const YT_MAX_TRANSCRIPT_CHARS = 120000;

function extractYouTubeId(text) {
  const m = text.match(/(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtube\.com\/embed\/|youtu\.be\/|m\.youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function extractBalancedJson(str, startIdx) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return str.slice(startIdx, i + 1);
    }
  }
  return null;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function fetchYouTubeTranscript(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=ru`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    },
  });
  const html = await res.text();

  const marker = 'ytInitialPlayerResponse = ';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const braceIdx = html.indexOf('{', idx);
  const jsonStr = extractBalancedJson(html, braceIdx);
  if (!jsonStr) return null;

  let player;
  try {
    player = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  const title = player?.videoDetails?.title || 'YouTube видео';
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || !tracks.length) return { title, transcript: null };

  const track = tracks.find(t => t.languageCode === 'ru' && t.kind !== 'asr')
    || tracks.find(t => t.languageCode === 'ru')
    || tracks.find(t => t.languageCode?.startsWith('en') && t.kind !== 'asr')
    || tracks.find(t => t.languageCode?.startsWith('en'))
    || tracks[0];

  const capRes = await fetch(track.baseUrl);
  const xml = await capRes.text();

  const transcript = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
    .map(m => decodeHtmlEntities(m[1]))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, transcript: transcript || null };
}

function truncateForClaude(transcript) {
  return transcript.length > YT_MAX_TRANSCRIPT_CHARS
    ? transcript.slice(0, YT_MAX_TRANSCRIPT_CHARS) + '\n[транскрипция обрезана]'
    : transcript;
}

async function summarizeYouTubeTranscript(env, title, transcript) {
  return callClaude(env, {
    system: 'Ты делаешь саммари транскрипции YouTube-видео для Telegram. Формат — только HTML (<b>, <i>), списки через "•". Никакого markdown.',
    user: `Название видео: "${title}"\n\nТранскрипция:\n${truncateForClaude(transcript)}\n\nСделай структурированное саммари:\n<b>О чём видео</b> — 1-2 предложения\n<b>Ключевые тезисы</b> — 4-8 пунктов списком\n<b>Вывод</b> — главная мысль\n\nТолько саммари, без предисловий.`,
  });
}

async function handleYoutubeLink(env, videoId) {
  const statusId = await sendGetId(env, '🎥 Достаю транскрипцию видео…');

  let data = null;
  try {
    data = await fetchYouTubeTranscript(videoId);
  } catch (e) {
    console.error('YouTube transcript fetch error:', e);
  }

  if (!data || !data.transcript) {
    await editMsg(env, statusId, '⚠️ Не удалось получить субтитры этого видео — у него нет ни ручных, ни автоматических субтитров на YouTube, либо видео недоступно. Транскрибация по аудио в этом боте не поддерживается.');
    return;
  }

  const { title, transcript } = data;

  await tgEdit(env, statusId, '🧠 Делаю саммари…');
  const summary = await summarizeYouTubeTranscript(env, title, transcript);

  await tgReq(env, 'deleteMessage', { chat_id: env.OWNER_CHAT_ID, message_id: statusId }).catch(() => {});

  await sendDocument(env, `transcript_${videoId}.txt`, transcript, {
    caption: `📄 Транскрипция: ${title}`,
  });

  const summaryMsgId = await sendGetId(
    env,
    `🎬 <b>${escapeHtml(title)}</b>\n\n${summary}\n\n<i>Ответь на это сообщение вопросом по видео — отвечу с опорой на транскрипцию.</i>`,
  );

  if (summaryMsgId) {
    await kset(env, `yt:transcript:${summaryMsgId}`, { title, transcript, videoId }, { expirationTtl: 60 * 60 * 24 * 60 });
  }
}

async function handleYoutubeQuestion(env, ytData, question) {
  const msgId = await sendGetId(env, '…');
  await callClaudeStreaming(env, {
    system: 'Ты отвечаешь на вопросы по конкретному YouTube-видео на основе его транскрипции. Используй только факты из транскрипции. Если ответа там нет — так и скажи. Формат — только HTML (<b>, <i>), без markdown.',
    user: `Видео: "${ytData.title}"\n\nТранскрипция:\n${truncateForClaude(ytData.transcript)}\n\nВопрос: ${question}`,
  }, msgId);
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

async function sendDocument(env, filename, content, extra = {}) {
  const form = new FormData();
  form.append('chat_id', env.OWNER_CHAT_ID);
  if (extra.caption) form.append('caption', extra.caption);
  form.append('document', new Blob([content], { type: 'text/plain; charset=utf-8' }), filename);
  const res = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  return res.json();
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
    user: `Ты помогаешь создавать контент для Instagram Reels.\n\nПрофиль:\n${buildProfileContext(profile)}\n${ideasCtx}\n${histCtx}\n\nФормат рилса на сегодня: "${format}"\n\nСформулируй ОДИН конкретный вопрос для размышления вслух. Вопрос должен:\n- Быть связан с нишей пользователя\n- Провоцировать личную историю, мнение или опыт из практики\n- Быть коротким (1–2 предложения)\n\nОтветь ТОЛЬКО вопросом, без предисловий и объяснений.`,
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
  const s = cl.steps;
  const step = (done, label) => `${done ? '✅' : '⬜'} ${label}`;
  return `📋 <b>Чек-лист рилса</b>\n\n`
    + `${step(true, 'Сценарий готов')}\n`
    + `${step(s.rehearsed, 'Репетиция — отправь голосовое')}\n`
    + `${step(s.recorded, 'Снял видео')}\n`
    + `${step(s.edited, 'Смонтировал')}\n`
    + `${step(s.posted, 'Выложил в Instagram')}`;
}

function checklistKeyboard(cl) {
  const s = cl.steps;
  const rows = [];
  if (s.rehearsed && !s.recorded) rows.push([{ text: '🎬 Снял видео', callback_data: 'cl:recorded' }]);
  if (s.recorded && !s.edited) rows.push([{ text: '✂️ Смонтировал', callback_data: 'cl:edited' }]);
  if (s.edited && !s.posted) rows.push([{ text: '📤 Выложил в Instagram', callback_data: 'cl:posted' }]);
  return { inline_keyboard: rows };
}

function defaultChecklistSteps() {
  return { rehearsed: false, recorded: false, edited: false, posted: false };
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
    const url = await getVoiceFileUrl(env, msg.voice.file_id);
    if (url) {
      const transcribed = await transcribeVoice(env, url);
      if (!transcribed) {
        await send(env, 'Не смог распознать голосовое, попробуй ещё раз.');
        return;
      }

      // Special: voice in checklist = rehearsal evaluation
      const sessionForVoice = await kget(env, 'session', { state: 'idle' });
      if (sessionForVoice.state === 'in_checklist') {
        await evaluateRehearsal(env, transcribed);
        return;
      }

      text = transcribed;
    }
  }

  // Reply to a YouTube summary = follow-up question about that video's transcript
  if (msg.reply_to_message && !text.startsWith('/')) {
    const ytData = await kget(env, `yt:transcript:${msg.reply_to_message.message_id}`, null);
    if (ytData) {
      await handleYoutubeQuestion(env, ytData, text);
      return;
    }
  }

  // YouTube link = transcribe + summarize
  const ytVideoId = extractYouTubeId(text);
  if (ytVideoId) {
    await handleYoutubeLink(env, ytVideoId);
    return;
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

  if (session.state === 'awaiting_topic') {
    await handleTopicInput(env, profile, text);
    return;
  }

  if (session.state === 'awaiting_viral') {
    await handleViralAnalysis(env, profile, text);
    return;
  }

  if (session.state === 'sfb_hooks_collect') {
    await handleSfbHooksInput(env, session, text);
    return;
  }

  if (['sfb_log_magnet', 'sfb_log_linked', 'sfb_log_metrics'].includes(session.state)) {
    await handleSfbLogText(env, session, text);
    return;
  }

  // Button-only steps of the content-ops flows — nudge back to the keyboard
  if (typeof session.state === 'string' && session.state.startsWith('sfb_')) {
    await send(env, 'Выбери вариант кнопкой выше 👆');
    return;
  }

  // Progress shortcuts — "записал", "снял", "смонтировал", "выложил" outside checklist flow
  const progressMatch = detectProgress(text);
  if (progressMatch) {
    await handleProgressShortcut(env, profile, progressMatch, text);
    return;
  }

  // Checklist shortcut
  if (/чек.?лист/i.test(text) && !/дай.*тему|тема|сценарий/i.test(text)) {
    await showChecklistOrStart(env, session);
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

  // Use free Llama for cheap classification
  const answer = await callLlama(env, {
    system: 'Отвечай только "да" или "нет", без объяснений.',
    user: `Это инструкция по настройке бота (изменить тон, тематику, предпочтения) или обычный вопрос/сообщение?\n\nСообщение: "${text}"`,
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

  // ── Sell-First Builder: content-ops callbacks ──────────────────────────────

  if (data.startsWith('sfbideapillar:')) {
    const session = await kget(env, 'session', {});
    if (session.state !== 'sfb_idea_pillar') return;
    await finalizeSfbIdea(env, session, data.replace('sfbideapillar:', ''));
    return;
  }

  if (data.startsWith('sfblogplatform:')) {
    const session = await kget(env, 'session', {});
    if (session.state !== 'sfb_log_platform') return;
    session.draft.platform = sfbDec(data.replace('sfblogplatform:', ''));
    session.state = 'sfb_log_type';
    await kset(env, 'session', session);
    await send(env, 'Тип публикации:', { reply_markup: sfbButtonsKeyboard(SFB_TYPES, 'sfblogtype:') });
    return;
  }

  if (data.startsWith('sfblogtype:')) {
    const session = await kget(env, 'session', {});
    if (session.state !== 'sfb_log_type') return;
    session.draft.type = sfbDec(data.replace('sfblogtype:', ''));
    session.state = 'sfb_log_pillar';
    await kset(env, 'session', session);
    await send(env, 'Столп контента:', { reply_markup: sfbPillarKeyboard('sfblogpillar:') });
    return;
  }

  if (data.startsWith('sfblogpillar:')) {
    const session = await kget(env, 'session', {});
    if (session.state !== 'sfb_log_pillar') return;
    session.draft.pillar = data.replace('sfblogpillar:', '');
    session.state = 'sfb_log_hook';
    await kset(env, 'session', session);
    await send(env, 'Вариант хука:', { reply_markup: sfbButtonsKeyboard(SFB_HOOK_VARIANTS, 'sfbloghook:') });
    return;
  }

  if (data.startsWith('sfbloghook:')) {
    const session = await kget(env, 'session', {});
    if (session.state !== 'sfb_log_hook') return;
    session.draft.hookVariant = sfbDec(data.replace('sfbloghook:', ''));
    session.state = 'sfb_log_cta';
    await kset(env, 'session', session);
    await send(env, 'Был комментарий-CTA (unlock за коммент)?', { reply_markup: sfbButtonsKeyboard(['да', 'нет'], 'sfblogcta:') });
    return;
  }

  if (data.startsWith('sfblogcta:')) {
    const session = await kget(env, 'session', {});
    if (session.state !== 'sfb_log_cta') return;
    const yes = sfbDec(data.replace('sfblogcta:', '')) === 'да';
    session.draft.ctaUsed = yes;
    if (yes) {
      session.state = 'sfb_log_magnet';
      await kset(env, 'session', session);
      await send(env, 'Какой лид-магнит? (чек-лист, гайд, шаблон…):');
    } else {
      session.draft.leadMagnet = null;
      session.state = 'sfb_log_linked';
      await kset(env, 'session', session);
      await send(env, 'Связано с идеей/постом? Пришли <code>i3</code>, <code>p5</code> (если рекайкл) или «нет»:', { parse_mode: 'HTML' });
    }
    return;
  }

  if (data.startsWith('sfbpush:')) {
    await sfbLogPush(env, data.replace('sfbpush:', ''));
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
    steps: defaultChecklistSteps(),
  };
  await kset(env, 'checklist:current', cl);
  await kset(env, 'session', { state: 'in_checklist' });
  await send(env, checklistText(cl) + '\n\n🎤 <i>Отправь голосовое — проговори сценарий, я разберу и помогу улучшить.</i>');
}

async function handleChecklistStep(env, profile, step) {
  const cl = await kget(env, 'checklist:current', null);
  if (!cl || cl.steps[step]) return;

  cl.steps[step] = true;

  const xpMap = { rehearsed: 10, recorded: 15, edited: 20, posted: 30 };
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

  await kset(env, 'session', { state: 'sfb_idea_pillar', summary, original: text });

  const reply = isUrl
    ? `💡 Понял идею:\n\n<i>${summary}</i>\n\nК какому столпу контента она относится?`
    : '💡 Идея принята. К какому столпу контента она относится?';
  await send(env, reply, { reply_markup: sfbPillarKeyboard('sfbideapillar:') });
}

// ── Viral analysis ────────────────────────────────────────────────────────────

async function handleViralAnalysis(env, profile, text) {
  await kset(env, 'session', { state: 'idle' });
  const msgId = await sendGetId(env, '🔥 Разбираю…');

  await callClaudeStreaming(env, {
    user: `Пользователь описал виральный рилс:\n"${text}"\n\nПрофиль пользователя:\n${buildProfileContext(profile)}\n\nСделай разбор в 2 частях:\n\n<b>Почему сработало:</b>\n— Механика крючка\n— Что триггерит просмотры/репосты\n— Почему алгоритм продвигал\n\n<b>Адаптация под твою нишу:</b>\n🎣 Крючок: [конкретная фраза]\n💡 Суть: [2–3 тезиса под нишу]\n📢 Призыв: [CTA]\n\nКратко, конкретно.`,
  }, msgId);
}

// ── Rehearsal evaluation ──────────────────────────────────────────────────────

async function evaluateRehearsal(env, transcribed) {
  const cl = await kget(env, 'checklist:current', null);
  const msgId = await sendGetId(env, '🎤 Слушаю…');

  const feedback = await callClaudeStreaming(env, {
    user: `Пользователь проговорил сценарий рилса вслух. Вот что получилось:\n\n"${transcribed}"\n\nСценарий который нужно было проговорить:\n${cl?.scenario || '(неизвестен)'}\n\nДай разбор по структуре:\n🎣 <b>Крючок</b> — сильный или нет? Как улучшить первые 3 секунды?\n💡 <b>Суть</b> — донёс ли мысль чётко?\n📢 <b>Призыв</b> — есть ли он и понятен ли?\n\n<b>Итого:</b> X/10 и одно конкретное что исправить перед съёмкой.`,
  }, msgId);

  // Mark rehearsal done
  if (cl) {
    cl.steps.rehearsed = true;
    await kset(env, 'checklist:current', cl);
  }

  await send(env, checklistText(cl || { steps: defaultChecklistSteps() }), { reply_markup: checklistKeyboard(cl || { steps: defaultChecklistSteps() }) });
}

// ── Free-form reel (anytime) ──────────────────────────────────────────────────

async function handleTopicInput(env, profile, text) {
  const format = FORMATS[profile.formatIndex % FORMATS.length];

  // If user said "choose yourself" — pick a topic first
  const wantsRandom = /^(выбери|сам|любую|любой|не знаю|сам выбери|ты выбери|что-нибудь|что угодно)/i.test(text.trim());
  let topic = text;
  if (wantsRandom) {
    const history = await kget(env, 'questions:log', []);
    const used = history.slice(-20).join(', ');
    topic = await callClaude(env, {
      user: `Профиль:\n${buildProfileContext(profile)}\n\nФормат: ${format}\n${used ? `Недавно обсуждали: ${used}\n` : ''}Предложи ОДНУ конкретную тему для Reel (1 короткое предложение). Тема должна отличаться от уже обсуждавшихся. Только тема, без объяснений.`,
    });
  }

  const msgId = await sendGetId(env, '…');

  const scenario = await callClaudeStreaming(env, {
    user: `Профиль:\n${buildProfileContext(profile)}\n\nФормат: ${format}\nТема: ${topic}\n\nСценарий Reel до 60 сек:\n\n🎣 <b>КРЮЧОК</b> — фраза для первых 3 секунд\n💡 <b>СУТЬ</b> — 2–3 тезиса\n📢 <b>ПРИЗЫВ</b> — что сделать зрителю\n\nТолько сценарий, без предисловий.`,
  }, msgId);

  await tgEdit(env, msgId, `🎬 <b>Сценарий</b> [${format}]\n\n${scenario}`);

  await send(env, 'Подходит?', {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Дай чек-лист', callback_data: 'confirm:ok' },
        { text: '✏️ Изменить', callback_data: 'confirm:edit' },
      ]],
    },
  });

  await kset(env, 'session', {
    state: 'awaiting_confirmation',
    question: text,
    format,
    scenario,
  });

  profile.formatIndex = (profile.formatIndex + 1) % FORMATS.length;
  await kset(env, 'profile', profile);
}

// ── Progress detection ────────────────────────────────────────────────────────

function detectProgress(text) {
  const t = text.toLowerCase();
  if (/выложил|запостил|опубликовал/.test(t)) return 'posted';
  if (/смонтировал|монтаж|отредактировал|нарезал/.test(t)) return 'edited';
  if (/записал рилс|снял рилс|записал видео|снял видео|снял ролик/.test(t)) return 'recorded';
  return null;
}

async function handleProgressShortcut(env, profile, step, text) {
  const cl = await kget(env, 'checklist:current', null);

  // If active checklist — update it
  if (cl && !cl.steps[step]) {
    await handleChecklistStep(env, profile, step);
    // If "posted" also try to mark earlier steps if not done
    if (step === 'posted' && !cl.steps.recorded) {
      // already marked posted, that's enough
    }
    return;
  }

  // No active checklist — if "posted", just give quick praise and log it
  if (step === 'posted') {
    const levelUp = applyXP(profile, 30);
    profile.streak = profile.lastReelDate === prevDay(todayMSK()) ? profile.streak + 1 : 1;
    profile.lastReelDate = todayMSK();
    profile.totalReels++;
    const reels = await kget(env, 'reels', []);
    reels.push({ date: todayMSK(), topic: text, format: '?' });
    await kset(env, 'reels', reels);
    await kset(env, 'profile', profile);
    const streakEmoji = profile.streak >= 7 ? '🔥' : profile.streak >= 3 ? '⚡' : '📅';
    let msg = `✅ <b>Рилс выложен!</b> +30 XP\n\n${streakEmoji} Стрик: ${profile.streak} дней\n🎬 Всего рилсов: ${profile.totalReels}`;
    if (levelUp) msg += `\n\n${levelUp.emoji} <b>Новый уровень: ${levelUp.name}!</b>`;
    await send(env, msg);
    return;
  }

  // Recorded / edited without checklist — nudge to start one
  const stepLabels = { recorded: 'снял видео', edited: 'смонтировал' };
  await send(env, `💪 Отлично, ${stepLabels[step]}! Продолжай — следующий шаг: ${step === 'recorded' ? 'монтаж' : 'публикация'}.`);
}

async function showChecklistOrStart(env, session) {
  const cl = await kget(env, 'checklist:current', null);
  if (cl) {
    await send(env, checklistText(cl), { reply_markup: checklistKeyboard(cl) });
  } else if (session.state === 'awaiting_confirmation' || session.scenario) {
    await send(env, 'Нажми «✅ Дай чек-лист» в предыдущем сообщении или подтверди сценарий.');
  } else {
    await send(env, 'Нет активного чеклиста. Сначала сделай сценарий — /reel');
  }
}

// ── General chat ──────────────────────────────────────────────────────────────

async function handleChat(env, profile, text) {
  const history = await kget(env, 'conv:history', []);
  history.push({ role: 'user', content: text });
  if (history.length > 20) history.shift();

  const historyText = history.slice(-10)
    .map(m => `${m.role === 'user' ? 'Пользователь' : 'Бот'}: ${m.content}`)
    .join('\n');

  // Load recent topics to avoid repeating
  const reels = await kget(env, 'reels', []);
  const recentTopics = reels.slice(-10).map(r => r.topic).filter(Boolean);
  const topicsCtx = recentTopics.length ? `\nУже снятые темы (не повторять): ${recentTopics.join(', ')}` : '';

  const msgId = await sendGetId(env, '…');

  const reply = await callClaudeStreaming(env, {
    system: `Коуч по личному бренду. Профиль:\n${buildProfileContext(profile)}${topicsCtx}\n\nПравила:\n- Если пользователь называет тему или просит выбрать — сразу пиши готовый сценарий Reel: КРЮЧОК / СУТЬ / ПРИЗЫВ. Не задавай уточняющих вопросов.\n- Если просит описание/caption для Instagram — давай текст с переносами строк, без HTML тегов, готовый для вставки.\n- Если просит чеклист конкретно для этого рилса (снял/монтаж/пост) — давай именно такой.\n- Отвечай кратко и конкретно.`,
    user: `История:\n${historyText}\n\nОтветь.`,
  }, msgId);

  history.push({ role: 'assistant', content: reply });
  await kset(env, 'conv:history', history);
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function handleCommand(env, profile, text) {
  const cmd = text.split(/\s+/)[0].toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    await send(env, `<b>Команды</b>\n\n/reel — сделать сценарий (после команды напиши тему или скажи голосовым)\n/viral — разобрать виральный рилс и адаптировать под тебя\n/profile — профиль и статистика\n/idea — добавить идею в бэклог (с привязкой к столпу)\n/stats — ввести аналитику из Instagram\n/skip — пропустить сегодня (стрик сгорит)\n\n<b>YouTube</b>\nПришли ссылку на видео — верну файл с транскрипцией и саммари. Ответь на сообщение с саммари вопросом — отвечу по содержанию видео.\n\n<b>Sell-First Builder — контент-система</b>\n/idea — идея → бэклог\n/hooks [id] — записать 4 варианта хука для ABCD-теста\n/log — залогировать выложенный пост (пошагово)\n/log push &lt;id&gt; — отметить пост как пушнутый в grid\n/log update &lt;id&gt; &lt;views&gt; &lt;comments&gt; &lt;saves&gt; &lt;shares&gt; — обновить метрики\n/today — квоты на сегодня/неделю + открытые hook-тесты\n/winners — trial-рилсы, которым пора решать: пуш или мимо\n/week — недельный обзор контент-системы\n/funnel [email tgFree tgPaid] — воронка email → TG free → TG paid\n/streak — стрик публикаций\n\n/help — справка`);
    return;
  }

  if (cmd === '/reel') {
    await kset(env, 'session', { state: 'awaiting_topic' });
    await send(env, '🎬 Какая тема? Напиши пару слов или голосовое:');
    return;
  }

  if (cmd === '/viral') {
    await kset(env, 'session', { state: 'awaiting_viral' });
    await send(env, '🔥 Опиши виральный рилс который ты видел — тема, хук, что зацепило. Я разберу почему сработало и адаптирую под твою нишу:');
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

  if (cmd === '/hooks') {
    await handleSfbHooksCommand(env, text);
    return;
  }

  if (cmd === '/log') {
    await handleSfbLogCommand(env, text);
    return;
  }

  if (cmd === '/today') {
    await handleSfbTodayCommand(env);
    return;
  }

  if (cmd === '/winners') {
    await handleSfbWinnersCommand(env);
    return;
  }

  if (cmd === '/week') {
    await handleSfbWeekCommand(env);
    return;
  }

  if (cmd === '/funnel') {
    await handleSfbFunnelCommand(env, text);
    return;
  }

  if (cmd === '/streak') {
    await handleSfbStreakCommand(env);
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

  // 21:00 MSK = 18:00 UTC — content-ops daily nudge (quotas + 48h/cooldown alerts)
  if (cron === '0 18 * * *') {
    await sfbDailyNudge(env);
    return;
  }

  // 20:00 MSK Sunday = 17:00 UTC Sunday — content-ops weekly review
  if (cron === '0 17 * * 0') {
    await sfbWeeklyReviewNudge(env);
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

// ── Sell-First Builder: content-ops system ────────────────────────────────────
// Idea/hook backlog + activity log + funnel tracking for the trial-reels growth
// playbook (IG/FB → YouTube → Telegram free → Telegram paid).

function sfbChunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sfbEnc(s) { return String(s).replace(/\s+/g, '_'); }
function sfbDec(s) { return String(s).replace(/_/g, ' '); }

function sfbPillarLabel(key) {
  return SFB_PILLARS.find(p => p.key === key)?.label || key || '—';
}

function sfbPillarKeyboard(prefix) {
  return { inline_keyboard: sfbChunk(SFB_PILLARS.map(p => ({ text: p.label, callback_data: `${prefix}${p.key}` })), 2) };
}

function sfbButtonsKeyboard(items, prefix, perRow = 2) {
  return { inline_keyboard: sfbChunk(items.map(v => ({ text: v, callback_data: `${prefix}${sfbEnc(v)}` })), perRow) };
}

async function sfbBacklog(env) { return kget(env, 'sfb:backlog', []); }
async function sfbSaveBacklog(env, arr) { await kset(env, 'sfb:backlog', arr); }
async function sfbPosts(env) { return kget(env, 'sfb:posts', []); }
async function sfbSavePosts(env, arr) { await kset(env, 'sfb:posts', arr); }
async function sfbFunnel(env) { return kget(env, 'sfb:funnel', { emailSubs: 0, tgFree: 0, tgPaid: 0, updatedAt: null }); }
async function sfbFunnelLog(env) { return kget(env, 'sfb:funnelLog', []); }

async function sfbNextId(env, kind) {
  const counters = await kget(env, 'sfb:counters', { idea: 0, post: 0 });
  counters[kind] = (counters[kind] || 0) + 1;
  await kset(env, 'sfb:counters', counters);
  return counters[kind];
}

function daysAgoStr(n) {
  const d = new Date(Date.now() + TZ_OFFSET * 3600 * 1000 - n * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function sfbGrowthPct(post) {
  const m = post.metrics;
  if (!m || m.length < 2) return null;
  const prev = m[m.length - 2].views;
  const cur = m[m.length - 1].views;
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

// ── /idea: pillar-tagged backlog (also feeds the legacy AI idea bank) ────────

async function finalizeSfbIdea(env, session, pillarKey) {
  const ideas = await kget(env, 'ideas', []);
  ideas.push({ date: todayMSK(), summary: session.summary, original: session.original });
  if (ideas.length > 100) ideas.shift();
  await kset(env, 'ideas', ideas);

  const backlog = await sfbBacklog(env);
  const id = await sfbNextId(env, 'idea');
  const idea = {
    id: `I${id}`,
    pillar: pillarKey,
    concept: session.summary,
    status: 'raw idea',
    hooks: [null, null, null, null],
    createdAt: todayMSK(),
  };
  backlog.push(idea);
  await sfbSaveBacklog(env, backlog);

  await kset(env, 'session', { state: 'idle' });

  await send(env, `✅ Добавлено в бэклог: <b>${idea.id}</b> · ${sfbPillarLabel(pillarKey)}\n<i>${idea.concept}</i>\n\nКогда снимешь тело видео — запиши хуки: <code>/hooks ${idea.id}</code>`);
}

// ── /hooks: 4 hook variants per idea for the ABCD test ───────────────────────

async function handleSfbHooksCommand(env, text) {
  const arg = text.replace('/hooks', '').trim();
  const backlog = await sfbBacklog(env);

  if (!arg) {
    const pending = backlog.filter(i => i.hooks.some(h => !h));
    if (!pending.length) {
      await send(env, '🎣 Все идеи в бэклоге уже с хуками. Добавь новую: /idea');
      return;
    }
    const rows = pending.slice(-10).map(i => `<b>${i.id}</b> · ${sfbPillarLabel(i.pillar)} — ${i.concept.slice(0, 60)}`).join('\n');
    await send(env, `🎣 <b>Без хуков ещё:</b>\n\n${rows}\n\nЗапусти: <code>/hooks ${pending[pending.length - 1].id}</code>`);
    return;
  }

  const idea = backlog.find(i => i.id.toLowerCase() === arg.toLowerCase());
  if (!idea) {
    await send(env, `Не нашёл идею ${arg}. Запусти /hooks без аргумента — покажу список.`);
    return;
  }

  await kset(env, 'session', { state: 'sfb_hooks_collect', ideaId: idea.id, hookIndex: 0, hooks: [] });
  await send(env, `🎣 <b>${idea.id}</b> · ${idea.concept}\n\nСними тело один раз, затем пришли хук #1 (2–3 сек):`);
}

async function handleSfbHooksInput(env, session, text) {
  const hooks = [...session.hooks, text.trim()];
  const nextIndex = session.hookIndex + 1;

  if (nextIndex < 4) {
    await kset(env, 'session', { ...session, hookIndex: nextIndex, hooks });
    await send(env, `Хук #${nextIndex + 1}:`);
    return;
  }

  const backlog = await sfbBacklog(env);
  const idea = backlog.find(i => i.id === session.ideaId);
  if (idea) {
    idea.hooks = hooks;
    idea.status = 'hooks recorded';
    await sfbSaveBacklog(env, backlog);
  }
  await kset(env, 'session', { state: 'idle' });

  const list = hooks.map((h, i) => `${String.fromCharCode(65 + i)}: ${h}`).join('\n');
  await send(env, `✅ Хуки записаны для <b>${session.ideaId}</b>:\n\n${list}\n\nВыложи все 4 отдельными trial-рилсами с разницей в пару минут, потом залогируй каждый через /log (столп ${idea ? sfbPillarLabel(idea.pillar) : ''}, укажи «${session.ideaId}» как связанную идею).`);
}

// ── /log: activity log — one row per posted piece ────────────────────────────

async function handleSfbLogCommand(env, text) {
  const args = text.split(/\s+/).slice(1);

  if (args[0]?.toLowerCase() === 'push') {
    await sfbLogPush(env, args[1]);
    return;
  }
  if (args[0]?.toLowerCase() === 'update') {
    await sfbLogUpdateMetrics(env, args[1], args.slice(2));
    return;
  }

  await kset(env, 'session', { state: 'sfb_log_platform', draft: {} });
  await send(env, '📋 <b>Логируем пост.</b> Платформа:', { reply_markup: sfbButtonsKeyboard(SFB_PLATFORMS, 'sfblogplatform:') });
}

async function sfbLogPush(env, idArg) {
  if (!idArg) { await send(env, 'Укажи id: <code>/log push P4</code>'); return; }
  const posts = await sfbPosts(env);
  const post = posts.find(p => p.id.toLowerCase() === idArg.toLowerCase());
  if (!post) { await send(env, `Не нашёл пост ${idArg}.`); return; }

  post.pushedToGrid = true;
  post.pushedAt = Date.now();
  await sfbSavePosts(env, posts);

  if (post.ideaId) {
    const backlog = await sfbBacklog(env);
    const idea = backlog.find(i => i.id.toLowerCase() === post.ideaId.toLowerCase());
    if (idea) { idea.status = 'pushed to grid'; await sfbSaveBacklog(env, backlog); }
  }

  await send(env, `🚀 ${post.id} отмечен как пушнутый в grid.`);
}

async function sfbLogUpdateMetrics(env, idArg, numArgs) {
  if (!idArg || numArgs.length < 4) {
    await send(env, 'Формат: <code>/log update P4 800 20 15 5</code>\n(просмотры комментарии сохранения репосты)');
    return;
  }
  const posts = await sfbPosts(env);
  const post = posts.find(p => p.id.toLowerCase() === idArg.toLowerCase());
  if (!post) { await send(env, `Не нашёл пост ${idArg}.`); return; }

  const [views, comments, saves, shares] = numArgs.slice(0, 4).map(x => parseInt(x, 10) || 0);
  post.metrics.push({ at: Date.now(), views, comments, saves, shares });
  await sfbSavePosts(env, posts);

  const growth = sfbGrowthPct(post);
  await send(env, `📈 Обновил ${post.id}: 👁 ${views} · 💬 ${comments} · 🔖 ${saves} · 🔁 ${shares}${growth !== null ? `\nРост за последний интервал: ${growth > 0 ? '+' : ''}${growth}%` : ''}`);
}

function parseSfbLinkedId(text) {
  const t = text.trim();
  if (/^нет$/i.test(t)) return {};
  const m = t.match(/^([ip])\s*(\d+)$/i);
  if (!m) return {};
  const id = (m[1].toLowerCase() === 'i' ? 'I' : 'P') + m[2];
  return m[1].toLowerCase() === 'i' ? { ideaId: id } : { recycledFrom: id };
}

async function handleSfbLogText(env, session, text) {
  const draft = session.draft;

  if (session.state === 'sfb_log_magnet') {
    draft.leadMagnet = text.trim();
    await kset(env, 'session', { ...session, state: 'sfb_log_linked' });
    await send(env, 'Связано с идеей/постом? Пришли <code>i3</code>, <code>p5</code> (если рекайкл) или «нет»:', { parse_mode: 'HTML' });
    return;
  }

  if (session.state === 'sfb_log_linked') {
    Object.assign(draft, parseSfbLinkedId(text));
    await kset(env, 'session', { ...session, state: 'sfb_log_metrics' });
    await send(env, 'Метрики на сейчас — через пробел: <code>просмотры комментарии сохранения репосты</code> (0 если 0):', { parse_mode: 'HTML' });
    return;
  }

  if (session.state === 'sfb_log_metrics') {
    await finalizeSfbLog(env, session, text);
    return;
  }
}

async function finalizeSfbLog(env, session, numsText) {
  const parts = numsText.trim().split(/\s+/).map(x => parseInt(x, 10) || 0);
  const [views, comments, saves, shares] = [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts[3] || 0];

  const posts = await sfbPosts(env);
  const id = await sfbNextId(env, 'post');
  const draft = session.draft;
  const post = {
    id: `P${id}`,
    date: todayMSK(),
    postedAt: Date.now(),
    platform: draft.platform,
    type: draft.type,
    pillar: draft.pillar,
    hookVariant: draft.hookVariant,
    ctaUsed: !!draft.ctaUsed,
    leadMagnet: draft.leadMagnet || null,
    ideaId: draft.ideaId || null,
    recycledFrom: draft.recycledFrom || null,
    metrics: [{ at: Date.now(), views, comments, saves, shares }],
    pushedToGrid: draft.type === 'grid',
    pushedAt: draft.type === 'grid' ? Date.now() : null,
  };
  posts.push(post);
  await sfbSavePosts(env, posts);

  if (post.ideaId) {
    const backlog = await sfbBacklog(env);
    const idea = backlog.find(i => i.id.toLowerCase() === post.ideaId.toLowerCase());
    if (idea && idea.status !== 'pushed to grid') {
      idea.status = 'posted';
      await sfbSaveBacklog(env, backlog);
    }
  }

  await kset(env, 'session', { state: 'idle' });

  let txt = `✅ Залогировано: <b>${post.id}</b>\n${post.platform} · ${post.type} · ${sfbPillarLabel(post.pillar)} · хук ${post.hookVariant}\n`;
  txt += `CTA: ${post.ctaUsed ? `да (${post.leadMagnet})` : 'нет'}\n`;
  txt += `👁 ${views} · 💬 ${comments} · 🔖 ${saves} · 🔁 ${shares}\n\n`;
  txt += `Обнови метрики позже: <code>/log update ${post.id} 800 20 15 5</code>`;
  if (post.type === 'trial reel') txt += `\nЕсли зайдёт — не забудь: <code>/log push ${post.id}</code> в течение 48ч.`;

  await send(env, txt);
}

// ── /today: quota status + open hook tests ───────────────────────────────────

async function handleSfbTodayCommand(env) {
  const posts = await sfbPosts(env);
  const today = todayMSK();
  const weekAgo = daysAgoStr(7);

  const trialToday = posts.filter(p => p.date === today && p.type === 'trial reel').length;
  const trialWeek = posts.filter(p => p.date >= weekAgo && p.type === 'trial reel').length;
  const gridWeek = posts.filter(p => p.date >= weekAgo && p.type === 'grid').length;

  let txt = `📅 <b>Сегодня — ${today}</b>\n\n`;
  txt += `🎬 Trial-рилсы сегодня: <b>${trialToday}</b> (потолок ${SFB_TRIAL_DAILY_CEILING}/день)\n`;
  txt += `🎬 Trial-рилсы за неделю: <b>${trialWeek}</b> (цель ${SFB_TRIAL_WEEKLY_TARGET[0]}–${SFB_TRIAL_WEEKLY_TARGET[1]}/неделю)\n`;
  txt += `📌 Grid-посты за неделю: <b>${gridWeek}/${SFB_GRID_WEEKLY_MIN}</b>${gridWeek >= SFB_GRID_WEEKLY_MIN ? ' ✅' : ''}\n`;

  const backlog = await sfbBacklog(env);
  const openHookTests = backlog.filter(i => i.status === 'hooks recorded');
  if (openHookTests.length) {
    txt += `\n🎣 <b>Открытые hook-тесты:</b>\n`;
    for (const idea of openHookTests) {
      const posted = posts.filter(p => p.ideaId === idea.id && ['A', 'B', 'C', 'D'].includes(p.hookVariant)).length;
      txt += `${idea.id} — ${posted}/4 хуков выложено\n`;
    }
  }

  await send(env, txt.trim());
}

// ── /winners: 48h + cooldown decision windows ────────────────────────────────

function sfbWinnerStatusLine(post) {
  const hours = (Date.now() - post.postedAt) / 3600000;
  const growth = sfbGrowthPct(post);
  if (growth !== null && growth < SFB_COOLDOWN_GROWTH_PCT) {
    return { urgent: true, line: `🧊 Остывает (рост ${growth}%) — последний шанс запушить` };
  }
  if (hours >= SFB_PUSH_WINDOW_HOURS) {
    return { urgent: true, line: `🚨 Окно 48ч закрылось (${Math.round(hours)}ч назад) — пуш даст меньше эффекта` };
  }
  return { urgent: false, line: `⏳ Осталось ~${Math.max(0, Math.round(SFB_PUSH_WINDOW_HOURS - hours))}ч до конца окна 48ч` };
}

async function handleSfbWinnersCommand(env) {
  const posts = await sfbPosts(env);
  const candidates = posts.filter(p => p.type === 'trial reel' && !p.pushedToGrid);
  if (!candidates.length) {
    await send(env, '🏆 Нет trial-рилсов, ожидающих решения о пуше.');
    return;
  }

  let txt = `🏆 <b>Кандидаты на пуш в grid</b>\n\n`;
  const keyboard = [];
  for (const post of candidates) {
    const growth = sfbGrowthPct(post);
    const { line } = sfbWinnerStatusLine(post);
    const lastMetric = post.metrics[post.metrics.length - 1];
    txt += `<b>${post.id}</b> · ${post.platform} · ${sfbPillarLabel(post.pillar)} · хук ${post.hookVariant}\n`;
    txt += `👁 ${lastMetric.views}${growth !== null ? ` (${growth > 0 ? '+' : ''}${growth}%)` : ''}\n${line}\n\n`;
    keyboard.push([{ text: `✅ Пушнуть ${post.id}`, callback_data: `sfbpush:${post.id}` }]);
  }

  await send(env, txt.trim(), { reply_markup: { inline_keyboard: keyboard } });
}

// ── /week: content-ops weekly review (separate from the recording-streak one) ─

async function buildSfbWeekReview(env) {
  const posts = await sfbPosts(env);
  const weekAgo = daysAgoStr(7);
  const weekPosts = posts.filter(p => p.date >= weekAgo);

  const byType = {};
  for (const p of weekPosts) byType[p.type] = (byType[p.type] || 0) + 1;

  const ranked = weekPosts
    .map(p => ({ p, views: p.metrics[p.metrics.length - 1]?.views || 0 }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 3);

  const unpushed = posts.filter(p => p.type === 'trial reel' && !p.pushedToGrid && (Date.now() - p.postedAt) / 3600000 >= SFB_PUSH_WINDOW_HOURS);

  const funnel = await sfbFunnel(env);
  const funnelLog = await sfbFunnelLog(env);
  const baseline = [...funnelLog].reverse().find(f => f.date <= weekAgo);

  const ctaPosts = weekPosts.filter(p => p.ctaUsed);
  const noCtaPosts = weekPosts.filter(p => !p.ctaUsed);
  const avgViews = arr => arr.length ? Math.round(arr.reduce((s, p) => s + (p.metrics[p.metrics.length - 1]?.views || 0), 0) / arr.length) : 0;

  const pillarComments = {};
  for (const p of weekPosts) {
    pillarComments[p.pillar] = (pillarComments[p.pillar] || 0) + (p.metrics[p.metrics.length - 1]?.comments || 0);
  }
  const topPillar = Object.entries(pillarComments).sort((a, b) => b[1] - a[1])[0];

  let txt = `📊 <b>Недельный обзор — контент-система</b>\n\n`;
  txt += `<b>Опубликовано:</b>\n${Object.entries(byType).map(([t, n]) => `• ${t}: ${n}`).join('\n') || '— ничего не залогировано'}\n\n`;

  if (ranked.length) {
    txt += `<b>Топ-3 поста:</b>\n`;
    txt += ranked.map((r, i) => `${i + 1}. ${r.p.id} · ${sfbPillarLabel(r.p.pillar)} · 👁 ${r.views}${r.p.ctaUsed ? ' · CTA' : ''} · хук ${r.p.hookVariant}`).join('\n');
    txt += '\n\n';
  }

  if (unpushed.length) txt += `🚨 <b>Победители мимо окна:</b> ${unpushed.map(p => p.id).join(', ')}\n\n`;

  txt += `<b>CTA vs без CTA</b> (сред. просмотры): ${avgViews(ctaPosts)} vs ${avgViews(noCtaPosts)}\n\n`;

  txt += `<b>Воронка:</b> 📧 ${funnel.emailSubs} · 🆓 TG ${funnel.tgFree} · 💰 TG paid ${funnel.tgPaid}`;
  if (baseline) {
    const d = (a, b) => `${a - b >= 0 ? '+' : ''}${a - b}`;
    txt += ` (за неделю: 📧${d(funnel.emailSubs, baseline.emailSubs)} · 🆓${d(funnel.tgFree, baseline.tgFree)} · 💰${d(funnel.tgPaid, baseline.tgPaid)})`;
  }
  txt += '\n\n';

  txt += topPillar ? `<b>Столп недели:</b> ${sfbPillarLabel(topPillar[0])} — больше всего комментариев, стоит удвоить.` : '<b>Столп недели:</b> пока недостаточно данных.';

  return txt;
}

async function handleSfbWeekCommand(env) {
  await send(env, await buildSfbWeekReview(env));
}

// ── /funnel: email → Telegram free → Telegram paid ───────────────────────────

async function handleSfbFunnelCommand(env, text) {
  const args = text.replace('/funnel', '').trim();
  const funnel = await sfbFunnel(env);

  if (!args) {
    const funnelLog = await sfbFunnelLog(env);
    const weekAgo = daysAgoStr(7);
    const baseline = [...funnelLog].reverse().find(f => f.date <= weekAgo);
    const d = (a, b) => `${a - b >= 0 ? '+' : ''}${a - b}`;

    let txt = `🔻 <b>Воронка</b>\n\n📧 Email: <b>${funnel.emailSubs}</b>\n🆓 Telegram free: <b>${funnel.tgFree}</b>\n💰 Telegram paid: <b>${funnel.tgPaid}</b>`;
    if (funnel.updatedAt) txt += `\n\n<i>обновлено ${funnel.updatedAt}</i>`;
    if (baseline) txt += `\nЗа неделю: 📧${d(funnel.emailSubs, baseline.emailSubs)} · 🆓${d(funnel.tgFree, baseline.tgFree)} · 💰${d(funnel.tgPaid, baseline.tgPaid)}`;
    txt += `\n\nОбновить: <code>/funnel 120 45 3</code> (email, TG free, TG paid)`;
    await send(env, txt);
    return;
  }

  const parts = args.split(/\s+/).map(x => parseInt(x, 10));
  const updated = {
    emailSubs: Number.isFinite(parts[0]) ? parts[0] : funnel.emailSubs,
    tgFree: Number.isFinite(parts[1]) ? parts[1] : funnel.tgFree,
    tgPaid: Number.isFinite(parts[2]) ? parts[2] : funnel.tgPaid,
    updatedAt: todayMSK(),
  };
  await kset(env, 'sfb:funnel', updated);

  const funnelLog = await sfbFunnelLog(env);
  funnelLog.push({ date: todayMSK(), ...updated });
  if (funnelLog.length > 200) funnelLog.shift();
  await kset(env, 'sfb:funnelLog', funnelLog);

  await send(env, `✅ Воронка обновлена:\n📧 ${updated.emailSubs} · 🆓 ${updated.tgFree} · 💰 ${updated.tgPaid}`);
}

// ── /streak: consecutive days with a logged post ─────────────────────────────

async function handleSfbStreakCommand(env) {
  const posts = await sfbPosts(env);
  const datesWithPosts = new Set(posts.map(p => p.date));

  let streak = 0;
  let d = todayMSK();
  if (!datesWithPosts.has(d)) d = prevDay(d);
  while (datesWithPosts.has(d)) {
    streak++;
    d = prevDay(d);
  }

  const emoji = streak >= 7 ? '🔥' : streak >= 3 ? '⚡' : '📅';
  const hint = datesWithPosts.has(todayMSK()) ? 'Сегодня уже залогировано 👍' : 'Сегодня ещё ничего не залогировано — самое время: /log';
  await send(env, `${emoji} <b>Стрик публикаций:</b> ${streak} дн. подряд\n\n${hint}`);
}

// ── Automated nudges (cron) ───────────────────────────────────────────────────

async function sfbDailyNudge(env) {
  const posts = await sfbPosts(env);
  const today = todayMSK();
  const trialToday = posts.filter(p => p.date === today && p.type === 'trial reel').length;

  let txt = `🔔 <b>Дневной чек-ин</b>\n\n🎬 Trial-рилсы сегодня: <b>${trialToday}</b>/${SFB_TRIAL_WEEKLY_TARGET[1]}\n`;

  const candidates = posts.filter(p => p.type === 'trial reel' && !p.pushedToGrid);
  const urgent = candidates
    .map(p => ({ p, ...sfbWinnerStatusLine(p) }))
    .filter(x => x.urgent);

  if (urgent.length) {
    txt += `\n🚨 <b>Требуют решения:</b>\n`;
    txt += urgent.map(x => `${x.p.id} — ${x.line}`).join('\n');
  } else if (trialToday === 0) {
    txt += `\nЕщё не постил trial-рилс сегодня. Есть 15 минут на съёмку тела + 1 хук?`;
  } else {
    txt += `\nВсё в порядке, ничего не горит. 👍`;
  }

  await send(env, txt);
}

async function sfbWeeklyReviewNudge(env) {
  await send(env, await buildSfbWeekReview(env));
}

// ── MCP server (Claude custom connector) ─────────────────────────────────────
// Exposes MyLife (tasks/projects/priorities/habits/focus + a business-coach
// chat) as a remote MCP server so Claude can read and edit everything and
// give coaching advice grounded in the real data.
// Auth: shared secret via `MYLIFE_MCP_TOKEN` (wrangler secret), passed as
// either `Authorization: Bearer <token>` or `?token=<token>` on the URL that
// goes into Claude's "Remote MCP server URL" field, e.g.
//   https://<worker-domain>/mylife/mcp?token=<token>

const MCP_PROTOCOL_VERSION = '2025-06-18';

const MYLIFE_COACH_SYSTEM = `Ты — прямой и практичный бизнес-коуч и продуктивный ассистент пользователя в приложении MyLife (личный трекер задач, проектов, привычек и фокус-дня).
Отвечай на языке пользователя (по умолчанию — русский), простым текстом или Markdown, без HTML-тегов.
Опирайся на переданный ниже срез данных (задачи, проекты, приоритеты, привычки), если он есть — давай конкретные, выполнимые советы, помогай расставлять приоритеты, замечай риски (просроченные задачи, заброшенные привычки) и задавай не более одного уточняющего вопроса, только если это критично.
Не лей воду, не извиняйся, не проси прощения за прошлые ответы.`;

async function callClaudeCoach(env, { system, user }) {
  const reqBody = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    system,
    messages: [{ role: 'user', content: user }],
  };
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
      if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return (data.content?.filter(b => b.type === 'text')?.map(b => b.text)?.join('') ?? '').trim();
    } catch (e) {
      if (attempts >= 3) throw e;
    }
  }
}

function mlSnapshotSummary(snapshot) {
  const { tasks, projects, priorities, habits } = snapshot;
  const projectName = id => projects.find(p => p.id === id)?.name || id;
  const priorityName = id => priorities.find(p => p.id === id)?.name || '—';
  const active = tasks.filter(t => t.status === 'active').sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  const lines = [];
  lines.push(`Проекты: ${projects.map(p => p.name).join(', ') || '—'}`);
  lines.push(`Активные задачи (${active.length}):`);
  for (const t of active.slice(0, 60)) {
    lines.push(`- [${t.id}] "${t.title}" | проект: ${projectName(t.projectId)} | приоритет: ${priorityName(t.priorityId)} | срок: ${t.dueDate || '—'}`);
  }
  if (habits.length) {
    lines.push(`Привычки: ${habits.map(h => h.name).join(', ')}`);
  }
  return lines.join('\n');
}

function mcpJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function mcpResult(id, result) {
  return mcpJson({ jsonrpc: '2.0', id, result });
}

function mcpError(id, code, message, status = 200) {
  return mcpJson({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, status);
}

function mcpToolText(obj, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], isError };
}

async function mcpResponseToToolResult(resPromise) {
  const res = await resPromise;
  let body;
  try { body = await res.json(); } catch { body = {}; }
  return mcpToolText(body, res.status >= 400);
}

const MCP_TOOLS = [
  {
    name: 'mylife_get_snapshot',
    description: 'Get everything in MyLife: tasks, projects, priorities, habits, extra notes/logs and the focus-day plan. Use this first to see current state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mylife_list_tasks',
    description: 'List tasks, optionally filtered by status and/or project.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'done', 'archived'], description: 'Filter by status. Omit for all statuses.' },
        projectId: { type: 'string', description: 'Filter by project id. Omit for all projects.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_create_task',
    description: 'Create a new task. If newProjectName is given and does not match an existing project, a new project is created for it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        projectId: { type: 'string', description: 'Existing project id. Defaults to the "general" project.' },
        newProjectName: { type: 'string', description: 'Create (or reuse) a project with this name for the task.' },
        priorityId: { type: 'string' },
        dueDate: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_update_task',
    description: 'Update fields on an existing task, including moving it between projects, changing status (active/done/archived), priority, due date, or planned minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        projectId: { type: 'string' },
        priorityId: { type: 'string' },
        dueDate: { type: 'string', description: 'YYYY-MM-DD' },
        status: { type: 'string', enum: ['active', 'done', 'archived'] },
        plannedMinutes: { type: 'number' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_delete_task',
    description: 'Permanently delete a task.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'mylife_create_project',
    description: 'Create a new project (or return the existing one if the name already matches).',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  },
  {
    name: 'mylife_delete_project',
    description: 'Delete a project. Its tasks are reassigned to the default "general" project. The "general" project itself cannot be deleted.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'mylife_create_priority',
    description: 'Create a new priority label (e.g. "Urgent") with an optional hex color.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, color: { type: 'string', description: 'Hex color, e.g. #F29AA3' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_update_priority',
    description: 'Rename or recolor an existing priority.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' }, color: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_delete_priority',
    description: 'Delete a priority label. Tasks using it are left without a priority.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'mylife_create_habit',
    description: 'Create a recurring habit to track.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        periodDays: { type: 'number', enum: [1, 7, 30], description: 'How often it should repeat: daily(1)/weekly(7)/monthly(30).' },
        daysOfWeek: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, description: 'Optional specific weekdays, 0=Sunday.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_update_habit',
    description: 'Update a habit\'s name/schedule, or toggle its completion log for a specific date (pass toggleDate as YYYY-MM-DD to mark/unmark that day done).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        periodDays: { type: 'number', enum: [1, 7, 30] },
        daysOfWeek: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
        toggleDate: { type: 'string', description: 'YYYY-MM-DD, toggles that date in the habit log' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_delete_habit',
    description: 'Delete a habit.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'mylife_add_note',
    description: 'Add a free-form note/log entry (extra log) for a given date.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, dateKey: { type: 'string', description: 'YYYY-MM-DD, defaults to today' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_delete_note',
    description: 'Delete a note/log entry by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'mylife_set_focus_day',
    description: 'Set (replace) the focus plan (up to 3 tasks) for a given day.',
    inputSchema: {
      type: 'object',
      properties: {
        dateKey: { type: 'string', description: 'YYYY-MM-DD' },
        tasks: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, estimatedMinutes: { type: 'number' } },
            required: ['name'],
          },
        },
      },
      required: ['dateKey', 'tasks'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_update_focus_task',
    description: 'Update one task within a day\'s focus plan (e.g. status: pending/active/done, actualMinutes).',
    inputSchema: {
      type: 'object',
      properties: {
        dateKey: { type: 'string', description: 'YYYY-MM-DD' },
        taskId: { type: 'string' },
        status: { type: 'string' },
        actualMinutes: { type: 'number' },
      },
      required: ['dateKey', 'taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_coach_chat',
    description: 'Talk to your business/productivity coach. By default the coach sees a summary of your current active tasks, projects and habits so advice is grounded in reality.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        includeContext: { type: 'boolean', description: 'Include a snapshot of tasks/projects/habits as context. Defaults to true.' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
];

async function mcpCallTool(env, name, args) {
  args = args || {};
  switch (name) {
    case 'mylife_get_snapshot':
      return mcpToolText(await mlLoadAll(env));
    case 'mylife_list_tasks': {
      const { tasks } = await mlLoadAll(env);
      const filtered = tasks.filter(t =>
        (!args.status || t.status === args.status) &&
        (!args.projectId || t.projectId === args.projectId));
      return mcpToolText({ tasks: filtered });
    }
    case 'mylife_create_task':
      return mcpResponseToToolResult(mlCreateTask(env, args));
    case 'mylife_update_task': {
      if (!args.id) return mcpToolText({ error: 'id required' }, true);
      const { id, ...patch } = args;
      return mcpResponseToToolResult(mlUpdateTask(env, id, patch));
    }
    case 'mylife_delete_task':
      if (!args.id) return mcpToolText({ error: 'id required' }, true);
      return mcpResponseToToolResult(mlDeleteTask(env, args.id));
    case 'mylife_create_project':
      return mcpResponseToToolResult(mlCreateProject(env, args));
    case 'mylife_delete_project':
      if (!args.id) return mcpToolText({ error: 'id required' }, true);
      return mcpResponseToToolResult(mlDeleteProject(env, args.id));
    case 'mylife_create_priority':
      return mcpResponseToToolResult(mlCreatePriority(env, args));
    case 'mylife_update_priority': {
      if (!args.id) return mcpToolText({ error: 'id required' }, true);
      const { id, ...patch } = args;
      return mcpResponseToToolResult(mlUpdatePriority(env, id, patch));
    }
    case 'mylife_delete_priority':
      if (!args.id) return mcpToolText({ error: 'id required' }, true);
      return mcpResponseToToolResult(mlDeletePriority(env, args.id));
    case 'mylife_create_habit':
      return mcpResponseToToolResult(mlCreateHabit(env, args));
    case 'mylife_update_habit': {
      if (!args.id) return mcpToolText({ error: 'id required' }, true);
      const { id, ...patch } = args;
      return mcpResponseToToolResult(mlUpdateHabit(env, id, patch));
    }
    case 'mylife_delete_habit':
      if (!args.id) return mcpToolText({ error: 'id required' }, true);
      return mcpResponseToToolResult(mlDeleteHabit(env, args.id));
    case 'mylife_add_note':
      return mcpResponseToToolResult(mlCreateExtraLog(env, args));
    case 'mylife_delete_note':
      if (!args.id) return mcpToolText({ error: 'id required' }, true);
      return mcpResponseToToolResult(mlDeleteExtraLog(env, args.id));
    case 'mylife_set_focus_day':
      return mcpResponseToToolResult(mlSetFocusDay(env, args));
    case 'mylife_update_focus_task': {
      if (!args.dateKey || !args.taskId) return mcpToolText({ error: 'dateKey and taskId required' }, true);
      const { dateKey, taskId, ...patch } = args;
      return mcpResponseToToolResult(mlUpdateFocusTask(env, dateKey, { taskId, patch }));
    }
    case 'mylife_coach_chat': {
      if (!args.message) return mcpToolText({ error: 'message required' }, true);
      let system = MYLIFE_COACH_SYSTEM;
      if (args.includeContext !== false) {
        const snapshot = await mlLoadAll(env);
        system += `\n\nТекущий срез данных пользователя:\n${mlSnapshotSummary(snapshot)}`;
      }
      const reply = await callClaudeCoach(env, { system, user: args.message });
      return { content: [{ type: 'text', text: reply }] };
    }
    default:
      return mcpToolText({ error: `Unknown tool: ${name}` }, true);
  }
}

async function handleMylifeMcp(request, env, url) {
  if (!env.MYLIFE_MCP_TOKEN) {
    return mcpJson({ error: 'Server misconfigured: MYLIFE_MCP_TOKEN secret is not set.' }, 500);
  }
  const authHeader = request.headers.get('Authorization') || '';
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = bearer || url.searchParams.get('token');
  if (token !== env.MYLIFE_MCP_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let rpc;
  try {
    rpc = await request.json();
  } catch {
    return mcpError(null, -32700, 'Parse error');
  }

  const { id, method, params } = rpc;

  // JSON-RPC notifications (no id) get no response body.
  if (id === undefined) {
    return new Response(null, { status: 202 });
  }

  try {
    switch (method) {
      case 'initialize':
        return mcpResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'mylife', title: 'MyLife', version: '1.0.0' },
        });
      case 'ping':
        return mcpResult(id, {});
      case 'tools/list':
        return mcpResult(id, { tools: MCP_TOOLS });
      case 'tools/call': {
        const result = await mcpCallTool(env, params?.name, params?.arguments);
        return mcpResult(id, result);
      }
      default:
        return mcpError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    console.error('MyLife MCP error:', e);
    return mcpError(id, -32000, e.message || 'Internal error');
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/mylife/api/')) {
      try {
        return await handleMylifeApi(request, env, url);
      } catch (e) {
        console.error('MyLife API error:', e);
        return jsonResponse({ error: e.message }, 500);
      }
    }

    if (url.pathname === '/mylife/mcp') {
      return handleMylifeMcp(request, env, url);
    }

    // Manual trigger for debugging scheduled jobs (secured with bot token as secret)
    if (url.pathname === '/debug/morning') {
      if (url.searchParams.get('token') !== env.TG_TOKEN) return new Response('Forbidden', { status: 403 });
      try {
        await sendMorningQuestion(env);
        return new Response('Sent');
      } catch (e) {
        console.error('Manual trigger failed:', e);
        return new Response('Error: ' + e.message, { status: 500 });
      }
    }

    if (request.method !== 'POST') return new Response('OK');

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
    try {
      await handleScheduled(env, event.cron);
    } catch (e) {
      console.error('Scheduled job failed:', e);
      try {
        await send(env, `⚠️ <b>Сбой в плановой задаче</b> (cron: ${event.cron})\n<code>${(e.message || String(e)).slice(0, 300)}</code>`);
      } catch {}
    }
  },
};
