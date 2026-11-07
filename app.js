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

/* ---------------- 工具 ---------------- */

const nextId = () => 'n' + (uid++);
const getNode = id => state.nodes.find(n => n.id === id);
const nodeOf = dom => getNode(dom?.closest('.node')?.dataset.id);
const isSel = (kind, id) => selected && selected.kind === kind && selected.id === id;

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

    const port = document.createElement('div');
    port.className = 'port';

    d.append(label, port);
    el.nodes.append(d);
  }
}

function drawEdges() {
  el.wireLayer.textContent = '';
  for (const e of state.edges) {
    const a = getNode(e.from);
    const b = getNode(e.to);
    if (!a || !b) continue;
    const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const d = `M${boundaryPoint(a, cb).x},${boundaryPoint(a, cb).y} ` +
              `L${boundaryPoint(b, ca).x},${boundaryPoint(b, ca).y}`;
    const key = e.from + '->' + e.to;

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

/* ---------------- 拖动 / 连线 ---------------- */

el.nodes.addEventListener('pointerdown', ev => {
  const dom = ev.target.closest('.node');
  if (!dom) return;
  if (ev.target.isContentEditable) return;   // 正在改文字，交给浏览器处理光标
  const node = nodeOf(dom);
  if (!node) return;

  ev.preventDefault();

  if (ev.target.classList.contains('port')) {
    tempPath = document.createElementNS(NS, 'path');
    tempPath.setAttribute('class', 'temp');
    tempPath.setAttribute('d', '');
    drag = { mode: 'wire', from: node.id };
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

window.addEventListener('pointermove', ev => {
  if (!drag) return;

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
    const r = el.canvas.getBoundingClientRect();
    const toward = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    const p1 = boundaryPoint(from, toward);
    tempPath.setAttribute('d', `M${p1.x},${p1.y} L${toward.x},${toward.y}`);
  }
});

window.addEventListener('pointerup', ev => {
  if (!drag) return;
  const d = drag;
  drag = null;
  tempPath = null;

  if (d.mode === 'wire') {
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
    const to = target?.dataset.id;
    if (to && to !== d.from && !state.edges.some(e => e.from === d.from && e.to === to)) {
      state.edges.push({ from: d.from, to });
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

/* ---------------- 画布：双击新建 / 点空白取消选择 ---------------- */

el.canvas.addEventListener('pointerdown', ev => {
  if (ev.target.closest('.node')) return;
  const hit = ev.target.closest('path.hit');
  if (hit) return select('edge', hit.dataset.edge);
  select(null);
});

el.canvas.addEventListener('dblclick', ev => {
  if (ev.target.closest('.node')) return;
  const r = el.canvas.getBoundingClientRect();
  const node = {
    id: nextId(),
    x: Math.round(ev.clientX - r.left - 70),
    y: Math.round(ev.clientY - r.top - 28),
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

/* ---------------- 删除 ---------------- */

document.addEventListener('keydown', ev => {
  const t = ev.target;
  if (t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return;
  if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
  if (!selected) return;
  ev.preventDefault();
  if (selected.kind === 'node') {
    const id = selected.id;
    state.nodes = state.nodes.filter(n => n.id !== id);
    state.edges = state.edges.filter(e => e.from !== id && e.to !== id);
  } else {
    state.edges = state.edges.filter(e => e.from + '->' + e.to !== selected.id);
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
    body: JSON.stringify({ nodes: state.nodes, edges: state.edges }),
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

document.addEventListener('keydown', ev => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
    ev.preventDefault();
    save();
  }
});

/* ---------------- 启动 ---------------- */

(async function init() {
  applyTheme(localStorage.getItem('arch-theme') || 'light');
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
