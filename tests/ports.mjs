// 验证四向连线 + 直角折线
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

const setup = async () => {
  await cdp.eval(`(() => {
    state.nodes = [
      { id: 'n1', x: 200, y: 150, w: 140, h: 56, text: 'A', kind: 'box' },
      { id: 'n2', x: 500, y: 350, w: 140, h: 56, text: 'B', kind: 'box' },
    ];
    state.edges = [];
    selection.clear(); selectedEdge = null;
    view = { x: 0, y: 0 };
    render();
    applyView();
  })()`);
  await sleep(150);
};

const portScreen = (nodeId, side) => cdp.eval(`(() => {
  const p = document.querySelector('.node[data-id="${nodeId}"] .port[data-side="${side}"]');
  const r = p.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);

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

// 把 path 的 d 拆成点
const parsePath = d => [...d.matchAll(/([ML])(-?[\d.]+),(-?[\d.]+)/g)]
  .map(m => ({ cmd: m[1], x: +m[2], y: +m[3] }));

// 每一段都必须水平或垂直
const isOrthogonal = pts => pts.slice(1).every((p, i) => p.x === pts[i].x || p.y === pts[i].y);

// ===== 1. 每个节点四个连接点 =====
const ports = await cdp.eval(`(() => {
  const n = document.querySelector('.node');
  const sides = [...n.querySelectorAll('.port')].map(p => p.dataset.side).sort();
  return { count: n.querySelectorAll('.port').length, sides };
})()`);
check('节点有四个连接点', ports.count === 4 && JSON.stringify(ports.sides) === JSON.stringify(['bottom', 'left', 'right', 'top']),
      `count=${ports.count} sides=${ports.sides.join(',')}`);

// ===== 2. 四个方向分别连一次，起点终点落在边中点 =====
const pairs = [['top', 'bottom'], ['right', 'left'], ['bottom', 'top'], ['left', 'right']];

for (const [fromSide, toSide] of pairs) {
  await setup();
  await dragTo(await portScreen('n1', fromSide), await portScreen('n2', toSide));

  const info = await cdp.eval(`(() => {
    const e = state.edges[0];
    if (!e) return null;
    const geo = edgeGeometry(e);
    return { ...e, p1: geo.p1, p2: geo.p2, pts: geo.points, total: state.edges.length,
             d: document.querySelector('#wireLayer path')?.getAttribute('d') };
  })()`);

  const expectP1 = { top: [270, 150], right: [340, 178], bottom: [270, 206], left: [200, 178] }[fromSide];
  const expectP2 = { top: [570, 350], right: [640, 378], bottom: [570, 406], left: [500, 378] }[toSide];
  const pts = info ? info.pts : [];
  const ok = info &&
    info.fromSide === fromSide && info.toSide === toSide && info.total === 1 &&
    info.p1.x === expectP1[0] && info.p1.y === expectP1[1] &&
    info.p2.x === expectP2[0] && info.p2.y === expectP2[1] &&
    isOrthogonal(pts) &&
    pts[0].x === expectP1[0] && pts[0].y === expectP1[1] &&
    pts[pts.length - 1].x === expectP2[0] && pts[pts.length - 1].y === expectP2[1];

  check(`${fromSide} -> ${toSide} 直角连线`, !!ok,
        info ? `起点(${info.p1.x},${info.p1.y}) 终点(${info.p2.x},${info.p2.y}) 折点数=${pts.length} 全直角=${isOrthogonal(pts)} d=${info.d}` : '没有生成连线');
}

// ===== 3. 斜向的两个节点：路径必须是多段直角折线，不是斜直线 =====
await setup();
await dragTo(await portScreen('n1', 'right'), await portScreen('n2', 'left'));
const ortho = await cdp.eval(`(() => {
  const d = document.querySelector('#wireLayer path').getAttribute('d');
  const geo = edgeGeometry(state.edges[0]);
  return { d, pts: geo.points };
})()`);
const parsed = parsePath(ortho.d);
check('斜向连线是直角折线而非直线',
      parsed.length >= 3 && isOrthogonal(ortho.pts) && ortho.pts.length >= 3,
      `段数=${parsed.length} 折点=${JSON.stringify(ortho.pts)}`);

// ===== 4. 落在节点空白处自动吸附最近边 =====
await setup();
const bCenter = await cdp.eval(`(() => {
  const r = document.querySelector('.node[data-id="n2"]').getBoundingClientRect();
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
})()`);
await dragTo(await portScreen('n1', 'right'), { x: bCenter.cx - 60, y: bCenter.cy - 20 });
const snapped = await cdp.eval(`(() => ({ e: state.edges[0] || null, n: state.edges.length }))()`);
check('落在节点空白处自动吸附最近边', snapped.n === 1 && ['top', 'left'].includes(snapped.e?.toSide),
      `toSide=${snapped.e?.toSide} fromSide=${snapped.e?.fromSide}`);

// ===== 5. 同一对连接点不重复连 =====
await setup();
const aR = await portScreen('n1', 'right');
const bL = await portScreen('n2', 'left');
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
  paths: [...document.querySelectorAll('#wireLayer path')].map(p => p.getAttribute('d')),
  ortho: state.edges.every(e => {
    const g = edgeGeometry(e);
    return g.points.slice(1).every((p, i) => p.x === g.points[i].x || p.y === g.points[i].y);
  }),
}))()`);
check('重开保留方向且仍是直角', after.edges.length === 2 && after.paths.length === 2 && after.ortho,
      `${JSON.stringify(after.edges)} 直角=${after.ortho}`);

// ===== 8. 旧存档（无方向字段）推导方向后仍画直角 =====
await cdp.eval(`(() => {
  state.nodes = [
    { id: 'm1', x: 100, y: 100, w: 140, h: 56, text: '旧A', kind: 'box' },
    { id: 'm2', x: 400, y: 260, w: 140, h: 56, text: '旧B', kind: 'box' },
  ];
  state.edges = [{ from: 'm1', to: 'm2' }];
  view = { x: 0, y: 0 };
  render();
})()`);
await sleep(200);
const legacy = await cdp.eval(`(() => {
  const p = document.querySelector('#wireLayer path');
  const geo = edgeGeometry(state.edges[0]);
  return { d: p?.getAttribute('d') || null, pts: geo.points, s1: geo.s1, s2: geo.s2 };
})()`);
const legacyOk = legacy.d && legacy.pts.length >= 3 &&
  isOrthogonal(legacy.pts) && legacy.s1 === 'right' && legacy.s2 === 'left';
check('旧存档无方向也能画直角', !!legacyOk,
      `推得 ${legacy.s1}->${legacy.s2} 折点=${JSON.stringify(legacy.pts)}`);

await fetch(BASE + '/api/diagrams/' + encodeURIComponent('四向测试'), { method: 'DELETE' });

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
