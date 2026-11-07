// 线上回归：四向连线
import { readFileSync } from 'node:fs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'https://wkeeli.cn/arch/';
const pwd = readFileSync('arch_password.txt', 'utf8').trim();
const auth = 'Basic ' + Buffer.from('admin:' + pwd, 'utf8').toString('base64');

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.w = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && c.w.has(m.id)) {
        const { res, rej } = c.w.get(m.id); c.w.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.w.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.w.has(id)) { this.w.delete(id); rej(new Error('timeout ' + method)); } }, 15000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.result?.description || ''));
    return r.result.value;
  }
}

const results = [];
const check = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${d}`); };

const list = await fetch('http://127.0.0.1:9222/json/list').then(r => r.json());
const page = list.find(t => t.type === 'page');
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Network.enable');
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
await cdp.send('Network.setExtraHTTPHeaders', { headers: { Authorization: auth } });
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: BASE + '?ports=' + Date.now() });
await sleep(4500);

const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse',
});

const ports = await cdp.eval(`(() => {
  const n = document.querySelector('.node');
  return { count: n.querySelectorAll('.port').length,
           sides: [...n.querySelectorAll('.port')].map(p => p.dataset.side).sort() };
})()`);
check('线上四向连接点', ports.count === 4, `count=${ports.count} sides=${ports.sides.join(',')}`);

const setup = async () => {
  await cdp.eval(`(() => {
    state.nodes = [
      { id: 'p1', x: 200, y: 150, w: 140, h: 56, text: 'A' },
      { id: 'p2', x: 500, y: 350, w: 140, h: 56, text: 'B' },
    ];
    state.edges = []; selected = null; view = { x: 0, y: 0 };
    render(); applyView();
  })()`);
  await sleep(150);
};
const portScreen = (id, side) => cdp.eval(`(() => {
  const p = document.querySelector('.node[data-id="${id}"] .port[data-side="${side}"]');
  const r = p.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
const dragTo = async (from, to) => {
  await mouse('mouseMoved', from.x, from.y); await sleep(60);
  await mouse('mousePressed', from.x, from.y);
  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', from.x + ((to.x - from.x) / 6) * i, from.y + ((to.y - from.y) / 6) * i);
    await sleep(25);
  }
  await mouse('mouseReleased', to.x, to.y);
  await sleep(250);
};

for (const [fs, ts] of [['top', 'bottom'], ['right', 'left'], ['bottom', 'top'], ['left', 'right']]) {
  await setup();
  await dragTo(await portScreen('p1', fs), await portScreen('p2', ts));
  const e = await cdp.eval('state.edges[0] || null');
  check(`线上 ${fs} -> ${ts}`, e && e.fromSide === fs && e.toSide === ts,
        e ? `${e.fromSide}->${e.toSide}` : '无连线');
}

// 存档往返
await cdp.eval(`(() => { document.getElementById('name').value = '线上四向'; document.getElementById('save').click(); })()`);
await sleep(1200);
const doc = await fetch(BASE + 'api/diagrams/' + encodeURIComponent('线上四向'), { headers: { Authorization: auth } }).then(r => r.json());
check('线上存档带方向', doc.edges?.[0]?.fromSide === 'left' && doc.edges?.[0]?.toSide === 'right',
      JSON.stringify(doc.edges));

await cdp.send('Page.navigate', { url: BASE + '?re=' + Date.now() });
await sleep(4200);
const back = await cdp.eval(`({
  edges: state.edges.map(e => e.fromSide + '>' + e.toSide),
  path: document.querySelector('#wireLayer path:not(.hit)')?.getAttribute('d') || null,
})`);
check('线上重开还原方向', back.edges.length === 1 && !!back.path, `${JSON.stringify(back.edges)} path=${back.path}`);

await fetch(BASE + 'api/diagrams/' + encodeURIComponent('线上四向'), { method: 'DELETE', headers: { Authorization: auth } });

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
