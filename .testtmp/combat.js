const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TARGET = 'http://127.0.0.1:8000/index.html';
const PORT = 9500 + Math.floor(Math.random() * 80);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=.testtmp\\cc-' + PORT,
  TARGET
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + PORT + path, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

class WS {
  constructor(url) {
    const u = new URL(url);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    const key = crypto.randomBytes(16).toString('base64');
    this.sock = net.connect(u.port, u.hostname, () => {
      this.sock.write(
        'GET ' + u.pathname + u.search + ' HTTP/1.1\r\nHost: ' + u.host +
        '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' +
        key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    let done = false;
    let buffer = Buffer.alloc(0);
    this.sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!done) {
        const idx = buffer.indexOf('\r\n\r\n');
        if (idx < 0) return;
        done = true;
        buffer = buffer.slice(idx + 4);
      }
      while (buffer.length >= 2) {
        const op = buffer[0] & 15;
        let len = buffer[1] & 127;
        let off = 2;
        if (len === 126) { len = buffer.readUInt16BE(2); off = 4; }
        if (buffer.length < off + len) break;
        const payload = buffer.slice(off, off + len);
        buffer = buffer.slice(off + len);
        if (op === 1) {
          let msg;
          try { msg = JSON.parse(payload.toString()); } catch { continue; }
          if (msg.id && this.pending.has(msg.id)) {
            this.pending.get(msg.id)(msg.result);
            this.pending.delete(msg.id);
          } else if (msg.method) this.events.push(msg);
        }
      }
    });
    this.ready = new Promise((resolve) => {
      const t = setInterval(() => { if (done) { clearInterval(t); resolve(); } }, 30);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      const data = Buffer.from(JSON.stringify({ id, method, params }));
      let header;
      if (data.length < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = 0x80 | data.length;
      } else {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(data.length, 2);
      }
      const mask = crypto.randomBytes(4);
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      this.sock.write(Buffer.concat([header, mask, data]));
    });
  }
}

(async () => {
  let targets = null;
  for (let i = 0; i < 50; i++) {
    try {
      const list = await getJson('/json');
      if (Array.isArray(list) && list.some((t) => t.type === 'page')) { targets = list; break; }
    } catch { /* wait */ }
    await sleep(500);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.ready;
  await ws.send('Runtime.enable');
  await ws.send('Page.enable');
  await sleep(3500);
  await ws.send('Runtime.evaluate', {
    expression: "document.getElementById('start-btn').click()"
  });
  await sleep(3500);

  const expression = [
    '(async () => {',
    '  const g = window.__game;',
    '  g.paused = false;',
    '  const out = {};',
    '  // ????????????????????????????????????/???',
    '  const enemy = g.enemies.enemies.find(e => e.ship.alive);',
    '  const beforeHp = enemy.ship.hp;',
    '  enemy.ship.position.set(g.player.position.x + 20, 0, g.player.position.z);',
    '  enemy.ship.heading = 0;',
    '  g.player.position.set(0,0,-120); g.player.heading = 0;',
    '  enemy.ship.position.set(20,0,-120);',
    '  // ????????5 ??14 ?????,
    '  let sunk = false;',
    '  for (let i=0;i<6;i++){ if(enemy.ship.damage(14,"cannonball")){ sunk=true; break; } }',
    '  out.damageWorks = (beforeHp - enemy.ship.hp) > 0;',
    '  out.sunkFlag = sunk;',
    '  out.hpAfter = enemy.ship.hp;',
    '  // ????????,
    '  for (let i=0;i<220;i++){ g.enemies.update(1/60, g.player, g.ocean, g.world, {spyglass:false}); }',
    '  out.enemyDeadAfterAnim = !enemy.ship.alive;',
    '  // AI ?????????????????????????????????? patrol',
    '  const other = g.enemies.enemies.find(e => e.ship.alive && e !== enemy);',
    '  if (other) {',
    '    other.ship.position.set(0,0,-60);',
    '    g.player.position.set(0,0,-120);',
    '    out.aiBefore = other.state;',
    '    for (let i=0;i<240;i++) g.enemies.update(1/60, g.player, g.ocean, g.world, {spyglass:false});',
    '    out.aiAfter = other.state;',
    '  }',
    '  // ???????,
    '  g.save();',
    '  const raw = JSON.parse(localStorage.getItem("endless-archipelago-save-v1"));',
    '  out.saveHasSeed = typeof raw.seed === "number";',
    '  out.savePlayerX = Number(raw.player.x.toFixed(1));',
    '  out.saveSunkCount = raw.sunkEnemies.length;',
    '  // ??????????????60 ????????????',
    '  g.player.resetState(0,-120,g.windAngle+Math.PI); g.player.sailAmount=1;',
    '  const counts = new Set();',
    '  for (let i=0;i<3600;i++){ g._fixedUpdate(1/60); if(i%300===0) counts.add(g.world.chunkCount); }',
    '  out.chunkCounts = Array.from(counts);',
    '  out.finalPos = [Math.round(g.player.position.x), Math.round(g.player.position.z)];',
    '  return JSON.stringify(out);',
    '})()'
  ].join('\n');

  const result = await ws.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true
  });
  console.log(result.result.value || JSON.stringify(result.result));
  chrome.kill();
  process.exit(0);
})();

