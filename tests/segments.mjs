// 验证连线每一段都能拖动改位置
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:8123';

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
      setTimeout(() => { if (this.w.has(id)) { this.w.delete(id); rej(new Error('timeout ' + method)); } }, 10000);
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
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: BASE + '/?seg=' + Date.now() });
await sleep(2500);

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

const setup = (nodes, edges) => cdp.eval(`(() => {
  state.nodes = ${JSON.stringify(nodes)};
  state.edges = ${JSON.stringify(edges)};
  selection.clear(); selectedEdge = null; view = { x: 0, y: 0 };
  setTool('select'); render(); applyView();
})()`);

// 取第 n 段的中点屏幕坐标
const segMid = (n) => cdp.eval(`(() => {
  const el2 = [...document.querySelectorAll('#hitLayer path')][${n}];
  const p = el2.getAttribute('d').match(/M([-\\d.]+),([-\\d.]+) L([-\\d.]+),([-\\d.]+)/);
  const r = document.getElementById('canvas').getBoundingClientRect();
  const mx = (+p[1] + +p[3]) / 2 + view.x + r.left;
  const my = (+p[2] + +p[4]) / 2 + view.y + r.top;
  return { x: mx, y: my, axis: el2.dataset.axis, seg: el2.dataset.seg, total: document.querySelectorAll('#hitLayer path').length };
})()`);

const geo = () => cdp.eval(`(() => {
  const g = edgeGeometry(state.edges[0]);
  return { pts: g.points, manual: g.manual,
           ortho: g.points.slice(1).every((p, i) => p.x === g.points[i].x || p.y === g.points[i].y),
           bends: state.edges[0].bends || null };
})()`);

// ===== 1. 每段都有独立的点击区，且带方向 =====
await setup([
  { id: 'A', x: 100, y: 100, w: 120, h: 60, text: 'A', kind: 'box' },
  { id: 'B', x: 600, y: 400, w: 120, h: 60, text: 'B', kind: 'box' },
], [{ from: 'A', to: 'B', fromSide: 'right', toSide: 'left' }]);
await sleep(300);

const segs = await cdp.eval(`(() => {
  const all = [...document.querySelectorAll('#hitLayer path')];
  return { n: all.length, axes: all.map(p => p.dataset.axis),
           idx: all.map(p => p.dataset.seg),
           edges: new Set(all.map(p => p.dataset.edge)).size };
})()`);
check('连线被拆成可独立操作的段', segs.n >= 2 && segs.edges === 1,
      `段数=${segs.n} 方向=${segs.axes.join(',')} 索引=${segs.idx.join(',')}`);

const before = await geo();
check('初始是自动绕行（无 bends）', before.manual === false, `manual=${before.manual} 折点数=${before.pts.length}`);

// ===== 2. 拖中间那段（竖段，左右拖）=====
const list0 = await cdp.eval(`[...document.querySelectorAll('#hitLayer path')].map(p => p.dataset.axis)`);
let vIdx = list0.findIndex(a => a === 'v');
if (vIdx < 0) vIdx = 0;
let m = await cdp.eval(`(() => {
  const el2 = [...document.querySelectorAll('#hitLayer path')][${vIdx}];
  const p = el2.getAttribute('d').match(/M([-\\d.]+),([-\\d.]+) L([-\\d.]+),([-\\d.]+)/);
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { x: (+p[1] + +p[3]) / 2 + view.x + r.left, y: (+p[2] + +p[4]) / 2 + view.y + r.top };
})()`);
await drag(m.x, m.y, m.x + 70, m.y);

const afterV = await geo();
check('拖竖段可以左右挪', afterV.manual === true && afterV.ortho === true,
      `manual=${afterV.manual} 直角=${afterV.ortho} bends=${JSON.stringify(afterV.bends)}`);
const shifted = afterV.pts.some(p => before.pts.every(q => q.x !== p.x));
check('位置确实变了', shifted === true, `折点数 ${before.pts.length} -> ${afterV.pts.length}`);

// ===== 3. 拖横段（上下拖）=====
const axes2 = await cdp.eval(`[...document.querySelectorAll('#hitLayer path')].map(p => p.dataset.axis)`);
const hIdx = axes2.findIndex(a => a === 'h');
m = await cdp.eval(`(() => {
  const el2 = [...document.querySelectorAll('#hitLayer path')][${hIdx}];
  const p = el2.getAttribute('d').match(/M([-\\d.]+),([-\\d.]+) L([-\\d.]+),([-\\d.]+)/);
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { x: (+p[1] + +p[3]) / 2 + view.x + r.left, y: (+p[2] + +p[4]) / 2 + view.y + r.top };
})()`);
const beforeH = await geo();
await drag(m.x, m.y, m.x, m.y + 40);
const afterH = await geo();
const movedY = afterH.pts.some((p, i) => beforeH.pts[i] && p.y !== beforeH.pts[i].y);
check('拖横段可以上下挪', afterH.ortho === true && movedY === true,
      `直角=${afterH.ortho} 有纵向变化=${movedY}`);

// ===== 4. 拖动后始终不穿过节点 =====
// 先造一个障碍，再拖段绕过它
await setup([
  { id: 'P', x: 100, y: 300, w: 110, h: 60, text: 'P', kind: 'box' },
  { id: 'Q', x: 700, y: 300, w: 110, h: 60, text: 'Q', kind: 'box' },
  { id: 'OBS', x: 380, y: 280, w: 140, h: 100, text: '障碍', kind: 'box' },
], [{ from: 'P', to: 'Q', fromSide: 'right', toSide: 'left' }]);
await sleep(300);
const autoOk = await cdp.eval(`(() => {
  const g = edgeGeometry(state.edges[0]);
  const o = state.nodes.find(n => n.id === 'OBS');
  const cross = g.points.slice(1).some((p, i) => {
    const a = g.points[i], b = p, eps = 1.2;
    if (a.y === b.y) return a.y > o.y + eps && a.y < o.y + o.h - eps &&
      Math.max(a.x, b.x) > o.x + eps && Math.min(a.x, b.x) < o.x + o.w - eps;
    if (a.x === b.x) return a.x > o.x + eps && a.x < o.x + o.w - eps &&
      Math.max(a.y, b.y) > o.y + eps && Math.min(a.y, b.y) < o.y + o.h - eps;
    return true;
  });
  return { cross, n: g.points.length };
})()`);
check('自动绕行先正确绕开障碍', autoOk.cross === false, `折点数=${autoOk.n} 穿过=${autoOk.cross}`);

// 拖一段，检查仍是直角（不一定还绕开，但形状不能乱）
const axes3 = await cdp.eval(`[...document.querySelectorAll('#hitLayer path')].map(p => p.dataset.axis)`);
const hi = axes3.findIndex(a => a === 'h');
m = await cdp.eval(`(() => {
  const el2 = [...document.querySelectorAll('#hitLayer path')][${hi}];
  const p = el2.getAttribute('d').match(/M([-\\d.]+),([-\\d.]+) L([-\\d.]+),([-\\d.]+)/);
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { x: (+p[1] + +p[3]) / 2 + view.x + r.left, y: (+p[2] + +p[4]) / 2 + view.y + r.top };
})()`);
await drag(m.x, m.y, m.x, m.y - 60);
const afterDrag = await geo();
check('手动拖动后仍是全直角', afterDrag.ortho === true,
      `折点数=${afterDrag.pts.length} bends=${JSON.stringify(afterDrag.bends)}`);

// ===== 5. 双击某段恢复自动绕行 =====
const anySeg = await cdp.eval(`(() => {
  const el2 = document.querySelector('#hitLayer path');
  const p = el2.getAttribute('d').match(/M([-\\d.]+),([-\\d.]+) L([-\\d.]+),([-\\d.]+)/);
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { x: (+p[1] + +p[3]) / 2 + view.x + r.left, y: (+p[2] + +p[4]) / 2 + view.y + r.top };
})()`);
for (const cc of [1, 2]) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: anySeg.x, y: anySeg.y, button: 'left', buttons: 1, clickCount: cc, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: anySeg.x, y: anySeg.y, button: 'left', buttons: 0, clickCount: cc, pointerType: 'mouse' });
  await sleep(70);
}
await sleep(400);
const reset = await geo();
check('双击线段恢复自动绕行', reset.manual === false && reset.bends === null,
      `manual=${reset.manual} bends=${JSON.stringify(reset.bends)}`);

// ===== 6. 点一下线段只是选中，不改形状 =====
await setup([
  { id: 'S', x: 100, y: 200, w: 110, h: 60, text: 'S', kind: 'box' },
  { id: 'E', x: 600, y: 200, w: 110, h: 60, text: 'E', kind: 'box' },
], [{ from: 'S', to: 'E', fromSide: 'right', toSide: 'left' }]);
await sleep(250);
const g0 = await geo();
const c0 = await cdp.eval(`(() => {
  const el2 = document.querySelector('#hitLayer path');
  const p = el2.getAttribute('d').match(/M([-\\d.]+),([-\\d.]+) L([-\\d.]+),([-\\d.]+)/);
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { x: (+p[1] + +p[3]) / 2 + view.x + r.left, y: (+p[2] + +p[4]) / 2 + view.y + r.top };
})()`);
await mouse('mouseMoved', c0.x, c0.y);
await mouse('mousePressed', c0.x, c0.y);
await mouse('mouseReleased', c0.x, c0.y);
await sleep(250);
const clicked = await cdp.eval(`({ edge: selectedEdge, bends: state.edges[0].bends || null })`);
const g1 = await geo();
check('点线段只选中不改形状',
      !!clicked.edge && clicked.bends === null &&
      JSON.stringify(g1.pts) === JSON.stringify(g0.pts),
      `选中=${clicked.edge} bends=${JSON.stringify(clicked.bends)}`);

// ===== 7. 直线段也能拖出 S 形 =====
await setup([
  { id: 'X', x: 100, y: 200, w: 110, h: 60, text: 'X', kind: 'box' },
  { id: 'Y', x: 600, y: 200, w: 110, h: 60, text: 'Y', kind: 'box' },
], [{ from: 'X', to: 'Y', fromSide: 'right', toSide: 'left' }]);
await sleep(250);
const straightBefore = await geo();
check('同高度两点是直线', straightBefore.pts.length === 2, `折点数=${straightBefore.pts.length}`);
const sx = await cdp.eval(`(() => {
  const el2 = document.querySelector('#hitLayer path');
  const p = el2.getAttribute('d').match(/M([-\\d.]+),([-\\d.]+) L([-\\d.]+),([-\\d.]+)/);
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { x: (+p[1] + +p[3]) / 2 + view.x + r.left, y: (+p[2] + +p[4]) / 2 + view.y + r.top };
})()`);
await drag(sx.x, sx.y, sx.x, sx.y + 80);
const sShape = await geo();
check('直线也能拖成 S 形（直角）',
      sShape.manual === true && sShape.ortho === true && sShape.pts.length >= 4,
      `折点数=${sShape.pts.length} 直角=${sShape.ortho} bends=${JSON.stringify(sShape.bends)}`);

// ===== 8. 拖动节点时折点跟着走 =====
const nodesBefore = await cdp.eval(`state.nodes.map(n => ({ id: n.id, x: n.x, y: n.y }))`);
const bendsBefore = await cdp.eval(`(state.edges[0].bends || []).map(p => ({ x: p.x, y: p.y }))`);
const nBox = await cdp.eval(`(() => {
  const r = document.querySelector('.node[data-id="X"]').getBoundingClientRect();
  return { x: r.left + 20, y: r.top + 20 };
})()`);
await drag(nBox.x, nBox.y, nBox.x + 50, nBox.y + 30);
const stateAfter = await cdp.eval(`(() => ({
  nodes: state.nodes.map(n => ({ id: n.id, x: n.x, y: n.y })),
  bends: (state.edges[0].bends || []).map(p => ({ x: p.x, y: p.y })),
  ortho: (() => { const g = edgeGeometry(state.edges[0]);
    return g.points.slice(1).every((p, i) => p.x === g.points[i].x || p.y === g.points[i].y); })(),
}))()`);
const dxNode = stateAfter.nodes.find(n => n.id === 'X').x - nodesBefore.find(n => n.id === 'X').x;
const dxBend = stateAfter.bends[0] ? stateAfter.bends[0].x - bendsBefore[0].x : 0;
check('拖节点时折点一起平移',
      dxNode === 50 && dxBend === 50 && stateAfter.ortho === true,
      `节点 +${dxNode} 折点 +${dxBend} 直角=${stateAfter.ortho}`);

// ===== 9. 存档往返记住折点 =====
await cdp.eval(`(() => {
  document.getElementById('name').value = '折点测试';
  document.getElementById('save').click();
})()`);
await sleep(1000);
const doc = await fetch(BASE + '/api/diagrams/' + encodeURIComponent('折点测试')).then(r => r.json());
const savedBends = doc.edges[0].bends;
check('存档记住折点', Array.isArray(savedBends) && savedBends.length >= 2,
      JSON.stringify(savedBends));

await cdp.send('Page.navigate', { url: BASE + '/?re=' + Date.now() });
await sleep(2200);
const restored = await cdp.eval(`(() => {
  const g = edgeGeometry(state.edges[0]);
  return { manual: g.manual, n: g.points.length, ortho: g.pts === undefined
    ? g.points.slice(1).every((p, i) => p.x === g.points[i].x || p.y === g.points[i].y) : true };
})()`);
check('重开还原手动折点',
      restored.manual === true && restored.n >= 4 && restored.ortho === true,
      `manual=${restored.manual} 折点数=${restored.n} 直角=${restored.ortho}`);

await fetch(BASE + '/api/diagrams/' + encodeURIComponent('折点测试'), { method: 'DELETE' });

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
