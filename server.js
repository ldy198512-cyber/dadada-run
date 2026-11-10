// 다다다 달리기 - 게임 서버
// 실행: npm install && npm start  →  큰 화면: /host , 참가자: /
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
let cfg = { teams: ['1본부', '2본부', '3본부', '4본부', '5본부'], hostPin: '' };
try { cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))); } catch (e) {}
const TEAMS = cfg.teams.slice(0, 8).map(String);
const HOST_PIN = String(process.env.HOST_PIN || cfg.hostPin || '');

const COUNTDOWN_MS = 4000;      // 3, 2, 1, 출발
const CLOSE_AFTER_FIRST_MS = 15000; // 1등 골인 후 마감까지
const HARD_LIMIT_MS = 90000;    // 한 판 최대 길이
const RELAY_LEGS = 4;             // 릴레이 주자 수 (본부당)
const RELAY_CLOSE_MS = 20000;     // 릴레이: 1등 골인 후 마감까지
const RELAY_LIMIT_MS = 180000;    // 릴레이 한 판 최대 길이
const MAX_TAPS_PER_SEC = 18;    // 사람 손으로 가능한 한계 (매크로 방지)

// ---------- 정적 파일 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const PUB = path.join(__dirname, 'public');
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p === '/host') p = '/host.html';
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('찾을 수 없는 페이지입니다'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

// ---------- 게임 상태 ----------
const players = new Map(); // id -> player
const hosts = new Set();
let botSeq = 0;
const g = { phase: 'lobby', mode: null, goal: 150, startAt: 0, closeAt: 0, parts: [], members: [], teamFinish: [], finishSeq: 0, results: null, timer: null, picks: TEAMS.map(() => []), rs: [], lap: 75 };

function lanUrl() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return `http://${i.address}:${PORT}`;
  return null;
}
const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const toHosts = (m) => { const s = JSON.stringify(m); for (const h of hosts) if (h.readyState === 1) h.send(s); };

function stateMsg(p) {
  return { t: 'state', phase: g.phase, mode: g.mode, goal: g.goal, startAt: g.startAt, closeAt: g.closeAt, now: Date.now(), members: g.members, lap: g.lap, legs: RELAY_LEGS, relay: g.mode === 'relay' ? g.rs.map(r => (r ? r.order : null)) : undefined, in: p ? g.parts.includes(p) : undefined, results: g.phase === 'finished' ? g.results : undefined };
}
function broadcastState() {
  toHosts(stateMsg(null));
  for (const p of players.values()) send(p.ws, stateMsg(p));
}
let rosterQueued = false;
function sendRoster() {
  if (rosterQueued) return; rosterQueued = true;
  setTimeout(() => {
    rosterQueued = false;
    toHosts({ t: 'roster', players: [...players.values()].map(p => ({ id: p.id, name: p.name, team: p.team, online: p.online, bot: !!p.bot })), picks: g.picks });
  }, 80);
}

function soloRanking() {
  return g.parts.slice().sort((a, b) => {
    if (a.finishMs && b.finishMs) return a.finishMs - b.finishMs || a.finishSeq - b.finishSeq;
    if (a.finishMs) return -1; if (b.finishMs) return 1;
    return b.taps - a.taps;
  });
}
function teamStats() {
  const out = [];
  TEAMS.forEach((_, t) => {
    const n = g.members[t] || 0; if (!n) return;
    let sum = 0; for (const p of g.parts) if (p.team === t) sum += p.taps;
    out.push({ team: t, members: n, sum, avg: sum / n, ms: g.teamFinish[t] || 0 });
  });
  out.sort((a, b) => { if (a.ms && b.ms) return a.ms - b.ms; if (a.ms) return -1; if (b.ms) return 1; return b.avg - a.avg; });
  out.forEach((s, i) => { s.rank = i + 1; });
  return out;
}

const onlineOf = (t) => [...players.values()].filter(p => p.online && p.team === t);
function relayReady() {
  let any = false;
  for (let t = 0; t < TEAMS.length; t++) {
    const n = onlineOf(t).length; if (!n) { if (g.picks[t].length) return false; continue; }
    const need = Math.min(RELAY_LEGS, n);
    if (g.picks[t].length !== need || !g.picks[t].every(id => players.get(id) && players.get(id).online)) return false;
    any = true;
  }
  return any;
}
const relayCur = (rs) => rs.order[rs.leg % rs.order.length];
function relayStats() {
  const out = [];
  g.rs.forEach((rs, t) => {
    if (!rs) return;
    const cur = players.get(relayCur(rs));
    const frac = rs.ms ? 0 : Math.max(0, Math.min(1, ((cur ? cur.taps : rs.base) - rs.base) / g.lap));
    out.push({ team: t, leg: rs.leg, frac, total: rs.ms ? RELAY_LEGS : rs.leg + frac, ms: rs.ms, cur: rs.ms ? null : relayCur(rs) });
  });
  out.sort((a, b) => { if (a.ms && b.ms) return a.ms - b.ms; if (a.ms) return -1; if (b.ms) return 1; return b.total - a.total; });
  out.forEach((s, i) => { s.rank = i + 1; });
  return out;
}
function sendRelayMe(onlyTeam) {
  const stats = relayStats(), now = Date.now();
  for (const p of g.parts) {
    if (onlyTeam !== undefined && p.team !== onlyTeam) continue;
    const s = stats.find(x => x.team === p.team), rs = g.rs[p.team];
    if (!s || !rs) { send(p.ws, { t: 'me', role: 'none', now }); continue; }
    const legsOfMine = []; for (let k = 0; k < RELAY_LEGS; k++) if (rs.order[k % rs.order.length] === p.id) legsOfMine.push(k);
    const turn = !rs.ms && s.cur === p.id, next = legsOfMine.find(k => k > rs.leg), curP = s.cur && players.get(s.cur);
    send(p.ws, { t: 'me', role: legsOfMine.length ? 'runner' : 'cheer', turn, wait: turn ? 0 : (next !== undefined ? next - rs.leg : -1), myLeg: (turn ? rs.leg : (next !== undefined ? next : legsOfMine[legsOfMine.length - 1] || 0)) + 1, leg: rs.leg, frac: s.frac, prog: s.total / RELAY_LEGS, rank: s.rank, total: stats.length, ms: rs.ms, cur: curP ? curP.name : '', closeAt: g.closeAt, now });
  }
}
function passBaton(t, now) {
  const rs = g.rs[t]; if (!rs || rs.ms || g.phase !== 'racing') return;
  rs.legTimes.push(now - rs.legStart); rs.leg++;
  if (rs.leg >= RELAY_LEGS) { rs.ms = now - g.startAt; if (!g.closeAt) g.closeAt = now + RELAY_CLOSE_MS; }
  else { const nx = players.get(relayCur(rs)); rs.base = nx ? nx.taps : 0; rs.legStart = now; }
  sendRelayMe(t);
}

function startGame(mode, goal) {
  if (g.phase !== 'lobby' && g.phase !== 'finished') return;
  const parts = [...players.values()].filter(p => p.online);
  if (!parts.length) return;
  clearInterval(g.timer);
  if (mode === 'relay' && !relayReady()) return;
  g.mode = mode === 'team' ? 'team' : mode === 'relay' ? 'relay' : 'solo';
  g.goal = Math.max(30, Math.min(500, goal | 0 || 150));
  g.parts = parts; g.finishSeq = 0; g.results = null; g.closeAt = 0;
  g.members = TEAMS.map((_, t) => parts.filter(p => p.team === t).length);
  g.teamFinish = TEAMS.map(() => 0);
  for (const p of parts) { p.taps = 0; p.finishMs = 0; p.finishSeq = 0; p.lastAt = 0; p.botAcc = 0; p.botRate = 4.5 + Math.random() * 4; }
  g.phase = 'countdown'; g.startAt = Date.now() + COUNTDOWN_MS;
  g.lap = Math.round(g.goal / 2); // 릴레이는 한 사람이 개인전의 절반 거리를 달림
  g.rs = g.mode === 'relay' ? TEAMS.map((_, t) => (g.picks[t].length ? { order: g.picks[t].slice(), leg: 0, base: 0, legStart: g.startAt, legTimes: [], ms: 0 } : null)) : [];
  broadcastState(); sendRoster();
  g.timer = setInterval(tick, 100);
}

function applyTaps(p, n, now) {
  if (g.phase !== 'racing' || !g.parts.includes(p) || p.finishMs) return;
  n = Math.floor(Number(n)); if (!(n > p.taps)) return;
  if (g.mode === 'relay') { // 지금 차례인 주자의 탭만 인정
    const rs = g.rs[p.team]; if (!rs || rs.ms || relayCur(rs) !== p.id) return;
    const cap = rs.base + Math.ceil((now - rs.legStart) / 1000 * MAX_TAPS_PER_SEC) + 3;
    p.taps = Math.max(p.taps, Math.min(n, cap));
    if (p.taps - rs.base >= g.lap) passBaton(p.team, now);
    return;
  }
  if (g.mode === 'team' && g.teamFinish[p.team]) return; // 골인한 본부는 기록 고정
  const allowed = Math.ceil((now - g.startAt) / 1000 * MAX_TAPS_PER_SEC) + 3; // 출발 후 누적 상한
  p.taps = Math.max(p.taps, Math.min(n, allowed));
  if (g.mode === 'solo' && p.taps >= g.goal) {
    p.taps = g.goal; p.finishMs = now - g.startAt; p.finishSeq = ++g.finishSeq;
    if (!g.closeAt) g.closeAt = now + CLOSE_AFTER_FIRST_MS;
  }
}

let tickN = 0;
function tick() {
  const now = Date.now();
  if (g.phase === 'countdown' && now >= g.startAt) { g.phase = 'racing'; broadcastState(); }
  const racing = g.phase === 'racing';
  if (!racing && g.phase !== 'countdown') return;
  tickN++;
  if (racing) for (const p of g.parts) {
    if (!p.bot) continue;
    if (g.mode === 'relay') { const rs = g.rs[p.team]; if (!rs || rs.ms || relayCur(rs) !== p.id) continue; if (p.botAcc < p.taps) p.botAcc = p.taps; }
    p.botAcc += p.botRate * (0.6 + Math.random() * 0.8) * 0.1; if (Math.floor(p.botAcc) > p.taps) applyTaps(p, Math.floor(p.botAcc), now);
  }
  let done = false;
  if (g.mode === 'relay') {
    const stats = relayStats();
    toHosts({ t: 'tick', el: Math.max(0, now - g.startAt), closeAt: g.closeAt, now, relay: stats.map(s => [s.team, s.leg, s.frac, s.ms, s.rank, s.cur]) });
    if (tickN % 2 === 0) sendRelayMe();
    done = stats.every(s => s.ms);
  } else if (g.mode === 'solo') {
    const rank = soloRanking();
    toHosts({ t: 'tick', el: Math.max(0, now - g.startAt), closeAt: g.closeAt, now, p: rank.map(p => [p.id, p.taps, p.finishMs]) });
    if (tickN % 3 === 0) rank.forEach((p, i) => send(p.ws, { t: 'me', taps: p.taps, rank: i + 1, total: rank.length, ms: p.finishMs, closeAt: g.closeAt, now }));
    done = rank.every(p => p.finishMs || !p.online);
  } else {
    let stats = teamStats();
    for (const s of stats) if (!s.ms && s.avg >= g.goal) { g.teamFinish[s.team] = now - g.startAt; if (!g.closeAt) g.closeAt = now + CLOSE_AFTER_FIRST_MS; }
    stats = teamStats();
    toHosts({ t: 'tick', el: Math.max(0, now - g.startAt), closeAt: g.closeAt, now, teams: stats.map(s => [s.team, Math.min(s.avg, g.goal), s.ms, s.rank]) });
    if (tickN % 3 === 0) for (const p of g.parts) { const s = stats.find(x => x.team === p.team); send(p.ws, { t: 'me', taps: p.taps, rank: s.rank, total: stats.length, avg: Math.min(s.avg, g.goal), ms: s.ms, closeAt: g.closeAt, now }); }
    done = stats.every(s => s.ms);
  }
  if (racing && (done || (g.closeAt && now >= g.closeAt) || now - g.startAt >= (g.mode === 'relay' ? RELAY_LIMIT_MS : HARD_LIMIT_MS))) finish();
}

function finish() {
  if (g.phase !== 'racing' && g.phase !== 'countdown') return;
  clearInterval(g.timer);
  if (g.mode === 'relay') {
    g.results = { mode: 'relay', lap: g.lap, legs: RELAY_LEGS, teams: relayStats().map(s => { const rs = g.rs[s.team]; return { team: s.team, rank: s.rank, ms: s.ms, prog: s.total / RELAY_LEGS, runners: Array.from({ length: RELAY_LEGS }, (_, k) => { const id = rs.order[k % rs.order.length], p = players.get(id); return { id, name: p ? p.name : '?', ms: rs.legTimes[k] || 0 }; }) }; }) };
  } else if (g.mode === 'solo') {
    g.results = { mode: 'solo', goal: g.goal, list: soloRanking().map((p, i) => ({ id: p.id, name: p.name, team: p.team, taps: p.taps, ms: p.finishMs, rank: i + 1 })) };
  } else {
    const stats = teamStats();
    g.results = {
      mode: 'team', goal: g.goal,
      teams: stats.map(s => {
        const best = g.parts.filter(p => p.team === s.team).sort((a, b) => b.taps - a.taps)[0];
        return { team: s.team, members: s.members, avg: Math.round(s.avg * 10) / 10, sum: s.sum, ms: s.ms, rank: s.rank, mvp: best ? { name: best.name, taps: best.taps } : null };
      }),
      players: g.parts.map(p => ({ id: p.id, team: p.team, taps: p.taps })),
    };
  }
  g.phase = 'finished';
  broadcastState();
}

function toLobby() {
  clearInterval(g.timer);
  g.phase = 'lobby'; g.mode = null; g.parts = []; g.results = null; g.closeAt = 0;
  for (const [id, p] of players) if (!p.online && !p.bot && !g.picks.some(l => l.includes(id))) players.delete(id);
  broadcastState(); sendRoster();
}

// ---------- 접속 처리 ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });
wss.on('connection', (ws) => {
  ws.alive = true; ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const now = Date.now();

    if (m.t === 'hello') {
      if (m.role === 'host') {
        if (HOST_PIN && String(m.pin || '') !== HOST_PIN) return send(ws, { t: 'denied' });
        ws.isHost = true; hosts.add(ws);
        send(ws, { t: 'welcome', role: 'host', teams: TEAMS, lan: lanUrl() });
        send(ws, stateMsg(null)); sendRoster();
        return;
      }
      const id = String(m.id || '').slice(0, 40); if (!id) return;
      const name = String(m.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 10) || '이름없음';
      const team = Math.max(0, Math.min(TEAMS.length - 1, m.team | 0));
      let p = players.get(id);
      if (!p) { p = { id, name, team, taps: 0, finishMs: 0, online: true }; players.set(id, p); }
      else {
        if (p.ws && p.ws !== ws) { p.ws.player = null; try { p.ws.close(); } catch (e) {} }
        p.name = name;
        if ((!g.parts.includes(p) || g.phase === 'lobby' || g.phase === 'finished') && p.team !== team) { p.team = team; g.picks = g.picks.map(l => l.filter(x => x !== id)); } // 경기 중에는 본부 변경 불가
      }
      p.ws = ws; p.online = true; ws.player = p;
      send(ws, { t: 'welcome', role: 'player', id, teams: TEAMS, team: p.team, name: p.name, taps: p.taps });
      send(ws, stateMsg(p)); sendRoster();
      return;
    }

    if (m.t === 'teams') return send(ws, { t: 'teams', teams: TEAMS });
    if (ws.player && m.t === 'tap') return applyTaps(ws.player, m.n, now);
    if (ws.player && m.t === 'leave') { const p = ws.player; if (!g.parts.includes(p) || g.phase === 'lobby' || g.phase === 'finished') { players.delete(p.id); g.parts = g.parts.filter(x => x !== p); g.picks = g.picks.map(l => l.filter(x => x !== p.id)); } ws.player = null; p.online = false; sendRoster(); return; }

    if (!ws.isHost) return;
    if (m.t === 'start') return startGame(m.mode, m.goal);
    if (m.t === 'end') return finish();
    if (m.t === 'pick') { // 릴레이 주자 지정/해제 (누른 순서가 달리는 순서)
      if (g.phase !== 'lobby' && g.phase !== 'finished') return;
      const p = players.get(String(m.id)); if (!p) return;
      const l = g.picks[p.team], i = l.indexOf(p.id);
      if (i >= 0) l.splice(i, 1); else if (l.length < RELAY_LEGS) l.push(p.id);
      return sendRoster();
    }
    if (m.t === 'skip') { if (g.mode === 'relay') passBaton(m.team | 0, now); return; }
    if (m.t === 'lobby') return toLobby();
    if (m.t === 'bots') {
      if (g.phase !== 'lobby' && g.phase !== 'finished') return;
      const n = Math.max(0, Math.min(60, m.n | 0));
      if (!n) { for (const [id, p] of players) if (p.bot) { players.delete(id); g.picks = g.picks.map(l => l.filter(x => x !== id)); } }
      for (let i = 0; i < n; i++) { const id = 'bot' + (++botSeq); players.set(id, { id, name: '연습' + botSeq, team: Math.floor(Math.random() * TEAMS.length), taps: 0, finishMs: 0, online: true, bot: true }); }
      return sendRoster();
    }
    if (m.t === 'clear') {
      if (g.phase !== 'lobby' && g.phase !== 'finished') return;
      for (const p of players.values()) send(p.ws, { t: 'kicked' });
      players.clear(); g.picks = TEAMS.map(() => []); toLobby();
    }
  });
  ws.on('close', () => {
    hosts.delete(ws);
    const p = ws.player;
    if (p && p.ws === ws) {
      p.online = false; p.ws = null;
      if (g.phase === 'lobby' && !g.picks.some(l => l.includes(p.id))) players.delete(p.id); // 로비에서는 나가면 명단에서 제외 (지정된 주자는 유지)
      sendRoster();
    }
  });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (e) {} }
}, 25000);

server.listen(PORT, () => {
  console.log(`다다다 달리기 서버 실행 중 (포트 ${PORT})`);
  console.log(`  큰 화면(진행자): http://localhost:${PORT}/host`);
  const lan = lanUrl(); if (lan) console.log(`  같은 와이파이 참가자: ${lan}`);
});
