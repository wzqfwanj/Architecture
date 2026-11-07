// Architecture —— 极简架构图编辑器
// 相对路径，方便挂在反向代理的子路径下（如 /arch/）
const API = 'api/diagrams';
const NS = 'http://www.w3.org/2000/svg';

const el = {
  canvas: document.getElementById('canvas'),
  nodes: document.getElementById('nodes'),
  wireLayer: document.getElementById('wireLayer'),
  name: document.getElementById('name'),
  list: document.getElementById('list'),
  save: document.getElementById('save'),
  del: document.getElementById('del'),
  theme: document.getElementById('theme'),
};

const state = { name: '', nodes: [], edges: [] };
let selected = null;      // { kind: 'node'|'edge', id }
let uid = 1;
let tempPath = null;
let lastTap = null;
let drag = null;
// 画布视图位移：节点坐标不变，只移动整个视图，方便画大图
let view = { x: 0, y: 0 };

/* ---------------- 工具 ---------------- */

const SIDES = ['top', 'right', 'bottom', 'left'];
const nextId = () => 'n' + (uid++);
const getNode = id => state.nodes.find(n => n.id === id);
const nodeOf = dom => getNode(dom?.closest('.node')?.dataset.id);
const isSel = (kind, id) => selected && selected.kind === kind && selected.id === id;

// 屏幕坐标 -> 画布坐标（要减掉视图位移）
function toCanvas(clientX, clientY) {
  const r = el.canvas.getBoundingClientRect();
  return { x: clientX - r.left - view.x, y: clientY - r.top - view.y };
}

// 把视图位移应用到三层：节点层、连线层、背景网格
function applyView() {
  el.nodes.style.transform = `translate(${view.x}px, ${view.y}px)`;
  el.wireLayer.setAttribute('transform', `translate(${view.x} ${view.y})`);
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

// 连线的唯一标识：同一个连接点之间才算重复
const edgeKey = e => `${e.from}->${e.to}@${e.fromSide || ''}|${e.toSide || ''}`;

// 从矩形中心朝目标点方向，取矩形边界上的交点
function boundaryPoint(node, toward) {
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const sx = Math.abs(dx) < 1e-6 ? Infinity : (node.w / 2) / Math.abs(dx);
  const sy = Math.abs(dy) < 1e-6 ? Infinity : (node.h / 2) / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

/* ---------------- 渲染 ---------------- */

function renderNodes() {
  el.nodes.textContent = '';
  for (const n of state.nodes) {
    const d = document.createElement('div');
    d.className = 'node' + (isSel('node', n.id) ? ' sel' : '');
    d.dataset.id = n.id;
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
    el.nodes.append(d);
  }
  applyView();
}

function drawEdges() {
  el.wireLayer.textContent = '';
  for (const e of state.edges) {
    const a = getNode(e.from);
    const b = getNode(e.to);
    if (!a || !b) continue;
    const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    // 有记录方向就从那条边中点出发；旧存档没有方向，退化为边界交点
    const p1 = e.fromSide ? portPoint(a, e.fromSide) : boundaryPoint(a, cb);
    const p2 = e.toSide ? portPoint(b, e.toSide) : boundaryPoint(b, ca);
    const d = `M${p1.x},${p1.y} L${p2.x},${p2.y}`;
    const key = edgeKey(e);

    const hit = document.createElementNS(NS, 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'hit');
    hit.dataset.edge = key;

    const line = document.createElementNS(NS, 'path');
    line.setAttribute('d', d);
    line.setAttribute('marker-end', 'url(#arrow)');
    if (isSel('edge', key)) line.setAttribute('class', 'sel');

    el.wireLayer.append(hit, line);
  }
  if (tempPath) el.wireLayer.append(tempPath);
  el.wireLayer.setAttribute('transform', `translate(${view.x} ${view.y})`);
}

// 正在编辑的文字先落回 state，否则重绘会把它丢掉
function commitEditing() {
  const label = el.nodes.querySelector('.label[contenteditable="true"]');
  if (label) label.blur();   // blur 同步触发 focusout，由那里写回 state
}

function render() {
  renderNodes();
  drawEdges();
}

function select(kind, id) {
  commitEditing();
  selected = kind ? { kind, id } : null;
  renderNodes();
  drawEdges();
}

// 只切换选中样式，不重建 DOM：按住的那个元素被移除，触屏上会直接触发 pointercancel
function markSelection() {
  for (const d of el.nodes.children) {
    d.classList.toggle('sel', isSel('node', d.dataset.id));
  }
}

/* ---------------- 文字编辑 ---------------- */

function startEdit(dom) {
  const label = dom?.querySelector('.label');
  if (!label || label.isContentEditable) return;
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

/* ---------------- 拖动节点 / 连线 ---------------- */

el.nodes.addEventListener('pointerdown', ev => {
  if (ev.button !== 0) return;   // 中键 / 右键交给画布处理
  const dom = ev.target.closest('.node');
  if (!dom) return;
  if (ev.target.isContentEditable) return;   // 正在改文字，交给浏览器处理光标
  const node = nodeOf(dom);
  if (!node) return;

  ev.preventDefault();

  const port = ev.target.closest('.port');
  if (port) {
    tempPath = document.createElementNS(NS, 'path');
    tempPath.setAttribute('class', 'temp');
    tempPath.setAttribute('d', '');
    drag = { mode: 'wire', from: node.id, fromSide: port.dataset.side };
    drawEdges();
    return;
  }

  // 双击才进编辑，但要等松手且确认没移动才生效。
  // 否则「点一下、再按下拖动」会被当成双击，表现为拖不动。
  const now = performance.now();
  const maybeEdit = !!(lastTap && lastTap.id === node.id && now - lastTap.t < 400);
  lastTap = maybeEdit ? null : { id: node.id, t: now };

  commitEditing();
  selected = { kind: 'node', id: node.id };
  markSelection();
  drawEdges();

  drag = {
    mode: 'move',
    id: node.id,
    startX: ev.clientX,
    startY: ev.clientY,
    ox: node.x,
    oy: node.y,
    moved: false,
    maybeEdit,
  };
});

/* ---------------- 拖动画布（平移） ---------------- */

// 中键默认会拉起自动滚动，一并挡掉，否则拖画布时页面会乱跳
el.canvas.addEventListener('mousedown', ev => {
  if (ev.button === 1) ev.preventDefault();
});
el.canvas.addEventListener('auxclick', ev => {
  if (ev.button === 1) ev.preventDefault();
});

el.canvas.addEventListener('pointerdown', ev => {
  const onNode = !!ev.target.closest('.node');
  const middle = ev.button === 1;
  // 中键：任何位置都能拖画布（包括按在节点上）
  // 左键：只在空白处拖画布，按在节点上交给节点自己处理
  if (!middle && (onNode || ev.button !== 0)) return;

  ev.preventDefault();
  // 落在连线上也允许平移；松手时没移动才当作选中连线
  const hit = middle ? null : ev.target.closest('path.hit');
  el.canvas.classList.add('panning');
  drag = {
    mode: 'pan',
    middle,
    startX: ev.clientX,
    startY: ev.clientY,
    ox: view.x,
    oy: view.y,
    moved: false,
    edge: hit ? hit.dataset.edge : null,
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

  if (drag.mode === 'move') {
    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = true;
    drag.maybeEdit = false;               // 移动过就不算双击
    lastTap = null;
    const node = getNode(drag.id);
    node.x = Math.round(drag.ox + dx);
    node.y = Math.round(drag.oy + dy);
    const dom = el.nodes.querySelector(`.node[data-id="${node.id}"]`);
    if (dom) {
      dom.style.left = node.x + 'px';
      dom.style.top = node.y + 'px';
    }
    drawEdges();
  } else if (drag.mode === 'wire' && tempPath) {
    const from = getNode(drag.from);
    if (!from) return;
    const toward = toCanvas(ev.clientX, ev.clientY);
    const p1 = portPoint(from, drag.fromSide);
    tempPath.setAttribute('d', `M${p1.x},${p1.y} L${toward.x},${toward.y}`);
    // 提示鼠标当前停在哪个连接点上
    const overEl = document.elementFromPoint(ev.clientX, ev.clientY);
    const overPort = overEl?.closest('.port');
    for (const p of el.nodes.querySelectorAll('.port.over')) p.classList.remove('over');
    if (overPort && overPort.closest('.node')?.dataset.id !== drag.from) {
      overPort.classList.add('over');
    }
  }
});

window.addEventListener('blur', () => el.canvas.classList.remove('panning'));

window.addEventListener('pointerup', ev => {
  if (!drag) return;
  const d = drag;
  drag = null;
  tempPath = null;

  if (d.mode === 'pan') {
    el.canvas.classList.remove('panning');
    if (d.moved) {
      // 平移取整，避免拖完留小数导致网格发虚
      view = { x: Math.round(view.x), y: Math.round(view.y) };
      applyView();
    } else if (d.middle) {
      // 中键点一下不动：什么都不做，别打乱当前选择
    } else if (d.edge) {
      select('edge', d.edge);            // 点在连线上没拖动：选中它
    } else {
      select(null);                      // 点空白：取消选择
    }
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
    return;
  }

  // 双击的第二下：没拖动才算编辑
  if (d.maybeEdit && !d.moved) {
    startEdit(el.nodes.querySelector(`.node[data-id="${d.id}"]`));
  }
  drawEdges();
});

/* ---------------- 画布：双击新建 ---------------- */

el.canvas.addEventListener('dblclick', ev => {
  if (ev.target.closest('.node')) return;
  const p = toCanvas(ev.clientX, ev.clientY);
  const node = {
    id: nextId(),
    x: Math.round(p.x - 70),
    y: Math.round(p.y - 28),
    w: 140,
    h: 56,
    text: '节点',
  };
  state.nodes.push(node);
  render();
  select('node', node.id);
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
    node.text = label.textContent.replace(/\s+/g, ' ').trim() || '节点';
    label.textContent = node.text;
  }
});

/* ---------------- 键盘 ---------------- */

document.addEventListener('keydown', ev => {
  const t = ev.target;
  const typing = t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName);

  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
    ev.preventDefault();
    save();
    return;
  }
  if (typing) return;

  if (ev.key === 'Home') {          // 节点全部框回视野
    ev.preventDefault();
    resetView();
    return;
  }
  if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
  if (!selected) return;
  ev.preventDefault();
  if (selected.kind === 'node') {
    const id = selected.id;
    state.nodes = state.nodes.filter(n => n.id !== id);
    state.edges = state.edges.filter(e => e.from !== id && e.to !== id);
  } else {
    state.edges = state.edges.filter(e => edgeKey(e) !== selected.id);
  }
  selected = null;
  render();
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
  state.nodes = doc.nodes;
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
  commitEditing();
  selected = null;
  render();
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
  selected = null;
  render();
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
  applyView();
  const names = await refreshList();
  if (names.length) {
    await load(names[0]);
    el.list.value = names[0];
  } else {
    // 空画布先给两个示例方框，否则用户不知道该干什么
    state.nodes = [
      { id: nextId(), x: 80, y: 80, w: 140, h: 56, text: '浏览器' },
      { id: nextId(), x: 320, y: 80, w: 140, h: 56, text: '服务端' },
    ];
    state.edges = [{ from: state.nodes[0].id, to: state.nodes[1].id }];
    render();
  }
})();
