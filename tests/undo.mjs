// 验证撤销 / 重做：各类操作都能撤回，且不会多退或空退
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
await cdp.send('Page.navigate', { url: BASE + '/?undo=' + Date.now() });
await sleep(2500);

const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse',
});
async function drag(x1, y1, x2, y2, steps = 6) {
  await mouse('mouseMoved', x1, y1);
  await mouse('mousePressed', x1, y1);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', x1 + ((x2 - x1) / steps) * i, y1 + ((y2 - y1) / steps) * i);
    await sleep(25);
  }
  await mouse('mouseReleased', x2, y2);
  await sleep(250);
}
async function press(key, mods = 2) {   // 2 = Ctrl
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: 'Key' + key.toUpperCase(), modifiers: mods, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: 'Key' + key.toUpperCase(), modifiers: mods, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
  await sleep(250);
}
const key = (k, code, vk) => cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk })
  .then(() => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }))
  .then(() => sleep(250));

const snap = () => cdp.eval(`(() => ({
  nodes: state.nodes.map(n => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, text: n.text })),
  edges: state.edges.map(e => ({ from: e.from, to: e.to, fromSide: e.fromSide, toSide: e.toSide,
                                 bends: e.bends || null })),
  undo: undoStack.length,
  redo: redoStack.length,
}))()`);

const setup = (nodes, edges) => cdp.eval(`(() => {
  state.nodes = ${JSON.stringify(nodes)};
  state.edges = ${JSON.stringify(edges)};
  selection.clear(); selectedEdge = null; view = { x: 0, y: 0 };
  undoStack.length = 0; redoStack.length = 0;
  setTool('select'); render(); applyView(); updateHistoryHint();
})()`);

// ===== 1. 新建节点可撤销 =====
await setup([], []);
await sleep(200);
const r = await cdp.eval(`(() => ({ left: 0, top: 0 }))()`);
const cRect = await cdp.eval(`(() => {
  const b = document.getElementById('canvas').getBoundingClientRect();
  return { left: b.left, top: b.top };
})()`);
for (const cc of [1, 2]) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cRect.left + 300, y: cRect.top + 200, button: 'left', buttons: 1, clickCount: cc, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cRect.left + 300, y: cRect.top + 200, button: 'left', buttons: 0, clickCount: cc, pointerType: 'mouse' });
  await sleep(70);
}
await sleep(350);
let s = await snap();
check('双击新建后节点数 +1', s.nodes.length === 1, `节点=${s.nodes.length} 可撤回=${s.undo}`);
await press('z');
s = await snap();
check('Ctrl+Z 撤销新建', s.nodes.length === 0 && s.undo === 0, `节点=${s.nodes.length} 可撤回=${s.undo}`);
await press('z', 2 | 8);   // Ctrl+Shift+Z
s = await snap();
check('Ctrl+Shift+Z 重做新建', s.nodes.length === 1, `节点=${s.nodes.length}`);

// ===== 2. 删除可撤销 =====
await setup([
  { id: 'a', x: 100, y: 100, w: 120, h: 60, text: 'A', kind: 'box' },
  { id: 'b', x: 400, y: 100, w: 120, h: 60, text: 'B', kind: 'box' },
], [{ from: 'a', to: 'b', fromSide: 'right', toSide: 'left' }]);
await sleep(200);
await cdp.eval(`selection.clear(); selection.add('a'); selection.add('b'); markSelection(); render();`);
await key('Delete', 'Delete', 46);
s = await snap();
check('Delete 删掉两个节点及连线', s.nodes.length === 0 && s.edges.length === 0,
      `节点=${s.nodes.length} 连线=${s.edges.length}`);
await press('z');
s = await snap();
check('Ctrl+Z 恢复删除的节点和连线',
      s.nodes.length === 2 && s.edges.length === 1 && s.edges[0].from === 'a',
      `节点=${s.nodes.length} 连线=${s.edges.length}`);

// ===== 3. 拖动节点可撤销（且只退一步）=====
await setup([
  { id: 'm', x: 100, y: 300, w: 120, h: 60, text: 'M', kind: 'box' },
], []);
await sleep(200);
const box = await cdp.eval(`(() => {
  const r = document.querySelector('.node[data-id="m"]').getBoundingClientRect();
  const b = document.getElementById('canvas').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await drag(box.x, box.y, box.x + 90, box.y + 60);
s = await snap();
check('拖动后位置变了', s.nodes[0].x === 190 && s.nodes[0].y === 360, `${s.nodes[0].x},${s.nodes[0].y}`);
const undoCountAfterDrag = s.undo;
await press('z');
s = await snap();
check('Ctrl+Z 撤销拖动只退一步',
      s.nodes[0].x === 100 && s.nodes[0].y === 300 && undoCountAfterDrag === 1,
      `位置=${s.nodes[0].x},${s.nodes[0].y} 拖动后可撤回=${undoCountAfterDrag}`);

// ===== 4. 只有点一下（没移动）不产生撤销步 =====
await setup([{ id: 'q', x: 200, y: 200, w: 120, h: 60, text: 'Q', kind: 'box' }], []);
await sleep(200);
const qb = await cdp.eval(`(() => {
  const r = document.querySelector('.node[data-id="q"]').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await mouse('mouseMoved', qb.x, qb.y);
await mouse('mousePressed', qb.x, qb.y);
await mouse('mouseReleased', qb.x, qb.y);
await sleep(250);
s = await snap();
check('单击节点不产生撤销步', s.undo === 0, `可撤回=${s.undo}`);

// ===== 5. 改文字可撤销 =====
await setup([{ id: 't', x: 200, y: 200, w: 140, h: 60, text: '原名', kind: 'box' }], []);
await sleep(200);
await cdp.eval(`(() => {
  const n = document.querySelector('.node[data-id="t"]');
  startEdit(n);
  n.querySelector('.label').textContent = '新名';
  n.querySelector('.label').blur();
})()`);
await sleep(300);
s = await snap();
check('改文字生效', s.nodes[0].text === '新名', `文本=${s.nodes[0].text}`);
await press('z');
s = await snap();
check('Ctrl+Z 撤销改文字', s.nodes[0].text === '原名', `文本=${s.nodes[0].text}`);

// ===== 6. 连线可撤销 =====
await setup([
  { id: 'p', x: 100, y: 100, w: 120, h: 60, text: 'P', kind: 'box' },
  { id: 'v', x: 500, y: 100, w: 120, h: 60, text: 'V', kind: 'box' },
], []);
await sleep(250);
const pts = await cdp.eval(`(() => {
  const a = document.querySelector('.node[data-id="p"] .port[data-side="right"]').getBoundingClientRect();
  const b = document.querySelector('.node[data-id="v"] .port[data-side="left"]').getBoundingClientRect();
  return { x1: a.left + a.width/2, y1: a.top + a.height/2, x2: b.left + b.width/2, y2: b.top + b.height/2 };
})()`);
await drag(pts.x1, pts.y1, pts.x2, pts.y2, 8);
s = await snap();
check('拖圆点建连线', s.edges.length === 1, `连线=${s.edges.length}`);
await press('z');
s = await snap();
check('Ctrl+Z 撤销连线', s.edges.length === 0, `连线=${s.edges.length}`);

// ===== 7. 缩放可撤销 =====
await setup([{ id: 'g', x: 100, y: 100, w: 200, h: 120, text: 'G', kind: 'box' }], []);
await sleep(200);
await cdp.eval(`selection.clear(); selection.add('g'); markSelection();`);
await sleep(150);
const grip = await cdp.eval(`(() => {
  const r = document.querySelector('.node[data-id="g"] .resize').getBoundingClientRect();
  return { x: r.left + r.width/2, y: r.top + r.height/2 };
})()`);
await drag(grip.x, grip.y, grip.x + 80, grip.y + 60);
s = await snap();
check('拖角标改大小', s.nodes[0].w === 280 && s.nodes[0].h === 180, `${s.nodes[0].w}x${s.nodes[0].h}`);
await press('z');
s = await snap();
check('Ctrl+Z 撤销缩放', s.nodes[0].w === 200 && s.nodes[0].h === 120, `${s.nodes[0].w}x${s.nodes[0].h}`);

// ===== 8. 连续多步撤销顺序正确 =====
await setup([], []);
await sleep(200);
for (let i = 0; i < 3; i++) {
  await cdp.eval(`(() => {
    beginHistory();
    state.nodes.push({ id: 'n' + (i = ${i}), x: 50 + ${i} * 160, y: 50, w: 120, h: 60, text: 'N' + ${i}, kind: 'box' });
    render();
    sealHistory();
  })()`);
  await sleep(80);
}
s = await snap();
check('连续新建三个', s.nodes.length === 3 && s.undo >= 3, `节点=${s.nodes.length} 可撤回=${s.undo}`);
await press('z');
const s1 = await snap();
await press('z');
const s2 = await snap();
await press('z');
const s3 = await snap();
check('连续撤销按逆序退回',
      s1.nodes.length === 2 && s2.nodes.length === 1 && s3.nodes.length === 0,
      `${s1.nodes.length} -> ${s2.nodes.length} -> ${s3.nodes.length}`);

// ===== 9. 撤销后再做新操作，重做栈要清空 =====
await press('z', 2 | 8);   // 重做一步
const afterRedo = await snap();
await cdp.eval(`(() => {
  beginHistory();
  state.nodes.push({ id: 'zz', x: 700, y: 400, w: 120, h: 60, text: 'Z', kind: 'box' });
  render(); sealHistory();
})()`);
await sleep(200);
const afterNew = await snap();
check('新操作后重做栈清空', afterNew.redo === 0 && afterRedo.redo > 0,
      `重做前=${afterRedo.redo} 新操作后=${afterNew.redo}`);

// ===== 10. 拖动线段可撤销 =====
await setup([
  { id: 's1', x: 100, y: 200, w: 110, h: 60, text: 'S1', kind: 'box' },
  { id: 's2', x: 600, y: 400, w: 110, h: 60, text: 'S2', kind: 'box' },
], [{ from: 's1', to: 's2', fromSide: 'right', toSide: 'left' }]);
await sleep(300);
const segPts = await cdp.eval(`(() => {
  const g = edgeGeometry(state.edges[0]);
  const p = g.points;
  const i = p.findIndex((q, k) => k > 0 && q.y === p[k-1].y);
  const a = p[i - 1], b = p[i];
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { x: (a.x + b.x)/2 + view.x + r.left, y: (a.y + b.y)/2 + view.y + r.top,
           idx: i - 1 };
})()`);
await drag(segPts.x, segPts.y, segPts.x, segPts.y + 60);
const afterSeg = await snap();
check('拖线段后产生 bends', !!afterSeg.edges[0].bends, `bends=${JSON.stringify(afterSeg.edges[0].bends)}`);
await press('z');
const afterUndoSeg = await snap();
check('Ctrl+Z 撤销线段拖动', afterUndoSeg.edges[0].bends === null,
      `bends=${JSON.stringify(afterUndoSeg.edges[0].bends)}`);

const failed = results.filter(x => !x).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
