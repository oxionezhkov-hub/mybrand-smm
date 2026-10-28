// German A1 exam trainer — single-page app (no build step).
// Data: window.TOPICS (content.js) and window.EXAM (exam.js).
// Progress lives in localStorage and syncs to KV via /deutsch/api/progress.
// The "AI" button streams answers from /deutsch/api/ai.
(() => {
  'use strict';

  const LESSONS = window.TOPICS || [];
  const EXAM = window.EXAM || {};
  const $app = document.getElementById('app');
  const PRONOUNS = ['ich', 'du', 'er/sie/es', 'wir', 'ihr', 'sie/Sie'];
  const DAY = 86400000;

  // ── Small helpers ─────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const sample = (a, n) => shuffle(a).slice(0, n);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const todayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const norm = (s) => String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[.,!?;:"„“”»«'’()\-–—…]/g, ' ').replace(/\s+/g, ' ').trim();
  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m || !n) return m || n;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  // [[Deutsch]] → tappable span that speaks itself.
  const rich = (s) => String(s || '').replace(/\[\[(.+?)\]\]/g, (_, t) => `<span class="de" data-say="${esc(t.replace(/<[^>]+>/g, ''))}">${t}</span>`);
  const ARTS = /^(der|die|das) /;
  const genderOf = (de) => (ARTS.exec(de) || [])[1] || null;
  const PLURAL_ONLY = new Set(['die Eltern', 'die Geschwister', 'die Großeltern', 'die Möbel', 'die Ferien', 'die Haare', 'die Schmerzen', 'die Kopfschmerzen', 'die Bauchschmerzen', 'die Halsschmerzen', 'die Pommes', 'die Öffnungszeiten']);
  const isNoun = (w) => !!genderOf(w.de) && !PLURAL_ONLY.has(w.de);
  const gClass = (de) => { const g = genderOf(de); return PLURAL_ONLY.has(de) ? 'g-pl' : g ? `g-${g}` : ''; };
  const wordHtml = (de) => { const g = genderOf(de); if (!g) return esc(de); return `<span class="${gClass(de)}">${g}</span> ${esc(de.slice(g.length + 1))}`; };

  // ── Words index ───────────────────────────────────────────────────────────
  const WORDS = new Map(); // de → {de, en, pic, pl, lid}
  for (const l of LESSONS) for (const [de, en, pic, pl] of l.words) if (!WORDS.has(de)) WORDS.set(de, { de, en, pic, pl, lid: l.id });
  const lessonWords = (l) => l.words.map(([de]) => WORDS.get(de));
  const lessonById = (id) => LESSONS.find((l) => l.id === id);

  // ── State, persistence, sync ─────────────────────────────────────────────
  const LS_KEY = 'deutsch.state.v1';
  const fresh = () => ({ v: 1, updatedAt: 0, w: {}, t: {}, ex: {}, wr: {}, pr: {}, days: {}, stats: { right: 0, wrong: 0 }, mocks: [], settings: { examDate: '', rate: 0.95, voice: '', theme: 'auto', name: 'Oleg' } });
  let S = (() => {
    try { const s = JSON.parse(localStorage.getItem(LS_KEY)); if (s && s.v === 1) return Object.assign(fresh(), s, { settings: Object.assign(fresh().settings, s.settings) }); } catch {}
    return fresh();
  })();
  let syncTimer = null, syncState = 'idle', dirty = false, firstPull = true;
  function save(sync = true) {
    S.updatedAt = Date.now();
    dirty = true;
    try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch {}
    if (sync) { clearTimeout(syncTimer); syncTimer = setTimeout(push, 12000); }
  }
  function merge(a, b) {
    const out = fresh();
    const newer = (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b;
    for (const k of new Set([...Object.keys(a.w || {}), ...Object.keys(b.w || {})])) {
      const x = a.w?.[k], y = b.w?.[k];
      if (!x || !y) { out.w[k] = x || y; continue; }
      const ax = (x.c || 0) + (x.x || 0), by = (y.c || 0) + (y.x || 0);
      out.w[k] = ax > by ? x : by > ax ? y : ((x.d || 0) >= (y.d || 0) ? x : y);
    }
    for (const k of new Set([...Object.keys(a.t || {}), ...Object.keys(b.t || {})])) {
      const x = a.t?.[k] || {}, y = b.t?.[k] || {};
      out.t[k] = { read: !!(x.read || y.read), best: Math.max(x.best || 0, y.best || 0), runs: Math.max(x.runs || 0, y.runs || 0) };
    }
    for (const k of new Set([...Object.keys(a.ex || {}), ...Object.keys(b.ex || {})])) {
      const x = a.ex?.[k] || {}, y = b.ex?.[k] || {};
      out.ex[k] = { best: Math.max(x.best || 0, y.best || 0), at: Math.max(x.at || 0, y.at || 0) };
    }
    out.wr = Object.assign({}, newer === a ? b.wr : a.wr, newer.wr);
    for (const k of new Set([...Object.keys(a.pr || {}), ...Object.keys(b.pr || {})])) out.pr[k] = !!(a.pr?.[k] || b.pr?.[k]);
    for (const k of new Set([...Object.keys(a.days || {}), ...Object.keys(b.days || {})])) out.days[k] = Math.max(a.days?.[k] || 0, b.days?.[k] || 0);
    out.stats = { right: Math.max(a.stats?.right || 0, b.stats?.right || 0), wrong: Math.max(a.stats?.wrong || 0, b.stats?.wrong || 0) };
    const mocks = new Map(); for (const m of [...(a.mocks || []), ...(b.mocks || [])]) mocks.set(m.at, m);
    out.mocks = [...mocks.values()].sort((p, q) => p.at - q.at).slice(-30);
    out.settings = Object.assign(fresh().settings, newer.settings);
    out.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);
    return out;
  }
  async function pull() {
    try {
      syncState = 'syncing';
      const r = await fetch('/deutsch/api/progress', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const { state } = await r.json();
      if (state && state.v === 1) {
        const before = JSON.stringify(S);
        S = merge(S, state);
        try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch {}
        if (firstPull && JSON.stringify(S) !== before) { applyTheme(); route(true); }
        if (JSON.stringify(state) !== JSON.stringify(S)) await push(false, true);
      } else if (S.updatedAt) await push(false, true);
      firstPull = false;
      syncState = 'ok';
    } catch { syncState = 'offline'; }
  }
  async function push(keepalive = false, force = false) {
    clearTimeout(syncTimer);
    if (!dirty && !force) return;
    dirty = false;
    try {
      const updatedAt = Date.now();
      S.updatedAt = updatedAt;
      try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch {}
      const r = await fetch('/deutsch/api/progress', { method: 'POST', keepalive, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: S, updatedAt }) });
      if (r.status === 409 && !keepalive) return pull();
      syncState = r.ok ? 'ok' : 'offline';
      if (!r.ok) dirty = true;
    } catch { syncState = 'offline'; dirty = true; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') push(true); else pull(); });

  // ── Progress logic ────────────────────────────────────────────────────────
  const IV = [0, 10 * 60e3, 60 * 60e3, 8 * 3600e3, DAY, 3 * DAY, 7 * DAY];
  function addXp(n) { const k = todayKey(); S.days[k] = (S.days[k] || 0) + n; }
  function grade(de, ok) {
    if (!de) return;
    const w = S.w[de] || { b: 0, d: 0, c: 0, x: 0 };
    if (ok) { w.b = Math.min(w.b + 1, 6); w.c++; } else { w.b = 1; w.x++; }
    w.d = Date.now() + (ok ? IV[w.b] : 60e3);
    S.w[de] = w;
  }
  function record(ok, de) {
    if (ok) S.stats.right++; else S.stats.wrong++;
    addXp(ok ? 10 : 2);
    grade(de, ok);
    save();
    paintChrome();
  }
  const mastery = (de) => Math.min((S.w[de]?.b || 0), 3);
  const learnedCount = () => [...WORDS.keys()].filter((k) => (S.w[k]?.b || 0) >= 3).length;
  function lessonPct(l) {
    const t = S.t[l.id] || {};
    const ws = l.words.map(([de]) => mastery(de) / 3);
    const wAvg = ws.reduce((a, b) => a + b, 0) / (ws.length || 1);
    return Math.round((t.read ? 25 : 0) + wAvg * 45 + (t.best || 0) * 0.3);
  }
  function streak() {
    let n = 0, t = Date.now();
    if (!S.days[todayKey(t)]) t -= DAY;
    while (S.days[todayKey(t)]) { n++; t -= DAY; }
    return n;
  }
  const dueWords = () => Object.entries(S.w).filter(([k, w]) => WORDS.has(k) && w.d <= Date.now()).map(([k]) => WORDS.get(k));
  const daysLeft = () => { if (!S.settings.examDate) return null; const d = new Date(S.settings.examDate + 'T09:00:00'); return Math.ceil((d - Date.now()) / DAY); };

  // ── Speech (text to speech + recognition) ─────────────────────────────────
  let voices = [];
  function loadVoices() {
    const all = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    const de = all.filter((v) => /^de(-|_|$)/i.test(v.lang));
    const score = (v) => (/(natural|online|neural|premium|enhanced)/i.test(v.name) ? 4 : 0) + (/google/i.test(v.name) ? 3 : 0) + (/(anna|petra|markus|helena|katja|conrad|yannick|amala|seraphina|florian)/i.test(v.name) ? 2 : 0) + (/de-DE/i.test(v.lang) ? 1 : 0);
    voices = de.sort((a, b) => score(b) - score(a));
  }
  if (window.speechSynthesis) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
  const canSpeak = () => !!window.speechSynthesis;
  function voiceFor(who) {
    const chosen = voices.find((v) => v.name === S.settings.voice) || voices[0];
    if (who !== 'B') return chosen;
    return voices.find((v) => v !== chosen && v.lang.slice(0, 2) === 'de') || chosen;
  }
  let lastSay = { text: '', at: 0 };
  function say(text, opts = {}) {
    return new Promise((resolve) => {
      if (!canSpeak() || !text) return resolve();
      if (!opts.queue) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).replace(/\s*\/\s*/g, ', ').replace(/[…]/g, ''));
      u.lang = 'de-DE';
      const v = voiceFor(opts.who);
      if (v) u.voice = v;
      const slowAgain = !opts.rate && lastSay.text === text && Date.now() - lastSay.at < 2500;
      u.rate = opts.rate || (slowAgain ? 0.6 : S.settings.rate || 0.95);
      if (opts.who === 'B' && voiceFor('B') === voiceFor('A')) u.pitch = 0.8;
      lastSay = { text, at: Date.now() };
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
      if (speechSynthesis.paused) speechSynthesis.resume();
    });
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function listenSpeech() {
    return new Promise((resolve, reject) => {
      if (!SR) return reject(new Error('Speech recognition is not supported in this browser (try Chrome).'));
      const r = new SR();
      r.lang = 'de-DE'; r.maxAlternatives = 4; r.interimResults = false;
      let done = false;
      r.onresult = (e) => { done = true; resolve([...e.results[0]].map((a) => a.transcript)); };
      r.onerror = (e) => { if (!done) reject(new Error(e.error === 'not-allowed' ? 'Microphone access was blocked.' : 'Could not hear you — try again.')); };
      r.onend = () => { if (!done) reject(new Error('Could not hear you — try again.')); };
      r.start();
    });
  }
  const similarity = (a, b) => { a = norm(a); b = norm(b); const m = Math.max(a.length, b.length) || 1; return 1 - lev(a, b) / m; };
  function sayBtn(text, label) { return h('button', { class: 'say', title: 'Listen (tap twice = slow)', 'aria-label': 'Listen', onclick: (e) => { e.stopPropagation(); say(text); } }, label || '🔊'); }
  function micBtn(target, onResult) {
    if (!SR) return null;
    return h('button', { class: 'say', title: 'Say it — check your pronunciation', 'aria-label': 'Speak', onclick: async (e) => {
      e.stopPropagation();
      const b = e.currentTarget; b.textContent = '⏺';
      try {
        const alts = await listenSpeech();
        const best = alts.map((a) => [a, similarity(a, target)]).sort((x, y) => y[1] - x[1])[0];
        const ok = best[1] >= 0.75;
        toast(ok ? `✅ Great! I heard: “${best[0]}”` : `🔁 I heard: “${best[0]}” — try again`);
        if (ok) addXp(5), save();
        onResult && onResult(ok);
      } catch (err) { toast(err.message); }
      b.textContent = '🎤';
    } }, '🎤');
  }

  // ── Chrome: nav, chips, toasts, theme ─────────────────────────────────────
  function toast(msg, ms = 2600) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = h('div', { class: 'toast' }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), ms);
  }
  function applyTheme() {
    const t = S.settings.theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  }
  function paintChrome() {
    document.getElementById('streakChip').textContent = `🔥 ${streak()}`;
    const dl = daysLeft();
    const cc = document.getElementById('countChip');
    cc.textContent = dl == null ? '📅 Set exam date' : dl > 0 ? `📅 ${dl} day${dl === 1 ? '' : 's'} to exam` : dl === 0 ? '📅 Exam today — viel Glück!' : '📅 Exam done';
    cc.style.cursor = 'pointer';
    cc.onclick = openSettings;
  }

  // ── AI context: what the learner is looking at ───────────────────────────
  const CTX = { page: '', detail: '' };
  const setCtx = (page, detail = '') => { CTX.page = page; CTX.detail = detail; };
  const ctxString = () => [`Page: ${CTX.page}`, CTX.detail].filter(Boolean).join('\n').slice(0, 2800);

  // ── Router ────────────────────────────────────────────────────────────────
  let cleanup = [];
  let lastHash = '';
  function route(keepScroll) {
    cleanup.forEach((f) => { try { f(); } catch {} });
    cleanup = [];
    if (window.speechSynthesis && !keepScroll) speechSynthesis.cancel();
    const hash = location.hash.replace(/^#\/?/, '');
    const [a, b, c] = hash.split('/');
    let view;
    if (!a) view = viewHome();
    else if (a === 'lessons') view = viewLessons();
    else if (a === 'l') view = viewLesson(b, c || 'learn');
    else if (a === 'practice') view = b ? viewPracticeRun(b, c) : viewPractice();
    else if (a === 'exam') view = viewExam(b, c);
    else if (a === 'words') view = viewWords();
    else view = viewHome();
    $app.replaceChildren(view);
    for (const n of document.querySelectorAll('[data-r]')) n.classList.toggle('on', n.dataset.r === (a === 'l' ? 'lessons' : a || 'home'));
    if (!keepScroll && hash !== lastHash) window.scrollTo(0, 0);
    lastHash = hash;
    paintChrome();
  }
  window.addEventListener('hashchange', () => route());
  const go = (h2) => { location.hash = h2; };

  // Tapping German text speaks it (outside pick mode).
  document.addEventListener('click', (e) => {
    const d = e.target.closest('[data-say]');
    if (d && !document.body.classList.contains('picking')) say(d.dataset.say);
  });

  // ── Views: Home ───────────────────────────────────────────────────────────
  function nextLesson() { return LESSONS.find((l) => lessonPct(l) < 70) || LESSONS[LESSONS.length - 1]; }
  function viewHome() {
    setCtx('Home dashboard');
    const xp = S.days[todayKey()] || 0, goal = 150;
    const due = dueWords().length;
    const nl = nextLesson();
    const total = S.stats.right + S.stats.wrong;
    const acc = total ? Math.round((S.stats.right / total) * 100) : 0;
    const dl = daysLeft();
    const greet = new Date().getHours() < 11 ? 'Guten Morgen' : new Date().getHours() < 18 ? 'Guten Tag' : 'Guten Abend';
    const examIds = [...(EXAM.reading || []), ...(EXAM.listening || [])].map((x) => x.id);
    const examDone = examIds.filter((id) => S.ex[id]).length;
    const prLearned = (EXAM.presentations || []).filter((p) => S.pr[p.id]).length;

    return h('div', null,
      h('div', { class: 'hero' },
        h('div', { class: 'card main' },
          h('div', { class: 'small muted', style: 'font-weight:600;margin-bottom:6px' }, dl == null ? 'Your A1 exam trainer' : dl > 0 ? `${dl} day${dl === 1 ? '' : 's'} until your exam` : 'Exam day!'),
          h('h1', { style: 'margin-bottom:8px' }, `${greet}, ${S.settings.name || 'Oleg'}! 👋`),
          h('p', { class: 'muted', style: 'margin-bottom:16px' }, due ? `${due} word${due === 1 ? ' is' : 's are'} due for review. Next lesson: Lektion ${nl.n} — ${nl.de.replace(/[.…]+$/, '…')}` : `Continue with Lektion ${nl.n} — ${nl.de.replace(/[.…]+$/, '…')}`),
          h('div', { class: 'row' },
            h('a', { class: 'btn lg', href: due ? '#/practice/review' : `#/l/${nl.id}` }, due ? `Review ${due} words` : `Continue Lektion ${nl.n} →`),
            h('a', { class: 'btn ghost lg', href: '#/exam' }, 'Exam training'))),
        h('div', { class: 'card' },
          h('div', { class: 'row', style: 'margin-bottom:14px' },
            h('div', { class: 'ring', style: `--p:${Math.min(100, Math.round((xp / goal) * 100))}` }, h('span', null, `${Math.min(100, Math.round((xp / goal) * 100))}%`)),
            h('div', null, h('b', null, 'Today'), h('div', { class: 'small muted' }, `${xp} / ${goal} XP · daily goal`))),
          h('div', { class: 'grid g2 keep' },
            h('div', { class: 'stat' }, h('b', null, `${learnedCount()}`), h('span', null, `of ${WORDS.size} words learned`)),
            h('div', { class: 'stat' }, h('b', null, `${streak()}🔥`), h('span', null, 'day streak')),
            h('div', { class: 'stat' }, h('b', null, `${acc}%`), h('span', null, 'answers correct')),
            h('div', { class: 'stat' }, h('b', null, `${examDone}/${examIds.length}`), h('span', null, 'exam tasks done'))))),
      h('div', { class: 'sec' }, h('h2', null, 'Your course: Schritte international Neu, Lektion 1–10'), h('a', { class: 'small', href: '#/lessons' }, 'All lessons')),
      h('div', { class: 'grid g2' }, LESSONS.map(lessonCard)),
      h('div', { class: 'sec' }, h('h2', null, 'Exam preparation'), h('a', { class: 'small', href: '#/exam' }, 'Open')),
      h('div', { class: 'grid g4' },
        examTile('🧪', 'Mock test', 'Listening + reading + grammar', '#/exam/mock'),
        examTile('🎤', 'My presentations', `${prLearned}/${(EXAM.presentations || []).length} learned`, '#/exam/talk'),
        examTile('✍️', 'Writing', `${(EXAM.writing || []).filter((w) => (S.wr[w.id] || '').length > 40).length}/${(EXAM.writing || []).length} written`, '#/exam/write'),
        examTile('💬', 'Dialogue', 'Phrases + role-plays', '#/exam/dialog')),
      h('p', { class: 'small muted', style: 'margin-top:22px;text-align:center' }, 'Tip: tap ', h('b', null, '✦ AI'), ' then tap any word, sentence or picture — the tutor explains it. Tap blue German words to hear them (tap twice = slower).'));
  }
  function examTile(em, t, s, href) {
    return h('a', { class: 'card link tight', href }, h('div', { style: 'font-size:26px;margin-bottom:6px' }, em), h('b', null, t), h('div', { class: 'small muted' }, s));
  }
  function lessonCard(l) {
    const p = lessonPct(l);
    return h('a', { class: 'card link tight', href: `#/l/${l.id}`, dataset: { ai: `Lektion ${l.n}: ${l.de} (${l.title}) — ${l.summary}` } },
      h('div', { class: 'lesson' },
        h('div', { class: 'em' }, l.emoji),
        h('div', { class: 't' },
          h('div', { class: 'lnum' }, `Lektion ${l.n}`),
          h('b', null, l.de), h('small', null, l.title),
          h('div', { class: `bar${p >= 100 ? ' good' : ''}` }, h('i', { style: `width:${p}%` }))),
        h('div', { class: 'small muted', style: 'font-weight:700' }, `${p}%`)));
  }

  function viewLessons() {
    setCtx('List of lessons (Lektion 1–10)');
    return h('div', null,
      h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, 'Lessons'), h('p', { class: 'muted', style: 'margin:6px 0 0' }, 'Exactly the 10 lessons of your course book. Learn the theory, then the words, then take the quiz.'))),
      h('div', { class: 'grid g2' }, LESSONS.map(lessonCard)));
  }

  // ── Views: Lesson ─────────────────────────────────────────────────────────
  function viewLesson(id, tab) {
    const l = lessonById(id);
    if (!l) return viewLessons();
    const tabs = [['learn', '📖 Learn'], ['words', '🔤 Words'], ['cards', '🃏 Cards'], ['quiz', '✅ Quiz']];
    if (l.verbs?.length) tabs.splice(3, 0, ['verbs', '⚙️ Verbs']);
    const head = h('div', null,
      h('div', { class: 'crumb' }, h('a', { href: '#/lessons' }, 'Lessons'), h('span', null, '›'), h('span', null, `Lektion ${l.n}`)),
      h('div', { class: 'page-head' },
        h('div', { style: 'font-size:40px;line-height:1' }, l.emoji),
        h('div', { class: 'grow' }, h('h1', null, l.de), h('div', { class: 'muted' }, `${l.title} · ${l.summary}`)),
        h('div', { class: 'ring hide-m', style: `--p:${lessonPct(l)}` }, h('span', null, `${lessonPct(l)}%`))),
      h('div', { class: 'tabs' }, tabs.map(([k, t]) => h('a', { href: `#/l/${l.id}/${k}`, class: tab === k ? 'on' : '' }, t))));
    let body;
    if (tab === 'words') body = lessonWordsView(l);
    else if (tab === 'cards') body = flashcards(lessonWords(l), `Lektion ${l.n} flashcards`);
    else if (tab === 'verbs') body = verbsView(l);
    else if (tab === 'quiz') body = session({ title: `Lektion ${l.n} quiz`, qs: lessonQuiz(l), onDone: (pct) => { const t = S.t[l.id] || {}; t.best = Math.max(t.best || 0, pct); t.runs = (t.runs || 0) + 1; S.t[l.id] = t; save(); }, again: () => route(true), ctxPage: `Lektion ${l.n} (${l.de}) — quiz` });
    else body = theoryView(l);
    if (tab !== 'quiz') setCtx(`Lektion ${l.n} — ${l.de} (${l.title}) — ${tab}`);
    return h('div', null, head, body);
  }
  function theoryView(l) {
    const t = S.t[l.id] || {};
    return h('div', { class: 'stack theory' },
      l.theory.map((s) => h('div', { class: 'card' },
        h('h3', null, s.h),
        s.p ? h('p', { html: rich(s.p) }) : null,
        s.table ? h('div', { class: 'tblwrap' }, h('table', { class: 'tbl' },
          s.table.head.some(Boolean) ? h('thead', null, h('tr', null, s.table.head.map((c) => h('th', { html: rich(c) })))) : null,
          h('tbody', null, s.table.rows.map((r) => h('tr', null, r.map((c) => h('td', { html: rich(c) }))))))) : null,
        s.ex ? h('ul', { class: 'ex' }, s.ex.map(([de, en]) => h('li', null, sayBtn(de), h('div', null, h('div', { class: 'exde', html: esc(de) }), h('div', { class: 'exen' }, en))))) : null,
        s.tip ? h('div', { class: 'tip', html: rich(s.tip) }) : null)),
      h('div', { class: 'card row', style: 'justify-content:space-between' },
        h('div', null, h('b', null, t.read ? '✅ Theory done' : 'Finished reading?'), h('div', { class: 'small muted' }, 'Next: learn the words with flashcards, then take the quiz.')),
        h('div', { class: 'row' },
          !t.read ? h('button', { class: 'btn', onclick: () => { S.t[l.id] = Object.assign(S.t[l.id] || {}, { read: true }); addXp(20); save(); toast('+20 XP — theory done!'); go(`#/l/${l.id}/cards`); } }, 'Mark as read ✓') : null,
          h('a', { class: 'btn primary', href: `#/l/${l.id}/cards` }, 'Flashcards →'))));
  }
  function wordRow(w) {
    const m = mastery(w.de);
    return h('div', { class: 'word', dataset: { ai: `Word from Lektion ${lessonById(w.lid)?.n}: ${w.de} = ${w.en}${w.pl ? `, plural: ${w.pl}` : ''}` } },
      h('div', { class: 'pic', dataset: { ai: `Picture ${w.pic} illustrating the German word "${w.de}" (${w.en})` } }, w.pic),
      h('div', { class: 'w' }, h('b', { html: wordHtml(w.de) }), h('small', null, w.en + (w.pl ? ` · pl. ${w.pl}` : ''))),
      h('span', { class: 'dots', title: 'Mastery' }, [0, 1, 2].map((i) => h('i', { class: i < m ? 'on' : '' }))),
      sayBtn(w.de));
  }
  function lessonWordsView(l) {
    return h('div', null,
      h('div', { class: 'row', style: 'margin-bottom:12px' },
        h('span', { class: 'small muted' }, 'Colours: ', h('b', { class: 'g-der' }, 'der'), ' · ', h('b', { class: 'g-das' }, 'das'), ' · ', h('b', { class: 'g-die' }, 'die'), ' · ', h('b', { class: 'g-pl' }, 'plural')),
        h('span', { class: 'sp' }),
        h('button', { class: 'btn sm', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; for (const w of lessonWords(l)) { await say(w.de, { queue: true }); await new Promise((r) => setTimeout(r, 250)); if (!document.body.contains(b)) break; } b.disabled = false; } }, '▶ Listen to all')),
      h('div', { class: 'words' }, lessonWords(l).map(wordRow)));
  }
  function verbsView(l) {
    return h('div', { class: 'stack' },
      l.verbs.map((v) => h('div', { class: 'card', dataset: { ai: `Verb conjugation table: ${v.inf} (${v.en}): ${v.forms.map((f, i) => `${PRONOUNS[i]} ${f}`).join(', ')}` } },
        h('div', { class: 'row', style: 'margin-bottom:8px' }, h('h3', null, v.inf), h('span', { class: 'muted' }, v.en)),
        h('table', { class: 'tbl' }, h('tbody', null, v.forms.map((f, i) => h('tr', null, h('td', { class: 'muted', style: 'width:110px' }, PRONOUNS[i]), h('td', null, h('span', { class: 'de', dataset: { say: `${PRONOUNS[i].split('/')[0]} ${f}` } }, f)))))))),
      h('a', { class: 'btn primary block', href: '#/practice/verbs' }, 'Drill all verb forms →'));
  }

  // ── Question builders ─────────────────────────────────────────────────────
  function distractors(w, field, pool, n = 3) {
    const seen = new Set([w[field]]);
    const sameKind = pool.filter((x) => x.de !== w.de && isNoun(x) === isNoun(w));
    const out = [];
    for (const x of shuffle(sameKind.length >= n ? sameKind : pool.filter((x2) => x2.de !== w.de))) {
      if (seen.has(x[field])) continue;
      seen.add(x[field]); out.push(x[field]);
      if (out.length >= n) break;
    }
    return out;
  }
  function mcQ(o) { const opts = shuffle([o.correct, ...o.wrong]); return Object.assign({ type: 'mc', options: opts, answer: opts.indexOf(o.correct) }, o); }
  function wordQ(w, kind, pool) {
    switch (kind) {
      case 'de_en': return mcQ({ kind: 'What does it mean?', prompt: w.de, promptHtml: wordHtml(w.de), say: w.de, correct: w.en, wrong: distractors(w, 'en', pool), wid: w.de, explain: `${w.de} = ${w.en}` });
      case 'en_de': return mcQ({ kind: 'Choose the German word', prompt: w.en, pic: w.pic, correct: w.de, wrong: distractors(w, 'de', pool), wid: w.de, explain: `${w.en} = ${w.de}` });
      case 'listen': return mcQ({ kind: 'Listen and choose', prompt: '', listen: true, say: w.de, correct: w.de, wrong: distractors(w, 'de', pool), wid: w.de, explain: `You heard: ${w.de} (${w.en})` });
      case 'type': return { type: 'type', kind: 'Write it in German', prompt: w.en, pic: w.pic, accept: [w.de], show: w.de, say: w.de, wid: w.de, noun: isNoun(w) };
      case 'gender': {
        const g = genderOf(w.de), bare = w.de.slice(g.length + 1);
        return { type: 'mc', gender: true, kind: 'der, das or die?', prompt: bare, pic: w.pic, sub: w.en, options: ['der', 'das', 'die'], answer: ['der', 'das', 'die'].indexOf(g), say: w.de, wid: w.de, explain: `${w.de}${w.pl ? ` — plural: ${w.pl}` : ''}` };
      }
    }
  }
  function quizQ(q, l) { const keep = q.o.length <= 3 && q.o.every((o) => /^(der|das|die|richtig|falsch)$/i.test(o)); const opts = keep ? q.o : shuffle(q.o); return { type: 'mc', kind: l ? `Lektion ${l.n}` : 'Grammar', prompt: q.q, options: opts, answer: opts.indexOf(q.o[q.a]), explain: q.e }; }
  function orderQ([de, en]) {
    const tokens = de.split(' ');
    let sh = shuffle(tokens);
    for (let i = 0; i < 5 && sh.join(' ') === de && tokens.length > 1; i++) sh = shuffle(tokens);
    return { type: 'order', kind: 'Build the sentence', prompt: en, tokens: sh, answerText: de, say: de };
  }
  function verbQ(v) {
    const i = Math.floor(Math.random() * 6);
    return { type: 'type', kind: `Verb: ${v.inf} (${v.en})`, prompt: `${PRONOUNS[i]} ___`, sub: `Write the form of „${v.inf}“`, accept: [v.forms[i]], show: `${PRONOUNS[i]} ${v.forms[i]}`, say: `${PRONOUNS[i].split('/')[0]} ${v.forms[i]}` };
  }
  function lessonQuiz(l) {
    const ws = lessonWords(l);
    const nouns = ws.filter(isNoun);
    const qs = l.quiz.map((q) => quizQ(q, l));
    const pickW = sample(ws, 10);
    qs.push(...pickW.slice(0, 3).map((w) => wordQ(w, 'de_en', ws)));
    qs.push(...pickW.slice(3, 5).map((w) => wordQ(w, 'en_de', ws)));
    if (canSpeak() && voices.length) qs.push(...pickW.slice(5, 7).map((w) => wordQ(w, 'listen', ws)));
    qs.push(...pickW.slice(7, 9).map((w) => wordQ(w, 'type', ws)));
    qs.push(...sample(nouns, 2).map((w) => wordQ(w, 'gender', ws)));
    qs.push(...sample(l.order, 3).map(orderQ));
    if (l.verbs?.length) qs.push(...sample(l.verbs, 2).map(verbQ));
    return shuffle(qs);
  }

  // ── Session engine (quizzes and drills) ───────────────────────────────────
  function session({ title, qs, onDone, again, ctxPage, back }) {
    const root = h('div', { class: 'quiz' });
    let i = 0, right = 0;
    const wrong = [];
    let keyHandler = null;
    const setKeys = (fn) => { keyHandler = fn; };
    const onKey = (e) => { if (e.target.tagName === 'TEXTAREA' || document.querySelector('.modal-bg') || (e.target.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' '))) return; if (keyHandler) keyHandler(e); };
    document.addEventListener('keydown', onKey);
    cleanup.push(() => document.removeEventListener('keydown', onKey));

    function finish() {
      const pct = qs.length ? Math.round((right / qs.length) * 100) : 0;
      onDone && onDone(pct);
      setCtx(`${ctxPage || title} — results`, `Score ${right}/${qs.length}. Mistakes: ${wrong.map((q) => `${q.prompt || q.say} → ${q.show || q.answerText || q.options?.[q.answer]}`).join('; ')}`);
      setKeys((e) => { if (e.key === 'Enter') { e.preventDefault(); again ? again() : null; } });
      root.replaceChildren(h('div', { class: 'qcard', style: 'text-align:center' },
        h('div', { class: 'confetti' }, pct >= 90 ? '🏆' : pct >= 70 ? '🎉' : pct >= 50 ? '💪' : '📚'),
        h('div', { class: 'score' }, `${pct}%`),
        h('p', { class: 'muted' }, `${right} of ${qs.length} correct · ${pct >= 80 ? 'Sehr gut!' : pct >= 60 ? 'Gut! Repeat the mistakes once more.' : 'Keep going — repeat the mistakes, then try again.'}`),
        wrong.length ? h('div', { style: 'text-align:left;margin:16px 0' }, h('b', null, 'Your mistakes'), h('ul', { class: 'ex' }, wrong.map((q) => h('li', null, q.say ? sayBtn(q.say) : null, h('div', null, h('div', { class: 'exde' }, q.show || q.answerText || q.options?.[q.answer]), h('div', { class: 'exen' }, q.prompt || q.kind)))))) : null,
        h('div', { class: 'row', style: 'justify-content:center;margin-top:10px' },
          wrong.length ? h('button', { class: 'btn', onclick: () => { root.replaceWith(session({ title: `${title} — mistakes`, qs: shuffle(wrong.map((q) => Object.assign({}, q, q.type === 'mc' && !q.gender ? reshuffle(q) : {}))), onDone: null, ctxPage })); } }, `Repeat ${wrong.length} mistakes`) : null,
          again ? h('button', { class: 'btn primary', onclick: again }, 'Again') : null,
          back ? h('a', { class: 'btn', href: back }, 'Back') : null)));
    }
    function reshuffle(q) { const opts = shuffle(q.options); return { options: opts, answer: opts.indexOf(q.options[q.answer]) }; }

    function show() {
      if (i >= qs.length) return finish();
      const q = qs[i];
      const card = h('div', { class: 'qcard' });
      let answered = false;
      const fbBox = h('div');
      const actions = h('div', { class: 'qactions' });
      const ctxBase = `${q.kind}: ${q.prompt || '(listening)'}${q.sub ? ` — ${q.sub}` : ''}${q.options ? `\nOptions: ${q.options.join(' | ')}` : ''}`;
      setCtx(ctxPage || title, `Current exercise — ${ctxBase}`);

      function done(ok, given, correctText) {
        if (answered) return;
        answered = true;
        if (ok) right++; else wrong.push(q);
        record(ok, q.wid);
        setCtx(ctxPage || title, `Exercise — ${ctxBase}\nLearner answered: ${given || '—'}\nCorrect answer: ${correctText}\nResult: ${ok ? 'correct' : 'wrong'}`);
        if (q.say) say(q.say);
        fbBox.replaceChildren(h('div', { class: `fb ${ok ? 'ok' : 'no'}` },
          h('b', { class: 't' }, ok ? pick(['Richtig! ✓', 'Super! ✓', 'Genau! ✓', 'Sehr gut! ✓']) : 'Not quite'),
          !ok ? h('div', null, 'Correct: ', h('b', null, correctText)) : null,
          q.explain ? h('div', { class: 'small', style: 'margin-top:4px' }, q.explain) : null,
          q.noteAfter ? h('div', { class: 'small', style: 'margin-top:4px' }, q.noteAfter) : null));
        actions.replaceChildren(
          !ok ? h('button', { class: 'btn', onclick: () => askAI('Why is my answer wrong? Explain the rule simply and give 2 more examples.') }, '✦ Why?') : null,
          h('button', { class: 'btn primary', onclick: next }, 'Continue ⏎'));
        setKeys((e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } });
        actions.querySelector('.btn.primary').focus({ preventScroll: true });
      }
      const next = () => { i++; show(); };

      card.append(h('div', { class: 'qkind' }, q.kind));
      if (q.listen) card.append(h('button', { class: 'big-say', onclick: () => say(q.say), title: 'Play again (tap twice = slow)' }, '🔊'), h('p', { class: 'muted', style: 'text-align:center' }, 'Tap to listen again'));
      if (q.clock) card.append(clockSvg(q.clock[0], q.clock[1]));
      if (q.pic && q.type !== 'mc') card.append(h('div', { class: 'qpic', dataset: { ai: `Picture ${q.pic}` } }, q.pic));
      if (q.pic && q.type === 'mc' && !q.listen) card.append(h('div', { class: 'qpic', style: 'font-size:52px', dataset: { ai: `Picture ${q.pic}` } }, q.pic));
      if (q.prompt) card.append(h('div', { class: 'qprompt', html: q.promptHtml || esc(q.prompt) }, q.wid && q.say && !q.listen && q.type === 'mc' && !q.gender ? h('span', { style: 'margin-left:8px;vertical-align:middle;display:inline-block' }, sayBtn(q.say)) : null));
      if (q.sub) card.append(h('div', { class: 'qsub' }, q.sub));

      if (q.type === 'mc') {
        const opts = h('div', { class: `opts${q.gender ? ' g3 gender' : q.options.every((o) => o.length < 18) && q.options.length === 4 ? ' g2' : ''}`, style: q.gender ? 'grid-template-columns:repeat(3,1fr)' : '' },
          q.options.map((o, k) => h('button', { class: 'opt', onclick: () => choose(k) }, q.gender ? null : h('span', { class: 'k' }, k + 1), o)));
        card.append(opts);
        const choose = (k) => {
          if (answered) return;
          const btns = [...opts.children];
          btns.forEach((b) => (b.disabled = true));
          btns[q.answer].classList.add('ok');
          if (k !== q.answer) btns[k].classList.add('no');
          done(k === q.answer, q.options[k], q.options[q.answer]);
        };
        setKeys((e) => { const n = Number(e.key); if (n >= 1 && n <= q.options.length) choose(n - 1); });
      } else if (q.type === 'type') {
        const inp = h('input', { class: 'input', placeholder: 'Type in German… (ä = ae, ß = ss is fine)', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
        const check = () => {
          const v = inp.value.trim();
          if (!v) return inp.focus();
          const nv = norm(v);
          const acc = q.accept.map(norm);
          let ok = acc.includes(nv);
          let note = '';
          if (!ok && q.noun) { const bare = acc.map((a) => a.replace(/^(der|die|das) /, '')); if (bare.includes(nv)) { ok = true; note = `Remember the article: ${q.show}`; } }
          if (!ok && acc.some((a) => a.length > 4 && lev(a, nv) === 1)) { ok = true; note = `Almost perfect — watch the spelling: ${q.show}`; }
          inp.disabled = true;
          q.noteAfter = note;
          done(ok, v, q.show);
        };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!answered) check(); else next(); } });
        card.append(inp);
        actions.append(h('button', { class: 'btn', onclick: () => { if (!answered) { inp.value = ''; done(false, '(skipped)', q.show); } } }, "I don't know"), h('button', { class: 'btn primary', onclick: check }, 'Check ⏎'));
        setKeys(null);
        setTimeout(() => inp.focus({ preventScroll: true }), 30);
      } else if (q.type === 'order') {
        const ans = h('div', { class: 'tokens' }), pool = h('div', { class: 'tokens pool' });
        const mk = (t) => { const b = h('button', { class: 'tok', onclick: () => { if (answered) return; (b.parentNode === pool ? ans : pool).append(b); } }, t); return b; };
        q.tokens.forEach((t) => pool.append(mk(t)));
        card.append(ans, pool);
        const check = () => {
          const v = [...ans.children].map((b) => b.textContent).join(' ');
          if (!v) return;
          done(norm(v) === norm(q.answerText) && v.split(' ')[0] === q.answerText.split(' ')[0], v, q.answerText);
        };
        actions.append(h('button', { class: 'btn', onclick: () => [...ans.children].forEach((b) => pool.append(b)) }, 'Reset'), h('button', { class: 'btn primary', onclick: check }, 'Check ⏎'));
        setKeys((e) => { if (e.key === 'Enter') { e.preventDefault(); check(); } });
      }
      card.append(fbBox, actions);
      root.replaceChildren(
        h('div', { class: 'qtop' },
          back ? h('a', { class: 'btn ghost sm', href: back }, '✕') : null,
          h('div', { class: 'bar' }, h('i', { style: `width:${(i / qs.length) * 100}%` })),
          h('span', { class: 'small muted', style: 'font-weight:700' }, `${i + 1}/${qs.length}`)),
        card);
      if (q.listen) setTimeout(() => say(q.say), 250);
    }
    if (!qs.length) root.append(h('div', { class: 'card', style: 'text-align:center' }, h('p', null, 'Nothing to practise here yet.'), back ? h('a', { class: 'btn', href: back }, 'Back') : null));
    else show();
    return root;
  }

  // ── Flashcards (spaced repetition) ────────────────────────────────────────
  function flashcards(words, label, opts = {}) {
    const root = h('div');
    let deck = opts.keepOrder ? words.slice() : shuffle(words).sort((a, b) => (S.w[a.de]?.b || 0) - (S.w[b.de]?.b || 0));
    let reverse = false;
    let idx = 0, seen = 0;
    const onKey = (e) => {
      if (document.querySelector('.modal-bg') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || (e.target.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' '))) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
      else if (e.key === '1') rate(0); else if (e.key === '2') rate(1); else if (e.key === '3') rate(2);
    };
    document.addEventListener('keydown', onKey);
    cleanup.push(() => document.removeEventListener('keydown', onKey));
    let cardEl, rateEl;
    function flip() { if (!cardEl) return; cardEl.classList.toggle('flip'); if (cardEl.classList.contains('flip')) { rateEl.classList.remove('hidden'); if (reverse) say(deck[idx].de); } }
    function rate(r) {
      if (!cardEl || !cardEl.classList.contains('flip')) return;
      const w = deck[idx];
      const e = S.w[w.de] || { b: 0, d: 0, c: 0, x: 0 };
      if (r === 0) { e.b = 1; e.x++; e.d = Date.now() + 60e3; deck.push(w); }
      else { e.b = Math.min(e.b + r, 6); e.c++; e.d = Date.now() + IV[e.b]; }
      S.w[w.de] = e;
      addXp(r === 0 ? 1 : 4);
      save(); paintChrome();
      idx++; seen++;
      show();
    }
    function show() {
      if (idx >= deck.length) {
        root.replaceChildren(h('div', { class: 'qcard', style: 'text-align:center;max-width:520px;margin:0 auto' },
          h('div', { class: 'confetti' }, '🎉'), h('h2', null, 'Deck finished!'), h('p', { class: 'muted' }, `${seen} cards reviewed. Now test yourself with the quiz.`),
          h('div', { class: 'row', style: 'justify-content:center' }, h('button', { class: 'btn', onclick: () => { idx = 0; seen = 0; deck = shuffle(words); show(); } }, 'Again'), opts.next ? h('a', { class: 'btn primary', href: opts.next }, opts.nextLabel || 'Continue →') : null)));
        return;
      }
      const w = deck[idx];
      setCtx(label, `Flashcard: ${w.de} = ${w.en}${w.pl ? ` (plural ${w.pl})` : ''}`);
      const front = reverse
        ? h('div', { class: 'fc-face' }, h('div', { class: 'pic' }, w.pic), h('div', { class: 'en-big' }, w.en), h('div', { class: 'fc-hint' }, 'Say it in German, then tap to flip'))
        : h('div', { class: 'fc-face' }, h('div', { class: 'pic', dataset: { ai: `Picture ${w.pic} for ${w.de}` } }, w.pic), h('div', { class: 'de-big', html: wordHtml(w.de) }), h('div', { class: 'fc-hint' }, 'Tap to flip · Space'));
      const back = h('div', { class: 'fc-face fc-back' },
        h('div', { class: 'de-big', html: wordHtml(w.de) }), h('div', { class: 'en-big' }, w.en),
        w.pl ? h('div', { class: 'muted' }, `Plural: ${w.pl}`) : null,
        h('div', { class: 'row', style: 'justify-content:center;margin-top:6px' }, sayBtn(w.de), micBtn(w.de)));
      cardEl = h('div', { class: 'fc-card', onclick: (e) => { if (!e.target.closest('button')) flip(); } }, front, back);
      rateEl = h('div', { class: 'fc-rate hidden' },
        h('button', { class: 'btn', onclick: () => rate(0) }, '😕 Again ', h('kbd', { class: 'hide-m' }, '1')),
        h('button', { class: 'btn', onclick: () => rate(1) }, '🙂 Good ', h('kbd', { class: 'hide-m' }, '2')),
        h('button', { class: 'btn primary', onclick: () => rate(2) }, '😎 Easy ', h('kbd', { class: 'hide-m' }, '3')));
      root.replaceChildren(
        h('div', { class: 'row', style: 'max-width:520px;margin:0 auto 12px' },
          h('div', { class: 'bar', style: 'flex:1' }, h('i', { style: `width:${(idx / deck.length) * 100}%` })),
          h('span', { class: 'small muted', style: 'font-weight:700' }, `${idx + 1}/${deck.length}`),
          h('button', { class: 'btn sm', onclick: () => { reverse = !reverse; show(); } }, reverse ? 'EN → DE' : 'DE → EN')),
        h('div', { class: 'fc' }, cardEl), rateEl);
      if (!reverse) say(w.de);
    }
    if (!words.length) root.append(h('div', { class: 'card' }, 'No words here.'));
    else show();
    return root;
  }

  // ── Drills: numbers, clock, Perfekt ───────────────────────────────────────
  const ONES = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
  const TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];
  function under100(n) { if (n < 20) return ONES[n]; const t = Math.floor(n / 10), o = n % 10; return o ? `${o === 1 ? 'ein' : ONES[o]}und${TENS[t]}` : TENS[t]; }
  function under1000(n) { const hd = Math.floor(n / 100), r = n % 100; return (hd ? `${hd === 1 ? '' : ONES[hd]}hundert` : '') + (r ? under100(r) : hd ? '' : 'null'); }
  function numDe(n) {
    if (n === 1000000) return 'eine Million';
    if (n < 1000) return under1000(n);
    const th = Math.floor(n / 1000), r = n % 1000;
    return `${th === 1 ? '' : under1000(th).replace(/eins$/, 'ein')}tausend${r ? under1000(r) : ''}`;
  }
  function numberQs(n = 12) {
    const qs = [];
    for (let k = 0; k < n; k++) {
      const r = Math.random();
      const v = r < 0.25 ? Math.floor(Math.random() * 21) : r < 0.8 ? 21 + Math.floor(Math.random() * 79) : pick([100, 200, 350, 999, 1000, 2500, 10000, 100000, 1000000, 120, 480, 750]);
      if (k % 2 === 0) qs.push({ type: 'type', kind: 'Numbers — listen and write the digits', listen: true, prompt: '', say: numDe(v), accept: [String(v)], show: `${v} — ${numDe(v)}` });
      else {
        const swap = v >= 21 && v < 100 && v % 10 ? Number(String(v).split('').reverse().join('')) : null;
        const wrong = [...new Set([swap, v + 10, v + 1, v - 1, v - 10, v + 100, Math.round(v / 2)].filter((x) => x != null && x >= 0 && x !== v && x <= 1000000))].slice(0, 3);
        qs.push(mcQ({ kind: 'Numbers — choose the German', prompt: String(v), correct: numDe(v), wrong: wrong.map(numDe), say: numDe(v), explain: v >= 21 && v < 100 ? 'Ones first, then tens: „…und…zig“.' : '' }));
      }
    }
    return qs;
  }
  const HW = ['zwölf', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf'];
  const hw = (x) => HW[((x - 1) % 12) + 1];
  function timeDe(hh, m) {
    const n = hw(hh + 1);
    return ({ 0: hh % 12 === 1 ? 'ein Uhr' : `${hw(hh)} Uhr`, 5: `fünf nach ${hw(hh)}`, 10: `zehn nach ${hw(hh)}`, 15: `Viertel nach ${hw(hh)}`, 20: `zwanzig nach ${hw(hh)}`, 25: `fünf vor halb ${n}`, 30: `halb ${n}`, 35: `fünf nach halb ${n}`, 40: `zwanzig vor ${n}`, 45: `Viertel vor ${n}`, 50: `zehn vor ${n}`, 55: `fünf vor ${n}` })[m];
  }
  function clockSvg(hh, m) {
    const ang = (deg) => (deg - 90) * Math.PI / 180;
    const ha = ang(((hh % 12) + m / 60) * 30), ma = ang(m * 6);
    const ticks = Array.from({ length: 12 }, (_, k) => { const a = ang(k * 30); return `<line class="tick" x1="${75 + Math.cos(a) * 60}" y1="${75 + Math.sin(a) * 60}" x2="${75 + Math.cos(a) * 68}" y2="${75 + Math.sin(a) * 68}"/>`; }).join('');
    const wrap = h('div', { dataset: { ai: `Clock picture showing ${hh}:${String(m).padStart(2, '0')}` } });
    wrap.innerHTML = `<svg class="clock" viewBox="0 0 150 150" aria-label="clock"><circle class="face" cx="75" cy="75" r="70"/>${ticks}<line class="hh" x1="75" y1="75" x2="${75 + Math.cos(ha) * 36}" y2="${75 + Math.sin(ha) * 36}"/><line class="mh" x1="75" y1="75" x2="${75 + Math.cos(ma) * 56}" y2="${75 + Math.sin(ma) * 56}"/><circle cx="75" cy="75" r="4" fill="currentColor"/></svg>`;
    return wrap;
  }
  function clockQs(n = 10) {
    const qs = [];
    for (let k = 0; k < n; k++) {
      const hh = 1 + Math.floor(Math.random() * 12), m = pick([0, 5, 10, 15, 20, 25, 30, 30, 35, 40, 45, 45, 50, 55]);
      const correct = timeDe(hh, m);
      const cand = new Set([timeDe(hh % 12 + 1, m), timeDe(hh === 1 ? 12 : hh - 1, m), timeDe(hh, (m + 30) % 60), timeDe(hh, m === 15 ? 45 : m === 45 ? 15 : (m + 15) % 60)]);
      cand.delete(correct);
      qs.push(mcQ({ kind: 'Wie spät ist es? (informal)', prompt: '', clock: [hh, m], correct, wrong: [...cand].slice(0, 3), say: `Es ist ${correct}`, explain: `${hh}:${String(m).padStart(2, '0')} → ${correct}. Official: ${hh} Uhr ${m || ''}`.trim() }));
    }
    return qs;
  }
  const PARTS = [
    ['machen', 'hat', 'gemacht'], ['lernen', 'hat', 'gelernt'], ['üben', 'hat', 'geübt'], ['kaufen', 'hat', 'gekauft'], ['spielen', 'hat', 'gespielt'], ['arbeiten', 'hat', 'gearbeitet'],
    ['frühstücken', 'hat', 'gefrühstückt'], ['kochen', 'hat', 'gekocht'], ['hören', 'hat', 'gehört'], ['wohnen', 'hat', 'gewohnt'], ['leben', 'hat', 'gelebt'], ['sagen', 'hat', 'gesagt'],
    ['suchen', 'hat', 'gesucht'], ['warten', 'hat', 'gewartet'], ['antworten', 'hat', 'geantwortet'], ['heiraten', 'hat', 'geheiratet'], ['lieben', 'hat', 'geliebt'],
    ['essen', 'hat', 'gegessen'], ['trinken', 'hat', 'getrunken'], ['schreiben', 'hat', 'geschrieben'], ['sprechen', 'hat', 'gesprochen'], ['treffen', 'hat', 'getroffen'], ['finden', 'hat', 'gefunden'],
    ['schlafen', 'hat', 'geschlafen'], ['sehen', 'hat', 'gesehen'], ['lesen', 'hat', 'gelesen'], ['nehmen', 'hat', 'genommen'], ['helfen', 'hat', 'geholfen'], ['singen', 'hat', 'gesungen'],
    ['gehen', 'ist', 'gegangen'], ['fahren', 'ist', 'gefahren'], ['kommen', 'ist', 'gekommen'], ['fliegen', 'ist', 'geflogen'], ['schwimmen', 'ist', 'geschwommen'], ['aufstehen', 'ist', 'aufgestanden'], ['bleiben', 'ist', 'geblieben'],
    ['einkaufen', 'hat', 'eingekauft'], ['aufräumen', 'hat', 'aufgeräumt'], ['anrufen', 'hat', 'angerufen'], ['fernsehen', 'hat', 'ferngesehen'], ['anfangen', 'hat', 'angefangen'],
    ['besuchen', 'hat', 'besucht'], ['bezahlen', 'hat', 'bezahlt'], ['verstehen', 'hat', 'verstanden'], ['erzählen', 'hat', 'erzählt'], ['bestehen', 'hat', 'bestanden'],
    ['studieren', 'hat', 'studiert'], ['telefonieren', 'hat', 'telefoniert'], ['reparieren', 'hat', 'repariert'], ['reservieren', 'hat', 'reserviert'],
  ];
  function perfektQs(n = 14) {
    return sample(PARTS, n).map(([inf, aux, part]) => Math.random() < 0.5
      ? mcQ({ kind: 'Perfekt: haben or sein?', prompt: `er ___ ${part}`, sub: `(${inf})`, correct: aux, wrong: [aux === 'hat' ? 'ist' : 'hat'], say: `er ${aux} ${part}`, explain: aux === 'ist' ? 'Movement from A to B (or bleiben) → sein.' : 'Most verbs → haben.' })
      : { type: 'type', kind: 'Perfekt: write aux + participle', prompt: `er ___ (${inf})`, accept: [`${aux} ${part}`], show: `er ${aux} ${part}`, say: `er ${aux} ${part}` });
  }

  // ── Views: Practice ───────────────────────────────────────────────────────
  const MODES = [
    ['review', '🔁', 'Smart review', 'Words that are due + new words, with spaced repetition'],
    ['cards', '🃏', 'Flashcards (all)', 'Flip through every word of the course'],
    ['mixed', '🎲', 'Mixed quiz', 'Grammar questions from all 10 lessons'],
    ['gender', '🎨', 'der · das · die', 'Guess the article of every noun'],
    ['verbs', '⚙️', 'Verb forms', 'ich bin, du hast, er nimmt …'],
    ['perfekt', '⏪', 'Perfekt', 'hat gemacht / ist gefahren (L7)'],
    ['listen', '👂', 'Listening words', 'Hear a word, pick the right one'],
    ['numbers', '🔢', 'Numbers', '0 – 1 000 000, prices & phone numbers'],
    ['clock', '🕒', 'Clock time', 'halb neun, Viertel vor zwölf … (L5)'],
    ['order', '🧩', 'Build sentences', 'Word order: verb in position 2'],
    ['type', '⌨️', 'Write the word', 'English → type the German word'],
  ];
  function viewPractice() {
    setCtx('Practice hub');
    const due = dueWords().length;
    return h('div', null,
      h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, 'Practice'), h('p', { class: 'muted', style: 'margin:6px 0 0' }, 'Short drills — 2–5 minutes each. Everything you answer updates your progress.'))),
      h('div', { class: 'grid g3' }, MODES.map(([k, em, t, s]) => h('a', { class: 'card link', href: `#/practice/${k}` },
        h('div', { class: 'row' }, h('span', { style: 'font-size:26px' }, em), k === 'review' && due ? h('span', { class: 'badge acc' }, `${due} due`) : null),
        h('b', { style: 'display:block;margin-top:8px' }, t), h('div', { class: 'small muted' }, s)))));
  }
  function viewPracticeRun(mode) {
    const all = [...WORDS.values()];
    const head = (t) => h('div', { class: 'crumb' }, h('a', { href: '#/practice' }, 'Practice'), h('span', null, '›'), h('span', null, t));
    const back = '#/practice';
    const again = () => route(true);
    const run = (t, qs) => { setCtx(`Practice — ${t}`); return h('div', null, head(t), session({ title: t, qs, again, back, ctxPage: `Practice — ${t}` })); };
    switch (mode) {
      case 'review': {
        const due = shuffle(dueWords()).slice(0, 15);
        const fresh2 = [];
        for (const l of LESSONS) for (const w of lessonWords(l)) if (!S.w[w.de] && fresh2.length < Math.max(0, 15 - due.length)) fresh2.push(w);
        const ws = [...due, ...fresh2];
        const qs = ws.map((w) => wordQ(w, isNoun(w) && Math.random() < 0.25 ? 'gender' : pick(['de_en', 'en_de', 'type', canSpeak() && voices.length ? 'listen' : 'de_en']), all));
        return run(`Smart review (${due.length} due, ${fresh2.length} new)`, qs);
      }
      case 'cards': setCtx('Practice — flashcards'); return h('div', null, head('Flashcards — all words'), flashcards(all, 'All flashcards'));
      case 'mixed': return run('Mixed quiz', sample(LESSONS.flatMap((l) => l.quiz.map((q) => quizQ(q, l))), 15));
      case 'gender': return run('der · das · die', sample(all.filter(isNoun), 15).map((w) => wordQ(w, 'gender', all)));
      case 'verbs': return run('Verb forms', sample(LESSONS.flatMap((l) => l.verbs || []), 14).map(verbQ));
      case 'perfekt': return run('Perfekt', perfektQs());
      case 'listen': return run('Listening words', sample(all, 12).map((w) => wordQ(w, 'listen', all)));
      case 'numbers': return run('Numbers', numberQs());
      case 'clock': return run('Clock time', clockQs());
      case 'order': return run('Build sentences', sample(LESSONS.flatMap((l) => l.order), 10).map(orderQ));
      case 'type': return run('Write the word', sample(all.filter((w) => w.de.length < 22), 12).map((w) => wordQ(w, 'type', all)));
      default: return viewPractice();
    }
  }

  // ── Views: Words dictionary ───────────────────────────────────────────────
  function viewWords() {
    setCtx('Dictionary of all course words');
    let filter = 'all', q = '';
    const list = h('div', { class: 'words' });
    const count = h('span', { class: 'small muted' });
    const paint = () => {
      const nq = norm(q);
      const ws = [...WORDS.values()].filter((w) => (filter === 'all' || w.lid === filter) && (!nq || norm(w.de).includes(nq) || norm(w.en).includes(nq)));
      count.textContent = `${ws.length} words`;
      list.replaceChildren(...ws.slice(0, 400).map(wordRow));
    };
    const chips = h('div', { class: 'tabs', style: 'margin:12px 0' }, [['all', 'All'], ...LESSONS.map((l) => [l.id, `L${l.n}`])].map(([k, t]) => h('a', { href: 'javascript:void 0', class: k === filter ? 'on' : '', onclick: (e) => { filter = k; [...chips.children].forEach((c) => c.classList.toggle('on', c === e.currentTarget)); paint(); } }, t)));
    paint();
    return h('div', null,
      h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, 'Words'), h('p', { class: 'muted', style: 'margin:6px 0 0' }, 'Every word of your course. Tap 🔊 to listen.')), count),
      h('input', { class: 'input', type: 'search', placeholder: 'Search German or English…', oninput: (e) => { q = e.target.value; paint(); } }),
      chips, list);
  }

  // ── Views: Exam ───────────────────────────────────────────────────────────
  function viewExam(sub, id) {
    if (sub === 'read' && id) return examTaskView(EXAM.reading.find((t) => t.id === id), 'read');
    if (sub === 'listen' && id) return examTaskView(EXAM.listening.find((t) => t.id === id), 'listen');
    if (sub === 'write') return id ? writingView(EXAM.writing.find((t) => t.id === id)) : listPage('write');
    if (sub === 'talk') return id ? presentationView(EXAM.presentations.find((t) => t.id === id)) : listPage('talk');
    if (sub === 'dialog') return id ? dialogView(EXAM.dialogue.scenarios.find((t) => t.id === id)) : dialogHub();
    if (sub === 'read' || sub === 'listen') return listPage(sub);
    if (sub === 'mock') return mockView();
    return examHub();
  }
  const examCrumb = (t) => h('div', { class: 'crumb' }, h('a', { href: '#/exam' }, 'Exam'), h('span', null, '›'), h('span', null, t));
  function bestBadge(id) { const e = S.ex[id]; return e ? h('span', { class: `badge ${e.best >= 80 ? 'good' : e.best >= 50 ? 'warn' : ''}` }, `best ${e.best}%`) : h('span', { class: 'badge' }, 'new'); }
  function examHub() {
    setCtx('Exam overview: format of the A1 term test and oral exam');
    const avg = (arr) => { const v = arr.map((t) => S.ex[t.id]?.best).filter((x) => x != null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    const r = avg(EXAM.reading), l = avg(EXAM.listening);
    const lastMock = S.mocks[S.mocks.length - 1];
    return h('div', null,
      h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, 'Exam training'), h('p', { class: 'muted', style: 'margin:6px 0 0' }, 'Built from your real exam papers: the A1 term test (80 points) and the oral exam (presentation + dialogue).'))),
      h('div', { class: 'card', style: 'margin-bottom:14px' },
        h('h3', { style: 'margin-bottom:8px' }, 'How the exam works'),
        h('div', { class: 'tblwrap' }, h('table', { class: 'tbl' }, h('tbody', null, EXAM.format.map((f) => h('tr', null,
          h('td', { style: 'width:34%' }, h('b', null, f.part), h('div', { class: 'small muted' }, f.en + (f.points ? ` · ${f.points} P.` : ''))),
          h('td', null, f.what, h('div', { class: 'small', style: 'color:var(--accent);margin-top:3px' }, '→ ' + f.tip)))))))),
      h('a', { class: 'card link', href: '#/exam/mock', style: 'margin-bottom:14px' },
        h('div', { class: 'row' }, h('span', { style: 'font-size:30px' }, '🧪'), h('div', { class: 'grow', style: 'flex:1' }, h('h2', null, 'Mock test'), h('div', { class: 'small muted' }, 'Listening + reading + grammar, like the real test. ~20 minutes.')),
          lastMock ? h('span', { class: 'badge acc' }, `last ${Math.round((lastMock.score / lastMock.max) * 100)}%`) : null, h('span', { class: 'btn primary' }, 'Start'))),
      h('div', { class: 'grid g2' },
        hubCard('👂', 'A · Hörverstehen', `${EXAM.listening.length} listening tasks${l != null ? ` · avg ${l}%` : ''}`, '#/exam/listen'),
        hubCard('📖', 'B · Leseverstehen', `${EXAM.reading.length} texts — incl. your real test${r != null ? ` · avg ${r}%` : ''}`, '#/exam/read'),
        hubCard('✍️', 'C · Schreiben', `${EXAM.writing.length} tasks with model answers + AI check`, '#/exam/write'),
        hubCard('🎤', 'Mündlich · Präsentation', `${EXAM.presentations.length} topics · ⭐ your own 2 topics`, '#/exam/talk'),
        hubCard('💬', 'Mündlich · Gespräch', `Phrases + ${EXAM.dialogue.scenarios.length} role-plays with the AI`, '#/exam/dialog')));
  }
  const hubCard = (em, t, s, href) => h('a', { class: 'card link', href }, h('div', { class: 'row' }, h('span', { style: 'font-size:26px' }, em), h('div', { style: 'flex:1' }, h('b', null, t), h('div', { class: 'small muted' }, s)), h('span', { class: 'muted' }, '›')));
  function listPage(kind) {
    const cfg = {
      read: ['Leseverstehen (reading)', EXAM.reading, (t) => `#/exam/read/${t.id}`, (t) => bestBadge(t.id)],
      listen: ['Hörverstehen (listening)', EXAM.listening, (t) => `#/exam/listen/${t.id}`, (t) => bestBadge(t.id)],
      write: ['Schreiben (writing)', EXAM.writing, (t) => `#/exam/write/${t.id}`, (t) => (S.wr[t.id] || '').length > 40 ? h('span', { class: 'badge good' }, 'written') : h('span', { class: 'badge' }, `${t.points} P.`)],
      talk: ['Präsentation (presentation)', EXAM.presentations.slice().sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0)), (t) => `#/exam/talk/${t.id}`, (t) => S.pr[t.id] ? h('span', { class: 'badge good' }, 'learned') : t.mine ? h('span', { class: 'badge acc' }, '⭐ your topic') : h('span', { class: 'badge' }, `${t.sem}. Semester`)],
    }[kind];
    setCtx(`Exam — ${cfg[0]} — list of tasks`);
    return h('div', null, examCrumb(cfg[0]),
      h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, cfg[0]),
        kind === 'talk' ? h('p', { class: 'muted', style: 'margin:6px 0 0' }, 'All monologue topics of your course (1st and 2nd semester). ⭐ = the topics you were given. Model answers are examples — replace details with your real life.') : null)),
      h('div', { class: 'grid g2' }, cfg[1].map((t) => h('a', { class: 'card link tight', href: cfg[2](t) },
        h('div', { class: 'row' }, h('span', { class: 'lnum' }, `Lektion ${t.lesson}`), h('span', { class: 'sp' }), cfg[3](t)),
        h('b', { style: 'display:block;margin-top:4px' }, t.title || t.topic), h('div', { class: 'small muted' }, t.instr || t.en || t.task)))));
  }

  // One reading/listening task: renders text or audio + questions; grade() returns {score, max}.
  function taskBlock(t, kind, { onGraded, showCheck = true } = {}) {
    const answers = new Map();
    const root = h('div', { class: 'stack' });
    let graded = false;
    if (kind === 'read') {
      root.append(h('div', { class: 'card' }, h('div', { class: 'small muted', style: 'margin-bottom:8px' }, t.instr), h('div', { class: 'passage' }, t.text.map((p) => h('p', { html: p })))));
    } else if (kind === 'listen') {
      const transcript = h('ul', { class: 'lines hidden' }, t.lines.map(([who, txt]) => h('li', null, h('span', { class: `who ${who === 'B' ? 'b' : ''}` }, who), h('div', null, txt))));
      let playing = false, plays = 0;
      const playBtn = h('button', { class: 'btn primary' }, '▶ Play');
      const play = async (rate) => {
        if (playing) { speechSynthesis.cancel(); playing = false; playBtn.textContent = '▶ Play'; return; }
        if (!canSpeak()) return toast('Audio is not available in this browser.');
        playing = true; plays++; playBtn.textContent = '■ Stop';
        const items = [...transcript.children];
        for (let k = 0; k < t.lines.length && playing; k++) {
          items.forEach((li, j) => li.classList.toggle('now', j === k));
          await say(t.lines[k][1], { who: t.lines[k][0], queue: true, rate });
          await new Promise((r) => setTimeout(r, 350));
        }
        items.forEach((li) => li.classList.remove('now'));
        playing = false; playBtn.textContent = plays >= 2 ? '▶ Play again' : '▶ Play (2nd time)';
      };
      playBtn.onclick = () => play();
      cleanup.push(() => { playing = false; });
      root.append(h('div', { class: 'card' },
        h('div', { class: 'small muted', style: 'margin-bottom:10px' }, t.instr, ' In the exam you hear each text twice. Read the questions first!'),
        h('div', { class: 'row' }, playBtn, h('button', { class: 'btn', onclick: () => play(0.75) }, '🐢 Slow'), h('span', { class: 'sp' }),
          h('button', { class: 'btn ghost sm', onclick: (e) => { transcript.classList.toggle('hidden'); e.currentTarget.textContent = transcript.classList.contains('hidden') ? 'Show transcript' : 'Hide transcript'; } }, 'Show transcript')),
        transcript));
    }
    const qwrap = h('div', { class: 'card' });
    t.questions.forEach((q, k) => {
      const block = h('div', { class: 'qblock' }, h('div', { class: 'qq' }, q.q));
      if (q.o) {
        const pills = h('div', { class: 'pills' }, q.o.map((o, j) => h('button', { class: 'pill', onclick: (e) => { if (graded) return; answers.set(k, j); [...pills.children].forEach((p) => p.classList.toggle('sel', p === e.currentTarget)); } }, o)));
        block.append(pills);
      } else {
        block.append(h('input', { class: 'input', placeholder: 'Write your answer…', oninput: (e) => answers.set(k, e.target.value), autocomplete: 'off' }));
      }
      block.append(h('div', { class: 'expl hidden' }));
      qwrap.append(block);
    });
    root.append(qwrap);
    function grade() {
      graded = true;
      let score = 0;
      const lines = [];
      t.questions.forEach((q, k) => {
        const block = qwrap.children[k];
        const ex = block.querySelector('.expl');
        let ok;
        if (q.o) {
          const a = answers.get(k);
          ok = a === q.a;
          const pills = [...block.querySelectorAll('.pill')];
          pills.forEach((p) => (p.disabled = true));
          pills[q.a].classList.add('ok');
          if (a != null && a !== q.a) pills[a].classList.add('no');
          lines.push(`${q.q} → learner: ${a != null ? q.o[a] : '—'}; correct: ${q.o[q.a]}`);
        } else {
          const v = norm(answers.get(k) || '');
          ok = !!v && q.fill.some((f) => norm(f) === v || (norm(f).length > 6 && lev(norm(f), v) <= 2));
          block.querySelector('input').disabled = true;
          lines.push(`${q.q} → learner: ${answers.get(k) || '—'}; correct: ${q.fill[0]}`);
        }
        if (ok) score++;
        ex.classList.remove('hidden');
        ex.className = `expl ${ok ? 'ok' : 'no'}`;
        ex.textContent = (ok ? '✓ ' : `✗ Correct: ${q.o ? q.o[q.a] : q.fill[0]}`) + (q.e ? (ok ? q.e : ` — ${q.e}`) : '');
      });
      setCtx(CTX.page, `Task "${t.title}" checked. ${lines.join('\n')}`);
      const pct = Math.round((score / t.questions.length) * 100);
      const e = S.ex[t.id] || {};
      S.ex[t.id] = { best: Math.max(e.best || 0, pct), at: Date.now() };
      addXp(score * 8); S.stats.right += score; S.stats.wrong += t.questions.length - score; save(); paintChrome();
      onGraded && onGraded(score, t.questions.length);
      return { score, max: t.questions.length };
    }
    if (showCheck) {
      const res = h('div');
      root.append(h('div', { class: 'row' }, h('button', { class: 'btn primary lg', onclick: (e) => { if (graded) return; e.currentTarget.disabled = true; const { score, max } = grade(); res.replaceChildren(h('div', { class: 'card row' }, h('div', { class: 'score' }, `${score}/${max}`), h('div', { style: 'flex:1' }, h('b', null, score === max ? 'Perfekt! 🏆' : score >= max * 0.7 ? 'Gut gemacht! 🎉' : 'Read the explanations above and try again.'), h('div', { class: 'small muted' }, 'Tap ✦ AI and tap a sentence you don\'t understand.')), h('button', { class: 'btn', onclick: () => route(true) }, 'Try again'))); } }, 'Check answers'), res));
    }
    return { el: root, grade };
  }
  function examTaskView(t, kind) {
    if (!t) return examHub();
    setCtx(`Exam — ${kind === 'read' ? 'Leseverstehen' : 'Hörverstehen'}: ${t.title}`, kind === 'read' ? `Text: ${t.text.join(' ').replace(/<[^>]+>/g, ' ').slice(0, 1800)}` : `Transcript: ${t.lines.map((x) => x[1]).join(' ').slice(0, 1800)}`);
    return h('div', null, examCrumb(kind === 'read' ? 'Leseverstehen' : 'Hörverstehen'),
      h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('span', { class: 'lnum' }, `Lektion ${t.lesson}`), h('h1', null, t.title)), bestBadge(t.id)),
      taskBlock(t, kind).el);
  }
  function mockView() {
    setCtx('Exam — mock test');
    const L = sample(EXAM.listening, 2), R = sample(EXAM.reading, 2);
    const G = { id: 'mock-g', title: 'Grammatik und Wortschatz', instr: 'Choose the correct answer.', questions: sample(LESSONS.flatMap((l) => l.quiz), 12).map((q) => { const o = shuffle(q.o); return Object.assign({}, q, { o, a: o.indexOf(q.o[q.a]) }); }) };
    const blocks = [...L.map((t) => ['listen', t]), ...R.map((t) => ['read', t])];
    const parts = blocks.map(([k, t]) => [k, t, taskBlock(t, k, { showCheck: false })]);
    const g = taskBlock(G, 'grammar', { showCheck: false });
    const res = h('div');
    let done = false;
    const finish = (e) => {
      if (done) return; done = true; e.currentTarget.disabled = true;
      let sc = 0, mx = 0; const per = { listen: [0, 0], read: [0, 0], grammar: [0, 0] };
      for (const [k, , b] of parts) { const r2 = b.grade(); sc += r2.score; mx += r2.max; per[k][0] += r2.score; per[k][1] += r2.max; }
      const rg = g.grade(); sc += rg.score; mx += rg.max; per.grammar = [rg.score, rg.max];
      delete S.ex['mock-g'];
      S.mocks.push({ at: Date.now(), score: sc, max: mx }); save();
      const pct = Math.round((sc / mx) * 100);
      res.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'score' }, `${pct}%`), h('div', { style: 'flex:1' }, h('b', null, `${sc} / ${mx} points`), h('div', { class: 'small muted' }, pct >= 60 ? 'You would pass — keep polishing the weak part.' : 'Not yet — practise the weakest part below, then try again.'))),
        h('div', { class: 'grid g3', style: 'margin-top:12px' }, [['👂 Hören', per.listen], ['📖 Lesen', per.read], ['🧩 Grammatik', per.grammar]].map(([n, [a, b]]) => h('div', { class: 'stat' }, h('b', null, `${a}/${b}`), h('span', null, n)))),
        h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'btn primary', onclick: () => route(true) }, 'New mock test'), h('a', { class: 'btn', href: '#/exam' }, 'Back'))));
      res.scrollIntoView({ behavior: 'smooth' });
    };
    return h('div', null, examCrumb('Mock test'),
      h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, 'Mock test'), h('p', { class: 'muted', style: 'margin:6px 0 0' }, 'Answer everything, then press “Finish” at the bottom. A new mix every time.'))),
      h('h2', { class: 'sec' }, 'A · Hörverstehen'), parts.filter((p) => p[0] === 'listen').map((p) => h('div', { style: 'margin-bottom:14px' }, h('h3', { style: 'margin:0 0 8px' }, p[1].title), p[2].el)),
      h('h2', { class: 'sec' }, 'B · Leseverstehen'), parts.filter((p) => p[0] === 'read').map((p) => h('div', { style: 'margin-bottom:14px' }, h('h3', { style: 'margin:0 0 8px' }, p[1].title), p[2].el)),
      h('h2', { class: 'sec' }, 'C · Grammatik'), g.el,
      h('div', { style: 'margin-top:16px' }, h('button', { class: 'btn primary lg block', onclick: finish }, 'Finish & see my score')), res);
  }
  function writingView(t) {
    if (!t) return listPage('write');
    setCtx(`Exam — Schreiben: ${t.title}`, `Task: ${t.task}`);
    const ta = h('textarea', { class: 'input', spellcheck: 'false', placeholder: t.start });
    ta.value = S.wr[t.id] || t.start;
    const wc = h('span', { class: 'small muted' });
    const upd = () => { wc.textContent = `${ta.value.trim().split(/\s+/).filter(Boolean).length} words`; };
    let tmr;
    ta.addEventListener('input', () => { upd(); clearTimeout(tmr); tmr = setTimeout(() => { S.wr[t.id] = ta.value; save(); }, 600); setCtx(`Exam — Schreiben: ${t.title}`, `Task: ${t.task}\nLearner's draft:\n${ta.value}`); });
    upd();
    const model = h('div', { class: 'card hidden' }, h('h3', { style: 'margin-bottom:8px' }, 'Model answer'), h('div', { class: 'passage', style: 'white-space:pre-wrap' }, t.model), h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn sm', onclick: () => say(t.model.replace(/\n/g, ' ')) }, '🔊 Listen')));
    return h('div', null, examCrumb('Schreiben'),
      h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('span', { class: 'lnum' }, `Lektion ${t.lesson} · ${t.points} points`), h('h1', null, t.title))),
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, h('p', { style: 'font-weight:600' }, t.task), h('div', { class: 'small muted', style: 'margin-bottom:4px' }, 'Your text must include:'), h('ul', { style: 'margin:0;padding-left:20px' }, t.points_list.map((p) => h('li', null, p)))),
        h('div', { class: 'card' }, ta, h('div', { class: 'row', style: 'margin-top:10px' }, wc, h('span', { class: 'sp' }),
          h('button', { class: 'btn', onclick: (e) => { model.classList.toggle('hidden'); e.currentTarget.textContent = model.classList.contains('hidden') ? 'Show model answer' : 'Hide model answer'; } }, 'Show model answer'),
          h('button', { class: 'btn primary', onclick: () => { S.wr[t.id] = ta.value; save(); askAI(`Please check my text for this writing task (${t.points} points).\nTask: ${t.task}\nIt must include: ${t.points_list.join('; ')}.\n\nMy text:\n${ta.value}\n\nGive me: 1) an estimated score out of ${t.points}, 2) each mistake with the correction and a short reason, 3) which required points are missing, 4) an improved version (still simple A1).`, { label: '✍️ Check my writing' }); } }, '✦ Check with AI'))),
        model));
  }
  function presentationView(t) {
    if (!t) return listPage('talk');
    setCtx(`Exam — Präsentation: ${t.topic}`, `Model text:\n${t.model.join(' ')}`);
    let mode = 'full';
    const list = h('ul', { class: 'lines memo' });
    const firstLetters = (s) => s.split(' ').map((w) => w[0] + w.slice(1).replace(/[A-Za-zÄÖÜäöüß]/g, '·')).join(' ');
    const paint = () => list.replaceChildren(...t.model.map((s, k) => h('li', null, h('span', { class: 'who' }, k + 1),
      h('div', { class: `txt ${mode === 'hide' ? 'blur' : ''}`, style: 'flex:1', onclick: (e) => e.currentTarget.classList.remove('blur'), dataset: { ai: `Sentence from my presentation: ${s}` } }, mode === 'first' ? firstLetters(s) : s),
      sayBtn(s), micBtn(s))));
    paint();
    const modes = h('div', { class: 'tabs', style: 'margin:0 0 12px' }, [['full', 'Full text'], ['first', 'First letters'], ['hide', 'Hidden']].map(([k, l]) => h('a', { href: 'javascript:void 0', class: k === mode ? 'on' : '', onclick: (e) => { mode = k; [...modes.children].forEach((c) => c.classList.toggle('on', c === e.currentTarget)); paint(); } }, l)));
    let playing = false;
    const playAll = async (e) => {
      const b = e.currentTarget;
      if (playing) { playing = false; speechSynthesis.cancel(); b.textContent = '▶ Play all'; return; }
      playing = true; b.textContent = '■ Stop';
      const items = [...list.children];
      for (let k = 0; k < t.model.length && playing; k++) { items.forEach((li, j) => li.classList.toggle('now', j === k)); await say(t.model[k], { queue: true }); await new Promise((r) => setTimeout(r, 300)); }
      items.forEach((li) => li.classList.remove('now')); playing = false; b.textContent = '▶ Play all';
    };
    cleanup.push(() => { playing = false; });
    return h('div', null, examCrumb('Präsentation'),
      h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('span', { class: 'lnum' }, `Lektion ${t.lesson} · ${t.sem}. Semester${t.mine ? ' · ⭐ your topic' : ''}`), h('h1', null, t.topic), h('div', { class: 'muted' }, t.en))),
      h('div', { class: 'stack' },
        t.tip ? h('div', { class: 'tip' }, t.tip) : null,
        h('div', { class: 'card' },
          h('div', { class: 'row', style: 'margin-bottom:12px' }, h('button', { class: 'btn primary', onclick: playAll }, '▶ Play all'), SR ? h('span', { class: 'small muted' }, '🎤 = say the sentence, I check you') : null, h('span', { class: 'sp' }),
            h('button', { class: `btn ${S.pr[t.id] ? '' : 'primary'}`, onclick: (e) => { S.pr[t.id] = !S.pr[t.id]; if (S.pr[t.id]) addXp(30); save(); e.currentTarget.textContent = S.pr[t.id] ? '✅ Learned' : 'Mark as learned'; } }, S.pr[t.id] ? '✅ Learned' : 'Mark as learned')),
          h('div', { class: 'small muted', style: 'margin-bottom:8px' }, 'Learn it step by step: read → first letters → hidden (tap a line to peek).'),
          modes, list),
        h('div', { class: 'card row' }, h('div', { style: 'flex:1' }, h('b', null, 'Practise with an examiner'), h('div', { class: 'small muted' }, 'The AI asks you follow-up questions about this topic in simple German and corrects your answers.')),
          h('button', { class: 'btn primary', onclick: () => askAI(`Act as my oral examiner for the A1 presentation topic: „${t.topic}“. I already gave my presentation. Now ask me ONE short follow-up question in simple German (A1). After each of my answers, correct my German briefly in English, then ask the next question. Ask 5 questions in total, then give me feedback.`, { label: '🎤 Examiner mode' }) }, '✦ Start'))));
  }
  function dialogHub() {
    setCtx('Exam — Gespräch (dialogue): phrases and role-plays');
    const D = EXAM.dialogue;
    return h('div', null, examCrumb('Gespräch'),
      h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, 'Gespräch (dialogue)'), h('p', { class: 'muted', style: 'margin:6px 0 0' }, 'Learn the ready phrases, then play the role-plays — with a partner or with the AI.'))),
      h('div', { class: 'grid g2' }, D.phrases.map((g) => h('div', { class: 'card' }, h('h3', { style: 'margin-bottom:8px' }, g.h), h('ul', { class: 'ex' }, g.rows.map(([de, en]) => h('li', null, sayBtn(de), h('div', null, h('div', { class: 'exde' }, de), h('div', { class: 'exen' }, en)))))))),
      h('div', { class: 'card', style: 'margin-top:14px' }, h('h3', { style: 'margin-bottom:8px' }, 'Activities for making plans'), h('div', { class: 'pills' }, D.activities.map((a) => h('button', { class: 'pill', onclick: () => say(a) }, a)))),
      h('div', { class: 'sec' }, h('h2', null, 'Role-plays')),
      h('div', { class: 'grid g2' }, D.scenarios.map((s) => h('a', { class: 'card link tight', href: `#/exam/dialog/${s.id}` }, h('span', { class: 'lnum' }, `Lektion ${s.lesson}`), h('b', { style: 'display:block' }, s.title), h('div', { class: 'small muted' }, s.en)))));
  }
  function dialogView(s) {
    if (!s) return dialogHub();
    setCtx(`Exam — Gespräch role-play: ${s.title}`, `Role A: ${s.a}\nRole B: ${s.b}\nModel dialogue: ${s.model.map(([w, t]) => `${w}: ${t}`).join(' / ')}`);
    const list = h('ul', { class: 'lines' }, s.model.map(([who, txt]) => h('li', null, h('span', { class: `who ${who === 'B' ? 'b' : ''}` }, who), h('div', { style: 'flex:1' }, txt), sayBtn(txt))));
    let playing = false;
    cleanup.push(() => { playing = false; });
    return h('div', null, h('div', { class: 'crumb' }, h('a', { href: '#/exam' }, 'Exam'), h('span', null, '›'), h('a', { href: '#/exam/dialog' }, 'Gespräch'), h('span', null, '›'), h('span', null, s.title)),
      h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('span', { class: 'lnum' }, `Lektion ${s.lesson}`), h('h1', null, s.title), h('div', { class: 'muted' }, s.en))),
      h('div', { class: 'stack' },
        h('div', { class: 'grid g2' }, h('div', { class: 'card' }, h('span', { class: 'badge acc' }, 'Partner A (you)'), h('p', { style: 'margin:8px 0 0' }, s.a)), h('div', { class: 'card' }, h('span', { class: 'badge warn' }, 'Partner B'), h('p', { style: 'margin:8px 0 0' }, s.b))),
        h('div', { class: 'card' },
          h('div', { class: 'row', style: 'margin-bottom:10px' }, h('h3', null, 'Model dialogue'), h('span', { class: 'sp' }),
            h('button', { class: 'btn sm', onclick: async (e) => { const b = e.currentTarget; if (playing) { playing = false; speechSynthesis.cancel(); b.textContent = '▶ Play'; return; } playing = true; b.textContent = '■ Stop'; const items = [...list.children]; for (let k = 0; k < s.model.length && playing; k++) { items.forEach((li, j) => li.classList.toggle('now', j === k)); await say(s.model[k][1], { who: s.model[k][0], queue: true }); await new Promise((r) => setTimeout(r, 300)); } items.forEach((li) => li.classList.remove('now')); playing = false; b.textContent = '▶ Play'; } }, '▶ Play')),
          list),
        h('div', { class: 'card row' }, h('div', { style: 'flex:1' }, h('b', null, 'Role-play with the AI'), h('div', { class: 'small muted' }, 'You are A. The AI plays B, answers in simple German and corrects you.')),
          h('button', { class: 'btn primary', onclick: () => askAI(`Let's role-play for my A1 oral exam. Situation: ${s.title} (${s.en}). I am partner A: ${s.a}. You are partner B: ${s.b}. Speak only simple A1 German in your role (one or two short sentences per turn). After each of my lines, add one short line in English in brackets if I made a mistake. Start the dialogue now as B.`, { label: '💬 Role-play' }) }, '✦ Start'))));
  }

  // ── AI tutor panel ────────────────────────────────────────────────────────
  const AI = { open: false, picking: false, picked: null, msgs: [], busy: false, el: null };
  try { AI.msgs = JSON.parse(localStorage.getItem('deutsch.chat') || '[]').slice(-30); } catch {}
  const fab = document.getElementById('fab');
  let lastSel = { text: '', at: 0 };
  document.addEventListener('selectionchange', () => {
    const s = String(window.getSelection() || '').trim();
    if (s && !(AI.el && AI.el.contains(window.getSelection().anchorNode))) lastSel = { text: s.slice(0, 600), at: Date.now() };
    if (AI.picking && s) { clearTimeout(AI.selT); AI.selT = setTimeout(() => { const s2 = String(window.getSelection() || '').trim(); if (AI.picking && s2) finishPick(s2.slice(0, 600), null); }, 900); }
  });
  fab.addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection
  fab.addEventListener('click', () => {
    if (AI.open && !AI.picking) { closeAI(); return; }
    if (AI.picking) { stopPick(); return; }
    openAI();
    const sel = Date.now() - lastSel.at < 4000 ? lastSel.text : '';
    if (sel) finishPick(sel, null);
    else startPick();
  });
  function buildPanel() {
    const msgs = h('div', { class: 'ai-msgs' });
    const quick = h('div', { class: 'ai-quick' });
    const pickedRow = h('div', { class: 'ai-picked hidden' });
    const ta = h('textarea', { placeholder: 'Ask anything… (English or German)', rows: 1 });
    const send = h('button', { class: 'btn primary', 'aria-label': 'Send' }, '➤');
    const form = h('form', { class: 'ai-form', onsubmit: (e) => { e.preventDefault(); const v = ta.value.trim(); if (!v) return; ta.value = ''; ta.style.height = ''; askAI(v); } }, ta, send);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(120, ta.scrollHeight) + 'px'; if (AI.picking) stopPick(true); });
    ta.addEventListener('focus', () => { if (AI.picking) stopPick(true); });
    const el = h('div', { class: 'ai', role: 'dialog', 'aria-label': 'AI tutor' },
      h('div', { class: 'ai-head' }, h('b', null, '✦ AI tutor'),
        h('button', { class: 'btn ghost sm', title: 'Point at something on the page', onclick: () => (AI.picking ? stopPick() : startPick()) }, '🎯 Point'),
        h('button', { class: 'btn ghost sm', title: 'New chat', onclick: () => { AI.msgs = []; AI.picked = null; persistChat(); paintAI(); } }, 'New'),
        h('button', { class: 'btn ghost sm', title: 'Close', 'aria-label': 'Close', onclick: closeAI }, '✕')),
      msgs, pickedRow, quick, form);
    AI.el = el; AI.parts = { msgs, quick, pickedRow, ta };
    document.body.append(el);
  }
  function openAI() { if (!AI.el) buildPanel(); AI.el.classList.remove('hidden'); AI.open = true; fab.classList.add('on'); paintAI(); }
  function closeAI() { stopPick(true); if (AI.el) AI.el.classList.add('hidden'); AI.open = false; fab.classList.remove('on'); }
  let pickbar = null;
  function startPick() {
    AI.picking = true;
    document.body.classList.add('picking');
    pickbar?.remove();
    pickbar = h('div', { class: 'pickbar' }, h('span', null, '👆 Tap a word, sentence or picture — or select text'), h('button', { onclick: () => stopPick() }, 'Cancel'));
    document.body.append(pickbar);
    paintAI();
  }
  function stopPick(silent) {
    AI.picking = false;
    document.body.classList.remove('picking');
    pickbar?.remove(); pickbar = null;
    if (!silent) paintAI();
  }
  // Intercept clicks while picking (capture phase, before links/buttons react).
  document.addEventListener('click', (e) => {
    if (!AI.picking) return;
    if (e.target.closest('.ai, .fab, .pickbar')) return;
    e.preventDefault(); e.stopPropagation();
    const sel = String(window.getSelection() || '').trim();
    if (sel) return finishPick(sel.slice(0, 600), null);
    const t = e.target;
    const tagged = t.closest('[data-ai]');
    let text = '';
    const own = (t.innerText || t.textContent || '').trim();
    if (t.closest('svg')) text = t.closest('[data-ai]')?.dataset.ai || 'a picture';
    else if (own && own.length <= 400 && !(tagged && own.length <= 3)) text = own;
    else if (tagged) text = tagged.dataset.ai;
    else text = (t.closest('p, li, td, .card') || t).innerText.trim().slice(0, 400);
    if (tagged && own && own !== tagged.dataset.ai && own.length <= 400) text = `${own}\n(context: ${tagged.dataset.ai})`;
    finishPick(text, t);
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (AI.picking) stopPick(); else if (AI.open) closeAI(); } });
  function finishPick(text, el) {
    stopPick(true);
    if (el) { el.classList.add('ai-flash'); setTimeout(() => el.classList.remove('ai-flash'), 1200); }
    try { window.getSelection()?.removeAllRanges(); } catch {}
    lastSel = { text: '', at: 0 };
    AI.picked = text;
    openAI();
    askAI('Explain this to me.', { picked: text });
  }
  function persistChat() { try { localStorage.setItem('deutsch.chat', JSON.stringify(AI.msgs.slice(-30))); } catch {} }
  function mdRender(src) {
    const inline = (s) => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    const lines = esc(src).split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*\|/.test(l)) {
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { if (!/^\s*\|?\s*:?-{2,}/.test(lines[i])) rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => `<td>${inline(c.trim())}</td>`).join('')); i++; }
        out.push(`<table>${rows.map((r) => `<tr>${r}</tr>`).join('')}</table>`);
        continue;
      }
      if (/^\s*[-*•] /.test(l)) { const it = []; while (i < lines.length && /^\s*[-*•] /.test(lines[i])) { it.push(`<li>${inline(lines[i].replace(/^\s*[-*•] /, ''))}</li>`); i++; } out.push(`<ul>${it.join('')}</ul>`); continue; }
      if (/^\s*\d+[.)] /.test(l)) { const it = []; while (i < lines.length && /^\s*\d+[.)] /.test(lines[i])) { it.push(`<li>${inline(lines[i].replace(/^\s*\d+[.)] /, ''))}</li>`); i++; } out.push(`<ol>${it.join('')}</ol>`); continue; }
      if (/^#{1,4} /.test(l)) { out.push(`<h4>${inline(l.replace(/^#+ /, ''))}</h4>`); i++; continue; }
      if (!l.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(\||[-*•] |\d+[.)] |#{1,4} )/.test(lines[i])) { para.push(inline(lines[i])); i++; }
      out.push(`<p>${para.join('<br>')}</p>`);
    }
    return out.join('');
  }
  function paintAI() {
    if (!AI.el) return;
    const { msgs, quick, pickedRow } = AI.parts;
    if (!AI.msgs.length) {
      msgs.replaceChildren(h('div', { class: 'ai-empty' }, h('b', null, 'Hallo! I\'m your German tutor.'),
        AI.picking ? 'Tap anything on the page — a word, a sentence, a table, a picture — and I\'ll explain it. Or type a question below.' : 'Ask me anything about German, or press 🎯 Point and tap something on the page.'));
    } else {
      msgs.replaceChildren(...AI.msgs.map((m) => m.role === 'user'
        ? h('div', { class: 'msg u' }, m.picked ? h('span', { class: 'pick' }, `📌 „${m.picked.length > 120 ? m.picked.slice(0, 120) + '…' : m.picked}“`) : null, m.label || m.content)
        : h('div', { class: `msg a${m.streaming ? ' typing' : ''}`, html: mdRender(m.content || '') })));
      msgs.scrollTop = msgs.scrollHeight;
    }
    pickedRow.classList.toggle('hidden', !AI.picked);
    if (AI.picked) pickedRow.replaceChildren(h('span', null, `📌 ${AI.picked}`), h('button', { class: 'btn ghost sm', onclick: () => { AI.picked = null; paintAI(); } }, '✕'));
    const qs = AI.picked ? [['Translate', 'Translate it word by word.'], ['Grammar', 'Explain the grammar in it.'], ['Pronounce', 'How do I pronounce it? Give a simple English-style pronunciation.'], ['Examples', 'Give me 3 more example sentences like this.']]
      : [['Quiz me', 'Give me a short quiz (5 questions) on what I see on this page.'], ['Explain page', 'Explain the most important thing on this page simply.'], ['Exam tips', 'What are the 5 most important things for my A1 exam from this topic?']];
    quick.replaceChildren(...qs.map(([t, p]) => h('button', { onclick: () => askAI(p, AI.picked ? { picked: AI.picked } : {}) }, t)));
  }
  // Clicking bold German in an AI answer speaks it.
  document.addEventListener('click', (e) => { const s = e.target.closest('.msg.a strong'); if (s && !AI.picking) say(s.textContent); });
  async function askAI(text, opts = {}) {
    openAI();
    stopPick(true);
    if (AI.busy) return toast('Wait a moment — I\'m still answering.');
    const picked = opts.picked || null;
    const content = picked ? `Selected on the page: «${picked}»\n\n${text}` : text;
    AI.msgs.push({ role: 'user', content, picked, label: opts.label || (picked ? text : null) });
    const ans = { role: 'assistant', content: '', streaming: true };
    AI.msgs.push(ans);
    AI.busy = true;
    paintAI();
    try {
      const r = await fetch('/deutsch/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: AI.msgs.filter((m) => m !== ans && m.content).slice(-14).map((m) => ({ role: m.role, content: m.content })), context: ctxString() }) });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const rd = r.body.getReader(), dec = new TextDecoder();
      let lastPaint = 0;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        ans.content += dec.decode(value, { stream: true });
        if (Date.now() - lastPaint > 60) { lastPaint = Date.now(); paintAI(); }
      }
    } catch (err) {
      ans.content = (ans.content ? ans.content + '\n\n' : '') + '⚠️ Could not reach the AI. Check your internet connection and try again.';
    }
    ans.streaming = false;
    AI.busy = false;
    AI.picked = null;
    persistChat();
    paintAI();
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  function openSettings() {
    const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } });
    const date = h('input', { class: 'input', type: 'date', value: S.settings.examDate || '' });
    const name = h('input', { class: 'input', value: S.settings.name || '' });
    const vsel = h('select', { class: 'input' }, h('option', { value: '' }, voices.length ? 'Best available' : 'No German voice found on this device'), voices.map((v) => h('option', { value: v.name, selected: v.name === S.settings.voice }, `${v.name} (${v.lang})`)));
    const rate = h('input', { type: 'range', min: '0.6', max: '1.2', step: '0.05', value: S.settings.rate || 0.95, style: 'width:100%' });
    const theme = h('select', { class: 'input' }, [['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, selected: S.settings.theme === v }, l)));
    const syncTxt = { ok: '✅ Synced — progress follows you between phone and laptop.', offline: '⚠️ Offline — progress is saved on this device and syncs later.', syncing: '⏳ Syncing…', idle: '⏳ Not synced yet.' }[syncState];
    bg.append(h('div', { class: 'modal' },
      h('h2', null, 'Settings'),
      h('label', { class: 'field' }, h('span', null, 'Exam date'), date),
      h('label', { class: 'field' }, h('span', null, 'Your name'), name),
      h('label', { class: 'field' }, h('span', null, 'German voice'), vsel),
      h('label', { class: 'field' }, h('span', null, 'Speaking speed'), rate),
      h('label', { class: 'field' }, h('span', null, 'Theme'), theme),
      h('p', { class: 'small muted' }, syncTxt),
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('button', { class: 'btn ghost sm', onclick: () => { if (confirm('Reset ALL progress on all devices? This cannot be undone.')) { const keep = S.settings; S = fresh(); S.settings = keep; save(); push(false, true); bg.remove(); route(); toast('Progress reset.'); } } }, 'Reset progress'),
        h('span', { class: 'sp' }),
        h('button', { class: 'btn', onclick: () => say('Hallo! Ich heiße Anna. Wie heißt du?', { rate: Number(rate.value) }) }, '🔊 Test'),
        h('button', { class: 'btn primary', onclick: () => { Object.assign(S.settings, { examDate: date.value, name: name.value.trim() || 'Oleg', voice: vsel.value, rate: Number(rate.value), theme: theme.value }); applyTheme(); save(); push(); bg.remove(); route(true); } }, 'Save'))));
    document.body.append(bg);
  }
  document.getElementById('setBtn').onclick = openSettings;

  // ── Start ─────────────────────────────────────────────────────────────────
  applyTheme();
  route();
  pull();
  setTimeout(() => { if (canSpeak() && !voices.length) { loadVoices(); if (!voices.length) toast('No German voice on this device — add one in system settings for audio.', 5000); } }, 2500);
})();
