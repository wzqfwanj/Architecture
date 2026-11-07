// 线上功能回归：直角连线、框选多选、容器、中键平移
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
const check = (n, ok, d) => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${d}`); };

const list = await fetch('http://127.0.0.1:9222/json/list').then(r => r.json());
const page = list.find(t => t.type === 'page');
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Network.enable');
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
await cdp.send('Network.setExtraHTTPHeaders', { headers: { Authorization: auth } });
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: BASE + '?prod=' + Date.now() });
await sleep(4500);

const mouse = (type, x, y, mods = 0) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
  clickCount: 1, pointerType: 'mouse', modifiers: mods,
});
async function drag(x1, y1, x2, y2, mods = 0, steps = 8) {
  await mouse('mouseMoved', x1, y1, mods);
  await mouse('mousePressed', x1, y1, mods);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', x1 + ((x2 - x1) / steps) * i, y1 + ((y2 - y1) / steps) * i, mods);
    await sleep(25);
  }
  await mouse('mouseReleased', x2, y2, mods);
  await sleep(300);
}
const mouseBtn = (type, x, y, button, buttons) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button, buttons, clickCount: 1, pointerType: 'mouse',
});

// ---- 0. 代码版本 ----
const meta = await cdp.eval(`(() => ({
  hasOrtho: typeof orthoPoints === 'function',
  hasMarquee: !!document.getElementById('marquee'),
  tools: [...document.querySelectorAll('.tool')].map(b => b.dataset.tool),
  hasResize: !!document.querySelector('.resize'),
  hint: document.querySelector('.hint').textContent,
}))()`);
check('线上是新版前端', meta.hasOrtho && meta.hasMarquee && meta.tools.length === 3,
      `tools=${meta.tools.join(',')}`);

const setup = () => cdp.eval(`(() => {
  state.nodes = [
    { id: 'b1', x: 60,  y: 60,  w: 120, h: 50, text: 'A', kind: 'box' },
    { id: 'b2', x: 240, y: 60,  w: 120, h: 50, text: 'B', kind: 'box' },
    { id: 'b3', x: 520, y: 420, w: 120, h: 50, text: 'C', kind: 'box' },
  ];
  state.edges = [];
  selection.clear(); selectedEdge = null;
  view = { x: 0, y: 0 };
  setTool('select'); render(); applyView();
})()`);

// ---- 1. 直角连线 ----
await setup();
await sleep(200);
const rect = await cdp.eval(`(() => {
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { left: r.left, top: r.top };
})()`);
// 从 b1 右边连到 b3 左边（斜向，必须是折线）
const pts = await cdp.eval(`(() => {
  const p1 = document.querySelector('.node[data-id="b1"] .port[data-side="right"]').getBoundingClientRect();
  const p2 = document.querySelector('.node[data-id="b3"] .port[data-side="left"]').getBoundingClientRect();
  return { x1: p1.left + p1.width/2, y1: p1.top + p1.height/2,
           x2: p2.left + p2.width/2, y2: p2.top + p2.height/2 };
})()`);
await drag(pts.x1, pts.y1, pts.x2, pts.y2);
const wire = await cdp.eval(`(() => {
  const d = document.querySelector('#wireLayer path:not(.hit)')?.getAttribute('d');
  if (!d) return null;
  const geo = edgeGeometry(state.edges[0]);
  const ortho = geo.points.slice(1).every((p, i) => p.x === geo.points[i].x || p.y === geo.points[i].y);
  return { d, pts: geo.points, ortho, sides: [geo.s1, geo.s2] };
})()`);
check('线上连线是直角折线', wire && wire.ortho && wire.pts.length >= 3,
      wire ? `折点=${JSON.stringify(wire.pts)}` : '没画出来');

// ---- 2. 框选多选 + 整体拖动 ----
await setup();
await sleep(200);
await drag(rect.left + 40, rect.top + 30, rect.left + 420, rect.top + 140);
const sel = await cdp.eval(`[...selection]`);
check('线上框选多选', sel.length === 2 && sel.includes('b1') && sel.includes('b2'), JSON.stringify(sel));

const beforeMove = await cdp.eval(`state.nodes.map(n => ({ id: n.id, x: n.x, y: n.y }))`);
await drag(rect.left + 80, rect.top + 80, rect.left + 160, rect.top + 130);
const afterMove = await cdp.eval(`state.nodes.map(n => ({ id: n.id, x: n.x, y: n.y }))`);
const d1 = afterMove.find(n => n.id === 'b1').x - beforeMove.find(n => n.id === 'b1').x;
const d2 = afterMove.find(n => n.id === 'b2').x - beforeMove.find(n => n.id === 'b2').x;
const d3 = afterMove.find(n => n.id === 'b3').x - beforeMove.find(n => n.id === 'b3').x;
check('线上多选整体拖动', d1 === 80 && d2 === 80 && d3 === 0, `A+${d1} B+${d2} C+${d3}`);

// ---- 3. 中键平移仍是平移 ----
const v0 = await cdp.eval('({ x: view.x, y: view.y })');
await mouseBtn('mouseMoved', rect.left + 800, rect.top + 650, 'none', 0);
await mouseBtn('mousePressed', rect.left + 800, rect.top + 650, 'middle', 4);
for (let i = 1; i <= 6; i++) {
  await mouseBtn('mouseMoved', rect.left + 800 + 10 * i, rect.top + 650 + 8 * i, 'middle', 4);
  await sleep(25);
}
await mouseBtn('mouseReleased', rect.left + 860, rect.top + 698, 'middle', 0);
await sleep(250);
const v1 = await cdp.eval('({ x: view.x, y: view.y })');
check('线上中键平移画布', v1.x - v0.x === 60 && v1.y - v0.y === 48, `view (${v0.x},${v0.y}) -> (${v1.x},${v1.y})`);

// ---- 4. 容器：拖出范围 + 成员 + 整体拖动 ----
await setup();
await sleep(200);
await cdp.eval(`document.querySelector('.tool[data-tool="group"]').click()`);
await drag(rect.left + 30, rect.top + 30, rect.left + 400, rect.top + 160);
const g = await cdp.eval(`(() => {
  const g = state.nodes.find(n => n.kind === 'group');
  return g ? { id: g.id, x: g.x, y: g.y, w: g.w, h: g.h,
               members: membersOf(g).map(m => m.id).sort(),
               dashed: getComputedStyle(document.querySelector('.node[data-kind="group"]')).borderStyle } : null;
})()`);
check('线上创建容器并包含成员',
      g && g.w > 300 && JSON.stringify(g.members) === JSON.stringify(['b1', 'b2']) && g.dashed === 'dashed',
      g ? `尺寸 ${g.w}x${g.h} 成员 ${JSON.stringify(g.members)} 边框 ${g.dashed}` : '没创建');

const gBefore = await cdp.eval(`(() => {
  const n = document.querySelector('.node[data-kind="group"]');
  const r = n.getBoundingClientRect();
  const g = state.nodes.find(n => n.kind === 'group');
  return { px: r.left + 15, py: r.bottom - 12, gx: g.x, gy: g.y,
           members: membersOf(g).map(m => ({ id: m.id, x: m.x, y: m.y })) };
})()`);
await drag(gBefore.px, gBefore.py, gBefore.px + 70, gBefore.py + 30);
const ga = await cdp.eval(`(() => {
  const g = state.nodes.find(n => n.kind === 'group');
  return { gx: g.x, gy: g.y, members: membersOf(g).map(m => ({ id: m.id, x: m.x, y: m.y })) };
})()`);
const gdx = ga.gx - gBefore.gx;
const gdy = ga.gy - gBefore.gy;
const m1x = ga.members.find(m => m.id === 'b1').x - gBefore.members.find(m => m.id === 'b1').x;
const m1y = ga.members.find(m => m.id === 'b1').y - gBefore.members.find(m => m.id === 'b1').y;
check('线上拖容器整体移动',
      gdx === 70 && gdy === 30 && m1x === 70 && m1y === 30,
      `容器 +(${gdx},${gdy}) 成员A +(${m1x},${m1y})`);

// ---- 5. 缩放手柄 ----
await setup();
await sleep(200);
const h = await cdp.eval(`(() => {
  const n = document.querySelector('.node[data-id="b1"]');
  selection.add('b1'); markSelection();
  const r = n.querySelector('.resize').getBoundingClientRect();
  return { x: r.left + r.width/2, y: r.top + r.height/2, w: state.nodes[0].w, h: state.nodes[0].h };
})()`);
await drag(h.x, h.y, h.x + 60, h.y + 30);
const resized = await cdp.eval(`({ w: state.nodes[0].w, h: state.nodes[0].h })`);
check('线上手柄改大小', resized.w - h.w === 60 && resized.h - h.h === 30,
      `${h.w}x${h.h} -> ${resized.w}x${resized.h}`);

// ---- 6. 存档往返（含 kind 与方向）----
await cdp.eval(`(() => {
  state.nodes = [
    { id: 'g9', x: 40, y: 40, w: 320, h: 200, text: '分组', kind: 'group' },
    { id: 'c9', x: 90, y: 90, w: 120, h: 50, text: '组内', kind: 'box' },
    { id: 'c8', x: 500, y: 400, w: 120, h: 50, text: '组外', kind: 'box' },
  ];
  state.edges = [{ from: 'c9', to: 'c8', fromSide: 'right', toSide: 'left' }];
  selection.clear(); selectedEdge = null; view = { x: 0, y: 0 };
  setTool('select'); render();
  document.getElementById('name').value = '线上功能自检';
  document.getElementById('save').click();
})()`);
await sleep(1200);
const doc = await fetch(BASE + 'api/diagrams/' + encodeURIComponent('线上功能自检'),
  { headers: { Authorization: auth } }).then(r => r.json());
check('线上存档保存 kind 与方向',
      doc.nodes.find(n => n.id === 'g9')?.kind === 'group' &&
      doc.edges[0].fromSide === 'right' && doc.edges[0].toSide === 'left',
      `kind=${doc.nodes.map(n => n.kind).join(',')} edge=${doc.edges[0].fromSide}->${doc.edges[0].toSide}`);

await cdp.send('Page.navigate', { url: BASE + '?re=' + Date.now() });
await sleep(4200);
const back = await cdp.eval(`(() => {
  const g = state.nodes.find(n => n.kind === 'group');
  const geo = edgeGeometry(state.edges[0]);
  return { group: !!g, members: g ? membersOf(g).map(m => m.id) : [],
           ortho: geo.points.slice(1).every((p, i) => p.x === geo.points[i].x || p.y === geo.points[i].y),
           groupDom: document.querySelectorAll('.node[data-kind="group"]').length };
})()`);
check('线上重开还原容器与直角连线',
      back.group && back.groupDom === 1 && JSON.stringify(back.members) === JSON.stringify(['c9']) && back.ortho,
      JSON.stringify(back));

await fetch(BASE + 'api/diagrams/' + encodeURIComponent('线上功能自检'), { method: 'DELETE', headers: { Authorization: auth } });

const failed = results.filter(r => !r.ok).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
