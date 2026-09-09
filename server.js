// ═══════════════════════════════════════════════════════════
//  Snowball relay
//
//  Three jobs, one small server:
//    · /scores          the leaderboard (GET to read, POST to add)
//    · /callog          calibration logs from the lab mode
//    · /ws              live link between headset and control tablet
//
//  The websocket carries traffic both ways. The headset streams what the
//  player sees; the tablet sends back commands — start, stop, set name —
//  so whoever is running the session never has to reach into the headset
//  and explain gestures to a five-year-old.
// ═══════════════════════════════════════════════════════════
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { WebSocketServer } from 'ws';

const AQUI = dirname(fileURLToPath(import.meta.url));
const PORTA = process.env.PORT || 8080;

// ── State ───────────────────────────────────────────────────
// Kept in memory. Render's free tier wipes the disk on every restart, so
// writing to a file would give a false sense of permanence; if the scores
// need to outlive a restart they belong in a real database.
const MAX_SCORES = 200;
let scores = [];        // { name, score, at }
let calLogs = [];       // raw calibration CSV blobs, newest last
const MAX_LOGS = 40;

const players = new Set();     // headsets
const viewers = new Set();     // control panels and spectator screens

// ── HTTP ────────────────────────────────────────────────────
const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb':  'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon'
};

// Safari on visionOS caches aggressively. Models and textures change
// rarely and are addressed by name, so they can be cached hard; the HTML
// must not be, or a deploy goes unnoticed until someone clears the cache.
function cacheDe(ext) {
  if (ext === '.html') return 'no-cache';
  if (ext === '.glb' || ext === '.jpg' || ext === '.jpeg' ||
      ext === '.png' || ext === '.mp3') return 'public, max-age=604800';
  return 'public, max-age=3600';
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, body) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function corpo(req, limite = 2_000_000) {
  return new Promise((ok, falha) => {
    let n = 0;
    const partes = [];
    req.on('data', c => {
      n += c.length;
      if (n > limite) { falha(new Error('too big')); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => ok(Buffer.concat(partes).toString('utf8')));
    req.on('error', falha);
  });
}

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const rota = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  // ── leaderboard ──
  if (rota === '/scores' && req.method === 'GET') {
    return json(res, 200, scores.slice(0, 50));
  }
  if (rota === '/scores' && req.method === 'POST') {
    try {
      const d = JSON.parse(await corpo(req, 10_000));
      const nome = String(d.name || 'anon').slice(0, 24);
      const pontos = Math.max(0, Math.min(999_999, Number(d.score) || 0));
      scores.push({ name: nome, score: pontos, at: Date.now() });
      scores.sort((a, b) => b.score - a.score);
      if (scores.length > MAX_SCORES) scores.length = MAX_SCORES;
      difundir({ ev: 'scores', scores: scores.slice(0, 10) });
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 400, { error: 'bad body' }); }
  }

  // ── calibration logs ──
  if (rota === '/callog' && req.method === 'POST') {
    try {
      const texto = await corpo(req);
      calLogs.push({ at: Date.now(), csv: texto });
      if (calLogs.length > MAX_LOGS) calLogs.shift();
      return json(res, 200, { ok: true, n: calLogs.length });
    } catch (e) { return json(res, 400, { error: 'bad body' }); }
  }
  if (rota === '/callog/latest' && req.method === 'GET') {
    const ultimo = calLogs[calLogs.length - 1];
    if (!ultimo) return json(res, 404, { error: 'none yet' });
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
    return res.end(ultimo.csv);
  }

  // ── health, and the ping the panel uses to keep Render awake ──
  if (rota === '/health' || rota === '/ping') {
    return json(res, 200, { ok: true, players: players.size, viewers: viewers.size });
  }

  // ── static ──
  // '/' is the hub the players open; the panel lives at '/control' so an
  // operator's tablet and a player's headset never land on the same page.
  let ficheiro = rota === '/' ? '/hub.html'
               : rota === '/control' ? '/control.html'
               : rota;
  if (!/\.[a-z]+$/.test(ficheiro)) ficheiro += '.html';
  try {
    const dados = await readFile(join(AQUI, 'public', ficheiro));
    const ext = extname(ficheiro);
    cors(res);
    res.writeHead(200, {
      'Content-Type': TIPOS[ext] || 'application/octet-stream',
      'Cache-Control': cacheDe(ext)
    });
    return res.end(dados);
  } catch (e) {
    return json(res, 404, { error: 'not found' });
  }
});

// ── WebSocket ───────────────────────────────────────────────
const wss = new WebSocketServer({ server: servidor, path: '/ws' });

function difundir(obj, para = viewers) {
  const txt = JSON.stringify(obj);
  for (const c of para) {
    if (c.readyState === 1) { try { c.send(txt); } catch (e) {} }
  }
}

wss.on('connection', (sock, req) => {
  const url = new URL(req.url, 'http://x');
  const papel = url.searchParams.get('role') === 'player' ? 'player' : 'viewer';
  sock.meta = {
    role: papel,
    id: (url.searchParams.get('id') || '').slice(0, 40),
    name: (url.searchParams.get('name') || '').slice(0, 24)
  };

  if (papel === 'player') {
    players.add(sock);
    difundir({ ev: 'player', online: true, id: sock.meta.id, name: sock.meta.name });
  } else {
    viewers.add(sock);
    // Bring the new panel up to date straight away.
    const p = [...players][0];
    sock.send(JSON.stringify({
      ev: 'hello',
      player: p ? { id: p.meta.id, name: p.meta.name } : null,
      scores: scores.slice(0, 10)
    }));
  }

  sock.on('message', (raw) => {
    let d;
    try { d = JSON.parse(raw.toString()); } catch (e) { return; }

    if (papel === 'player') {
      // Live state on its way to the panel. Passed through untouched:
      // the server has no opinion about the game.
      difundir({ ev: 'state', id: sock.meta.id, ...d });
      return;
    }

    // From the panel. Only these get through — the headset must never be
    // asked to run something an operator typed by accident.
    const PERMITIDOS = new Set(['start', 'stop', 'reset', 'name', 'recal', 'duration']);
    if (!PERMITIDOS.has(d.cmd)) return;
    const msg = JSON.stringify({ ev: 'cmd', cmd: d.cmd, value: d.value ?? null });
    for (const p of players) {
      if (p.readyState === 1) { try { p.send(msg); } catch (e) {} }
    }
    // Echo to the other panels so two operators do not fight each other.
    for (const v of viewers) {
      if (v !== sock && v.readyState === 1) {
        try { v.send(JSON.stringify({ ev: 'cmd-sent', cmd: d.cmd, value: d.value ?? null })); } catch (e) {}
      }
    }
  });

  sock.on('close', () => {
    players.delete(sock); viewers.delete(sock);
    if (papel === 'player') {
      difundir({ ev: 'player', online: players.size > 0, id: sock.meta.id });
    }
  });
  sock.on('error', () => {});
});

// Drop connections that have gone quiet without saying goodbye.
setInterval(() => {
  for (const s of [...players, ...viewers]) {
    if (s.readyState !== 1) { players.delete(s); viewers.delete(s); }
  }
}, 30_000);

servidor.listen(PORTA, () => {
  console.log(`relay a correr na porta ${PORTA}`);
  console.log(`painel de controlo: http://localhost:${PORTA}/control`);
});
