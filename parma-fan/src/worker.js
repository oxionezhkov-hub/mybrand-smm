// BETCITY PARMA — fan desktop backend (Cloudflare Worker)
//
// Thin, cached layer over the public Infobasket API (org.infobasket.su) that
// powers the VTB United League scoreboards, plus a Workers AI assistant that
// answers with the live data in its context. Static UI lives in ../public.
//
// Free-plan budget: 50 subrequests and little CPU per request, 1000 KV writes
// a day — short-lived data is memoized in isolate memory, only slow-changing
// data (roster, season history) is written to KV.

import INDEX_HTML from '../public/index.html';
import APP_CSS from '../public/app.css';
import APP_JS from '../public/app.txt';

const TEAM_ID = 3059;
const IB = 'https://org.infobasket.su';
const ARENA = {
  name: 'УДС «Молот»',
  address: 'Пермь, ул. Лебедева, 13',
  lat: 58.0240637,
  lon: 56.2959713,
};
const IMG_HOSTS = ['img.infobasket.su', 'files.infobasket.su', 'parmabasket.ru', 'vtb-league.com'];

// Workers AI models, tried in order until one answers.
const AI_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
];

// ── Small utilities ──────────────────────────────────────────────────────────

const json = (obj, status = 200, maxAge = 0) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
      'access-control-allow-origin': '*',
    },
  });

const msDate = (s) => {
  const m = /Date\((-?\d+)\)/.exec(s || '');
  return m ? Number(m[1]) : null;
};

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.').replace('%', ''));
  return Number.isFinite(n) ? n : null;
};

const avgOf = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x) && x > 0);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
};

const imgUrl = (u) => (u ? `/img?u=${encodeURIComponent(u)}` : null);
const teamLogo = (teamId) => imgUrl(`https://parmabasket.ru/upload/teams/${teamId}.png`);

// In-isolate memo with in-flight de-duplication.
const MEM = new Map();
async function memo(key, ttlMs, fn) {
  const hit = MEM.get(key);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.p;
  const p = fn();
  MEM.set(key, { p, exp: now + ttlMs });
  try {
    return await p;
  } catch (e) {
    // Fall back to the last good value if there is one.
    if (hit && hit.ok) {
      MEM.set(key, hit);
      return hit.p;
    }
    MEM.delete(key);
    throw e;
  } finally {
    const cur = MEM.get(key);
    if (cur && cur.p === p) cur.ok = true;
  }
}

// Memory → KV → origin. KV entries carry their own timestamp so a stale value
// can still be served if the origin is down.
async function cached(env, key, ttlSec, fn) {
  return memo(key, Math.min(ttlSec, 120) * 1000, async () => {
    let stale = null;
    if (env.CACHE) {
      try {
        const v = await env.CACHE.get(key, 'json');
        if (v && v.t && Date.now() - v.t < ttlSec * 1000) return v.d;
        stale = v;
      } catch {}
    }
    try {
      const d = await fn();
      if (env.CACHE) {
        try {
          await env.CACHE.put(key, JSON.stringify({ t: Date.now(), d }), { expirationTtl: Math.max(ttlSec * 20, 86400) });
        } catch {}
      }
      return d;
    } catch (e) {
      if (stale) return stale.d;
      throw e;
    }
  });
}

async function ib(path, params = {}) {
  const u = new URL(IB + path);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(u.toString(), {
        headers: {
          accept: 'application/json, text/plain, */*',
          referer: 'https://vtb-league.com/',
          origin: 'https://vtb-league.com',
          'user-agent': 'Mozilla/5.0 (parma-fan desktop)',
        },
      });
      if (!r.ok) throw new Error(`infobasket ${r.status} ${path}`);
      const d = await r.json();
      if (d && d.MessageType && d.Message) throw new Error(d.Message);
      return d;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ── Domain: seasons, competitions, games ─────────────────────────────────────

async function getSeasons(env) {
  return cached(env, 'seasons:v1', 86400, async () => {
    const list = await ib(`/Widget/GetTeamSeasons/${TEAM_ID}`, { format: 'json', lang: 'ru' });
    return list.map((s) => ({ id: s.CompID, year: s.Year, name: s.SeasonName })).sort((a, b) => b.year - a.year);
  });
}

async function getSeasonComps(env, seasonId) {
  return cached(env, `comps:${seasonId}`, 6 * 3600, async () => {
    const list = await ib(`/Widget/GetTeamComps/${TEAM_ID}`, { format: 'json', season: seasonId, lang: 'ru' });
    return list
      .filter((c) => c.Level === 1)
      .map((c) => ({ id: c.CompID, name: c.CompNameRu.replace(/\s*\|\s*/, ' · '), sort: c.CompSort }))
      .sort((a, b) => a.sort - b.sort);
  });
}

async function getCurrent(env) {
  const seasons = await getSeasons(env);
  const season = seasons[0];
  const comps = await getSeasonComps(env, season.id);
  const main = comps.find((c) => /ВТБ/i.test(c.name)) || comps[0];
  return { season, comps, mainCompId: main ? main.id : null };
}

function normGame(g, compName) {
  let ts = msDate(g.GameDateTimeMoscow) ?? msDate(g.GameDateTime);
  if (!ts && g.GameDate) {
    // No tip-off time yet: anchor the game at noon Moscow time on its date.
    const [dd, mm, yy] = g.GameDate.split('.').map(Number);
    if (yy) ts = Date.UTC(yy, mm - 1, dd, 9);
  }
  const side = (k) => ({
    id: g[`Team${k}id`],
    name: g[`ShortTeamName${k}ru`] || g[`CompTeamName${k}ru`],
    full: g[`TeamName${k}ru`],
    city: g[`RegionTeamName${k}ru`],
    logo: teamLogo(g[`Team${k}id`]),
    score: g.GameStatus === 0 ? null : g[`Score${k}`],
  });
  const home = side('A');
  const away = side('B');
  const isHome = home.id === TEAM_ID;
  const us = isHome ? home : away;
  const them = isHome ? away : home;
  let result = null;
  if (g.GameStatus === 1 && us.score != null && them.score != null) result = us.score > them.score ? 'W' : 'L';
  return {
    id: g.GameID,
    number: g.GameNumber,
    ts,
    hasTime: !!g.HasTime && g.GameTimeMsk !== '--:--',
    timeMsk: g.GameTimeMsk,
    dateLabel: g.DisplayDateTimeMsk,
    status: g.GameStatus, // 0 planned, 1 finished, 2 live
    home,
    away,
    isHome,
    opponent: them,
    result,
    arena: g.ArenaRu,
    city: g.RegionRu,
    attendance: g.GameAttendance || null,
    tv: (g.TvRu || '').replace(/^ТВ:\s*/i, '') || null,
    league: compName || g.LeagueNameRu,
    stage: g.CompNameRu,
  };
}

async function getSchedule(env) {
  return memo('schedule', 60_000, async () => {
    const cur = await getCurrent(env);
    const lists = await Promise.all(
      cur.comps.map((c) =>
        ib(`/Widget/TeamGames/${TEAM_ID}`, { format: 'json', compId: c.id })
          .then((gs) => gs.map((g) => ({ ...normGame(g, c.name), compId: c.id })))
          .catch(() => []),
      ),
    );
    const games = lists.flat().sort((a, b) => a.ts - b.ts);
    return { season: cur.season, comps: cur.comps, mainCompId: cur.mainCompId, games, updated: Date.now() };
  });
}

// ── Domain: roster, coaches, stats ───────────────────────────────────────────

function normPlayerStats(p) {
  if (!p) return null;
  return {
    games: p.GameCount ?? null,
    starts: p.StartCount ?? null,
    pts: num(p.AvgPoints),
    reb: num(p.AvgRebound),
    ast: num(p.AvgAssist),
    stl: num(p.AvgSteal),
    blk: num(p.AvgBlocks),
    tov: num(p.AvgTurnover),
    pm: num(p.AvgPlusMinus),
    eff: num(p.AvgKPI),
    min: p.AvgPlayedTime || null,
    fg2: p.Shots2 || null,
    fg2p: num(p.Shot2Percent),
    fg3: p.Shots3 || null,
    fg3p: num(p.Shot3Percent),
    ft: p.Shots1 || null,
    ftp: num(p.Shot1Percent),
    totPts: p.Points ?? null,
    totReb: p.Rebound ?? null,
    totAst: p.Assist ?? null,
  };
}

async function getTeam(env) {
  return cached(env, 'team:v2', 1800, async () => {
    const cur = await getCurrent(env);
    const compId = cur.mainCompId;
    const [roster, stats] = await Promise.all([
      ib(`/Widget/TeamRoster/${TEAM_ID}`, { format: 'json', compId, lang: 'ru' }),
      ib(`/Widget/TeamStats/${TEAM_ID}`, { format: 'json', compId }).catch(() => null),
    ]);
    const statById = new Map((stats?.Players || []).map((p) => [p.PersonID, p]));
    const players = (roster.Players || [])
      .filter((p) => p.IsActive !== false)
      .map((p) => {
        const pi = p.PersonInfo || {};
        return {
          id: p.PersonID,
          number: p.DisplayNumber,
          last: pi.PersonLastNameRu,
          first: pi.PersonFirstNameRu,
          lastEn: pi.PersonLastNameEn,
          firstEn: pi.PersonFirstNameEn,
          position: p.Position,
          posId: p.PosID,
          height: p.Height || pi.PersonHeight || null,
          weight: p.Weight || pi.PersonWeight || null,
          birth: p.PersonBirth,
          age: p.Age,
          country: p.CountryName,
          countryCode: p.CountryId,
          captain: !!p.Capitan,
          photo: imgUrl(p.PhotoUrl),
          stats: normPlayerStats(statById.get(p.PersonID)),
        };
      })
      .sort((a, b) => Number(a.number) - Number(b.number));
    const coaches = (roster.Coaches || []).map((c) => {
      const pi = c.PersonInfo || {};
      return {
        id: c.PersonID,
        last: pi.PersonLastNameRu,
        first: pi.PersonFirstNameRu,
        middle: pi.PersonSecondNameRu,
        post: c.Post,
        birth: c.PersonBirth,
        age: c.Age,
        country: c.CountryName,
        photo: imgUrl(c.PhotoUrl),
      };
    });
    const team = stats
      ? {
          games: stats.GameCount,
          pts: num(stats.AvgPoints),
          reb: num(stats.AvgRebound),
          ast: num(stats.AvgAssist),
          stl: num(stats.AvgSteal),
          blk: num(stats.AvgBlocks),
          tov: num(stats.AvgTurnover),
          pm: num(stats.AvgPlusMinus),
          fg2p: num(stats.Shot2Percent),
          fg3p: num(stats.Shot3Percent),
          ftp: num(stats.Shot1Percent),
          fg3: stats.AvgShots3,
          fg2: stats.AvgShots2,
          ft: stats.AvgShots1,
        }
      : null;
    return {
      compId,
      season: cur.season,
      players,
      coaches,
      team,
      avg: {
        age: avgOf(players.map((p) => p.age)),
        height: avgOf(players.map((p) => p.height)),
        weight: avgOf(players.map((p) => p.weight)),
      },
    };
  });
}

// ── Domain: standings & season history ───────────────────────────────────────

function flattenComps(comps, out = []) {
  for (const c of comps || []) {
    out.push(c);
    if (c.Children && c.Children.length) flattenComps(c.Children, out);
  }
  return out;
}

function normTable(rows) {
  return rows
    .map((r) => {
      const st = r.Standings || {};
      const n = r.CompTeamName || {};
      return {
        place: r.Place,
        teamId: r.TeamID,
        name: n.CompTeamShortNameRu || n.CompTeamNameRu,
        city: n.CompTeamRegionNameRu,
        logo: teamLogo(r.TeamID),
        g: st.StandingGame ?? r.Games ?? 0,
        w: st.StandingWin ?? r.Won ?? 0,
        l: st.StandingLose ?? r.Lost ?? 0,
        pf: st.StandingGoalPlus ?? null,
        pa: st.StandingGoalMinus ?? null,
        diff: st.StandingGoalDifference ?? null,
        pts: st.StandingPoints ?? null,
        pct: num(st.VictoryPercent),
        form: (r.Results || []).slice(-5).map((x) => (x.IsWon ? 'W' : x.IsLost ? 'L' : '·')),
      };
    })
    .sort((a, b) => a.place - b.place);
}

function normPlayoff(pairs) {
  return (pairs || []).map((p) => ({
    round: p.RoundNameRu,
    t1: { id: p.TeamName1?.TeamID, name: p.TeamName1?.CompTeamShortNameRu, score: p.Score1 },
    t2: { id: p.TeamName2?.TeamID, name: p.TeamName2?.CompTeamShortNameRu, score: p.Score2 },
    final: !!p.IsFinal,
    games: (p.Scores || []).filter((s) => s.Score).map((s) => ({ id: s.GameID, date: s.GameDate, score: s.Score, t1: s.Team1id })),
  }));
}

// Every public stage of a competition: tables for round-robins, series for
// playoffs. ≤ ~6 subrequests per competition.
async function compStages(compId) {
  const issue = await ib(`/Widget/CompIssue/${compId}`, { format: 'json' });
  let stages = flattenComps(issue.Comps).filter((c) => c.IsPublic);
  if (!stages.length && issue.ParentComp) stages = [issue.ParentComp];
  stages = stages.slice(0, 6);
  const out = await Promise.all(
    stages.map(async (s) => {
      try {
        if (s.CompType === 10) {
          const pairs = await ib(`/Widget/PlayOff/${s.CompID}`, { format: 'json' });
          return { id: s.CompID, name: s.CompShortNameRu, type: 'playoff', series: normPlayoff(pairs) };
        }
        const rows = await ib(`/Widget/CompTeamResults/${s.CompID}`, { format: 'json' });
        if (!Array.isArray(rows) || !rows.length) return null;
        return { id: s.CompID, name: s.CompShortNameRu, type: 'table', table: normTable(rows) };
      } catch {
        return null;
      }
    }),
  );
  return out.filter(Boolean);
}

async function getStandings(env) {
  return cached(env, 'standings:v1', 900, async () => {
    const cur = await getCurrent(env);
    const comps = await Promise.all(
      cur.comps.map(async (c) => ({ id: c.id, name: c.name, stages: await compStages(c.id).catch(() => []) })),
    );
    return { season: cur.season, comps: comps.filter((c) => c.stages.length) };
  });
}

async function getSeasonSummary(env, seasonId) {
  const seasons = await getSeasons(env);
  const season = seasons.find((s) => s.id === seasonId);
  if (!season) throw new Error('unknown season');
  const isCurrent = seasons[0].id === seasonId;
  return cached(env, `season:v2:${seasonId}`, isCurrent ? 3600 : 30 * 86400, async () => {
    const comps = await getSeasonComps(env, seasonId);
    const res = await Promise.all(
      comps.slice(0, 6).map(async (c) => {
        const stages = await compStages(c.id).catch(() => []);
        const results = [];
        for (const s of stages) {
          if (s.type === 'table') {
            const row = s.table.find((r) => r.teamId === TEAM_ID);
            if (row) results.push({ stage: s.name, place: row.place, of: s.table.length, w: row.w, l: row.l, pf: row.pf, pa: row.pa });
          } else {
            const mine = s.series.filter((p) => p.t1.id === TEAM_ID || p.t2.id === TEAM_ID);
            for (const p of mine) {
              const us = p.t1.id === TEAM_ID ? p.t1 : p.t2;
              const them = p.t1.id === TEAM_ID ? p.t2 : p.t1;
              results.push({ stage: `${s.name}: ${p.round}`, series: `${us.score ?? 0}–${them.score ?? 0}`, vs: them.name, won: (us.score ?? 0) > (them.score ?? 0) });
            }
          }
        }
        return { id: c.id, name: c.name, results };
      }),
    );
    return { season, comps: res };
  });
}

// ── Domain: live game ────────────────────────────────────────────────────────

const PLAY_TEXT = {
  1: 'штрафной — забил',
  2: '2 очка',
  3: '3 очка',
  4: 'штрафной — мимо',
  5: 'промах с игры',
  6: 'промах из-за дуги',
  26: 'перехват',
  27: 'блок-шот',
  28: 'подбор',
  40: 'фол',
  41: 'фол',
  42: 'фол',
  43: 'неспортивный фол',
  44: 'технический фол',
  45: 'дисквалифицирующий фол',
  46: 'фол',
  47: 'потеря',
};

const pad2 = (n) => String(n).padStart(2, '0');
const clockStr = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
};

function buildLive(d, gameId) {
  const o = d.Online || {};
  const periodLens = String(o.Periods || '10,10,10,10').split(',').map((x) => Number(x) * 60);
  const extra = o.PeriodExtraSeconds || 300;
  const lenOf = (p) => (p <= periodLens.length ? periodLens[p - 1] : extra);
  const base = (p) => {
    let t = 0;
    for (let i = 1; i < p; i++) t += lenOf(i);
    return t;
  };

  const startById = new Map();
  for (const s of d.OnlineStarts || []) if (s.SysStatus === 1) startById.set(s.StartID, s);

  const teamsMeta = {};
  for (const t of d.OnlineTeams || []) if (t.TeamNumber === 1 || t.TeamNumber === 2) teamsMeta[t.TeamNumber] = t;
  const gt = {};
  for (const t of d.GameTeams || []) gt[t.TeamNumber] = t;

  const plays = (d.OnlinePlays || [])
    .filter((p) => p.SysStatus === 1)
    .sort((a, b) => a.PlayPeriod - b.PlayPeriod || a.PlaySecond - b.PlaySecond || a.PlaySortOrder - b.PlaySortOrder);

  const score = { 1: 0, 2: 0 };
  const periods = { 1: [], 2: [] };
  const box = { 1: new Map(), 2: new Map() };
  const progression = [{ t: 0, a: 0, b: 0 }];
  const feed = [];
  let lastPeriod = 0;
  let lastSecond = 0;
  let running = false;

  const pl = (s) => {
    const m = box[s.TeamNumber];
    if (!m.has(s.StartID))
      m.set(s.StartID, { id: s.PersonID, num: s.DisplayNumber, name: s.PersonName2 || s.PersonName1, pts: 0, reb: 0, stl: 0, blk: 0, pf: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0 });
    return m.get(s.StartID);
  };

  for (const p of plays) {
    if (p.PlayPeriod > 0) {
      lastPeriod = p.PlayPeriod;
      lastSecond = p.PlaySecond;
    }
    if (p.PlayTypeID === 71) running = true;
    if (p.PlayTypeID === 70) running = false;
    const s = startById.get(p.StartID);
    const tn = s && (s.TeamNumber === 1 || s.TeamNumber === 2) ? s.TeamNumber : null;
    const isPlayer = s && s.StartType === 1;
    const type = p.PlayTypeID;
    if (tn && [1, 2, 3].includes(type)) {
      const pts = type === 1 ? o.FreeThrowValue || 1 : type === 2 ? o.FieldGoalValue || 2 : o.LongShotValue || 3;
      score[tn] += pts;
      const per = p.PlayPeriod - 1;
      while (periods[1].length <= per) periods[1].push(0), periods[2].push(0);
      periods[tn][per] += pts;
      progression.push({ t: Math.round((base(p.PlayPeriod) + p.PlaySecond / 10) / 6) / 10, a: score[1], b: score[2] });
      if (isPlayer) {
        const b = pl(s);
        b.pts += pts;
        if (type === 1) b.ftm++, b.fta++;
        else if (type === 2) b.fgm++, b.fga++;
        else b.fgm++, b.fga++, b.tpm++, b.tpa++;
      }
    } else if (tn && isPlayer) {
      const b = pl(s);
      if (type === 4) b.fta++;
      else if (type === 5) b.fga++;
      else if (type === 6) b.fga++, b.tpa++;
      else if (type === 28) b.reb++;
      else if (type === 26) b.stl++;
      else if (type === 27) b.blk++;
      else if (type >= 40 && type <= 46) b.pf++;
    }
    if (tn && PLAY_TEXT[type] && (isPlayer || [1, 2, 3].includes(type))) {
      feed.push({
        period: p.PlayPeriod,
        clock: clockStr(lenOf(p.PlayPeriod) - p.PlaySecond / 10),
        team: tn,
        player: isPlayer ? `${s.DisplayNumber} ${s.PersonName2 || s.PersonName1}`.trim() : null,
        type,
        text: PLAY_TEXT[type],
        pts: [1, 2, 3].includes(type) ? (type === 1 ? 1 : type) : 0,
        a: score[1],
        b: score[2],
      });
    }
  }

  // Prefer the official box score when the protocol is filled in (finished games).
  const officialPlayers = (n) =>
    (gt[n]?.Players || []).map((p) => ({
      id: p.PersonID,
      num: p.DisplayNumber,
      name: p.PersonNameRu,
      pts: p.Points || 0,
      reb: p.Rebound || 0,
      ast: p.Assist || 0,
      stl: p.Steal || 0,
      blk: p.Blocks || 0,
      pf: p.Foul || 0,
      pm: p.PlusMinus ?? null,
      min: p.PlayedTime || null,
      fg2: p.Shots2 || null,
      fg3: p.Shots3 || null,
      ft: p.Shots1 || null,
      start: !!p.IsStart,
    }));

  const teams = [1, 2].map((n) => {
    const m = teamsMeta[n] || {};
    const g = gt[n] || {};
    const official = officialPlayers(n);
    const useOfficial = official.some((p) => p.pts > 0 || p.min);
    const derived = [...box[n].values()].map((b) => ({
      ...b,
      ast: null,
      fg2: `${b.fgm - b.tpm}/${b.fga - b.tpa}`,
      fg3: `${b.tpm}/${b.tpa}`,
      ft: `${b.ftm}/${b.fta}`,
    }));
    const players = (useOfficial ? official : derived).sort((a, b) => b.pts - a.pts);
    const playsScore = score[n];
    return {
      id: m.TeamID || g.TeamID,
      name: m.ShortName2 || g.TeamName?.CompTeamShortNameRu,
      city: m.RegionName2 || g.TeamName?.CompTeamRegionNameRu,
      logo: teamLogo(m.TeamID || g.TeamID),
      color: m.DominantColorARGB ? '#' + m.DominantColorARGB.slice(2) : null,
      score: Math.max(playsScore, g.Score || 0),
      periods: periods[n],
      coach: g.Coach ? g.Coach.PersonNameRu : null,
      players,
      boxSource: useOfficial ? 'official' : 'derived',
      totals: g.Score
        ? {
            fg2: g.Shots2,
            fg3: g.Shots3,
            ft: g.Shots1,
            reb: g.Rebound,
            ast: g.Assist,
            stl: g.Steal,
            tov: g.Turnover,
            blk: g.Blocks,
            pf: g.Foul,
          }
        : null,
    };
  });

  const finished = d.GameStatus === 1 && !d.IsOnline;
  // The online protocol opens ~30 min before tip-off: lineups are in, clock untouched.
  const pregame = !!d.IsOnline && !running && score[1] + score[2] === 0 && (!lastPeriod || (lastPeriod === 1 && lastSecond === 0));
  const len = lastPeriod ? lenOf(lastPeriod) : lenOf(1);
  const remaining = lastPeriod ? len - lastSecond / 10 : len;
  return {
    gameId,
    status: d.IsOnline ? 2 : d.GameStatus,
    isOnline: !!d.IsOnline,
    finished,
    date: d.GameDate,
    timeMsk: d.GameTimeMsk ? d.GameTimeMsk.replace('.', ':') : null,
    venue: o.Venue2 || null,
    attendance: o.Attendance || null,
    tv: d.TvRu || null,
    league: d.LeagueNameRu,
    stage: d.CompNameRu,
    period: lastPeriod,
    pregame,
    periodLabel: pregame ? 'разминка' : lastPeriod > (periodLens.length || 4) ? `ОТ${lastPeriod - periodLens.length}` : lastPeriod ? `${lastPeriod}-я четверть` : null,
    clock: clockStr(remaining),
    clockSec: Math.max(0, Math.round(remaining)),
    clockRunning: !!d.IsOnline && running,
    teams,
    feed: feed.slice(-60).reverse(),
    progression,
    updated: Date.now(),
  };
}

async function getLive(env, gameId) {
  return memo(`live:${gameId}`, 7000, async () => {
    const d = await ib(`/Widget/GetOnline/${gameId}`, { format: 'json', lang: 'ru' });
    return buildLive(d, gameId);
  });
}

// Which Parma game the "live" screen should show right now.
function pickFocusGame(games, now = Date.now()) {
  const live = games.find((g) => g.status === 2);
  if (live) return { game: live, reason: 'live' };
  // A game that should have tipped off in the last 3 hours (feed lag) or
  // starts within 90 minutes.
  const near = games.find((g) => g.status === 0 && g.hasTime && g.ts - now < 90 * 60_000 && now - g.ts < 3 * 3600_000);
  if (near) return { game: near, reason: now >= near.ts ? 'started' : 'soon' };
  const recent = [...games].reverse().find((g) => g.status === 1 && now - g.ts < 18 * 3600_000);
  if (recent) return { game: recent, reason: 'recent' };
  const next = games.find((g) => g.status === 0 && g.ts > now - 3 * 3600_000);
  return { game: next || null, reason: 'next' };
}

async function getScoreboard(env, compId) {
  return memo(`board:${compId}`, 15_000, async () => {
    const list = await ib(`/Widget/CalendarCarousel/${compId}`, { format: 'json', max: 30, from: 'today-1', to: 'today+2' });
    return list.map((g) => normGame(g)).sort((a, b) => a.ts - b.ts);
  });
}

// ── Calendar export ──────────────────────────────────────────────────────────

function icsDate(ts) {
  const d = new Date(ts);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
const icsEsc = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');

function buildIcs(schedule, onlyId) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//parma-fan//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:БЕТСИТИ ПАРМА — матчи',
    'X-WR-TIMEZONE:Europe/Moscow',
  ];
  for (const g of schedule.games) {
    if (onlyId && g.id !== onlyId) continue;
    if (!g.ts) continue;
    const title = `${g.home.name} — ${g.away.name}${g.status === 1 ? ` ${g.home.score}:${g.away.score}` : ''}`;
    lines.push('BEGIN:VEVENT', `UID:parma-${g.id}@parma-fan`, `DTSTAMP:${icsDate(Date.now())}`);
    if (g.hasTime) {
      lines.push(`DTSTART:${icsDate(g.ts)}`, `DTEND:${icsDate(g.ts + 2 * 3600_000)}`);
    } else {
      const d = new Date(g.ts + 3 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
      lines.push(`DTSTART;VALUE=DATE:${d}`);
    }
    lines.push(
      `SUMMARY:${icsEsc(`🏀 ${title}`)}`,
      `LOCATION:${icsEsc([g.arena, g.city].filter(Boolean).join(', '))}`,
      `DESCRIPTION:${icsEsc(`${g.league} · ${g.stage}${g.tv ? `\nТВ: ${g.tv}` : ''}`)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// ── AI assistant ─────────────────────────────────────────────────────────────

const FAN_FACTS = `Клуб: БК «БЕТСИТИ ПАРМА» (Пермский край), выступает в Единой лиге ВТБ. Официальный сайт parmabasket.ru, Telegram t.me/parmabasketprm, VK vk.com/parmabasket, YouTube youtube.com/parmabasket.
Домашняя арена: УДС «Молот», Пермь, ул. Лебедева, 13 (Мотовилихинский район). Офис клуба: там же, офис 119, будни 10:00–17:30 (местное время, МСК+2).
Билеты: единственный официальный оператор — Сцена24 (scena24.ru/v2/?org=parma), также в приложении «БЕТСИТИ ПАРМА» и в офисе клуба. Билетный менеджер: +7 (967) 905-44-81, Telegram @parmatickets, tickets@parmabasket.ru. В одном заказе — не более 5 билетов. Абонементы на сезон 2026/27 в продаже.
Скидки: 50% — дети 6–14 лет, студенты очного отделения, люди с инвалидностью, пенсионеры, ветераны (с документом); 30% — карта «Профсоюзный дисконт»; 10% — владельцы абонемента прошлого сезона. Дети до 5 лет включительно — бесплатно без отдельного места.
Возврат: в день матча и за 2 дня — не производится; за 3 дня и ранее — комиссия 25%. Купленные онлайн — через поддержку Сцена24: 8 (342) 240-38-56, support@bisys.ru. Вместо возврата можно обменять билет на другой матч.
На билете указано афишное время (начало шоу), на сайте — время вбрасывания. Электронный билет можно не печатать, но скриншоты могут не считаться турникетом.
Время матчей в календаре — московское (Пермь = МСК+2).`;

function fmtGame(g) {
  const d = g.ts ? new Date(g.ts + 3 * 3600_000).toISOString().slice(0, 10) : '';
  const sc = g.status === 1 ? ` ${g.home.score}:${g.away.score} (${g.result === 'W' ? 'победа' : 'поражение'} Пармы)` : g.status === 2 ? ' — ИДЁТ СЕЙЧАС' : '';
  return `${d}${g.hasTime ? ' ' + g.timeMsk + ' МСК' : ''} ${g.home.name} — ${g.away.name}${sc}; ${g.league}, ${g.stage}; ${g.arena || ''}${g.city ? ', ' + g.city : ''}${g.tv ? '; ТВ: ' + g.tv : ''}`;
}

async function buildAiContext(env) {
  const [sched, team, standings] = await Promise.all([
    getSchedule(env).catch(() => null),
    getTeam(env).catch(() => null),
    getStandings(env).catch(() => null),
  ]);
  const parts = [`Сегодня: ${new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')} (МСК).`, FAN_FACTS];
  if (team) {
    parts.push(
      `Состав (сезон ${team.season?.name}), средние за матч в Единой лиге ВТБ:\n` +
        team.players
          .map((p) => {
            const s = p.stats;
            return `#${p.number} ${p.first} ${p.last} — ${p.position}, ${p.height || '?'} см, ${p.weight || '?'} кг, ${p.age} лет, ${p.country}${s ? `; ${s.games} игр, ${s.pts ?? 0} очк, ${s.reb ?? 0} подб, ${s.ast ?? 0} пер, КПИ ${s.eff ?? 0}, ${s.min || ''} мин, 3-очк ${s.fg3 || '-'}` : ''}`;
          })
          .join('\n'),
    );
    parts.push('Тренерский штаб:\n' + team.coaches.map((c) => `${c.post}: ${c.first} ${c.middle || ''} ${c.last}`.replace(/\s+/g, ' ')).join('\n'));
    if (team.team) {
      const t = team.team;
      parts.push(`Командная статистика (ВТБ): ${t.games} игр, ${t.pts} очк/игру, ${t.reb} подб, ${t.ast} пер, 2-очк ${t.fg2p}%, 3-очк ${t.fg3p}%, штрафные ${t.ftp}%.`);
    }
  }
  if (sched) {
    parts.push(`Турниры сезона ${sched.season.name}: ${sched.comps.map((c) => c.name).join('; ')}.`);
    parts.push('Матчи сезона:\n' + sched.games.map(fmtGame).join('\n'));
    const focus = pickFocusGame(sched.games);
    if (focus.game && (focus.reason === 'live' || focus.reason === 'started')) {
      try {
        const live = await getLive(env, focus.game.id);
        const [a, b] = live.teams;
        parts.push(
          `ОНЛАЙН СЕЙЧАС: ${a.name} ${a.score}:${b.score} ${b.name}, ${live.periodLabel || ''}, на часах ${live.clock}. По четвертям: ${a.periods.map((x, i) => `${x}:${b.periods[i]}`).join(', ')}. Лидеры: ${[a, b]
            .map((t) => `${t.name}: ${t.players.slice(0, 3).map((p) => `${p.name} ${p.pts}`).join(', ')}`)
            .join('; ')}`,
        );
      } catch {}
    }
  }
  if (standings) {
    for (const c of standings.comps) {
      for (const s of c.stages) {
        if (s.type === 'table') parts.push(`Таблица — ${c.name}, ${s.name}:\n` + s.table.map((r) => `${r.place}. ${r.name} ${r.w}-${r.l}`).join('\n'));
      }
    }
  }
  return parts.join('\n\n');
}

const AI_SYSTEM = `Ты — «Пармыч», ИИ-помощник болельщика баскетбольного клуба «БЕТСИТИ ПАРМА» из Перми в фанатском приложении.
Отвечай по-русски, живо и по делу, как знающий болельщик, без канцелярита. Можно лёгкий юмор, без кринжа.
Для фактов о клубе, составе, матчах, счёте, таблицах и билетах опирайся ТОЛЬКО на данные ниже — они актуальные и подтягиваются из официального протокола лиги. Если в данных ответа нет — честно скажи, что не знаешь, и подскажи, где проверить (parmabasket.ru, vtb-league.com). Ничего не выдумывай.
На общие вопросы о баскетболе (правила, тактика, история, лиги, термины) отвечай из своих знаний.
Форматирование: короткие абзацы, при необходимости списки через «- » и **жирный** для ключевого. Без таблиц и заголовков.

ДАННЫЕ:
`;

async function streamAi(env, messages) {
  let lastErr;
  for (const model of AI_MODELS) {
    try {
      const stream = await env.AI.run(model, { messages, stream: true, max_tokens: 900, temperature: 0.4 });
      return { stream, model };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function handleAi(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  const history = Array.isArray(body.messages) ? body.messages : [];
  const clean = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!clean.length || clean[clean.length - 1].role !== 'user') return json({ error: 'no question' }, 400);

  const context = await buildAiContext(env);
  const messages = [{ role: 'system', content: AI_SYSTEM + context }, ...clean];

  let src;
  try {
    src = await streamAi(env, messages);
  } catch (e) {
    return json({ error: 'AI недоступен: ' + (e && e.message) }, 502);
  }

  // Normalize the different Workers AI stream flavours into `data: {"t":…}`.
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const { readable, writable } = new TransformStream();
  (async () => {
    const w = writable.getWriter();
    const reader = src.stream.getReader();
    let buf = '';
    try {
      await w.write(enc.encode(`data: ${JSON.stringify({ model: src.model })}\n\n`));
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const ev = JSON.parse(payload);
            // `response` is sometimes a bare number ("202") — prefer the
            // OpenAI-style delta, which is always a string.
            const delta = ev.choices?.[0]?.delta?.content ?? ev.choices?.[0]?.text;
            const t = delta != null ? String(delta) : ev.response != null ? String(ev.response) : '';
            if (t) await w.write(enc.encode(`data: ${JSON.stringify({ t })}\n\n`));
          } catch {}
        }
      }
    } catch (e) {
      await w.write(enc.encode(`data: ${JSON.stringify({ error: String(e && e.message) })}\n\n`));
    } finally {
      await w.write(enc.encode('data: [DONE]\n\n'));
      await w.close();
    }
  })();
  return new Response(readable, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ── Image proxy ──────────────────────────────────────────────────────────────

async function handleImg(url) {
  const target = url.searchParams.get('u');
  let t;
  try {
    t = new URL(target);
  } catch {
    return new Response('bad url', { status: 400 });
  }
  if (t.protocol !== 'https:' || !IMG_HOSTS.includes(t.hostname)) return new Response('forbidden', { status: 403 });
  const r = await fetch(t.toString(), {
    headers: { referer: t.hostname.includes('parmabasket') ? 'https://parmabasket.ru/' : 'https://vtb-league.com/', 'user-agent': 'Mozilla/5.0' },
    cf: { cacheTtl: 604800, cacheEverything: true },
  });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || !ct.startsWith('image/')) return new Response('not found', { status: 404 });
  return new Response(r.body, {
    headers: { 'content-type': ct, 'cache-control': 'public, max-age=604800, immutable', 'access-control-allow-origin': '*' },
  });
}

// ── Static UI ────────────────────────────────────────────────────────────────

const STATIC = {
  '/': [INDEX_HTML, 'text/html; charset=utf-8'],
  '/index.html': [INDEX_HTML, 'text/html; charset=utf-8'],
  '/app.css': [APP_CSS, 'text/css; charset=utf-8'],
  '/app.js': [APP_JS, 'text/javascript; charset=utf-8'],
};

function serveStatic(path) {
  const hit = STATIC[path] || STATIC['/'];
  return new Response(hit[0], {
    headers: { 'content-type': hit[1], 'cache-control': path === '/' || !STATIC[path] ? 'no-cache' : 'public, max-age=300' },
  });
}

// ── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === '/img') return await handleImg(url);
      if (p === '/api/ai' && request.method === 'POST') return await handleAi(request, env);
      if (p === '/api/schedule') return json(await getSchedule(env), 200, 30);
      if (p === '/api/team') return json(await getTeam(env), 200, 300);
      if (p === '/api/standings') return json(await getStandings(env), 200, 120);
      if (p === '/api/seasons') return json(await getSeasons(env), 200, 3600);
      if (p === '/api/season') return json(await getSeasonSummary(env, Number(url.searchParams.get('id'))), 200, 3600);
      if (p === '/api/arena') return json(ARENA, 200, 86400);
      if (p === '/api/live') {
        let gameId = Number(url.searchParams.get('game')) || null;
        let focus = null;
        if (!gameId) {
          const sched = await getSchedule(env);
          focus = pickFocusGame(sched.games);
          if (focus.game && focus.reason !== 'next' && focus.reason !== 'soon') gameId = focus.game.id;
        }
        if (!gameId) return json({ live: null, focus });
        const live = await getLive(env, gameId);
        return json({ live, focus });
      }
      if (p === '/api/scoreboard') {
        const sched = await getSchedule(env);
        const compId = Number(url.searchParams.get('comp')) || sched.mainCompId;
        return json({ compId, games: await getScoreboard(env, compId) });
      }
      if (p === '/api/calendar.ics') {
        const sched = await getSchedule(env);
        const only = Number(url.searchParams.get('game')) || null;
        return new Response(buildIcs(sched, only), {
          headers: {
            'content-type': 'text/calendar; charset=utf-8',
            'content-disposition': `attachment; filename="${only ? 'parma-match-' + only : 'parma-season'}.ics"`,
          },
        });
      }
      if (p.startsWith('/api/')) return json({ error: 'not found' }, 404);
      return serveStatic(p);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502);
    }
  },
};
