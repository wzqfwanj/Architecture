// Architecture —— 极简架构图编辑器
// 相对路径，方便挂在反向代理的子路径下（如 /arch/）
const API = 'api/diagrams';
const NS = 'http://www.w3.org/2000/svg';

const el = {
  canvas: document.getElementById('canvas'),
  nodes: document.getElementById('nodes'),
  wireLayer: document.getElementById('wireLayer'),
  labelLayer: document.getElementById('labelLayer'),
  hitLayer: document.getElementById('hitLayer'),
  marquee: document.getElementById('marquee'),
  name: document.getElementById('name'),
  list: document.getElementById('list'),
  save: document.getElementById('save'),
  del: document.getElementById('del'),
  theme: document.getElementById('theme'),
  tools: [...document.querySelectorAll('.tool')],
};

const state = { name: '', nodes: [], edges: [] };
let uid = 1;
let tempPath = null;
let lastTap = null;        // 节点上的双击检测
let lastTapCanvas = null;  // 画布上的双击检测（不依赖原生 dblclick）
let drag = null;
// 画布视图位移：节点坐标不变，只移动整个视图，方便画大图
let view = { x: 0, y: 0 };
// 左侧栏选中的工具：select / box / group
let tool = 'select';

// 选择状态：可多选节点，一次最多选一条连线
const selection = new Set();
let selectedEdge = null;

// 兼容旧写法 selected = {kind,id} / selected = null
Object.defineProperty(window, 'selected', {
  configurable: true,
  get() {
    if (selectedEdge) return { kind: 'edge', id: selectedEdge };
    if (selection.size === 1) return { kind: 'node', id: [...selection][0] };
    return null;
  },
  set(v) {
    selection.clear();
    selectedEdge = null;
    if (!v) return;
    if (v.kind === 'node') selection.add(v.id);
    else if (v.kind === 'edge') selectedEdge = v.id;
  },
});

/* ---------------- 工具 ---------------- */

const SIDES = ['top', 'right', 'bottom', 'left'];
const SIDE_NORMAL = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};
const isHoriz = side => side === 'left' || side === 'right';
const nextId = () => 'n' + (uid++);
const getNode = id => state.nodes.find(n => n.id === id);
const nodeOf = dom => getNode(dom?.closest('.node')?.dataset.id);

// 屏幕坐标 -> 画布坐标（要减掉视图位移）
function toCanvas(clientX, clientY) {
  const r = el.canvas.getBoundingClientRect();
  return { x: clientX - r.left - view.x, y: clientY - r.top - view.y };
}

// 把视图位移应用到三层：节点层、连线层、背景网格
function applyView() {
  el.nodes.style.transform = `translate(${view.x}px, ${view.y}px)`;
  el.wireLayer.setAttribute('transform', `translate(${view.x} ${view.y})`);
  if (el.labelLayer) el.labelLayer.setAttribute('transform', `translate(${view.x} ${view.y})`);
  el.canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
}

// 把所有节点框回视野中央（Home 键）
function resetView() {
  if (!state.nodes.length) {
    view = { x: 0, y: 0 };
  } else {
    const minX = Math.min(...state.nodes.map(n => n.x));
    const minY = Math.min(...state.nodes.map(n => n.y));
    const maxX = Math.max(...state.nodes.map(n => n.x + n.w));
    const maxY = Math.max(...state.nodes.map(n => n.y + n.h));
    const r = el.canvas.getBoundingClientRect();
    view = {
      x: Math.round(r.width / 2 - (minX + maxX) / 2),
      y: Math.round(r.height / 2 - (minY + maxY) / 2),
    };
  }
  applyView();
}

// 某条边中点的画布坐标，连线从这里出发 / 到这里落脚
function portPoint(node, side) {
  switch (side) {
    case 'top': return { x: node.x + node.w / 2, y: node.y };
    case 'right': return { x: node.x + node.w, y: node.y + node.h / 2 };
    case 'bottom': return { x: node.x + node.w / 2, y: node.y + node.h };
    case 'left': return { x: node.x, y: node.y + node.h / 2 };
    default: return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
  }
}

// 松开时落在节点范围内但没对准连接点，就取离得最近的那条边
function nearestSide(node, p) {
  let best = 'top';
  let bestD = Infinity;
  for (const side of SIDES) {
    const q = portPoint(node, side);
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < bestD) { bestD = d; best = side; }
  }
  return best;
}

// 旧存档没有方向时，按两节点的相对位置推断一组朝向
function inferSides(a, b) {
  const dx = (b.x + b.w / 2) - (a.x + a.w / 2);
  const dy = (b.y + b.h / 2) - (a.y + a.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  }
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

// 连线的唯一标识：同一个连接点之间才算重复
const edgeKey = e => `${e.from}->${e.to}@${e.fromSide || ''}|${e.toSide || ''}`;

/* ---------------- 直角连线 ---------------- */

// 去掉重复点和共线的中间点，避免路径里出现多余的折
function tidy(points) {
  const dedup = [];
  for (const p of points) {
    const q = dedup[dedup.length - 1];
    if (q && q.x === p.x && q.y === p.y) continue;
    dedup.push({ x: Math.round(p.x), y: Math.round(p.y) });
  }
  const out = [];
  for (let i = 0; i < dedup.length; i++) {
    const prev = out[out.length - 1];
    const cur = dedup[i];
    const next = dedup[i + 1];
    if (prev && next) {
      const sameX = prev.x === cur.x && cur.x === next.x;
      const sameY = prev.y === cur.y && cur.y === next.y;
      if (sameX || sameY) continue;
    }
    out.push(cur);
  }
  return out;
}

// 正交折线：先从两端沿法线伸出一小段，再用 L 型或 Z 型接上
function orthoPoints(p1, s1, p2, s2, stub = 20) {
  const n1 = SIDE_NORMAL[s1] || { x: 0, y: 0 };
  const n2 = SIDE_NORMAL[s2] || { x: 0, y: 0 };
  const a = { x: p1.x + n1.x * stub, y: p1.y + n1.y * stub };
  const b = { x: p2.x + n2.x * stub, y: p2.y + n2.y * stub };
  const h1 = isHoriz(s1);
  const h2 = isHoriz(s2);

  const pts = [p1, a];
  if (h1 && h2) {
    const mx = (a.x + b.x) / 2;
    pts.push({ x: mx, y: a.y }, { x: mx, y: b.y });
  } else if (!h1 && !h2) {
    const my = (a.y + b.y) / 2;
    pts.push({ x: a.x, y: my }, { x: b.x, y: my });
  } else if (h1) {
    pts.push({ x: b.x, y: a.y });
  } else {
    pts.push({ x: a.x, y: b.y });
  }
  pts.push(b, p2);
  return tidy(pts);
}

// 把任意点序列补成直角折线：相邻两点不在一条轴上就插一个肘点。
// startDir / endDir 用来保证进出节点的那一段沿着连接点法线方向。
function orthogonalize(seq, startDir, endDir) {
  const out = [{ x: seq[0].x, y: seq[0].y }];
  let dir = startDir || null;      // 'h' 或 'v'
  for (let i = 1; i < seq.length; i++) {
    const P = out[out.length - 1];
    const Q = seq[i];
    const isLast = i === seq.length - 1;
    if (P.x === Q.x || P.y === Q.y) {
      out.push({ x: Q.x, y: Q.y });
      dir = P.x === Q.x ? 'v' : 'h';
      continue;
    }
    // 需要拐一次：preferH 为真表示先水平走，肘点取 (Q.x, P.y)
    let preferH = dir ? dir === 'h' : true;
    if (isLast && endDir) preferH = endDir === 'v';
    const elbow = preferH ? { x: Q.x, y: P.y } : { x: P.x, y: Q.y };
    out.push(elbow, { x: Q.x, y: Q.y });
    dir = P.x === elbow.x ? 'v' : 'h';
  }
  return out;
}

function toPath(points) {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
}

/* ---------------- 绕开节点的直角布线 ---------------- */

const ROUTE_MARGIN = 10;     // 线与节点之间留的间距
const ROUTE_STUB = 14;       // 从连接点先直着出去的一小段
const ROUTE_TURN_COST = 30;  // 拐一次弯的代价，越小越爱拐弯
const ROUTE_MAX_NODES = 80;  // 节点太多就不做绕行，免得拖不动

// 连线路径缓存：节点没动就复用，避免每帧都跑寻路
const routeCache = new Map();
let routeStamp = '';

function inflateRect(n, m) {
  return { x1: n.x - m, y1: n.y - m, x2: n.x + n.w + m, y2: n.y + n.h + m };
}

function pointInRect(p, r, eps = 0.5) {
  return p.x > r.x1 + eps && p.x < r.x2 - eps && p.y > r.y1 + eps && p.y < r.y2 - eps;
}

// 正交线段是否穿过某个矩形（贴边不算穿）
function segBlocked(a, b, rects) {
  const eps = 0.5;
  if (a.y === b.y) {
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    return rects.some(r => a.y > r.y1 + eps && a.y < r.y2 - eps && hi > r.x1 + eps && lo < r.x2 - eps);
  }
  if (a.x === b.x) {
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    return rects.some(r => a.x > r.x1 + eps && a.x < r.x2 - eps && hi > r.y1 + eps && lo < r.y2 - eps);
  }
  return true;
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(n) {
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      const t = a[p]; a[p] = a[i]; a[i] = t;
      i = p;
    }
  }
  pop() {
    const a = this.a;
    if (!a.length) return null;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        const t = a[m]; a[m] = a[i]; a[i] = t;
        i = m;
      }
    }
    return top;
  }
}

const uniqSorted = arr => [...new Set(arr)].sort((a, b) => a - b);

// 在「节点边界 ± 间距」构成的网格上做 A*，返回中间折点（不含起终点）
function astar(start, end, rects, xs, ys) {
  const nx = xs.length;
  const ny = ys.length;
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));
  const sx = xi.get(start.x);
  const sy = yi.get(start.y);
  const ex = xi.get(end.x);
  const ey = yi.get(end.y);
  if ([sx, sy, ex, ey].some(v => v === undefined)) return null;

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  // 方向用 0..3，4 表示「还没走过」
  const keyOf = (x, y, d) => (y * nx + x) * 5 + d;
  const best = new Map();
  const from = new Map();
  const heap = new MinHeap();
  const h = () => Math.abs(xs[sx] - xs[ex]) + Math.abs(ys[sy] - ys[ey]);

  const startKey = keyOf(sx, sy, 4);
  best.set(startKey, 0);
  heap.push({ x: sx, y: sy, d: 4, g: 0, f: h(), k: startKey });

  let goal = null;
  while (heap.size) {
    const cur = heap.pop();
    if (cur.g > (best.get(cur.k) ?? Infinity)) continue;
    if (cur.x === ex && cur.y === ey) { goal = cur; break; }

    for (let d = 0; d < 4; d++) {
      const tx = cur.x + DIRS[d][0];
      const ty = cur.y + DIRS[d][1];
      if (tx < 0 || tx >= nx || ty < 0 || ty >= ny) continue;
      const p = { x: xs[cur.x], y: ys[cur.y] };
      const q = { x: xs[tx], y: ys[ty] };
      if (segBlocked(p, q, rects)) continue;

      const step = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
      const turn = cur.d !== 4 && cur.d !== d ? ROUTE_TURN_COST : 0;
      const g = cur.g + step + turn;
      const k = keyOf(tx, ty, d);
      if (g >= (best.get(k) ?? Infinity)) continue;
      best.set(k, g);
      from.set(k, cur.k);
      heap.push({ x: tx, y: ty, d, g, f: g + Math.abs(q.x - xs[ex]) + Math.abs(q.y - ys[ey]), k });
    }
  }

  if (!goal) return null;
  const out = [];
  let k = goal.k;
  while (k !== undefined && k !== startKey) {
    const idx = Math.floor(k / 5);
    const y = Math.floor(idx / nx);
    const x = idx % nx;
    out.push({ x: xs[x], y: ys[y] });
    k = from.get(k);
  }
  out.reverse();
  return out;
}

// 尽力绕开所有实心节点；实在绕不开就退回简单折线
function routePoints(p1, s1, p2, s2) {
  const simple = orthoPoints(p1, s1, p2, s2);
  if (!state.nodes.length || state.nodes.length > ROUTE_MAX_NODES) return simple;

  // 容器只是个框，不是实体障碍，否则容器内成员之间的线无路可走
  const blockers = state.nodes.filter(n => n.kind !== 'group');
  const n1 = SIDE_NORMAL[s1] || { x: 0, y: 0 };
  const n2 = SIDE_NORMAL[s2] || { x: 0, y: 0 };

  // 依次尝试：先留足间距；两节点贴得很近时再放宽到贴边走
  const attempts = [
    { margin: ROUTE_MARGIN, stub: ROUTE_STUB },
    { margin: 0, stub: 6 },
    { margin: 0, stub: 0 },
  ];

  for (const { margin, stub } of attempts) {
    const rects = blockers.map(n => inflateRect(n, margin));
    const a = { x: p1.x + n1.x * stub, y: p1.y + n1.y * stub };
    const b = { x: p2.x + n2.x * stub, y: p2.y + n2.y * stub };
    if (rects.some(r => pointInRect(a, r)) || rects.some(r => pointInRect(b, r))) continue;

    const xs = uniqSorted([a.x, b.x, ...rects.flatMap(r => [r.x1, r.x2])]);
    const ys = uniqSorted([a.y, b.y, ...rects.flatMap(r => [r.y1, r.y2])]);
    const mid = astar(a, b, rects, xs, ys);
    if (mid) return tidy([p1, a, ...mid, b, p2]);
  }

  return simple;
}

// 一条连线的路径与端点信息
function edgeGeometry(e) {
  const a = getNode(e.from);
  const b = getNode(e.to);
  if (!a || !b) return null;
  let [s1, s2] = [e.fromSide, e.toSide];
  if (!s1 || !s2) [s1, s2] = inferSides(a, b);
  const p1 = portPoint(a, s1);
  const p2 = portPoint(b, s2);

  // 手动拖过段落的连线以 bends 为准，没拖过才自动绕行
  const manual = Array.isArray(e.bends) && e.bends.length;
  const points = manual
    ? tidy(orthogonalize([p1, ...e.bends, p2],
        isHoriz(s1) ? 'h' : 'v', isHoriz(s2) ? 'h' : 'v'))
    : routePoints(p1, s1, p2, s2);

  return { points, p1, p2, s1, s2, manual: !!manual };
}

/* ---------------- 容器 ---------------- */

// 节点中心落在容器里，就算它的成员
function centerInside(inner, outer) {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  return cx > outer.x && cx < outer.x + outer.w && cy > outer.y && cy < outer.y + outer.h;
}

function membersOf(group) {
  return state.nodes.filter(n => n.id !== group.id && n.kind !== 'group' && centerInside(n, group));
}

// 拖动某个节点时，实际要一起移动的节点
function moveTargets(anchorId) {
  const ids = new Set(selection.has(anchorId) ? selection : [anchorId]);
  for (const id of [...ids]) {
    const n = getNode(id);
    if (n && n.kind === 'group') for (const m of membersOf(n)) ids.add(m.id);
  }
  return [...ids].map(getNode).filter(Boolean);
}

/* ---------------- 撤销 / 重做 ---------------- */

const HISTORY_MAX = 80;
const undoStack = [];
const redoStack = [];
let historyLocked = false;   // 应用历史时不要再次记录

// 只保存文档内容，不动视图和选择
function snapshot() {
  return JSON.stringify({ nodes: state.nodes, edges: state.edges });
}

// 动作开始前记录「起点」；连续操作（拖动、缩放）只在开始时记一次
function beginHistory() {
  if (historyLocked) return;
  const snap = snapshot();
  if (undoStack.length && undoStack[undoStack.length - 1] === snap) return;
  undoStack.push(snap);
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
}

// 动作完成后对比：没变化就把这条记录丢掉，避免撤销时「空退一步」
function sealHistory() {
  if (historyLocked) return;
  if (!undoStack.length) return;
  if (undoStack[undoStack.length - 1] === snapshot()) undoStack.pop();
  redoStack.length = 0;
  updateHistoryHint();
}

function restore(snap) {
  historyLocked = true;
  const doc = JSON.parse(snap);
  state.nodes = doc.nodes;
  state.edges = doc.edges;
  // id 计数器要跟上，否则撤销后再新建会撞 id
  uid = state.nodes.reduce((m, n) => {
    const num = parseInt(String(n.id).slice(1), 10);
    return Math.max(m, Number.isFinite(num) ? num : 0);
  }, 0) + 1;
  routeCache.clear();
  routeStamp = '';
  // 撤销可能会把选中的对象删掉
  for (const id of [...selection]) if (!getNode(id)) selection.delete(id);
  if (selectedEdge && !state.edges.some(e => edgeKey(e) === selectedEdge)) selectedEdge = null;
  render();
  historyLocked = false;
  updateHistoryHint();
}

function undo() {
  commitEditing();
  if (!undoStack.length) return false;
  const cur = snapshot();
  const prev = undoStack.pop();
  redoStack.push(cur);
  restore(prev);
  return true;
}

function redo() {
  commitEditing();
  if (!redoStack.length) return false;
  const cur = snapshot();
  const next = redoStack.pop();
  undoStack.push(cur);
  restore(next);
  return true;
}

let hintTimer = null;
function updateHistoryHint() {
  const hint = document.getElementById('historyHint');
  if (!hint) return;
  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;
  if (!canUndo && !canRedo) {
    hint.textContent = '';
    return;
  }
  hint.textContent = canRedo ? `已撤回 · 可重做 ${redoStack.length} 步` : `可撤回 ${undoStack.length} 步`;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hint.textContent = ''; }, 2000);
}

/* ---------------- 渲染 ---------------- */

function renderNodes() {
  el.nodes.textContent = '';
  // 容器先渲染，普通方框压在上面
  const ordered = [...state.nodes].sort((a, b) => {
    const ga = a.kind === 'group' ? 0 : 1;
    const gb = b.kind === 'group' ? 0 : 1;
    return ga - gb;
  });

  for (const n of ordered) {
    const d = document.createElement('div');
    d.className = 'node' + (n.kind === 'group' ? ' group' : '') + (selection.has(n.id) ? ' sel' : '');
    d.dataset.id = n.id;
    d.dataset.kind = n.kind === 'group' ? 'group' : 'box';
    d.style.cssText = `left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px`;

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = n.text;

    d.append(label);
    for (const side of SIDES) {
      const port = document.createElement('div');
      port.className = 'port';
      port.dataset.side = side;
      d.append(port);
    }
    // 右下角缩放手柄：视觉上是一条细线 L 角标，选中才出现
    const grip = document.createElement('div');
    grip.className = 'resize';
    d.append(grip);

    el.nodes.append(d);
  }
  applyView();
}

// 取连线的几何（带缓存）；节点一动缓存就整体清掉
function geoOf(e) {
  const ck = edgeKey(e) + '#' + (e.bends || []).map(p => p.x + ',' + p.y).join(';');
  let geo = routeCache.get(ck);
  if (geo === undefined) {
    geo = edgeGeometry(e);
    routeCache.set(ck, geo);
  }
  return geo;
}

// 文字挂在最长那一段的中点上，看起来最自然
function labelAnchor(points) {
  let best = { len: -1, x: 0, y: 0 };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (len > best.len) {
      best = { len, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return { x: best.x, y: best.y };
}

function drawLabels() {
  if (!el.labelLayer) return;
  el.labelLayer.textContent = '';
  for (const e of state.edges) {
    if (!e.label) continue;
    const geo = geoOf(e);
    if (!geo) continue;
    const p = labelAnchor(geo.points);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', Math.round(p.x));
    t.setAttribute('y', Math.round(p.y));
    t.setAttribute('class', 'wire-label');
    t.dataset.edge = edgeKey(e);
    t.textContent = e.label;
    el.labelLayer.append(t);
  }
  el.labelLayer.setAttribute('transform', `translate(${view.x} ${view.y})`);
}

/* ---------------- 连线文字编辑 ---------------- */

let labelEditor = null;

function editEdgeLabel(edge) {
  if (!edge) return;
  commitEditing();
  const geo = geoOf(edge);
  if (!geo) return;
  const p = labelAnchor(geo.points);
  beginHistory();

  const input = document.createElement('input');
  input.className = 'edge-label-input';
  input.value = edge.label || '';
  input.placeholder = '输入文字';
  input.style.left = (p.x + view.x) + 'px';
  input.style.top = (p.y + view.y) + 'px';
  el.canvas.append(input);

  labelEditor = { input, edge };
  input.focus();
  input.select();

  input.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); commitLabelEdit(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); cancelLabelEdit(); }
  });
  input.addEventListener('blur', () => commitLabelEdit());
}

function commitLabelEdit() {
  if (!labelEditor) return;
  const { input, edge } = labelEditor;
  labelEditor = null;          // 先清，避免移除元素触发 blur 再进来
  const text = input.value.replace(/\s+/g, ' ').trim();
  input.remove();
  if (text) edge.label = text;
  else delete edge.label;
  drawLabels();
  sealHistory();
}

function cancelLabelEdit() {
  if (!labelEditor) return;
  const { input } = labelEditor;
  labelEditor = null;
  input.remove();
  sealHistory();               // 内容没变，这一步会被丢掉
}

function drawEdges() {
  el.wireLayer.textContent = '';
  el.hitLayer.textContent = '';

  // 节点几何一变就清缓存，否则拖动时每帧都会重跑寻路
  const stamp = state.nodes.map(n => `${n.id}:${n.x},${n.y},${n.w},${n.h}`).join('|');
  if (stamp !== routeStamp) {
    routeStamp = stamp;
    routeCache.clear();
  }

  for (const e of state.edges) {
    const geo = geoOf(e);
    if (!geo) continue;
    const d = toPath(geo.points);
    const key = edgeKey(e);

    // 点击用的加宽路径放低层，避免盖住节点。
    // 每段单独一个元素，这样能拖某一段，也能按方向给出对应的光标。
    const pts = geo.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const hit = document.createElementNS(NS, 'path');
      hit.setAttribute('d', `M${a.x},${a.y} L${b.x},${b.y}`);
      hit.dataset.edge = key;
      hit.dataset.seg = String(i - 1);
      hit.dataset.axis = a.y === b.y ? 'h' : 'v';
      el.hitLayer.append(hit);
    }

    // 看得见的线放高层，不被节点底色切断
    const line = document.createElementNS(NS, 'path');
    line.setAttribute('d', d);
    line.setAttribute('marker-end', 'url(#arrow)');
    if (selectedEdge === key) line.setAttribute('class', 'sel');
    el.wireLayer.append(line);
  }
  if (tempPath) el.wireLayer.append(tempPath);
  const t = `translate(${view.x} ${view.y})`;
  el.wireLayer.setAttribute('transform', t);
  el.hitLayer.setAttribute('transform', t);
  drawLabels();
}

// 正在编辑的文字先落回 state，否则重绘会把它丢掉
function commitEditing() {
  const label = el.nodes.querySelector('.label[contenteditable="true"]');
  if (label) label.blur();   // blur 同步触发 focusout，由那里写回 state
  commitLabelEdit();
}

function render() {
  renderNodes();
  drawEdges();
}

function clearSelection() {
  selection.clear();
  selectedEdge = null;
}

function select(kind, id) {
  commitEditing();
  clearSelection();
  if (kind === 'node' && id) selection.add(id);
  if (kind === 'edge' && id) selectedEdge = id;
  renderNodes();
  drawEdges();
}

// 只切换选中样式，不重建 DOM：按住的那个元素被移除，触屏上会直接触发 pointercancel
function markSelection() {
  for (const d of el.nodes.children) {
    d.classList.toggle('sel', selection.has(d.dataset.id));
  }
}

/* ---------------- 文字编辑 ---------------- */

function startEdit(dom) {
  const label = dom?.querySelector('.label');
  if (!label || label.isContentEditable) return;
  beginHistory();                       // 记录改文字之前的文本
  label.contentEditable = 'true';
  label.dataset.before = label.textContent;
  dom.classList.add('editing');
  label.focus();
  const range = document.createRange();
  range.selectNodeContents(label);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(range);
}

/* ---------------- 框选矩形 ---------------- */

function showMarquee(x1, y1, x2, y2) {
  const l = Math.min(x1, x2);
  const t = Math.min(y1, y2);
  el.marquee.hidden = false;
  el.marquee.style.left = l + 'px';
  el.marquee.style.top = t + 'px';
  el.marquee.style.width = Math.abs(x2 - x1) + 'px';
  el.marquee.style.height = Math.abs(y2 - y1) + 'px';
}

function hideMarquee() {
  el.marquee.hidden = true;
}

/* ---------------- 工具切换 ---------------- */

function setTool(name) {
  tool = name;
  for (const b of el.tools) b.classList.toggle('active', b.dataset.tool === name);
  el.canvas.style.cursor = name === 'select' ? '' : 'crosshair';
}

for (const b of el.tools) {
  b.addEventListener('click', () => setTool(b.dataset.tool));
}

/* ---------------- 节点上的交互 ---------------- */

el.nodes.addEventListener('pointerdown', ev => {
  if (ev.button !== 0) return;   // 中键 / 右键交给画布处理
  const dom = ev.target.closest('.node');
  if (!dom) return;
  if (ev.target.isContentEditable) return;   // 正在改文字，交给浏览器处理光标
  const node = nodeOf(dom);
  if (!node) return;

  ev.preventDefault();

  // 连接点：拉线
  const port = ev.target.closest('.port');
  if (port) {
    tempPath = document.createElementNS(NS, 'path');
    tempPath.setAttribute('class', 'temp');
    tempPath.setAttribute('d', '');
    beginHistory();
    drag = { mode: 'wire', from: node.id, fromSide: port.dataset.side };
    drawEdges();
    return;
  }

  // 右下角手柄：调整大小
  if (ev.target.classList.contains('resize')) {
    commitEditing();
    clearSelection();
    selection.add(node.id);
    markSelection();
    beginHistory();
    drag = {
      mode: 'resize',
      id: node.id,
      startX: ev.clientX,
      startY: ev.clientY,
      ow: node.w,
      oh: node.h,
      moved: false,
    };
    return;
  }

  // 双击才进编辑，但要等松手且确认没移动才生效。
  // 否则「点一下、再按下拖动」会被当成双击，表现为拖不动。
  const now = performance.now();
  const maybeEdit = !!(lastTap && lastTap.id === node.id && now - lastTap.t < 400);
  lastTap = maybeEdit ? null : { id: node.id, t: now };

  commitEditing();

  // 选择：shift 加选 / 已选中的保持整组 / 否则单选
  if (ev.shiftKey) {
    if (selection.has(node.id)) selection.delete(node.id);
    else selection.add(node.id);
    selectedEdge = null;
  } else if (!selection.has(node.id)) {
    clearSelection();
    selection.add(node.id);
  }
  markSelection();
  drawEdges();

  const targets = moveTargets(node.id);
  const moving = new Set(targets.map(n => n.id));
  // 手动画过的折线要跟着节点一起平移，否则形状会被扯歪
  const bendBackup = state.edges
    .filter(e => moving.has(e.from) || moving.has(e.to))
    .filter(e => Array.isArray(e.bends) && e.bends.length)
    .map(e => ({ e, bends: e.bends.map(p => ({ x: p.x, y: p.y })) }));

  beginHistory();
  drag = {
    mode: 'move',
    id: node.id,
    startX: ev.clientX,
    startY: ev.clientY,
    items: targets.map(n => ({ id: n.id, ox: n.x, oy: n.y })),
    bendBackup,
    moved: false,
    maybeEdit,
  };
});

/* ---------------- 画布上的交互 ---------------- */

// 中键默认会拉起自动滚动，一并挡掉，否则拖画布时页面会乱跳
el.canvas.addEventListener('mousedown', ev => {
  if (ev.button === 1) ev.preventDefault();
});
el.canvas.addEventListener('auxclick', ev => {
  if (ev.button === 1) ev.preventDefault();
});

el.canvas.addEventListener('pointerdown', ev => {
  // 点在自己的输入框上时交给输入框处理，别触发框选
  if (ev.target.closest('.edge-label-input')) return;

  const onNode = !!ev.target.closest('.node');

  // 中键：任何位置都能拖画布（包括按在节点上）
  if (ev.button === 1) {
    ev.preventDefault();
    el.canvas.classList.add('panning');
    drag = {
      mode: 'pan',
      startX: ev.clientX,
      startY: ev.clientY,
      ox: view.x,
      oy: view.y,
      moved: false,
    };
    return;
  }

  if (ev.button !== 0 || onNode) return;

  // 连线上按下：不框选，可以拖着走，也可以点一下选中
  const hit = ev.target.closest('#wireHits path');
  // 直接点在已有的文字上，等同于点到它所属的那条线
  const labelText = ev.target.closest('#wireLabels text');
  const hitKey = hit ? hit.dataset.edge : (labelText ? labelText.dataset.edge : null);

  // 自己判定画布双击。
  // 不能用原生 dblclick：第一次点击若选中了连线会重建 SVG，
  // 浏览器就认为两次点击的目标不同，不再派发 dblclick。
  const now = performance.now();
  const isDouble = !!lastTapCanvas &&
    now - lastTapCanvas.t < 400 &&
    Math.abs(ev.clientX - lastTapCanvas.x) < 6 &&
    Math.abs(ev.clientY - lastTapCanvas.y) < 6;
  lastTapCanvas = isDouble ? null : { t: now, x: ev.clientX, y: ev.clientY };

  // 双击连线（或它的文字）：编辑这条线的文字
  if (isDouble && hitKey && tool === 'select') {
    ev.preventDefault();
    const edge = state.edges.find(x => edgeKey(x) === hitKey);
    if (edge) {
      select('edge', hitKey);
      editEdgeLabel(edge);
      return;
    }
  }

  // 双击空白：新建方框
  if (isDouble && !hitKey && tool === 'select') {
    ev.preventDefault();
    const p = toCanvas(ev.clientX, ev.clientY);
    const node = {
      id: nextId(),
      x: Math.round(p.x - 70),
      y: Math.round(p.y - 28),
      w: 140,
      h: 56,
      text: '节点',
      kind: 'box',
    };
    beginHistory();
    state.nodes.push(node);
    render();
    select('node', node.id);
    sealHistory();
    return;
  }

  // 点在文字上：只选中对应的线，不拖段也不框选
  if (labelText) {
    ev.preventDefault();
    if (!isDouble) select('edge', labelText.dataset.edge);
    return;
  }

  // 线上按住：进入段落拖动（松手没动就当作选中）
  if (hit) {
    const edge = state.edges.find(x => edgeKey(x) === hit.dataset.edge);
    const geo = edge ? edgeGeometry(edge) : null;
    if (edge && geo) {
      ev.preventDefault();
      beginHistory();
      drag = {
        mode: 'segs',
        key: hit.dataset.edge,
        seg: Number(hit.dataset.seg),
        startX: ev.clientX,
        startY: ev.clientY,
        pts0: geo.points.map(p => ({ x: p.x, y: p.y })),
        moved: false,
      };
      return;
    }
  }

  // 触屏没有中键，拖空白处仍然平移画布，否则手机上没法移动视图
  if (ev.pointerType === 'touch' && !hit) {
    drag = { mode: 'pan', startX: ev.clientX, startY: ev.clientY, ox: view.x, oy: view.y, moved: false };
    return;
  }

  ev.preventDefault();

  // 左侧栏选了方框 / 容器：拖出范围来创建
  if (tool === 'box' || tool === 'group') {
    // marquee 用的是画布内坐标，要减掉画布在页面里的位置
    const r = el.canvas.getBoundingClientRect();
    drag = {
      mode: 'draw',
      kind: tool,
      startX: ev.clientX - r.left,
      startY: ev.clientY - r.top,
      moved: false,
    };
    beginHistory();
    el.canvas.classList.add('marqueeing');
    showMarquee(drag.startX, drag.startY, drag.startX, drag.startY);
    return;
  }

  // 默认：框选
  const r = el.canvas.getBoundingClientRect();
  drag = {
    mode: 'marquee',
    startX: ev.clientX - r.left,
    startY: ev.clientY - r.top,
    curX: ev.clientX - r.left,
    curY: ev.clientY - r.top,
    moved: false,
    shift: ev.shiftKey,
  };
});

window.addEventListener('pointermove', ev => {
  if (!drag) return;

  if (drag.mode === 'pan') {
    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = true;
    view = { x: drag.ox + dx, y: drag.oy + dy };
    applyView();
    return;
  }

  if (drag.mode === 'segs') {
    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = true;

    const edge = state.edges.find(x => edgeKey(x) === drag.key);
    if (!edge) return;
    const pts = drag.pts0;
    const i = drag.seg;
    const a = pts[i];
    const b = pts[i + 1];
    if (!a || !b) return;

    // 只沿垂直方向移动这一段
    const horiz = a.y === b.y;
    const delta = horiz ? dy : dx;
    const along = horiz ? 'y' : 'x';
    const geo = edgeGeometry(edge);
    const n1 = SIDE_NORMAL[geo.s1] || { x: 0, y: 0 };
    const n2 = SIDE_NORMAL[geo.s2] || { x: 0, y: 0 };
    const STUB = 20;

    const shift = p => {
      const q = { x: p.x, y: p.y };
      q[along] = Math.round(p[along] + delta);
      return q;
    };

    const atStart = i === 0;
    const atEnd = i + 1 === pts.length - 1;

    let out;
    if (atStart && atEnd) {
      // 整条线只有一段：造 S 形，两端各沿法线伸出后整体平移
      out = horiz
        ? [
            pts[0],
            { x: pts[0].x + n1.x * STUB, y: pts[0].y },
            { x: pts[0].x + n1.x * STUB, y: pts[0].y + delta },
            { x: pts[1].x + n2.x * STUB, y: pts[1].y + delta },
            { x: pts[1].x + n2.x * STUB, y: pts[1].y },
            pts[1],
          ]
        : [
            pts[0],
            { x: pts[0].x, y: pts[0].y + n1.y * STUB },
            { x: pts[0].x + delta, y: pts[0].y + n1.y * STUB },
            { x: pts[1].x + delta, y: pts[1].y + n2.y * STUB },
            { x: pts[1].x, y: pts[1].y + n2.y * STUB },
            pts[1],
          ];
    } else {
      // 先按普通规则平移这一段的两个端点（贴着端口的那端不动）
      const moved = pts.map(p => ({ x: p.x, y: p.y }));
      if (!atStart) Object.assign(moved[i], shift(pts[i]));
      if (!atEnd) Object.assign(moved[i + 1], shift(pts[i + 1]));

      out = [];
      for (let k = 0; k < moved.length; k++) {
        // 起点没动、下一点动了：在起点旁边补一个 Jog，把线接到新位置
        if (k === 1 && atStart) {
          const p0 = moved[0];
          const q = { x: p0.x + n1.x * STUB, y: p0.y + n1.y * STUB };
          out.push(p0, q, horiz ? { x: q.x, y: moved[1].y } : { x: moved[1].x, y: q.y }, moved[1]);
          continue;
        }
        // 终点没动、前一点动了：同理补 Jog 再进入端口
        if (k === moved.length - 1 && atEnd) {
          const pEnd = moved[moved.length - 1];
          const prev = moved[moved.length - 2];
          const q = { x: pEnd.x + n2.x * STUB, y: pEnd.y + n2.y * STUB };
          out.push(prev, horiz ? { x: q.x, y: prev.y } : { x: prev.x, y: q.y }, q, pEnd);
          continue;
        }
        out.push(moved[k]);
      }
    }

    const bounds = tidy(out);
    edge.bends = bounds.slice(1, -1);
    routeCache.clear();
    drawEdges();
    return;
  }

  if (drag.mode === 'marquee' || drag.mode === 'draw') {
    const r = el.canvas.getBoundingClientRect();
    const cx = ev.clientX - r.left;
    const cy = ev.clientY - r.top;
    const dx = cx - drag.startX;
    const dy = cy - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = true;
    if (drag.mode === 'marquee') {
      drag.curX = cx;
      drag.curY = cy;
    }
    el.canvas.classList.add('marqueeing');
    showMarquee(drag.startX, drag.startY, cx, cy);
    return;
  }

  if (drag.mode === 'resize') {
    const node = getNode(drag.id);
    if (!node) return;
    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
    drag.moved = true;
    // 容器要容得下里面的方框，最小尺寸比普通方框大一些
    const minW = node.kind === 'group' ? 80 : 40;
    const minH = node.kind === 'group' ? 60 : 30;
    node.w = Math.max(minW, Math.round(drag.ow + dx));
    node.h = Math.max(minH, Math.round(drag.oh + dy));
    const dom = el.nodes.querySelector(`.node[data-id="${node.id}"]`);
    if (dom) {
      dom.style.width = node.w + 'px';
      dom.style.height = node.h + 'px';
    }
    drawEdges();
    return;
  }

  if (drag.mode === 'move') {
    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = true;
    drag.maybeEdit = false;               // 移动过就不算双击
    lastTap = null;
    for (const item of drag.items) {
      const node = getNode(item.id);
      if (!node) continue;
      node.x = Math.round(item.ox + dx);
      node.y = Math.round(item.oy + dy);
      const dom = el.nodes.querySelector(`.node[data-id="${node.id}"]`);
      if (dom) {
        dom.style.left = node.x + 'px';
        dom.style.top = node.y + 'px';
      }
    }
    for (const { e, bends } of drag.bendBackup) {
      e.bends = bends.map(p => ({ x: Math.round(p.x + dx), y: Math.round(p.y + dy) }));
    }
    drawEdges();
    return;
  }

  if (drag.mode === 'wire' && tempPath) {
    const from = getNode(drag.from);
    if (!from) return;
    const toward = toCanvas(ev.clientX, ev.clientY);
    const p1 = portPoint(from, drag.fromSide);
    // 预览也走直角折线，和最终效果一致
    const hoverSide = hoveredPortSide(ev, drag.from) || oppositeSide(drag.fromSide);
    tempPath.setAttribute('d', toPath(routePoints(p1, drag.fromSide, toward, hoverSide)));

    // 提示鼠标当前停在哪个连接点上
    for (const p of el.nodes.querySelectorAll('.port.over')) p.classList.remove('over');
    const overPort = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.port');
    if (overPort && overPort.closest('.node')?.dataset.id !== drag.from) {
      overPort.classList.add('over');
    }
  }
});

function oppositeSide(side) {
  return { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[side] || 'left';
}

function hoveredPortSide(ev, excludeId) {
  const el2 = document.elementFromPoint(ev.clientX, ev.clientY);
  const port = el2?.closest('.port');
  const node = port?.closest('.node');
  if (!port || !node || node.dataset.id === excludeId) return null;
  return port.dataset.side;
}

window.addEventListener('blur', () => {
  el.canvas.classList.remove('panning', 'marqueeing');
});

window.addEventListener('pointerup', ev => {
  if (!drag) return;
  const d = drag;
  drag = null;
  tempPath = null;
  hideMarquee();
  el.canvas.classList.remove('panning', 'marqueeing');

  if (d.mode === 'pan') {
    if (d.moved) {
      // 平移取整，避免拖完留小数导致网格发虚
      view = { x: Math.round(view.x), y: Math.round(view.y) };
      applyView();
    }
    return;
  }

  if (d.mode === 'segs') {
    if (!d.moved) select('edge', d.key);   // 只是点了一下：选中这条线
    else drawEdges();
    sealHistory();
    return;
  }

  if (d.mode === 'marquee') {
    if (d.moved) {
      // 框选：与矩形相交的节点都选上
      const r = el.canvas.getBoundingClientRect();
      const x1 = Math.min(d.startX, d.curX);
      const y1 = Math.min(d.startY, d.curY);
      const x2 = Math.max(d.startX, d.curX);
      const y2 = Math.max(d.startY, d.curY);
      const a = toCanvas(x1 + r.left, y1 + r.top);
      const b = toCanvas(x2 + r.left, y2 + r.top);
      if (!d.shift) clearSelection();
      for (const n of state.nodes) {
        const hitBox = n.x < b.x && n.x + n.w > a.x && n.y < b.y && n.y + n.h > a.y;
        if (hitBox) selection.add(n.id);
      }
      renderNodes();
      drawEdges();
    } else if (d.edge) {
      select('edge', d.edge);            // 点在连线上没拖动：选中它
    } else {
      select(null);                      // 点空白：取消选择
    }
    return;
  }

  if (d.mode === 'draw') {
    // 拖出的范围就是新节点的大小；没拖动则用默认尺寸
    const r = el.canvas.getBoundingClientRect();
    const p1 = toCanvas(d.startX + r.left, d.startY + r.top);
    const p2 = toCanvas(ev.clientX, ev.clientY);
    const isGroup = d.kind === 'group';
    const minW = isGroup ? 80 : 40;
    const minH = isGroup ? 60 : 30;
    const defW = isGroup ? 260 : 140;
    const defH = isGroup ? 180 : 56;

    let w = Math.abs(p2.x - p1.x);
    let h = Math.abs(p2.y - p1.y);
    let x = Math.min(p1.x, p2.x);
    let y = Math.min(p1.y, p2.y);

    if (w < minW || h < minH) {
      // 单击（或拖得太小）：居中出现一个默认大小的节点
      w = defW;
      h = defH;
      x = p1.x - defW / 2;
      y = p1.y - defH / 2;
    }

    const node = {
      id: nextId(),
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
      text: isGroup ? '分组' : '节点',
      kind: isGroup ? 'group' : 'box',
    };
    state.nodes.push(node);
    setTool('select');
    clearSelection();
    selection.add(node.id);
    render();
    sealHistory();
    lastTap = { id: node.id, t: performance.now() };
    return;
  }

  if (d.mode === 'wire') {
    for (const p of el.nodes.querySelectorAll('.port.over')) p.classList.remove('over');
    const dropEl = document.elementFromPoint(ev.clientX, ev.clientY);
    const to = dropEl?.closest('.node')?.dataset.id;
    if (to && to !== d.from) {
      const dropPort = dropEl.closest('.port');
      const toSide = dropPort
        ? dropPort.dataset.side
        : nearestSide(getNode(to), toCanvas(ev.clientX, ev.clientY));
      const edge = { from: d.from, to, fromSide: d.fromSide, toSide };
      if (!state.edges.some(e => edgeKey(e) === edgeKey(edge))) state.edges.push(edge);
    }
    drawEdges();
    sealHistory();
    return;
  }

  if (d.mode === 'resize') {
    // 尺寸变了，容器包住的成员可能增减，重绘让选中框和端口位置对齐
    renderNodes();
    drawEdges();
    sealHistory();
    return;
  }

  // 拖动类操作到这里结束，统一封口（没实际移动就不会留下撤销步）
  if (d.mode === 'move') sealHistory();

  // 双击的第二下：没拖动才算编辑（多选时不进编辑）
  if (d.maybeEdit && !d.moved && selection.size === 1) {
    startEdit(el.nodes.querySelector(`.node[data-id="${d.id}"]`));
  }
  drawEdges();
});

/* ---------------- 编辑框事件 ---------------- */

el.nodes.addEventListener('dblclick', ev => {
  const dom = ev.target.closest('.node');
  if (dom) startEdit(dom);
});

el.nodes.addEventListener('keydown', ev => {
  const t = ev.target;
  if (!t.isContentEditable) return;
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    t.blur();
  } else if (ev.key === 'Escape') {
    t.textContent = t.dataset.before || '';
    t.blur();
  }
  ev.stopPropagation();
});

el.nodes.addEventListener('focusout', ev => {
  const label = ev.target;
  if (!label.classList?.contains('label') || !label.isContentEditable) return;
  label.contentEditable = 'false';
  label.closest('.node')?.classList.remove('editing');
  const node = nodeOf(label);
  if (node) {
    node.text = label.textContent.replace(/\s+/g, ' ').trim() || (node.kind === 'group' ? '分组' : '节点');
    label.textContent = node.text;
    sealHistory();                      // 文本没变就不留下撤销步
  }
});

/* ---------------- 键盘 ---------------- */

document.addEventListener('keydown', ev => {
  const t = ev.target;
  const typing = t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName);

  const mod = ev.ctrlKey || ev.metaKey;
  const hotkey = ev.key.toLowerCase();

  if (mod && hotkey === 's') {
    ev.preventDefault();
    save();
    return;
  }

  // 撤销 / 重做：即使在输入框里也接管，避免和浏览器自己的历史打架
  if (mod && hotkey === 'z' && !ev.shiftKey) {
    ev.preventDefault();
    undo();
    return;
  }
  if (mod && ((hotkey === 'z' && ev.shiftKey) || hotkey === 'y')) {
    ev.preventDefault();
    redo();
    return;
  }

  if (typing) return;

  if (ev.key === 'Home') {          // 节点全部框回视野
    ev.preventDefault();
    resetView();
    return;
  }

  // R：把选中的连线恢复到自动布线（原先是双击线段的动作）
  if (hotkey === 'r' && selectedEdge) {
    const edge = state.edges.find(x => edgeKey(x) === selectedEdge);
    if (edge && Array.isArray(edge.bends) && edge.bends.length) {
      beginHistory();
      delete edge.bends;
      routeCache.clear();
      render();
      sealHistory();
      return;
    }
  }

  // 工具快捷键
  if (hotkey === 'v') return setTool('select');
  if (hotkey === 'b') return setTool('box');
  if (hotkey === 'g') return setTool('group');

  if (ev.key === 'Escape') return select(null);

  if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
  if (!selection.size && !selectedEdge) return;
  ev.preventDefault();
  beginHistory();

  if (selection.size) {
    const ids = new Set(selection);
    state.nodes = state.nodes.filter(n => !ids.has(n.id));
    state.edges = state.edges.filter(e => !ids.has(e.from) && !ids.has(e.to));
  }
  if (selectedEdge) {
    state.edges = state.edges.filter(e => edgeKey(e) !== selectedEdge);
  }
  clearSelection();
  render();
  sealHistory();
});

/* ---------------- 主题 ---------------- */

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  el.theme.textContent = mode === 'dark' ? '亮' : '暗';
  localStorage.setItem('arch-theme', mode);
}

el.theme.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

/* ---------------- 存档 ---------------- */

const currentName = () => (el.name.value || '未命名').trim();

async function listNames() {
  try {
    const r = await fetch(API);
    return r.ok ? await r.json() : [];
  } catch {
    return [];
  }
}

async function refreshList(selectedName) {
  const names = await listNames();
  el.list.textContent = '';
  const opt = document.createElement('option');
  opt.value = '';
  opt.textContent = names.length ? '打开…' : '（暂无存档）';
  el.list.append(opt);
  for (const n of names) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    el.list.append(o);
  }
  if (selectedName) el.list.value = selectedName;
  return names;
}

async function load(name) {
  const doc = await fetch(API + '/' + encodeURIComponent(name)).then(r => r.json());
  if (!doc || !Array.isArray(doc.nodes)) return;
  state.name = name;
  state.nodes = doc.nodes.map(n => ({
    ...n,
    kind: n.kind === 'group' ? 'group' : 'box',
  }));
  state.edges = Array.isArray(doc.edges) ? doc.edges : [];
  view = doc.view && Number.isFinite(doc.view.x) && Number.isFinite(doc.view.y)
    ? { x: doc.view.x, y: doc.view.y }
    : { x: 0, y: 0 };
  // 不能用 nodes.length：删过节点后 id 会撞
  uid = state.nodes.reduce((m, n) => {
    const num = parseInt(String(n.id).slice(1), 10);
    return Math.max(m, Number.isFinite(num) ? num : 0);
  }, 0) + 1;
  el.name.value = name;
  cancelLabelEdit();
  commitEditing();
  clearSelection();
  // 换了一张图，历史不能跨图撤销
  undoStack.length = 0;
  redoStack.length = 0;
  render();
  updateHistoryHint();
}

async function save() {
  commitEditing();
  const name = currentName();
  const res = await fetch(API + '/' + encodeURIComponent(name), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes: state.nodes, edges: state.edges, view }),
  });
  if (!res.ok) return alert('保存失败：HTTP ' + res.status);
  state.name = name;
  el.name.value = name;
  // 存过盘就以此为新的起点，撤销不会退回保存前
  undoStack.length = 0;
  redoStack.length = 0;
  routeCache.clear();
  routeStamp = '';
  await refreshList(name);
  flash('已保存');
}

async function removeCurrent() {
  const name = state.name || el.name.value.trim();
  if (!name) return;
  if (!confirm(`删除存档「${name}」？`)) return;
  await fetch(API + '/' + encodeURIComponent(name), { method: 'DELETE' });
  state.nodes = [];
  state.edges = [];
  state.name = '';
  el.name.value = '';
  view = { x: 0, y: 0 };
  cancelLabelEdit();
  clearSelection();
  undoStack.length = 0;
  redoStack.length = 0;
  render();
  updateHistoryHint();
  await refreshList();
}

let flashTimer = null;
function flash(text) {
  el.save.textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (el.save.textContent = '保存'), 1200);
}

el.save.addEventListener('click', save);
el.del.addEventListener('click', removeCurrent);
el.list.addEventListener('change', () => {
  if (el.list.value) load(el.list.value);
});

/* ---------------- 启动 ---------------- */

(async function init() {
  applyTheme(localStorage.getItem('arch-theme') || 'light');
  setTool('select');
  applyView();
  const names = await refreshList();
  if (names.length) {
    await load(names[0]);
    el.list.value = names[0];
  } else {
    // 空画布先给两个示例方框，否则用户不知道该干什么
    state.nodes = [
      { id: nextId(), x: 80, y: 80, w: 140, h: 56, text: '浏览器', kind: 'box' },
      { id: nextId(), x: 320, y: 80, w: 140, h: 56, text: '服务端', kind: 'box' },
    ];
    state.edges = [{ from: state.nodes[0].id, to: state.nodes[1].id, fromSide: 'right', toSide: 'left' }];
    render();
  }
})();
