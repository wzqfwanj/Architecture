// 验证四个方向都能连线
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
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: BASE + '/?ports=' + Date.now() });
await sleep(2500);

const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse',
});

// 把画布清空，摆两个已知坐标的节点，方便算坐标
const setup = async () => {
  await cdp.eval(`(() => {
    state.nodes = [
      { id: 'n1', x: 200, y: 150, w: 140, h: 56, text: 'A' },
      { id: 'n2', x: 500, y: 350, w: 140, h: 56, text: 'B' },
    ];
    state.edges = [];
    selected = null;
    view = { x: 0, y: 0 };
    render();
    applyView();
  })()`);
  await sleep(150);
};

// 取某个节点某条边连接点的屏幕坐标
const portScreen = (nodeId, side) => cdp.eval(`(() => {
  const p = document.querySelector('.node[data-id="${nodeId}"] .port[data-side="${side}"]');
  const r = p.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);

// 从某处拖到某处（先 hover 让连接点可点）
const dragTo = async (from, to) => {
  await mouse('mouseMoved', from.x, from.y);
  await sleep(60);
  await mouse('mousePressed', from.x, from.y);
  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', from.x + ((to.x - from.x) / 6) * i, from.y + ((to.y - from.y) / 6) * i);
    await sleep(25);
  }
  await mouse('mouseReleased', to.x, to.y);
  await sleep(250);
};

// ===== 1. 每个节点四个连接点 =====
const ports = await cdp.eval(`(() => {
  const n = document.querySelector('.node');
  const sides = [...n.querySelectorAll('.port')].map(p => p.dataset.side).sort();
  return { count: n.querySelectorAll('.port').length, sides };
})()`);
check('节点有四个连接点', ports.count === 4 && JSON.stringify(ports.sides) === JSON.stringify(['bottom', 'left', 'right', 'top']),
      `count=${ports.count} sides=${ports.sides.join(',')}`);

// ===== 2. 四个方向分别连一次 =====
const pairs = [
  ['top', 'bottom'],
  ['right', 'left'],
  ['bottom', 'top'],
  ['left', 'right'],
];

for (const [fromSide, toSide] of pairs) {
  await setup();
  const a = await portScreen('n1', fromSide);
  const b = await portScreen('n2', toSide);
  await dragTo(a, b);

  const edge = await cdp.eval(`(() => {
    const e = state.edges[0];
    if (!e) return null;
    const p = portPoint(getNode(e.from), e.fromSide);
    const q = portPoint(getNode(e.to), e.toSide);
    const path = document.querySelector('#wireLayer path:not(.hit)');
    return { ...e, p, q, d: path?.getAttribute('d'), total: state.edges.length };
  })()`);

  const ok = edge && edge.fromSide === fromSide && edge.toSide === toSide &&
             edge.p.x === 200 + (fromSide === 'right' ? 140 : fromSide === 'left' ? 0 : 70) &&
             edge.q.x === 500 + (toSide === 'right' ? 140 : toSide === 'left' ? 0 : 70) &&
             edge.total === 1;
  check(`${fromSide} -> ${toSide} 连线`, !!ok,
        edge ? `起点(${edge.p.x},${edge.p.y}) 终点(${edge.q.x},${edge.q.y}) path=${edge.d}` : '没有生成连线');
}

// ===== 3. 连线渲染的起点确实是边中点，不是边界交点 =====
await setup();
const aTop = await portScreen('n1', 'top');
const bBottom = await portScreen('n2', 'bottom');
await dragTo(aTop, bBottom);
const rendered = await cdp.eval(`(() => {
  const d = document.querySelector('#wireLayer path:not(.hit)').getAttribute('d');
  const m = d.match(/M([-\\d.]+),([-\\d.]+) L([-\\d.]+),([-\\d.]+)/);
  return { d, from: { x: +m[1], y: +m[2] }, to: { x: +m[3], y: +m[4] } };
})()`);
check('连线从边中点出发到边中点',
      rendered.from.x === 270 && rendered.from.y === 150 && rendered.to.x === 570 && rendered.to.y === 406,
      `${JSON.stringify(rendered.from)} -> ${JSON.stringify(rendered.to)}`);

// ===== 4. 拖到节点中央（没对准连接点）自动吸附最近的边 =====
await setup();
const aCenter = await cdp.eval(`(() => {
  const r = document.querySelector('.node[data-id="n1"]').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
const bNode = await cdp.eval(`(() => {
  const r = document.querySelector('.node[data-id="n2"]').getBoundingClientRect();
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
})()`);
// 从 A 右侧连接点拖到 B 的左上角区域（不是连接点）
const aRight = await portScreen('n1', 'right');
await dragTo(aRight, { x: bNode.cx - 60, y: bNode.cy - 20 });
const snapped = await cdp.eval(`(() => ({ e: state.edges[0] || null, n: state.edges.length }))()`);
check('落在节点空白处自动吸附最近边', snapped.n === 1 && ['top', 'left'].includes(snapped.e?.toSide),
      `toSide=${snapped.e?.toSide} fromSide=${snapped.e?.fromSide}`);

// ===== 5. 同一对连接点不重复连 =====
const aR = await portScreen('n1', 'right');
const bL = await portScreen('n2', 'left');
await setup();
await dragTo(aR, bL);
await dragTo(aR, bL);
const dup = await cdp.eval('state.edges.length');
check('同一对连接点不重复', dup === 1, `连线数=${dup}`);

// ===== 6. 不同方向的同一对节点可以各连一条 =====
await dragTo(await portScreen('n1', 'bottom'), await portScreen('n2', 'top'));
const multi = await cdp.eval(`state.edges.map(e => e.fromSide + '->' + e.toSide)`);
check('同一对节点可连不同方向', multi.length === 2, JSON.stringify(multi));

// ===== 7. 存档往返保留方向 =====
await cdp.eval(`(() => { document.getElementById('name').value = '四向测试'; document.getElementById('save').click(); })()`);
await sleep(1000);
const doc = await fetch(BASE + '/api/diagrams/' + encodeURIComponent('四向测试')).then(r => r.json());
check('存档保存方向', doc.edges?.length === 2 && doc.edges.every(e => e.fromSide && e.toSide),
      JSON.stringify(doc.edges));

await cdp.send('Page.navigate', { url: BASE + '/?reload=' + Date.now() });
await sleep(2200);
const after = await cdp.eval(`(() => ({
  edges: state.edges.map(e => e.fromSide + '->' + e.toSide),
  paths: [...document.querySelectorAll('#wireLayer path:not(.hit)')].map(p => p.getAttribute('d')),
}))()`);
check('重开保留方向且渲染一致', after.edges.length === 2 && after.paths.length === 2,
      `${JSON.stringify(after.edges)} paths=${after.paths.length}`);

// ===== 8. 旧存档（无方向字段）仍能渲染 =====
await cdp.eval(`(() => {
  state.nodes = [
    { id: 'm1', x: 100, y: 100, w: 140, h: 56, text: '旧A' },
    { id: 'm2', x: 400, y: 100, w: 140, h: 56, text: '旧B' },
  ];
  state.edges = [{ from: 'm1', to: 'm2' }];
  view = { x: 0, y: 0 };
  render();
})()`);
await sleep(200);
const legacy = await cdp.eval(`(() => {
  const p = document.querySelector('#wireLayer path:not(.hit)');
  return { d: p?.getAttribute('d') || null, n: state.edges.length };
})()`);
check('旧存档无方向也能画线', !!legacy.d && /^M[\d.]+,[\d.]+ L[\d.]+,[\d.]+$/.test(legacy.d), `path=${legacy.d}`);

await fetch(BASE + '/api/diagrams/' + encodeURIComponent('四向测试'), { method: 'DELETE' });

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
