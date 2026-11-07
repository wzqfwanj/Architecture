// 线上验证：连线每一段可拖动
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
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: BASE + '?seg=' + Date.now() });
await sleep(4500);

const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse',
});
async function drag(x1, y1, x2, y2, steps = 8) {
  await mouse('mouseMoved', x1, y1);
  await mouse('mousePressed', x1, y1);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', x1 + ((x2 - x1) / steps) * i, y1 + ((y2 - y1) / steps) * i);
    await sleep(25);
  }
  await mouse('mouseReleased', x2, y2);
  await sleep(300);
}
const segList = () => cdp.eval(`[...document.querySelectorAll('#hitLayer path')].map(p => ({ axis: p.dataset.axis, seg: p.dataset.seg }))`);
const geo = () => cdp.eval(`(() => {
  const g = edgeGeometry(state.edges[0]);
  return { pts: g.points, manual: g.manual,
           ortho: g.points.slice(1).every((p, i) => p.x === g.points[i].x || p.y === g.points[i].y),
           bends: state.edges[0].bends || null };
})()`);
const mid = (idx) => cdp.eval(`(() => {
  const el2 = [...document.querySelectorAll('#hitLayer path')][${idx}];
  const p = el2.getAttribute('d').match(/M([-\\d.]+),([-\\d.]+) L([-\\d.]+),([-\\d.]+)/);
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { x: (+p[1] + +p[3]) / 2 + view.x + r.left, y: (+p[2] + +p[4]) / 2 + view.y + r.top };
})()`);

const setup = () => cdp.eval(`(() => {
  state.nodes = [
    { id: 'A', x: 100, y: 100, w: 120, h: 60, text: 'A', kind: 'box' },
    { id: 'B', x: 600, y: 400, w: 120, h: 60, text: 'B', kind: 'box' },
    { id: 'OBS', x: 340, y: 220, w: 140, h: 100, text: '障碍', kind: 'box' },
  ];
  state.edges = [{ from: 'A', to: 'B', fromSide: 'right', toSide: 'left' }];
  selection.clear(); selectedEdge = null; view = { x: 0, y: 0 };
  setTool('select'); render(); applyView();
})()`);
await setup();
await sleep(350);

// 1. 每段独立可拖
const sl = await segList();
check('线上每段都是独立点击区', sl.length >= 3 && sl.every(s => s.axis === 'h' || s.axis === 'v'),
      `段数=${sl.length} 方向=${sl.map(s => s.axis).join(',')}`);

// 2. 拖竖段
const vIdx = sl.findIndex(s => s.axis === 'v');
const before = await geo();
let m = await mid(vIdx >= 0 ? vIdx : 0);
await drag(m.x, m.y, m.x + 70, m.y);
const afterV = await geo();
check('线上拖竖段可左右挪',
      afterV.manual === true && afterV.ortho === true &&
      JSON.stringify(afterV.pts) !== JSON.stringify(before.pts),
      `manual=${afterV.manual} 直角=${afterV.ortho} bends=${JSON.stringify(afterV.bends)}`);

// 3. 拖横段
const sl2 = await segList();
const hIdx = sl2.findIndex(s => s.axis === 'h');
m = await mid(hIdx);
const beforeH = await geo();
await drag(m.x, m.y, m.x, m.y + 45);
const afterH = await geo();
const yChanged = afterH.pts.some((p, i) => beforeH.pts[i] && p.y !== beforeH.pts[i].y);
check('线上拖横段可上下挪', afterH.ortho === true && yChanged === true,
      `直角=${afterH.ortho} 有纵向变化=${yChanged}`);

// 4. 手动调整后仍保持直角
check('线上手动折线保持全直角', afterH.ortho === true, `折点数=${afterH.pts.length}`);

// 5. 双击线段恢复自动绕行（有 bends 时）
const sl3 = await segList();
m = await mid(0);
for (const cc of [1, 2]) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: m.x, y: m.y, button: 'left', buttons: 1, clickCount: cc, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: m.x, y: m.y, button: 'left', buttons: 0, clickCount: cc, pointerType: 'mouse' });
  await sleep(70);
}
await sleep(400);
const reset = await geo();
check('线上双击线段恢复自动绕行',
      reset.manual === false && reset.bends === null && reset.ortho === true,
      `manual=${reset.manual} bends=${JSON.stringify(reset.bends)} 段数=${sl3.length}`);

// 6. 存档往返记住折点
await setup();
await sleep(300);
m = await mid(1);
await drag(m.x, m.y, m.x + 60, m.y);
const manualGeo = await geo();
await cdp.eval(`(() => {
  document.getElementById('name').value = '线折点自检';
  document.getElementById('save').click();
})()`);
await sleep(1200);
const doc = await fetch(BASE + 'api/diagrams/' + encodeURIComponent('线折点自检'),
  { headers: { Authorization: auth } }).then(r => r.json());
check('线上存档写入 bends', Array.isArray(doc.edges[0].bends) && doc.edges[0].bends.length > 0,
      JSON.stringify(doc.edges[0].bends));

await cdp.send('Page.navigate', { url: BASE + '?re=' + Date.now() });
await sleep(4200);
// 页面启动会加载列表里的第一张图，不一定就是刚存的那张，这里显式加载
const loaded = await cdp.eval(`(async () => {
  await load('线折点自检');
  return { name: state.name, nodes: state.nodes.length, edges: state.edges.length,
           bends: state.edges[0]?.bends || null };
})()`);
check('线上重开能载入该存档',
      loaded.name === '线折点自检' && loaded.edges === 1 && Array.isArray(loaded.bends) && loaded.bends.length > 0,
      `存档=${loaded.name} 连线=${loaded.edges} bends=${JSON.stringify(loaded.bends)}`);
await sleep(300);
const back = await geo();
check('线上重开还原手动折线',
      back.manual === true && back.ortho === true &&
      JSON.stringify(back.pts) === JSON.stringify(manualGeo.pts),
      `折点数 ${manualGeo.pts.length} -> ${back.pts.length}`);

await fetch(BASE + 'api/diagrams/' + encodeURIComponent('线折点自检'), { method: 'DELETE', headers: { Authorization: auth } });

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
