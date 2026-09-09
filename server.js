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
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
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
let calLogs = [];       // recordings, newest last
let proximoLog = 0;
const MAX_LOGS = 40;

const players = new Set();     // headsets
const viewers = new Set();     // control panels and spectator screens

const PASTA_LOGS = join(AQUI, 'gravacoes');
async function gravarEmDisco(reg) {
  await mkdir(PASTA_LOGS, { recursive: true });
  const nome = `${reg.id}-${reg.label}-${reg.at}.csv`;
  await writeFile(join(PASTA_LOGS, nome), reg.csv, 'utf8');
}
async function lerDoDisco() {
  try {
    const ficheiros = (await readdir(PASTA_LOGS)).filter(f => f.endsWith('.csv')).sort();
    for (const f of ficheiros.slice(-MAX_LOGS)) {
      const [id, ...resto] = f.replace(/\.csv$/, '').split('-');
      const at = Number(resto.pop()) || Date.now();
      const csv = await readFile(join(PASTA_LOGS, f), 'utf8');
      calLogs.push({ id, at, label: resto.join('-') || 'sessao', csv });
      proximoLog = Math.max(proximoLog, Number(id) || 0);
    }
    if (calLogs.length) console.log(`${calLogs.length} grava\u00e7\u00f5es recuperadas do disco`);
  } catch (e) { /* nenhuma ainda */ }
}

// A plain page listing what has been recorded, so a laptop can collect a
// session the headset made without anyone fighting AirDrop.
function paginaLogs(lista) {
  const escapar = t => String(t).replace(/[<>&"]/g, c =>
    ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;' })[c]);
  const linhas = lista.map(l => `
    <tr>
      <td>${escapar(l.label)}</td>
      <td>${new Date(l.at).toLocaleString('pt-PT')}</td>
      <td class="n">${l.linhas.toLocaleString('pt-PT')}</td>
      <td class="n">${(l.bytes / 1048576).toFixed(2)} MB</td>
      <td><a href="/logs/${l.id}">descarregar</a>
          <button data-id="${l.id}">copiar</button></td>
    </tr>`).join('');
  return `<!DOCTYPE html><html lang="pt"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sess\u00f5es gravadas</title>
<style>
 body{margin:0;padding:34px 22px 70px;background:#070a12;color:#eef3ff;
   font:16px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
 .w{max-width:820px;margin:0 auto}
 h1{font-size:32px;margin:0 0 6px;letter-spacing:-.02em}
 p.sub{color:#7d879e;margin:0 0 26px}
 table{width:100%;border-collapse:collapse;font-size:15px}
 th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.1em;
   color:#4a5468;padding:0 10px 10px 0;font-weight:600}
 td{padding:12px 10px 12px 0;border-top:1px solid #1e2637;vertical-align:middle}
 td.n{font-family:ui-monospace,Menlo,monospace;color:#7d879e}
 a{color:#5b8cff}
 button{margin-left:9px;background:#26324a;color:#eef3ff;border:none;border-radius:8px;
   padding:7px 13px;font:inherit;font-size:14px;cursor:pointer}
 .vazio{color:#7d879e;padding:36px 0}
</style></head><body><div class="w">
<h1>Sess\u00f5es gravadas</h1>
<p class="sub">O que foi gravado dentro dos \u00f3culos. Descarrega aqui, no computador.</p>
${lista.length ? `<table>
 <tr><th>sess\u00e3o</th><th>quando</th><th>linhas</th><th>tamanho</th><th></th></tr>
 ${linhas}</table>` : '<p class="vazio">Ainda nada gravado.</p>'}
</div>
<script>
for (const b of document.querySelectorAll('button[data-id]')) {
  b.onclick = async () => {
    const t = await (await fetch('/logs/' + b.dataset.id)).text();
    try { await navigator.clipboard.writeText(t); b.textContent = 'copiado'; }
    catch (e) { b.textContent = 'falhou'; }
    setTimeout(() => { b.textContent = 'copiar'; }, 1600);
  };
}
</script></body></html>`;
}

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

  // ── session logs ──
  // Getting a file off a Vision Pro is genuinely awkward, so a recording
  // made inside the headset is posted here and collected later from a
  // laptop. A throw session runs to several megabytes, hence the raised
  // ceiling: the default would have rejected it with a bare 400.
  if (rota === '/callog' && req.method === 'POST') {
    try {
      const texto = await corpo(req, 16_000_000);
      const etiqueta = (url.searchParams.get('label') || 'sessao').slice(0, 40)
        .replace(/[^\w\- ]/g, '');
      const id = String(++proximoLog);
      const reg = { id, at: Date.now(), label: etiqueta, csv: texto };
      calLogs.push(reg);
      if (calLogs.length > MAX_LOGS) calLogs.shift();
      // Also to disk. Render's free tier wipes this on every deploy, so it
      // is not permanence — but it does survive the server restarting
      // under you between the recording and the walk to the laptop.
      gravarEmDisco(reg).catch(() => {});
      return json(res, 200, { ok: true, id, bytes: texto.length,
                              url: '/logs/' + id });
    } catch (e) { return json(res, 400, { error: 'bad body' }); }
  }

  // Index, as JSON for scripts and as a page for a person.
  if (rota === '/logs' && req.method === 'GET') {
    const lista = calLogs.map(l => ({
      id: l.id, at: l.at, label: l.label,
      bytes: l.csv.length,
      linhas: l.csv.split('\n').length - 1
    })).reverse();
    if ((req.headers.accept || '').includes('application/json')) {
      return json(res, 200, lista);
    }
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
                         'Cache-Control': 'no-cache' });
    return res.end(paginaLogs(lista));
  }

  if (rota.startsWith('/logs/') && req.method === 'GET') {
    const id = rota.slice(6);
    const l = calLogs.find(x => x.id === id);
    if (!l) return json(res, 404, { error: 'nao existe' });
    cors(res);
    const nome = `${l.label}-${new Date(l.at).toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${nome}"`
    });
    return res.end(l.csv);
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
               : rota === '/watch' ? '/watch.html'
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

// Several headsets can be running at once — a queue of children at an
// event, say. Viewers get told who is playing so they can pick, and every
// state packet carries the id it came from.
function listaJogadores() {
  return [...players].map(p => ({ id: p.meta.id, name: p.meta.name || 'jogador' }));
}
function difundirLista() {
  difundir({ ev: 'players', players: listaJogadores() });
}

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
    difundirLista();
  } else {
    viewers.add(sock);
    // Bring the new panel up to date straight away.
    sock.send(JSON.stringify({
      ev: 'hello',
      players: listaJogadores(),
      player: listaJogadores()[0] || null,   // kept for the older panel
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
    let entregues = 0;
    const conhecidos = [];
    for (const p of players) {
      conhecidos.push(p.meta.id);
      // A command aimed at one player leaves the others alone; without a
      // target it goes to everyone, which is what a single-headset setup
      // wants and what the panel sends by default.
      if (d.target && p.meta.id !== d.target) continue;
      if (p.readyState === 1) {
        try { p.send(msg); entregues++; } catch (e) {}
      }
    }
    // Tell the panel what actually happened. Without this, a command that
    // matched nobody looks exactly like a command that worked, and there is
    // no way to tell a dead socket from a bug in the game.
    try {
      sock.send(JSON.stringify({ ev: 'cmd-ack', cmd: d.cmd,
        target: d.target ?? null, entregues, conhecidos }));
    } catch (e) {}
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
      difundirLista();
    }
  });
  sock.vivo = true;
  sock.on('pong', () => { sock.vivo = true; });
  sock.on('error', () => {});
});

// ── Heartbeat ─────────────────────────────────────────────
// A headset that reloads the page, loses Wi-Fi or goes to sleep leaves a
// socket the operating system has not yet torn down. The server keeps
// listing it as a player, the panel keeps showing its tile, and pressing
// Start on that tile sends the command into a hole. A ping every five
// seconds finds them.
function baterCoracao() {
  for (const s of [...players, ...viewers]) {
    if (s.readyState !== 1) { limpar(s); continue; }
    if (s.vivo === false) { limpar(s); try { s.terminate(); } catch (e) {} continue; }
    s.vivo = false;
    try { s.ping(); } catch (e) { limpar(s); }
  }
}
function limpar(s) {
  const era = players.delete(s);
  viewers.delete(s);
  if (era) difundirLista();
}
setInterval(baterCoracao, 5_000);

await lerDoDisco();

servidor.listen(PORTA, () => {
  console.log(`relay a correr na porta ${PORTA}`);
  console.log(`painel de controlo: http://localhost:${PORTA}/control`);
});
