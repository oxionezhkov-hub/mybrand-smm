// MyLife companion bot — Cloudflare Worker
// Telegram bot (task summaries, YouTube transcription) + MyLife web app backend + MCP server

// ── Constants ────────────────────────────────────────────────────────────────

const TZ_OFFSET = 3; // Moscow UTC+3

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
  const [tasks, projects, priorities, habits, extraLogs, focus, focusBlocks, recommendations, knowledge, commProfile, wins, activityDays, checkins] = await Promise.all([
    kget(env, 'mylife:tasks', []),
    kget(env, 'mylife:projects', null),
    kget(env, 'mylife:priorities', null),
    kget(env, 'mylife:habits', []),
    kget(env, 'mylife:extra-logs', []),
    kget(env, 'mylife:focus', {}),
    kget(env, 'mylife:focus-blocks', []),
    kget(env, 'mylife:recommendations', []),
    kget(env, 'mylife:knowledge', ''),
    kget(env, 'mylife:comm-profile', ''),
    kget(env, 'mylife:wins', []),
    kget(env, 'mylife:activity-days', []),
    kget(env, 'mylife:checkins', []),
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
  return {
    tasks, projects: proj, priorities: pri, habits, extraLogs, focus,
    focusBlocks, recommendations, knowledge, commProfile, wins, checkins,
    activityDays, streak: mlComputeStreak(activityDays),
  };
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

  if (resource === 'status-log' && request.method === 'POST') {
    const body = await readJson(request);
    const result = await mlLogStatusEvent(env, body.statusType);
    if (!result) return jsonResponse({ error: 'invalid statusType' }, 400);
    return jsonResponse({ ...result, extraLogs: await kget(env, 'mylife:extra-logs', []) });
  }

  if (resource === 'focus') {
    if (request.method === 'POST') return mlSetFocusDay(env, await readJson(request));
    if (request.method === 'PATCH' && id) return mlUpdateFocusTask(env, id, await readJson(request));
  }

  if (resource === 'link-preview' && request.method === 'POST') {
    const body = await readJson(request);
    return mlLinkPreview(env, body.url);
  }

  if (resource === 'push') {
    if (id === 'vapid-key' && request.method === 'GET') {
      return env.VAPID_PRIVATE_JWK
        ? jsonResponse({ key: vapidPublicKeyRaw(env) })
        : jsonResponse({ error: 'push not configured' }, 503);
    }
    if (id === 'subscribe' && request.method === 'POST') return mlPushSubscribe(env, await readJson(request));
    if (id === 'unsubscribe' && request.method === 'POST') return mlPushUnsubscribe(env, await readJson(request));
    if (id === 'test' && request.method === 'GET') {
      const subs = await kget(env, 'mylife:push-subs', []);
      const results = [];
      for (const sub of subs) {
        let entry = { endpointHost: null, status: null, error: null };
        try {
          entry.endpointHost = new URL(sub.endpoint).host;
          const res = await sendWebPush(env, sub, {
            title: 'Тест уведомлений',
            body: 'Если видишь это — push работает 🎉',
            tag: 'mylife-test',
            url: '/mylife/',
          });
          entry.status = res.status;
          if (res.status >= 400) entry.error = await res.text().catch(() => null);
        } catch (e) {
          entry.error = e.message || String(e);
        }
        results.push(entry);
      }
      return jsonResponse({ ok: true, subscriptions: subs.length, results });
    }
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
    kind: body.kind === 'status' ? 'status' : null,
    statusType: STATUS_EVENTS[body.statusType] ? body.statusType : null,
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

// ── Day status pings (started work / break / woke up / went to sleep) ──────────
// Not tasks — just timestamped markers, shown in the same Progress timeline as
// completed tasks and free-form notes, so the day's rhythm is visible at a glance.

const STATUS_EVENTS = {
  work_start: { emoji: '🟢', label: 'Начал работу' },
  break: { emoji: '☕', label: 'Ушёл отдыхать' },
  wake: { emoji: '🌅', label: 'Проснулся' },
  sleep: { emoji: '😴', label: 'Лёг спать' },
};

const STATUS_PATTERNS = [
  { statusType: 'work_start', re: /^(начал\s*(работу|работать)|приступ(ил|аю)|начинаю\s*работу|за работу)/i },
  { statusType: 'break', re: /^(ушел|ушёл|ушла|иду)?\s*(отдыхать|на перерыв|перерыв\b|отдых\b)/i },
  { statusType: 'wake', re: /^(проснул(ся|ась)|встал|встала|доброе утро)/i },
  { statusType: 'sleep', re: /^(лёг|лег|легла|пошел|пошёл|пошла|иду)?\s*спать|ложусь\s*спать|спокойной\s*ночи/i },
];

function detectStatusEvent(text) {
  const t = text.replace(/^[^\p{L}]+/u, '').trim();
  for (const p of STATUS_PATTERNS) {
    if (p.re.test(t)) return p.statusType;
  }
  return null;
}

function formatDuration(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h && m) return `${h} ч ${m} мин`;
  if (h) return `${h} ч`;
  return `${Math.max(m, 1)} мин`;
}

async function mlLogStatusEvent(env, statusType) {
  const meta = STATUS_EVENTS[statusType];
  if (!meta) return null;

  const logs = await kget(env, 'mylife:extra-logs', []);
  const prevStatus = [...logs].reverse().find(l => l.kind === 'status');
  const now = Date.now();

  const entry = {
    id: crypto.randomUUID(),
    dateKey: todayMSK(),
    text: `${meta.emoji} ${meta.label}`,
    kind: 'status',
    statusType,
    createdAt: now,
  };
  logs.push(entry);
  await kset(env, 'mylife:extra-logs', logs);
  await mlTouchActivity(env, todayMSK());

  let elapsedText = null;
  if (prevStatus) {
    const prevMeta = STATUS_EVENTS[prevStatus.statusType];
    elapsedText = `С «${prevMeta?.label ?? prevStatus.text}» прошло ${formatDuration(Math.round((now - prevStatus.createdAt) / 60000))}.`;
  }
  return { entry, elapsedText };
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

// Marks an existing task done (by id) or creates a new one already done — used
// by the Telegram bot when the user reports work they just finished. Returns
// the task itself; its completedAt is what the Progress panel timelines on,
// so no separate log entry is needed.
async function mlLogTaskDone(env, { taskId, title, projectId, newProjectName }) {
  let tasks;
  let task;
  if (taskId) {
    tasks = await kget(env, 'mylife:tasks', []);
    task = tasks.find(t => t.id === taskId);
    if (!task) return null;
  } else {
    const createRes = await mlCreateTask(env, { title, projectId, newProjectName });
    const { task: created } = await createRes.json();
    tasks = await kget(env, 'mylife:tasks', []);
    task = tasks.find(t => t.id === created.id);
  }
  task.status = 'done';
  task.completedAt = Date.now();
  await kset(env, 'mylife:tasks', tasks);
  await mlTouchActivity(env, todayMSK());
  return task;
}

// ── Bulk task operations — one KV round trip for many tasks at once, so a
// request like "delete all my tasks" doesn't require finding and deleting
// each task individually. ──────────────────────────────────────────────────

async function mlBulkCreateTasks(env, body) {
  const items = Array.isArray(body.tasks) ? body.tasks : [];
  if (!items.length) return jsonResponse({ error: 'tasks required' }, 400);

  const { tasks, projects } = await mlLoadAll(env);
  const created = [];

  for (const item of items) {
    let projectId = item.projectId || MYLIFE_GENERAL_PROJECT;
    if (item.newProjectName && item.newProjectName.trim()) {
      const name = item.newProjectName.trim();
      const existing = projects.find(p => p.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        projectId = existing.id;
      } else {
        const newProject = { id: crypto.randomUUID(), name, order: projects.length, createdAt: Date.now() };
        projects.push(newProject);
        projectId = newProject.id;
      }
    } else if (!projects.find(p => p.id === projectId)) {
      projectId = MYLIFE_GENERAL_PROJECT;
    }

    const siblingCount = tasks.filter(t => t.projectId === projectId && t.status === 'active').length
      + created.filter(t => t.projectId === projectId).length;

    const task = {
      id: crypto.randomUUID(),
      title: (item.title || '').trim() || 'Без названия',
      description: item.description || '',
      projectId,
      priorityId: item.priorityId || null,
      dueDate: item.dueDate || null,
      plannedMinutes: null,
      status: 'active',
      order: siblingCount,
      createdAt: Date.now(),
      completedAt: null,
      archivedAt: null,
    };
    tasks.push(task);
    created.push(task);
  }

  await kset(env, 'mylife:tasks', tasks);
  await kset(env, 'mylife:projects', projects);
  return jsonResponse({ created, count: created.length, projects });
}

function mlTaskMatchesFilter(t, filter) {
  if (filter.ids?.length) return filter.ids.includes(t.id);
  if (filter.status && t.status !== filter.status) return false;
  if (filter.projectId && t.projectId !== filter.projectId) return false;
  if (filter.priorityId && t.priorityId !== filter.priorityId) return false;
  return true;
}

function mlFilterIsEmpty(filter) {
  return !filter.ids?.length && !filter.status && !filter.projectId && !filter.priorityId;
}

async function mlBulkUpdateTasks(env, body) {
  const filter = body.filter || {};
  const patch = body.patch || {};
  if (mlFilterIsEmpty(filter)) {
    return jsonResponse({ error: 'filter required: at least one of ids, status, projectId, priorityId' }, 400);
  }

  const tasks = await kget(env, 'mylife:tasks', []);
  const fields = ['title', 'description', 'projectId', 'priorityId', 'dueDate', 'plannedMinutes'];
  let count = 0;

  for (const t of tasks) {
    if (!mlTaskMatchesFilter(t, filter)) continue;
    count++;
    for (const f of fields) {
      if (patch[f] !== undefined) t[f] = patch[f];
    }
    if (patch.status && patch.status !== t.status) {
      t.status = patch.status;
      if (patch.status === 'done') t.completedAt = Date.now();
      if (patch.status === 'archived') t.archivedAt = Date.now();
      if (patch.status === 'active') { t.completedAt = null; t.archivedAt = null; }
    }
  }

  await kset(env, 'mylife:tasks', tasks);
  return jsonResponse({ updated: count });
}

async function mlBulkDeleteTasks(env, body) {
  const filter = body.filter || {};
  if (mlFilterIsEmpty(filter) && !filter.all) {
    return jsonResponse({ error: 'filter required: ids, status, projectId, priorityId, or filter.all=true to delete every task' }, 400);
  }

  const tasks = await kget(env, 'mylife:tasks', []);
  const remaining = filter.all ? [] : tasks.filter(t => !mlTaskMatchesFilter(t, filter));
  const deleted = tasks.length - remaining.length;
  await kset(env, 'mylife:tasks', remaining);
  return jsonResponse({ deleted });
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

// ── MyLife productivity extensions: focus blocks, streaks, check-ins, ──────────
// recommendations, knowledge base, communication profile, wins, scratchpad.

async function mlTouchActivity(env, dateKey) {
  const days = await kget(env, 'mylife:activity-days', []);
  if (!days.includes(dateKey)) {
    days.push(dateKey);
    await kset(env, 'mylife:activity-days', days);
  }
}

function mlComputeStreak(days) {
  const set = new Set(days);
  let d = todayMSK();
  if (!set.has(d)) d = prevDay(d); // today not logged yet shouldn't zero out an ongoing streak
  let streak = 0;
  while (set.has(d)) {
    streak++;
    d = prevDay(d);
  }
  return streak;
}

async function mlStartFocusBlock(env, body) {
  const blocks = await kget(env, 'mylife:focus-blocks', []);
  for (const b of blocks) {
    if (b.status === 'active') { b.status = 'abandoned'; b.endedAt = Date.now(); }
  }
  const taskTitle = (body.taskTitle || '').trim();
  if (!taskTitle) return jsonResponse({ error: 'taskTitle required' }, 400);
  const block = {
    id: crypto.randomUUID(),
    taskTitle,
    taskId: body.taskId || null,
    durationMinutes: 90,
    startedAt: Date.now(),
    endedAt: null,
    status: 'active',
  };
  blocks.push(block);
  await kset(env, 'mylife:focus-blocks', blocks);
  return jsonResponse({ block });
}

async function mlEndFocusBlock(env, body) {
  const blocks = await kget(env, 'mylife:focus-blocks', []);
  const block = body.id
    ? blocks.find(b => b.id === body.id)
    : [...blocks].reverse().find(b => b.status === 'active');
  if (!block) return jsonResponse({ error: 'no matching focus block' }, 404);
  block.status = body.status === 'abandoned' ? 'abandoned' : 'done';
  block.endedAt = Date.now();
  await kset(env, 'mylife:focus-blocks', blocks);
  if (block.status === 'done') await mlTouchActivity(env, todayMSK());
  return jsonResponse({ block });
}

const MYLIFE_CHECKIN_QUESTIONS = [
  'Что сегодня получилось лучше всего?',
  'Что сегодня забрало больше всего энергии?',
  'Было ли сегодня ощущение потока? Когда именно?',
  'Что я откладывал(а) сегодня и почему?',
  'Как я оцениваю своё тело и энергию прямо сейчас, простыми словами?',
  'Что я хочу отпустить перед сном?',
  'За что я могу себя сегодня похвалить?',
  'Что бы я хотел(а) завтра сделать иначе?',
  'Какая мысль сейчас крутится в голове?',
  'Что сегодня удивило?',
];

function mlPickCheckinQuestions(n = 3) {
  const pool = [...MYLIFE_CHECKIN_QUESTIONS];
  const picked = [];
  while (picked.length < n && pool.length) {
    picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return picked;
}

async function mlSaveCheckin(env, body) {
  const answers = Array.isArray(body.answers) ? body.answers.filter(a => a && a.question && a.answer) : [];
  if (!answers.length) return jsonResponse({ error: 'answers required' }, 400);
  const checkins = await kget(env, 'mylife:checkins', []);
  const dateKey = isValidDateKey(body.dateKey) ? body.dateKey : todayMSK();
  const entry = { id: crypto.randomUUID(), dateKey, answers, createdAt: Date.now() };
  checkins.push(entry);
  await kset(env, 'mylife:checkins', checkins);
  await mlTouchActivity(env, dateKey);
  return jsonResponse({ checkin: entry });
}

async function mlAddRecommendation(env, body) {
  const text = (body.text || '').trim();
  if (!text) return jsonResponse({ error: 'text required' }, 400);
  const list = await kget(env, 'mylife:recommendations', []);
  const entry = { id: crypto.randomUUID(), text, tag: body.tag || null, createdAt: Date.now() };
  list.push(entry);
  await kset(env, 'mylife:recommendations', list);
  return jsonResponse({ recommendation: entry, recommendations: list });
}

async function mlGetTextBlob(env, key) {
  return jsonResponse({ text: await kget(env, key, '') });
}

async function mlUpdateTextBlob(env, key, body) {
  let text = await kget(env, key, '');
  const addition = (body.text || '').trim();
  text = body.mode === 'replace' || !text ? addition : `${text}\n\n${addition}`;
  await kset(env, key, text);
  return jsonResponse({ text });
}

async function mlAddWin(env, body) {
  const text = (body.text || '').trim();
  if (!text) return jsonResponse({ error: 'text required' }, 400);
  const wins = await kget(env, 'mylife:wins', []);
  const win = { id: crypto.randomUUID(), text, dateKey: isValidDateKey(body.dateKey) ? body.dateKey : todayMSK(), createdAt: Date.now() };
  wins.push(win);
  await kset(env, 'mylife:wins', wins);
  return jsonResponse({ win, wins });
}

async function mlWeeklyReview(env) {
  const snapshot = await mlLoadAll(env);
  const cutoff = Date.now() - 7 * 86400000;
  const completedTasks = snapshot.tasks.filter(t => t.status === 'done' && t.completedAt && t.completedAt >= cutoff);
  const overdueTasks = snapshot.tasks.filter(t => t.status === 'active' && t.dueDate && t.dueDate < todayMSK());
  const blocksThisWeek = snapshot.focusBlocks.filter(b => b.startedAt >= cutoff);
  const doneBlocks = blocksThisWeek.filter(b => b.status === 'done');
  const winsThisWeek = snapshot.wins.filter(w => w.createdAt >= cutoff);
  return {
    streak: snapshot.streak,
    completedTasks: completedTasks.map(t => t.title),
    overdueTasks: overdueTasks.map(t => t.title),
    focusBlocks: { started: blocksThisWeek.length, completed: doneBlocks.length, totalMinutes: doneBlocks.length * 90 },
    wins: winsThisWeek.map(w => w.text),
  };
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

const CLAUDE_BASE_SYSTEM = `Ты личный ассистент пользователя в Telegram-боте MyLife.
Форматирование — только HTML для Telegram: <b>жирный</b>, <i>курсив</i>, <code>код</code>, <pre>таблица</pre>. Не используй Markdown-звёздочки (**), решётки (#) и другие markdown-символы.
Отвечай кратко и конкретно. Не задавай уточняющих вопросов — просто выполни задачу. Не добавляй «если хочешь», «дай знать», «готов помочь» и подобные фразы.`;

// Llama via Cloudflare AI — free, used as a fallback when Claude is unavailable
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

// Non-streaming AI call — for JSON parsing, short utility calls.
// TEMPORARILY routed through the free Cloudflare Workers AI Llama model
// instead of paid Claude, per owner's request — CLAUDE_API/api.anthropic.com
// is unused while this stands; see git history for the previous Claude body
// to switch back.
async function callClaude(env, { system = '', user, json = false } = {}) {
  const fullSystem = system ? `${CLAUDE_BASE_SYSTEM}\n\n${system}` : CLAUDE_BASE_SYSTEM;
  const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [
      { role: 'system', content: fullSystem },
      { role: 'user', content: user },
    ],
  });
  const text = (result?.response ?? '').trim();

  if (json) {
    try {
      return JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
    } catch {
      return null;
    }
  }
  return text;
}

// Streaming AI call. TEMPORARILY just delegates to Llama (see callClaude above
// for why); kept as its own function so call sites don't need to change either
// way this gets switched.
async function callClaudeStreaming(env, { system = '', user }, msgId) {
  return callLlamaStreaming(env, { system, user }, msgId);
}

// ── YouTube transcription ────────────────────────────────────────────────────
// YouTube blocks unauthenticated caption scraping from datacenter IPs (incl.
// Cloudflare Workers) with a "sign in to confirm you're not a bot" wall, so we
// use the Supadata API (https://supadata.ai) to fetch transcripts instead.
// Title comes from YouTube's own oEmbed endpoint, which isn't gated.

const YT_MAX_TRANSCRIPT_CHARS = 120000;
const SUPADATA_POLL_ATTEMPTS = 20;
const SUPADATA_POLL_DELAY_MS = 3000;

function extractYouTubeId(text) {
  const m = text.match(/(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtube\.com\/embed\/|youtu\.be\/|m\.youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function fetchYouTubeTitle(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.title || null;
  } catch {
    return null;
  }
}

function supadataContentToText(data) {
  if (typeof data?.content === 'string') return data.content;
  if (Array.isArray(data?.content)) return data.content.map(c => c.text).join(' ');
  return null;
}

async function pollSupadataJob(env, jobId) {
  for (let i = 0; i < SUPADATA_POLL_ATTEMPTS; i++) {
    await new Promise(r => setTimeout(r, SUPADATA_POLL_DELAY_MS));
    const res = await fetch(`https://api.supadata.ai/v1/transcript/${jobId}`, {
      headers: { 'x-api-key': env.SUPADATA_API_KEY },
    });
    if (res.status === 202) continue;
    if (!res.ok) return null;
    return supadataContentToText(await res.json());
  }
  return null;
}

async function fetchSupadataTranscript(env, videoUrl) {
  const res = await fetch(`https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(videoUrl)}&text=true&mode=auto`, {
    headers: { 'x-api-key': env.SUPADATA_API_KEY },
  });

  if (res.status === 202) {
    const { jobId } = await res.json();
    return pollSupadataJob(env, jobId);
  }
  if (!res.ok) {
    console.error('Supadata transcript error:', res.status, await res.text().catch(() => ''));
    return null;
  }
  return supadataContentToText(await res.json());
}

async function fetchYouTubeTranscript(env, videoId) {
  const [title, transcript] = await Promise.all([
    fetchYouTubeTitle(videoId),
    fetchSupadataTranscript(env, `https://www.youtube.com/watch?v=${videoId}`),
  ]);
  return { title: title || 'YouTube видео', transcript };
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
    data = await fetchYouTubeTranscript(env, videoId);
  } catch (e) {
    console.error('YouTube transcript fetch error:', e);
  }

  if (!data || !data.transcript) {
    await editMsg(env, statusId, '⚠️ Не удалось получить транскрипцию этого видео — у него нет субтитров, либо видео недоступно.');
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

async function send(env, text, extra = {}, chatId = env.OWNER_CHAT_ID) {
  return tgReq(env, 'sendMessage', {
    chat_id: chatId,
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

async function sendDocument(env, filename, content, extra = {}, chatId = env.OWNER_CHAT_ID) {
  const form = new FormData();
  form.append('chat_id', chatId);
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

// ── Main message handler ──────────────────────────────────────────────────────

const STATUS_KEYBOARD = {
  keyboard: [
    ['🟢 Начал работу', '☕ Ушёл отдыхать'],
    ['🌅 Проснулся', '😴 Лёг спать'],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

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

  const text = msg.text || msg.caption || '';

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

  if (text === '/start' || text === '/help') {
    await send(env, `<b>MyLife-бот</b>\n\nПришли ссылку на YouTube-видео — верну файл с транскрипцией и саммари. Ответь на сообщение с саммари вопросом — отвечу по содержанию видео.\n\n<b>Задачи:</b> напиши, что ты сделал (например «сделал дизайн лендинга») — найду похожую задачу в трекере и предложу отметить выполненной, а если не найду — спрошу, в какой проект добавить.\n\n<b>Статус дня:</b> кнопки ниже (или просто напиши) — «начал работу» / «ушёл отдыхать» / «проснулся» / «лёг спать». Это не задачи, а метки времени — помогают понять, сколько ты работаешь.\n\nЛюбое другое сообщение — это разговор с твоим MyLife-коучем, который видит твои актуальные задачи, проекты и привычки.\n\n/today — саммари задач на сегодня\n/help — справка`, {
      reply_markup: STATUS_KEYBOARD,
    });
    return;
  }

  if (text === '/today') {
    await send(env, await mlMorningBriefText(env));
    return;
  }

  if (text.startsWith('/')) {
    await send(env, 'Неизвестная команда. /help');
    return;
  }

  // Day status ping (started work / break / woke up / went to sleep) — not a task
  const statusType = detectStatusEvent(text);
  if (statusType) {
    const { elapsedText } = await mlLogStatusEvent(env, statusType);
    const meta = STATUS_EVENTS[statusType];
    await send(env, `${meta.emoji} Записал: ${meta.label}${elapsedText ? `\n<i>${elapsedText}</i>` : ''}`);
    return;
  }

  // Otherwise, check whether this reports a task the user just finished
  const { tasks, projects } = await mlLoadAll(env);
  const active = tasks.filter(t => t.status === 'active');
  let match = null;
  try {
    match = await matchTaskReport(env, text, active);
  } catch (e) {
    console.error('matchTaskReport failed:', e);
  }

  if (match?.isTaskReport) {
    const matchedTask = match.matchedTaskId ? active.find(t => t.id === match.matchedTaskId) : null;
    const fallbackTitle = (match.suggestedTitle || text).slice(0, 80);

    if (matchedTask) {
      await kset(env, 'session', { state: 'awaiting_task_confirm', taskId: matchedTask.id, rawText: text, suggestedTitle: fallbackTitle });
      await send(env, `Похоже, это задача: <b>${escapeHtml(matchedTask.title)}</b>\nОтметить выполненной?`, {
        reply_markup: { inline_keyboard: [[
          { text: '✅ Да, отметить', callback_data: 'taskdone:yes' },
          { text: '✖️ Нет, это другое', callback_data: 'taskdone:no' },
        ]] },
      });
      return;
    }

    await kset(env, 'session', { state: 'awaiting_task_project', rawText: text, suggestedTitle: fallbackTitle });
    await send(env, `Не нашёл подходящую задачу в трекере. К какому проекту отнести «${escapeHtml(fallbackTitle)}»?`, {
      reply_markup: { inline_keyboard: [
        ...projects.map(p => [{ text: p.name, callback_data: `taskproj:${p.id}` }]),
        [{ text: '✖️ Не добавлять', callback_data: 'taskproj:cancel' }],
      ] },
    });
    return;
  }

  await handleChat(env, text);
}

// Classifies a free-text message: does it report a task the user just finished,
// and if so which active task (if any) it most likely matches.
async function matchTaskReport(env, text, activeTasks) {
  const taskList = activeTasks.slice(0, 80).map(t => `${t.id}: ${t.title}`).join('\n');
  const result = await callClaude(env, {
    system: 'Ты классифицируешь сообщения пользователя в личном трекере задач. Отвечай только валидным JSON.',
    user: `Активные задачи (id: название):\n${taskList || '(нет задач)'}\n\nСообщение пользователя: "${text}"\n\nПользователь часто пишет о сделанной работе в сжатом стиле трекера задач — короткой фразой действие+объект, БЕЗ явного прошедшего времени (например "Ответить Софии по МБА" значит то же самое, что "Ответил Софии по МБА"). Такие короткие фразы-отчёты тоже нужно засчитывать как отчёт о выполненной работе.\n\nЭто отчёт о сделанной/законченной работе (в любой форме — с прошедшим временем или без), или это вопрос к тебе, просьба о совете, обсуждение, планирование будущего, или статус дня (начал работу/отдыхаю/проснулся/сплю)? Вопросы и просьбы о помощи — НЕ отчёт о работе, даже если упоминают задачи.\n\nЕсли это отчёт о работе — сопоставь по смыслу (тот же клиент/тема/действие, не только точное совпадение слов) с одной из активных задач. Если подходящей задачи нет — предложи короткое название (3-6 слов) для новой задачи, в том же сжатом стиле, что писал пользователь.\n\nВерни строго JSON без пояснений:\n{"isTaskReport": true|false, "matchedTaskId": "id или null", "suggestedTitle": "название или null"}`,
    json: true,
  });
  return result || { isTaskReport: false, matchedTaskId: null, suggestedTitle: null };
}

// ── Callback handler ──────────────────────────────────────────────────────────

async function handleCallback(env, query) {
  const data = query.data;
  await tgReq(env, 'answerCallbackQuery', { callback_query_id: query.id });

  if (data === 'taskdone:yes') {
    const session = await kget(env, 'session', {});
    if (session.state !== 'awaiting_task_confirm') return;
    await kset(env, 'session', { state: 'idle' });
    const task = await mlLogTaskDone(env, { taskId: session.taskId });
    if (task) await send(env, `✅ Отметил выполненной: <b>${escapeHtml(task.title)}</b>`);
    return;
  }

  if (data === 'taskdone:no') {
    const session = await kget(env, 'session', {});
    if (session.state !== 'awaiting_task_confirm') return;
    const { projects } = await mlLoadAll(env);
    await kset(env, 'session', { state: 'awaiting_task_project', rawText: session.rawText, suggestedTitle: session.suggestedTitle });
    await send(env, `Хорошо. К какому проекту отнести «${escapeHtml(session.suggestedTitle)}»?`, {
      reply_markup: { inline_keyboard: [
        ...projects.map(p => [{ text: p.name, callback_data: `taskproj:${p.id}` }]),
        [{ text: '✖️ Не добавлять', callback_data: 'taskproj:cancel' }],
      ] },
    });
    return;
  }

  if (data.startsWith('taskproj:')) {
    const session = await kget(env, 'session', {});
    if (session.state !== 'awaiting_task_project') return;
    await kset(env, 'session', { state: 'idle' });

    const projectId = data.replace('taskproj:', '');
    if (projectId === 'cancel') {
      await send(env, 'Ок, не добавляю.');
      return;
    }

    const task = await mlLogTaskDone(env, { title: session.suggestedTitle, projectId });
    if (task) await send(env, `✅ Добавил и отметил выполненной: <b>${escapeHtml(task.title)}</b>`);
    return;
  }
}

async function handleChat(env, text) {
  const msgId = await sendGetId(env, '…');
  const snapshot = await mlLoadAll(env);

  const history = await kget(env, 'conv:history', []);
  history.push({ role: 'user', content: text });
  const historyText = history.slice(-12)
    .map(m => `${m.role === 'user' ? 'Пользователь' : 'Коуч'}: ${m.content}`)
    .join('\n');

  const reply = await callClaudeStreaming(env, {
    system: `${MYLIFE_COACH_SYSTEM}\n\nТекущий срез данных пользователя:\n${mlSnapshotSummary(snapshot)}`,
    user: `История переписки (для контекста, отвечай на последнее сообщение пользователя):\n${historyText}`,
  }, msgId);

  history.push({ role: 'assistant', content: reply });
  if (history.length > 30) history.splice(0, history.length - 30);
  await kset(env, 'conv:history', history);
  await mlTouchActivity(env, todayMSK());
}

// ── Scheduled jobs ────────────────────────────────────────────────────────────

async function handleScheduled(env, cron) {
  // Every 5 minutes — Zoom transcript polling fallback (see checkPendingZoomTranscripts).
  // Kept outside the MAILINGS_PAUSED gate below: pausing the daily task-summary/push
  // mailings shouldn't also stop recordings from reaching Telegram.
  if (cron === '*/5 * * * *') {
    await checkPendingZoomTranscripts(env);
    return;
  }

  if (env.MAILINGS_PAUSED === 'true') return;

  // 7:00 MSK = 4:00 UTC — morning task summary in Telegram + browser push
  if (cron === '0 4 * * *') {
    await send(env, await mlMorningBriefText(env));
    await pushBroadcast(env, {
      title: 'Доброе утро',
      body: 'Загляни в задачи на сегодня.',
      tag: 'mylife-morning',
      url: '/mylife/',
    });
    return;
  }

  // 13:00 MSK = 10:00 UTC — daytime browser push: update task statuses
  if (cron === '0 10 * * *') {
    await pushBroadcast(env, {
      title: 'Обновление задач',
      body: 'Проверь и обнови статусы задач.',
      tag: 'mylife-day',
      url: '/mylife/',
    });
    return;
  }

  // 21:00 MSK = 18:00 UTC — evening browser push: plan tomorrow
  if (cron === '0 18 * * *') {
    await pushBroadcast(env, {
      title: 'План на завтра',
      body: 'Спланируй, что сделать завтра.',
      tag: 'mylife-evening',
      url: '/mylife/',
    });
    return;
  }
}


async function mlMorningBriefText(env) {
  const snapshot = await mlLoadAll(env);
  const today = todayMSK();
  const focus = snapshot.focus[today];
  const active = snapshot.tasks.filter(t => t.status === 'active');
  const dueToday = active.filter(t => t.dueDate === today);
  const overdue = active.filter(t => t.dueDate && t.dueDate < today);

  const projectName = id => snapshot.projects.find(p => p.id === id)?.name || id;

  const lines = [`🌅 <b>Саммари задач</b>`, `🔥 Стрик: ${snapshot.streak} дн.`];

  if (focus?.tasks?.length) {
    lines.push('', '<b>Фокус на сегодня:</b>');
    for (const t of focus.tasks) {
      const mark = t.status === 'done' ? '✅' : t.status === 'skipped' ? '⊘' : '⬜';
      lines.push(`${mark} ${t.name}${t.estimatedMinutes ? ` (~${t.estimatedMinutes} мин)` : ''}`);
    }
  }

  if (overdue.length) {
    lines.push('', `<b>Просрочено (${overdue.length}):</b>`);
    for (const t of overdue.slice(0, 10)) lines.push(`• ${t.title} — ${projectName(t.projectId)}`);
  }

  if (dueToday.length) {
    lines.push('', `<b>Срок сегодня (${dueToday.length}):</b>`);
    for (const t of dueToday.slice(0, 10)) lines.push(`• ${t.title} — ${projectName(t.projectId)}`);
  }

  lines.push('', `Всего активных задач: ${active.length}`);

  return lines.join('\n');
}

// ── Web Push (RFC 8291/8292) ─────────────────────────────────────────────────
// Sends browser push notifications (Chrome, Safari 16.4+ as an installed PWA)
// using VAPID auth + aes128gcm payload encryption, no external dependency.

function b64urlToBytes(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

function vapidJwk(env) {
  return JSON.parse(env.VAPID_PRIVATE_JWK);
}

function vapidPublicKeyRaw(env) {
  const jwk = vapidJwk(env);
  return bytesToB64url(concatBytes(new Uint8Array([0x04]), b64urlToBytes(jwk.x), b64urlToBytes(jwk.y)));
}

async function buildVapidJWT(env, audience) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:owner@example.com',
  };
  const encHeader = bytesToB64url(new TextEncoder().encode(JSON.stringify(header)));
  const encPayload = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encHeader}.${encPayload}`;
  const key = await crypto.subtle.importKey('jwk', vapidJwk(env), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`;
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

async function hkdfExpand(prk, info, length) {
  const t1 = await hmacSha256(prk, concatBytes(info, new Uint8Array([1])));
  return t1.slice(0, length);
}

// RFC 8291 §3.4 — derive the aes128gcm content-encryption key/nonce from the
// subscriber's P-256 key + auth secret and an ephemeral application-server keypair.
async function encryptWebPushPayload(subscription, payloadObj) {
  const p256dh = b64urlToBytes(subscription.keys.p256dh);
  const authSecret = b64urlToBytes(subscription.keys.auth);

  const uaPublicKey = await crypto.subtle.importKey('raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const asKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));

  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublicKey }, asKeyPair.privateKey, 256);
  const ecdhSecret = new Uint8Array(sharedBits);

  const prk = await hmacSha256(authSecret, ecdhSecret);
  const keyInfo = concatBytes(new TextEncoder().encode('WebPush: info\0'), p256dh, asPublicRaw);
  const ikm = await hkdfExpand(prk, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk2 = await hmacSha256(salt, ikm);
  const cek = await hkdfExpand(prk2, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk2, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const plaintext = new TextEncoder().encode(JSON.stringify(payloadObj));
  const recordPlain = concatBytes(plaintext, new Uint8Array([2])); // aes128gcm last-record delimiter

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, recordPlain));

  const rs = ciphertext.length;
  const header = concatBytes(
    salt,
    new Uint8Array([(rs >>> 24) & 0xff, (rs >>> 16) & 0xff, (rs >>> 8) & 0xff, rs & 0xff]),
    new Uint8Array([asPublicRaw.length]),
    asPublicRaw,
  );

  return concatBytes(header, ciphertext);
}

async function sendWebPush(env, subscription, payloadObj) {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await buildVapidJWT(env, audience);
  const body = await encryptWebPushPayload(subscription, payloadObj);
  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      'Authorization': `vapid t=${jwt}, k=${vapidPublicKeyRaw(env)}`,
    },
    body,
  });
}

async function pushBroadcast(env, payloadObj) {
  if (!env.VAPID_PRIVATE_JWK) return;
  const subs = await kget(env, 'mylife:push-subs', []);
  if (!subs.length) return;
  const alive = [];
  for (const sub of subs) {
    try {
      const res = await sendWebPush(env, sub, payloadObj);
      if (res.status === 404 || res.status === 410) continue; // subscription expired/gone
      alive.push(sub);
    } catch (e) {
      console.error('Web push send failed:', e);
      alive.push(sub); // transient error — keep and retry next time
    }
  }
  if (alive.length !== subs.length) await kset(env, 'mylife:push-subs', alive);
}

async function mlPushSubscribe(env, body) {
  const sub = body.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return jsonResponse({ error: 'invalid subscription' }, 400);
  const subs = await kget(env, 'mylife:push-subs', []);
  const next = subs.filter(s => s.endpoint !== sub.endpoint);
  next.push(sub);
  await kset(env, 'mylife:push-subs', next);
  return jsonResponse({ ok: true });
}

async function mlPushUnsubscribe(env, body) {
  const subs = await kget(env, 'mylife:push-subs', []);
  const next = subs.filter(s => s.endpoint !== body.endpoint);
  await kset(env, 'mylife:push-subs', next);
  return jsonResponse({ ok: true });
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
Опирайся на переданный ниже срез данных (задачи, проекты, приоритеты, привычки, база знаний, профиль общения, стрик, недавние победы и рекомендации), если он есть — давай конкретные, выполнимые советы, помогай расставлять приоритеты, замечай риски (просроченные задачи, заброшенные привычки) и задавай не более одного уточняющего вопроса, только если это критично.
Если пользователь просит что-то запомнить о себе (стиль общения, что раздражает/помогает) — используй mylife_update_comm_profile с mode "append". Если хочешь зафиксировать важный вывод или рекомендацию, чтобы она не потерялась — используй mylife_add_recommendation.
Не лей воду, не извиняйся, не проси прощения за прошлые ответы.`;

const MYLIFE_STUCK_SYSTEM = `Пользователь застрял на задаче и не может сдвинуться с места. Не утешай и не читай мотивационные речи. Твоя единственная цель — предложить САМУЮ маленькую версию задачи, с которой можно начать прямо сейчас (буквально 2-10 минут действия). Дай один конкретный первый шаг и, если уместно, ещё один запасной вариант. Коротко, без воды.`;

// TEMPORARILY routed through Llama, same as callClaude/callClaudeStreaming above.
async function callClaudeCoach(env, { system, user }) {
  const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return (result?.response ?? '').trim();
}

function mlSnapshotSummary(snapshot) {
  const { tasks, projects, priorities, habits, knowledge, commProfile, streak, wins, recommendations } = snapshot;
  const projectName = id => projects.find(p => p.id === id)?.name || id;
  const priorityName = id => priorities.find(p => p.id === id)?.name || '—';
  const active = tasks.filter(t => t.status === 'active').sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  const lines = [];
  lines.push(`Стрик: ${streak} дн. подряд`);
  lines.push(`Проекты: ${projects.map(p => p.name).join(', ') || '—'}`);
  lines.push(`Активные задачи (${active.length}):`);
  for (const t of active.slice(0, 60)) {
    lines.push(`- [${t.id}] "${t.title}" | проект: ${projectName(t.projectId)} | приоритет: ${priorityName(t.priorityId)} | срок: ${t.dueDate || '—'}`);
  }
  if (habits.length) {
    lines.push(`Привычки: ${habits.map(h => h.name).join(', ')}`);
  }
  if (knowledge) lines.push(`\nБаза знаний о проектах/жизни пользователя:\n${knowledge}`);
  if (commProfile) lines.push(`\nКак лучше общаться с пользователем:\n${commProfile}`);
  if (wins?.length) lines.push(`\nНедавние маленькие победы: ${wins.slice(-5).map(w => w.text).join('; ')}`);
  if (recommendations?.length) lines.push(`\nПоследние сохранённые рекомендации: ${recommendations.slice(-5).map(r => r.text).join('; ')}`);
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
    description: 'Permanently delete a single task. For deleting several/all tasks at once, use mylife_bulk_delete_tasks instead — it is much cheaper than calling this per task.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'mylife_bulk_create_tasks',
    description: 'Create multiple tasks in a single call. Use whenever the user asks to add several tasks at once instead of calling mylife_create_task repeatedly.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              projectId: { type: 'string' },
              newProjectName: { type: 'string' },
              priorityId: { type: 'string' },
              dueDate: { type: 'string', description: 'YYYY-MM-DD' },
            },
            required: ['title'],
          },
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_bulk_update_tasks',
    description: 'Update every task matching a filter (or an explicit list of ids) in one call — e.g. mark everything in a project done, or move everything with a given priority to another project. Much cheaper than calling mylife_update_task per task.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          description: 'At least one of ids/status/projectId/priorityId is required. If ids is given, the other fields are ignored.',
          properties: {
            ids: { type: 'array', items: { type: 'string' } },
            status: { type: 'string', enum: ['active', 'done', 'archived'] },
            projectId: { type: 'string' },
            priorityId: { type: 'string' },
          },
          additionalProperties: false,
        },
        patch: {
          type: 'object',
          description: 'Fields to apply to every matched task.',
          properties: {
            status: { type: 'string', enum: ['active', 'done', 'archived'] },
            projectId: { type: 'string' },
            priorityId: { type: 'string' },
            dueDate: { type: 'string', description: 'YYYY-MM-DD' },
          },
          additionalProperties: false,
        },
      },
      required: ['filter', 'patch'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_bulk_delete_tasks',
    description: 'Delete every task matching a filter (or an explicit list of ids) in a single call — e.g. "delete all my tasks" or "delete all done tasks in project X". Much cheaper than finding and calling mylife_delete_task per task. Pass filter.all=true to delete every task in MyLife.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          description: 'At least one of ids/status/projectId/priorityId/all is required.',
          properties: {
            ids: { type: 'array', items: { type: 'string' } },
            status: { type: 'string', enum: ['active', 'done', 'archived'] },
            projectId: { type: 'string' },
            priorityId: { type: 'string' },
            all: { type: 'boolean', description: 'Delete every task, ignoring the other filter fields. Use only when the user clearly asked to delete everything.' },
          },
          additionalProperties: false,
        },
      },
      required: ['filter'],
      additionalProperties: false,
    },
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
    description: 'Talk to your business/productivity coach. By default the coach sees a summary of your current active tasks, projects, habits, knowledge base, communication profile, streak, recent wins and recommendations, so advice is grounded in reality.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        includeContext: { type: 'boolean', description: 'Include a snapshot of tasks/projects/habits/knowledge as context. Defaults to true.' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_start_focus_block',
    description: 'Start a 90-minute focus block on a single task. Any previously-active block is auto-marked abandoned. Ask the user which single task they will work on before calling this, then hold them to just that task for the block.',
    inputSchema: {
      type: 'object',
      properties: { taskTitle: { type: 'string' }, taskId: { type: 'string', description: 'Optional matching MyLife task id.' } },
      required: ['taskTitle'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_end_focus_block',
    description: 'End a focus block: mark it done (counts toward the streak and weekly review) or abandoned. Omit id to end whichever block is currently active.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, status: { type: 'string', enum: ['done', 'abandoned'] } },
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_list_focus_blocks',
    description: 'List recent focus blocks (default last 7 days) with their status and duration.',
    inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'How many days back to look. Defaults to 7.' } }, additionalProperties: false },
  },
  {
    name: 'mylife_get_evening_questions',
    description: 'Get 2-3 varied, non-repetitive evening check-in questions (about energy, mood, what went well/hard today) to ask the user. Follow up with mylife_save_checkin once they answer.',
    inputSchema: { type: 'object', properties: { count: { type: 'number', description: 'How many questions, 2-3. Defaults to 3.' } }, additionalProperties: false },
  },
  {
    name: 'mylife_save_checkin',
    description: 'Save the user\'s answers to an evening check-in. Counts as activity for the streak.',
    inputSchema: {
      type: 'object',
      properties: {
        dateKey: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
        answers: {
          type: 'array',
          items: { type: 'object', properties: { question: { type: 'string' }, answer: { type: 'string' } }, required: ['question', 'answer'] },
        },
      },
      required: ['answers'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_get_streak',
    description: 'Get the current streak: consecutive days with at least one completed focus block, saved check-in, or coach chat.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mylife_get_weekly_review',
    description: 'Get a rollup of the last 7 days: tasks completed, overdue tasks, focus blocks started/completed and total focused minutes, wins logged, and the current streak.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mylife_add_win',
    description: 'Log a small win/accomplishment for the day, even a minor one — for later reassurance that the day wasn\'t empty.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, dateKey: { type: 'string', description: 'YYYY-MM-DD, defaults to today' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_add_recommendation',
    description: 'Save a recommendation, insight, or conclusion from this conversation so it is not lost. Retrieve later with mylife_get_snapshot or mylife_coach_chat context.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, tag: { type: 'string', description: 'Optional short category/tag.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_get_knowledge_base',
    description: 'Get the free-form knowledge base about the user\'s projects, work, and life. Read this at the start of a new conversation to get oriented instead of asking the user to re-explain.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mylife_update_knowledge_base',
    description: 'Update the knowledge base about the user\'s projects/work/life.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'append adds to existing text; replace overwrites it. Defaults to append.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_get_comm_profile',
    description: 'Get the profile describing how best to communicate with this user: style, pet peeves, what helps, what to ask.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mylife_update_comm_profile',
    description: 'Update the communication profile — e.g. when the user says "remember that I don\'t like long lists in the morning", append that here so future conversations adapt.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'append adds to existing text; replace overwrites it. Defaults to append.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'mylife_im_stuck',
    description: 'Use when the user is stuck on a task and can\'t move forward. Returns the smallest possible next action to break the stall — not motivational advice.',
    inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'What they are stuck on.' } }, required: ['task'], additionalProperties: false },
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
    case 'mylife_bulk_create_tasks':
      return mcpResponseToToolResult(mlBulkCreateTasks(env, args));
    case 'mylife_bulk_update_tasks':
      return mcpResponseToToolResult(mlBulkUpdateTasks(env, args));
    case 'mylife_bulk_delete_tasks':
      return mcpResponseToToolResult(mlBulkDeleteTasks(env, args));
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
      await mlTouchActivity(env, todayMSK());
      return { content: [{ type: 'text', text: reply }] };
    }
    case 'mylife_start_focus_block':
      return mcpResponseToToolResult(mlStartFocusBlock(env, args));
    case 'mylife_end_focus_block':
      return mcpResponseToToolResult(mlEndFocusBlock(env, args));
    case 'mylife_list_focus_blocks': {
      const all = await kget(env, 'mylife:focus-blocks', []);
      const days = Number.isFinite(args.days) && args.days > 0 ? args.days : 7;
      const cutoff = Date.now() - days * 86400000;
      return mcpToolText({ focusBlocks: all.filter(b => b.startedAt >= cutoff) });
    }
    case 'mylife_get_evening_questions': {
      const n = [2, 3].includes(args.count) ? args.count : 3;
      return mcpToolText({ questions: mlPickCheckinQuestions(n) });
    }
    case 'mylife_save_checkin':
      return mcpResponseToToolResult(mlSaveCheckin(env, args));
    case 'mylife_get_streak': {
      const days = await kget(env, 'mylife:activity-days', []);
      return mcpToolText({ streak: mlComputeStreak(days) });
    }
    case 'mylife_get_weekly_review':
      return mcpToolText(await mlWeeklyReview(env));
    case 'mylife_add_win':
      return mcpResponseToToolResult(mlAddWin(env, args));
    case 'mylife_add_recommendation':
      return mcpResponseToToolResult(mlAddRecommendation(env, args));
    case 'mylife_get_knowledge_base':
      return mcpResponseToToolResult(mlGetTextBlob(env, 'mylife:knowledge'));
    case 'mylife_update_knowledge_base':
      if (!args.text) return mcpToolText({ error: 'text required' }, true);
      return mcpResponseToToolResult(mlUpdateTextBlob(env, 'mylife:knowledge', args));
    case 'mylife_get_comm_profile':
      return mcpResponseToToolResult(mlGetTextBlob(env, 'mylife:comm-profile'));
    case 'mylife_update_comm_profile':
      if (!args.text) return mcpToolText({ error: 'text required' }, true);
      return mcpResponseToToolResult(mlUpdateTextBlob(env, 'mylife:comm-profile', args));
    case 'mylife_im_stuck': {
      if (!args.task) return mcpToolText({ error: 'task required' }, true);
      const reply = await callClaudeCoach(env, { system: MYLIFE_STUCK_SYSTEM, user: args.task });
      return { content: [{ type: 'text', text: reply }] };
    }
    default:
      return mcpToolText({ error: `Unknown tool: ${name}` }, true);
  }
}

// Generic JSON-RPC/MCP request handler shared by every remote MCP endpoint
// this Worker exposes (MyLife, video transcription, ...). Each endpoint just
// supplies its own token, tool list, tool dispatcher and serverInfo.
async function handleMcpRequest(request, env, url, { token, tokenEnvName, tools, callTool, serverInfo }) {
  if (!token) {
    return mcpJson({ error: `Server misconfigured: ${tokenEnvName} secret is not set.` }, 500);
  }
  const authHeader = request.headers.get('Authorization') || '';
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  const reqToken = bearer || url.searchParams.get('token');
  if (reqToken !== token) {
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
          serverInfo,
        });
      case 'ping':
        return mcpResult(id, {});
      case 'tools/list':
        return mcpResult(id, { tools });
      case 'tools/call': {
        const result = await callTool(env, params?.name, params?.arguments);
        return mcpResult(id, result);
      }
      default:
        return mcpError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    console.error(`${serverInfo.name} MCP error:`, e);
    return mcpError(id, -32000, e.message || 'Internal error');
  }
}

async function handleMylifeMcp(request, env, url) {
  return handleMcpRequest(request, env, url, {
    token: env.MYLIFE_MCP_TOKEN,
    tokenEnvName: 'MYLIFE_MCP_TOKEN',
    tools: MCP_TOOLS,
    callTool: mcpCallTool,
    serverInfo: { name: 'mylife', title: 'MyLife', version: '1.0.0' },
  });
}

// ── Video transcription MCP server (Claude custom connector) ────────────────
// Standalone connector so it can be added in Claude separately from MyLife.
// Auth: shared secret via `VIDEO_MCP_TOKEN` (wrangler secret), passed as
// either `Authorization: Bearer <token>` or `?token=<token>` on the URL that
// goes into Claude's "Remote MCP server URL" field, e.g.
//   https://<worker-domain>/video/mcp?token=<token>

const VIDEO_MCP_TOOLS = [
  {
    name: 'transcribe_video',
    description: 'Fetches the transcript of an online video by URL (YouTube watch/shorts/youtu.be links, and other platforms Supadata supports) so its full text can be read and discussed. Returns the video title (when available) and the full transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL of the video, e.g. https://www.youtube.com/watch?v=... or https://youtu.be/...' },
      },
      required: ['url'],
    },
  },
];

async function mcpCallVideoTool(env, name, args) {
  switch (name) {
    case 'transcribe_video': {
      const videoUrl = args?.url;
      if (!videoUrl) return mcpToolText({ error: 'url required' }, true);

      let title = null;
      let transcript = null;
      try {
        const youtubeId = extractYouTubeId(videoUrl);
        if (youtubeId) {
          ({ title, transcript } = await fetchYouTubeTranscript(env, youtubeId));
        } else {
          transcript = await fetchSupadataTranscript(env, videoUrl);
        }
      } catch (e) {
        console.error('transcribe_video error:', e);
        return mcpToolText({ error: 'Failed to fetch transcript: ' + e.message }, true);
      }

      if (!transcript) {
        return mcpToolText({ error: 'No transcript available for this video — it may have no captions, or the URL/platform is not supported.' }, true);
      }

      const truncated = transcript.length > YT_MAX_TRANSCRIPT_CHARS;
      return mcpToolText({ title, url: videoUrl, truncated, transcript: truncateForClaude(transcript) });
    }
    default:
      return mcpToolText({ error: `Unknown tool: ${name}` }, true);
  }
}

async function handleVideoMcp(request, env, url) {
  return handleMcpRequest(request, env, url, {
    token: env.VIDEO_MCP_TOKEN,
    tokenEnvName: 'VIDEO_MCP_TOKEN',
    tools: VIDEO_MCP_TOOLS,
    callTool: mcpCallVideoTool,
    serverInfo: { name: 'video-transcription', title: 'Video Transcription', version: '1.0.0' },
  });
}

// ── Zoom → Telegram (recording + transcript) ─────────────────────────────────
// One or more independent Zoom accounts, each with its own Server-to-Server
// OAuth app and its own webhook Secret Token, all feeding the same Telegram
// bot. Configured entirely via the ZOOM_ACCOUNTS_JSON secret — no code
// changes needed to add/remove an account. See wrangler.toml for the format
// and for what to put in each Zoom app's Event Subscriptions.
//
// Per account, Event Subscriptions' endpoint URL must be:
//   https://<worker-domain>/zoom/webhook/<label>
// (a separate URL per account, matching that account's `label` — this is how
// the worker knows which webhook_secret_token to verify the request with,
// including during Zoom's URL-validation handshake).
// Subscribe to: "Recording Completed" and "All Recordings have completed
// Transcription" (recording.transcript_completed).
//
// Only recording.transcript_completed actually sends to Telegram — its
// payload already carries every recording file, transcript included, so
// there's no need to correlate two separate events. recording.completed is
// just logged (useful for wrangler tail while wiring up a new account).

function getZoomAccounts(env) {
  return parseZoomAccounts(env).accounts;
}

// Returns both the parsed accounts and, on failure, why — used by getZoomAccounts
// (which only needs the list) and by /debug/zoom-accounts (which needs the reason).
function parseZoomAccounts(env) {
  if (!env.ZOOM_ACCOUNTS_JSON) return { accounts: [], error: 'ZOOM_ACCOUNTS_JSON secret is not set' };
  try {
    const arr = JSON.parse(env.ZOOM_ACCOUNTS_JSON);
    if (!Array.isArray(arr)) return { accounts: [], error: 'ZOOM_ACCOUNTS_JSON must be a JSON array' };
    return { accounts: arr, error: null };
  } catch (e) {
    console.error('Invalid ZOOM_ACCOUNTS_JSON:', e);
    return { accounts: [], error: 'Invalid JSON: ' + e.message };
  }
}

function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  return bytesToHex(await hmacSha256(enc.encode(secret), enc.encode(message)));
}

async function getZoomAccessToken(env, account) {
  const cacheKey = `zoom:token:${account.label}`;
  const cached = await kget(env, cacheKey, null);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

  const basic = btoa(`${account.client_id}:${account.client_secret}`);
  const res = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(account.account_id)}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!res.ok) throw new Error(`Zoom OAuth ${res.status}: ${await res.text().catch(() => '')}`);

  const data = await res.json();
  const expiresIn = data.expires_in || 3600;
  const expiresAt = Date.now() + expiresIn * 1000;
  await kset(env, cacheKey, { token: data.access_token, expiresAt }, { expirationTtl: Math.max(60, expiresIn - 60) });
  return data.access_token;
}

// Zoom recording file downloads work with either the account's S2S OAuth
// bearer token or the short-lived `download_token` that comes in the same
// webhook payload (as `payload.download_token`) — the latter is the
// documented/recommended way and is what actually works for some accounts
// where the OAuth bearer gets rejected for file downloads specifically, so
// prefer it when the webhook included one.
//
// Zoom's own devforum guidance for the resulting intermittent 401 (errorCode
// 300 "Forbidden"): the file can lag behind the webhook by a few seconds on
// their end, so retry with a short delay instead of treating it as fatal.
const ZOOM_DOWNLOAD_RETRY_DELAYS_MS = [0, 5000, 10000, 15000];

async function downloadZoomFile(downloadUrl, token, downloadToken) {
  let lastError;
  for (const delay of ZOOM_DOWNLOAD_RETRY_DELAYS_MS) {
    if (delay) await new Promise(r => setTimeout(r, delay));
    try {
      const res = downloadToken
        ? await fetch(`${downloadUrl}?access_token=${encodeURIComponent(downloadToken)}`)
        : await fetch(downloadUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) return res.text();
      lastError = new Error(`Zoom file download ${res.status}: ${await res.text().catch(() => '')}`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

// Strips VTT cue numbers/timestamps/tags, keeping just the spoken text (Zoom's
// transcript cues are usually already "Speaker Name: text").
function vttToText(vtt) {
  const out = [];
  for (const rawLine of vtt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === 'WEBVTT') continue;
    if (/^\d+$/.test(line)) continue; // cue index
    if (line.includes('-->')) continue; // timestamp range
    out.push(line.replace(/<[^>]+>/g, ''));
  }
  return out.join('\n');
}

// Zoom's Report/Dashboard participant-list APIs need a Business+ plan, so on
// Pro accounts the only source of speaker names is the transcript itself —
// its cues are normally "Speaker Name: text", so pull the unique names out.
function extractSpeakers(text) {
  const names = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/^([^:<>]{1,60}):\s/);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      names.push(m[1].trim());
    }
  }
  return names;
}

async function handleZoomTranscriptCompleted(env, account, obj, downloadToken) {
  const meetingUuid = obj.uuid;
  const dedupKey = `zoom:done:${account.label}:${meetingUuid}`;
  if (await env.KV.get(dedupKey)) return;
  await env.KV.put(dedupKey, '1', { expirationTtl: 172800 }); // 48h — covers Zoom's webhook retries

  const chatId = account.chat_id || env.OWNER_CHAT_ID;
  const topic = obj.topic || 'Zoom-встреча';
  const startTime = obj.start_time ? new Date(obj.start_time) : null;
  const dateLabel = startTime ? startTime.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '';
  const transcriptFile = (obj.recording_files || []).find(f => f.file_type === 'TRANSCRIPT' || f.recording_type === 'audio_transcript');

  const lines = [`🎥 <b>${escapeHtml(topic)}</b>`];
  if (dateLabel) lines.push(dateLabel);
  if (obj.share_url) lines.push(`Запись: ${obj.share_url}`);
  if (obj.password) lines.push(`Пароль: <code>${escapeHtml(obj.password)}</code>`);
  if (!transcriptFile) lines.push('⚠️ Транскрипт недоступен для этой записи.');

  await send(env, lines.join('\n'), { link_preview_options: { is_disabled: true }, disable_web_page_preview: true }, chatId);
  if (!transcriptFile) return;

  try {
    const token = await getZoomAccessToken(env, account);
    const vtt = await downloadZoomFile(transcriptFile.download_url, token, downloadToken);
    const text = vttToText(vtt);
    const speakers = extractSpeakers(text);
    const safeTopic = topic.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60) || 'meeting';
    const dateStamp = startTime ? startTime.toISOString().slice(0, 10) : todayMSK();
    const caption = `📄 Транскрипт: ${topic}` + (speakers.length ? `\n👥 Участники: ${speakers.join(', ')}` : '');
    await sendDocument(env, `${safeTopic}_${dateStamp}.txt`, text, { caption }, chatId);
  } catch (e) {
    console.error(`Zoom transcript download failed (${account.label}/${meetingUuid}):`, e);
    await send(env, `⚠️ Не удалось скачать транскрипт (${e.message}). Ссылка на запись — выше.`, {}, chatId);
  }
}

// Fallback for recording.transcript_completed simply not firing (a known Zoom
// gap) — polls the Recordings API for meetings queued by recording.completed
// (see handleZoomWebhook) until a transcript file shows up or ~20 minutes pass.
const ZOOM_PENDING_GIVE_UP_MINUTES = 20;

async function checkPendingZoomTranscripts(env) {
  const list = await env.KV.list({ prefix: 'zoom:pending:' });
  const accounts = getZoomAccounts(env);

  for (const key of list.keys) {
    const pending = await kget(env, key.name, null);
    if (!pending) {
      await env.KV.delete(key.name);
      continue;
    }

    const account = accounts.find(a => a.label === pending.accountLabel);
    if (!account) {
      await env.KV.delete(key.name);
      continue;
    }

    // The real webhook already handled this meeting — nothing left to poll for.
    if (await env.KV.get(`zoom:done:${account.label}:${pending.meetingUuid}`)) {
      await env.KV.delete(key.name);
      continue;
    }

    try {
      const token = await getZoomAccessToken(env, account);
      // Zoom's API wants a UUID that starts with / or contains // double-encoded.
      const uuidPath = encodeURIComponent(encodeURIComponent(pending.meetingUuid));
      const res = await fetch(`https://api.zoom.us/v2/meetings/${uuidPath}/recordings`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        const hasTranscript = (data.recording_files || []).some(f => f.file_type === 'TRANSCRIPT' || f.recording_type === 'audio_transcript');
        if (hasTranscript) {
          await handleZoomTranscriptCompleted(env, account, data, null);
          await env.KV.delete(key.name);
          continue;
        }
      } else if (res.status !== 404) {
        console.error(`Zoom pending-transcript poll ${res.status} (${pending.accountLabel}/${pending.meetingUuid}):`, await res.text().catch(() => ''));
      }
    } catch (e) {
      console.error(`Zoom pending-transcript poll failed (${pending.accountLabel}/${pending.meetingUuid}):`, e);
    }

    if (Date.now() - pending.firstSeenAt >= ZOOM_PENDING_GIVE_UP_MINUTES * 60000) {
      const chatId = account.chat_id || env.OWNER_CHAT_ID;
      await send(env, `⚠️ Транскрипт для встречи «${escapeHtml(pending.topic)}» так и не появился за ${ZOOM_PENDING_GIVE_UP_MINUTES} минут. Ссылка на запись — в более раннем сообщении.`, {}, chatId);
      await env.KV.delete(key.name);
    }
  }
}

async function handleZoomWebhook(request, env, label, ctx) {
  const account = getZoomAccounts(env).find(a => a.label === label);
  if (!account) return new Response('Unknown account', { status: 404 });

  const bodyText = await request.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  // Zoom's one-time endpoint validation handshake — no signature to check yet.
  if (body.event === 'endpoint.url_validation') {
    const plainToken = body.payload?.plainToken;
    if (!plainToken) return new Response('Missing plainToken', { status: 400 });
    return jsonResponse({ plainToken, encryptedToken: await hmacHex(account.webhook_secret_token, plainToken) });
  }

  const signature = request.headers.get('x-zm-signature') || '';
  const timestamp = request.headers.get('x-zm-request-timestamp') || '';
  const expected = `v0=${await hmacHex(account.webhook_secret_token, `v0:${timestamp}:${bodyText}`)}`;
  if (signature !== expected) return new Response('Invalid signature', { status: 401 });

  const obj = body.payload?.object;
  if (body.event === 'recording.completed' && obj) {
    console.log(`Zoom recording.completed (${account.label}): ${obj.uuid}`);
    // recording.transcript_completed is the one that actually sends to Telegram, but
    // it doesn't always fire (a known Zoom gap). Queue this meeting for the every-5-minute
    // cron (checkPendingZoomTranscripts) to poll for a transcript as a fallback, in case
    // the webhook never shows up. Harmless if it does show up — that path's own KV dedup
    // (zoom:done:...) makes whichever one runs first win, and the poller drops the queue
    // entry as soon as it sees that key set.
    await kset(env, `zoom:pending:${account.label}:${obj.uuid}`, {
      accountLabel: account.label,
      meetingUuid: obj.uuid,
      topic: obj.topic || 'Zoom-встреча',
      firstSeenAt: Date.now(),
    }, { expirationTtl: 3600 });
  } else if (body.event === 'recording.transcript_completed' && obj) {
    // Downloading can take up to ~30s (Zoom's own fix for a known file-lag
    // race — see downloadZoomFile), well past what Zoom waits for a webhook
    // response before treating it as failed and retrying delivery. Ack Zoom
    // immediately and let the retries run in the background via waitUntil,
    // which — unlike code left running after an awaited call returns —
    // Cloudflare guarantees to complete even after the response is sent.
    const work = handleZoomTranscriptCompleted(env, account, obj, body.payload?.download_token);
    if (ctx?.waitUntil) ctx.waitUntil(work);
    else await work; // no execution context (e.g. local test) — fall back to awaiting inline
  }

  return new Response('OK');
}

// ── Entry point ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/zoom/webhook/')) {
      try {
        return await handleZoomWebhook(request, env, url.pathname.slice('/zoom/webhook/'.length), ctx);
      } catch (e) {
        console.error('Zoom webhook error:', e);
        return new Response('Error: ' + e.message, { status: 500 });
      }
    }

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

    if (url.pathname === '/video/mcp') {
      return handleVideoMcp(request, env, url);
    }

    // Manual check that the Llama fallback (Cloudflare Workers AI) responds,
    // independent of Claude/CLAUDE_API — same model callClaudeStreaming falls
    // back to on Claude failure. No side effects (doesn't message Telegram or
    // touch stored data), so unlike /debug/morning it needs no token.
    if (url.pathname === '/debug/llama') {
      try {
        const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [{ role: 'user', content: 'Ответь одним словом: работаешь?' }],
        });
        return jsonResponse({ ok: true, response: result?.response ?? null });
      } catch (e) {
        console.error('Llama debug check failed:', e);
        return jsonResponse({ ok: false, error: e.message || String(e) }, 500);
      }
    }

    // Manual check of ZOOM_ACCOUNTS_JSON — reports parsed account labels
    // (never secrets) so a "/zoom/webhook/<label> -> Unknown account" report
    // can be diagnosed (missing/invalid secret vs. a label typo/mismatch).
    if (url.pathname === '/debug/zoom-accounts') {
      const { accounts, error } = parseZoomAccounts(env);
      return jsonResponse({
        error,
        count: accounts.length,
        accounts: accounts.map(a => ({
          label: a.label ?? null,
          hasAccountId: !!a.account_id,
          hasClientId: !!a.client_id,
          hasClientSecret: !!a.client_secret,
          hasWebhookSecretToken: !!a.webhook_secret_token,
          chatId: a.chat_id ?? null,
        })),
      });
    }

    // Manually run the every-5-minute Zoom transcript poll right now (instead of
    // waiting for the cron) and report what's still queued afterward. No side
    // effects beyond what the real cron already does, so no token needed.
    if (url.pathname === '/debug/zoom-poll') {
      try {
        await checkPendingZoomTranscripts(env);
        const list = await env.KV.list({ prefix: 'zoom:pending:' });
        const pending = [];
        for (const k of list.keys) {
          const p = await kget(env, k.name, null);
          if (p) pending.push(p);
        }
        return jsonResponse({ ok: true, pending });
      } catch (e) {
        console.error('Zoom poll debug check failed:', e);
        return jsonResponse({ ok: false, error: e.message || String(e) }, 500);
      }
    }

    // Manual trigger for debugging scheduled jobs (secured with bot token as secret)
    if (url.pathname === '/debug/morning') {
      if (url.searchParams.get('token') !== env.TG_TOKEN) return new Response('Forbidden', { status: 403 });
      try {
        await send(env, await mlMorningBriefText(env));
        await pushBroadcast(env, { title: 'Доброе утро', body: 'Загляни в задачи на сегодня.', tag: 'mylife-morning', url: '/mylife/' });
        return new Response('Sent');
      } catch (e) {
        console.error('Manual trigger failed:', e);
        return new Response('Error: ' + e.message, { status: 500 });
      }
    }

    // API endpoint for Claude Code to send entrepreneur summary to Telegram
    if (url.pathname === '/api/send-summary' && request.method === 'POST') {
      if (url.searchParams.get('token') !== env.TG_TOKEN) return new Response('Forbidden', { status: 403 });
      try {
        const body = await readJson(request);
        const text = body.text || body.message || '';
        if (!text) return jsonResponse({ error: 'text or message field required' }, 400);
        await send(env, text);
        return jsonResponse({ ok: true, message: 'Summary sent to Telegram' });
      } catch (e) {
        console.error('Send summary error:', e);
        return jsonResponse({ error: e.message }, 500);
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
