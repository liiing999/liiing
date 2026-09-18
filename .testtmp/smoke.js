const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TARGET = 'http://127.0.0.1:8000/index.html';
const port = 9334;
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + port,
  '--user-data-dir=.testtmp\\final-smoke',
  'about:blank'
], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + port + p, res => {
      let d=''; res.on('data', c=>d+=c); res.on('end',()=>resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

class CDP {
  constructor(wsUrl) {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    this.id = 0; this.pending = new Map(); this.events = [];
    this.sock = net.connect(u.port, u.hostname, () => {
      this.sock.write(
        'GET ' + u.pathname + u.search + ' HTTP/1.1\r\n' +
        'Host: ' + u.host + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let handshakeDone = false; let buf = Buffer.alloc(0);
    this.sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        handshakeDone = true;
        buf = buf.slice(idx + 4);
      }
      buf = this._parse(buf);
    });
    this.ready = new Promise(r => { this._onReady = r; });
    const check = setInterval(() => { if (handshakeDone) { clearInterval(check); this._onReady(); } }, 30);
  }
  _parse(buf) {
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80; const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f; let off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) break;
      const payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (op === 1 || op === 0) {
        const text = payload.toString('utf8');
        this._onMessage(text);
      }
    }
    return buf;
  }
  _onMessage(text) {
    let msg; try { msg = JSON.parse(text); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg.result); this.pending.delete(msg.id); }
    else if (msg.method) this.events.push(msg);
  }
  send(method, params = {}) {
    return new Promise(resolve => {
      const mid = ++this.id; this.pending.set(mid, resolve);
      const data = Buffer.from(JSON.stringify({ id: mid, method, params }));
      const header = Buffer.alloc(2 + (data.length < 126 ? 0 : 2));
      header[0] = 0x81;
      if (data.length < 126) { header[1] = 0x80 | data.length; }
      else { header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
      const mask = crypto.randomBytes(4);
      const masked = Buffer.from(data);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      this.sock.write(Buffer.concat([header, mask, masked]));
    });
  }
  drainEvents() { const e = this.events.splice(0); return e; }
}

(async () => {
  let list = null;
  for (let i = 0; i < 40; i++) { try { list = await getJson('/json'); break; } catch { await sleep(500); } }
  if (!list) { console.log('FAIL: chrome did not start'); process.exit(1); }
  const page = list.find(t => t.type === 'page');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;
  const errors = [];
  cdp.sock.on('data', () => {});
  const collect = () => {
    for (const ev of cdp.drainEvents()) {
      if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error')
        errors.push('console.error: ' + ev.params.args.map(a => a.value || a.description || '').join(' '));
      if (ev.method === 'Runtime.exceptionThrown')
        errors.push('exception: ' + (ev.params.exceptionDetails.exception?.description || ev.params.exceptionDetails.text));
      if (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error')
        errors.push('log: ' + ev.params.entry.text);
    }
  };
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: TARGET });
  await sleep(4000); collect();
  const r1 = await cdp.send('Runtime.evaluate', { expression: `document.getElementById('start-btn').click(); 'ok'`, returnByValue: true });
  console.log('start click:', r1.result.value);
  await sleep(7000); collect();
  const state = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
    hud: !document.getElementById('hud').classList.contains('hidden'),
    speed: document.getElementById('speed-text').textContent,
    info: document.getElementById('info-stats').textContent.replace(/\\s+/g,' ').slice(0,200)
  })`, returnByValue: true });
  console.log('state:', state.result.value);
  console.log('--- ERRORS (' + errors.length + ') ---');
  errors.filter(e=>!/pointer lock/i.test(e)).slice(0,25).forEach(e=>console.log(e)); const realErrors = errors.filter(e=>!/pointer lock/i.test(e));
  chrome.kill();
  process.exit(realErrors.length ? 2 : 0);
})();

