const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TARGET = 'http://127.0.0.1:8000/index.html';
const PORT = 9600 + Math.floor(Math.random() * 80);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=.testtmp\\sh-' + PORT,
  '--window-size=1280,800', TARGET
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) => new Promise((res, rej) => {
  http.get('http://127.0.0.1:' + PORT + p, (r) => {
    let d = ''; r.on('data', (c) => { d += c; });
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
class WS {
  constructor(u) {
    this.u = new URL(u); this.id = 0; this.pending = new Map(); this.events = [];
    const k = crypto.randomBytes(16).toString('base64');
    this.sock = net.connect(this.u.port, this.u.hostname, () => {
      this.sock.write('GET ' + this.u.pathname + ' HTTP/1.1\r\nHost: ' + this.u.host +
        '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' +
        k + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let done = false; let buf = Buffer.alloc(0);
    this.sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (!done) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; done = true; buf = buf.slice(i + 4); }
      while (buf.length >= 2) {
        const op = buf[0] & 15; let len = buf[1] & 127; let off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const pl = buf.slice(off, off + len); buf = buf.slice(off + len);
        if (op === 1) { let m; try { m = JSON.parse(pl.toString()); } catch { continue; }
          if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m.result); this.pending.delete(m.id); } }
      }
    });
    this.ready = new Promise((r) => { const t = setInterval(() => { if (done) { clearInterval(t); r(); } }, 30); });
  }
  send(method, params = {}) {
    return new Promise((res) => {
      const id = ++this.id; this.pending.set(id, res);
      const data = Buffer.from(JSON.stringify({ id, method, params }));
      let h;
      if (data.length < 126) { h = Buffer.alloc(2); h[0] = 0x81; h[1] = 0x80 | data.length; }
      else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(data.length, 2); }
      const m = crypto.randomBytes(4);
      for (let i = 0; i < data.length; i++) data[i] ^= m[i % 4];
      this.sock.write(Buffer.concat([h, m, data]));
    });
  }
}

(async () => {
  let targets = null;
  for (let i = 0; i < 50; i++) {
    try { const l = await getJson('/json'); if (Array.isArray(l) && l.some((t) => t.type === 'page')) { targets = l; break; } } catch {}
    await sleep(500);
  }
  const ws = new WS(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await ws.ready;
  await ws.send('Runtime.enable');
  await sleep(3500);
  await ws.send('Runtime.evaluate', { expression: "document.getElementById('start-btn').click()" });
  await sleep(5000);
  // ??????????????????????????????
  await ws.send('Runtime.evaluate', {
    expression: `(() => {
      const g = window.__game;
      g.paused = false;
      g.player.resetState(0, -40, 0);
      g.cameraRig.yaw = Math.PI; g.cameraRig.pitch = 0.35; g.cameraRig.distance = 16;
      return 'ok';
    })()`,
    returnByValue: true
  });
  await sleep(3000);
  const shot = await ws.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('.testtmp/play.png', Buffer.from(shot.data, 'base64'));
  console.log('screenshot saved');
  chrome.kill();
  process.exit(0);
})();
