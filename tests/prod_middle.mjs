// 线上回归：中键拖拽画布
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
await cdp.send('Page.navigate', { url: BASE + '?mid=' + Date.now() });
await sleep(4500);

const mouseBtn = (type, x, y, button, buttons) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button, buttons, clickCount: 1, pointerType: 'mouse',
});
async function dragWith(button, buttons, x, y, dx, dy, steps = 8) {
  await mouseBtn('mouseMoved', x, y, 'none', 0);
  await mouseBtn('mousePressed', x, y, button, buttons);
  for (let i = 1; i <= steps; i++) {
    await mouseBtn('mouseMoved', x + (dx / steps) * i, y + (dy / steps) * i, button, buttons);
    await sleep(25);
  }
  await mouseBtn('mouseReleased', x + dx, y + dy, button, 0);
  await sleep(250);
}

const snap = () => cdp.eval(`(() => {
  const n = document.querySelector('.node');
  const r = n.getBoundingClientRect();
  return { view: { x: view.x, y: view.y },
           nodeLeft: parseFloat(n.style.left), nodeTop: parseFloat(n.style.top),
           cx: r.left + r.width / 2, cy: r.top + r.height / 2, sel: selected };
})()`);

const hint = await cdp.eval("document.querySelector('.hint').textContent");
check('线上提示含中键', /中键/.test(hint), hint.slice(0, 30) + '…');

let s0 = await snap();
await dragWith('middle', 4, 720, 580, 100, 65);
let s1 = await snap();
check('线上中键空白处平移', s1.view.x - s0.view.x === 100 && s1.view.y - s0.view.y === 65,
      `view (${s0.view.x},${s0.view.y}) -> (${s1.view.x},${s1.view.y})`);

s0 = await snap();
await dragWith('middle', 4, s0.cx, s0.cy, 70, 45);
s1 = await snap();
check('线上中键按在节点上平移画布',
      s1.view.x - s0.view.x === 70 && s1.view.y - s0.view.y === 45 &&
      s1.nodeLeft === s0.nodeLeft && s1.nodeTop === s0.nodeTop,
      `view (${s0.view.x},${s0.view.y}) -> (${s1.view.x},${s1.view.y})，节点未动=${s1.nodeLeft === s0.nodeLeft}`);

s0 = await snap();
await dragWith('left', 1, s0.cx, s0.cy, 40, 30);
s1 = await snap();
check('线上左键拖节点仍正常',
      s1.nodeLeft - s0.nodeLeft === 40 && s1.nodeTop - s0.nodeTop === 30 && s1.view.x === s0.view.x,
      `节点位移 (${s1.nodeLeft - s0.nodeLeft},${s1.nodeTop - s0.nodeTop})`);

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
