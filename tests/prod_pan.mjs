// 线上回归：平移画布
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
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 620, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: BASE + '?pp=' + Date.now() });
await sleep(4500);

const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse',
});
async function drag(x, y, dx, dy, steps = 8) {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y);
  for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', x + (dx / steps) * i, y + (dy / steps) * i); await sleep(25); }
  await mouse('mouseReleased', x + dx, y + dy);
  await sleep(250);
}

const meta = await cdp.eval(`({
  cursor: getComputedStyle(document.getElementById('canvas')).cursor,
  hint: document.querySelector('.hint').textContent,
  nodes: document.querySelectorAll('.node').length
})`);
check('线上是最新代码', meta.cursor === 'grab' && /平移/.test(meta.hint), `cursor=${meta.cursor}`);

const s0 = await cdp.eval(`(() => {
  const n = document.querySelector('.node'); const r = n.getBoundingClientRect();
  return { view: { x: view.x, y: view.y }, cx: r.left + r.width/2, cy: r.top + r.height/2 };
})()`);

await drag(520, 480, 120, 80);
const s1 = await cdp.eval(`(() => {
  const n = document.querySelector('.node'); const r = n.getBoundingClientRect();
  return { view: { x: view.x, y: view.y }, cx: r.left + r.width/2, cy: r.top + r.height/2 };
})()`);

check('线上拖动平移画布', s1.view.x - s0.view.x === 120 && s1.view.y - s0.view.y === 80,
      `view (${s0.view.x},${s0.view.y}) -> (${s1.view.x},${s1.view.y})`);
check('线上节点屏幕位置跟随', Math.abs(s1.cx - s0.cx - 120) <= 1 && Math.abs(s1.cy - s0.cy - 80) <= 1,
      `屏幕位移 (${Math.round(s1.cx - s0.cx)},${Math.round(s1.cy - s0.cy)})`);

// 平移后建节点落点
const before = await cdp.eval("document.querySelectorAll('.node').length");
for (const cc of [1, 2]) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 650, y: 400, button: 'left', buttons: 1, clickCount: cc, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 650, y: 400, button: 'left', buttons: 0, clickCount: cc, pointerType: 'mouse' });
  await sleep(60);
}
await sleep(350);
const created = await cdp.eval(`(() => {
  const ns = [...document.querySelectorAll('.node')];
  const r = ns[ns.length-1].getBoundingClientRect();
  return { count: ns.length, cx: r.left + r.width/2, cy: r.top + r.height/2 };
})()`);
check('线上平移后落点正确', created.count === before + 1 && Math.abs(created.cx - 650) <= 2 && Math.abs(created.cy - 400) <= 2,
      `鼠标(650,400) 节点中心(${Math.round(created.cx)},${Math.round(created.cy)})`);

// Home
await drag(520, 480, -600, -400);
await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
await sleep(300);
const home = await cdp.eval(`(() => {
  const r = document.getElementById('canvas').getBoundingClientRect();
  const inside = [...document.querySelectorAll('.node')].every(b => {
    const x = b.getBoundingClientRect();
    return x.left >= r.left && x.right <= r.right && x.top >= r.top && x.bottom <= r.bottom;
  });
  return { inside, view: { x: view.x, y: view.y } };
})()`);
check('线上 Home 归位', home.inside === true, `view=(${home.view.x},${home.view.y}) 全部在视野内=${home.inside}`);

await fetch(BASE + 'api/diagrams/' + encodeURIComponent('线上平移自检'), {
  method: 'PUT', headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ nodes: [{ id: 'n1', x: 0, y: 0, w: 140, h: 56, text: '收尾' }], edges: [], view: { x: 50, y: 60 } }),
});
await cdp.send('Page.navigate', { url: BASE + '?rr=' + Date.now() });
await sleep(4000);
const restored = await cdp.eval(`({ view: { x: view.x, y: view.y }, name: document.getElementById('name').value })`);
check('线上 view 随存档还原', restored.view.x === 50 && restored.view.y === 60, `view=${JSON.stringify(restored.view)}`);
await fetch(BASE + 'api/diagrams/' + encodeURIComponent('线上平移自检'), { method: 'DELETE', headers: { Authorization: auth } });

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
