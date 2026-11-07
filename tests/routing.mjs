// 验证连线绕开节点：路径不与任何节点矩形重叠
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
await cdp.send('Page.navigate', { url: BASE + '/?route=' + Date.now() });
await sleep(2500);

// 在页面里注入一个检测函数：路径线段是否穿过节点矩形（严格内部重叠）
const installProbe = () => cdp.eval(`(() => {
  window.__overlaps = () => {
    const bad = [];
    for (const e of state.edges) {
      const geo = edgeGeometry(e);
      if (!geo) continue;
      const pts = geo.points;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        for (const n of state.nodes) {
          // 两端节点本身不算：线从它的边中点出发
          if (n.id === e.from || n.id === e.to) continue;
          // 容器只是框，线在其内部是正常的
          if (n.kind === 'group') continue;
          const eps = 1.2;
          const inside = (p) => p.x > n.x + eps && p.x < n.x + n.w - eps &&
                                 p.y > n.y + eps && p.y < n.y + n.h - eps;
          if (a.y === b.y) {
            const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
            if (a.y > n.y + eps && a.y < n.y + n.h - eps && hi > n.x + eps && lo < n.x + n.w - eps) {
              bad.push({ edge: e.from + '->' + e.to, node: n.id, seg: [a, b], axis: 'h' });
            }
          } else if (a.x === b.x) {
            const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
            if (a.x > n.x + eps && a.x < n.x + n.w - eps && hi > n.y + eps && lo < n.y + n.h - eps) {
              bad.push({ edge: e.from + '->' + e.to, node: n.id, seg: [a, b], axis: 'v' });
            }
          } else {
            bad.push({ edge: e.from + '->' + e.to, node: n.id, seg: [a, b], axis: 'diag' });
          }
          void inside;
        }
      }
    }
    return bad;
  };
  return 'probe installed';
})()`);

await installProbe();

const setup = (nodes, edges) => cdp.eval(`(() => {
  state.nodes = ${JSON.stringify(nodes)};
  state.edges = ${JSON.stringify(edges)};
  selection.clear(); selectedEdge = null; view = { x: 0, y: 0 };
  setTool('select'); render(); applyView();
})()`);

const orthoOk = async () => cdp.eval(`(() => {
  const out = [];
  for (const e of state.edges) {
    const geo = edgeGeometry(e);
    const ok = geo.points.slice(1).every((p, i) => p.x === geo.points[i].x || p.y === geo.points[i].y);
    out.push({ edge: e.from + '->' + e.to, ok, n: geo.points.length });
  }
  return out;
})()`);

// ---------- 场景 1：直线穿过第三方节点 ----------
await setup([
  { id: 'L', x: 60,  y: 300, w: 120, h: 60, text: '左', kind: 'box' },
  { id: 'R', x: 620, y: 300, w: 120, h: 60, text: '右', kind: 'box' },
  { id: 'M', x: 330, y: 270, w: 140, h: 120, text: '中间', kind: 'box' },
], [{ from: 'L', to: 'R', fromSide: 'right', toSide: 'left' }]);
await sleep(300);

let bad = await cdp.eval('window.__overlaps()');
let ortho = await orthoOk();
check('横穿场景：路径不穿过中间节点', bad.length === 0,
      bad.length ? JSON.stringify(bad) : '无重叠');
check('横穿场景：仍是全直角', ortho.every(o => o.ok),
      JSON.stringify(ortho));

// 像素确认：中间节点中心应该是节点底色，不是线的颜色
const mid = await cdp.eval(`(() => {
  const n = document.querySelector('.node[data-id="M"]').getBoundingClientRect();
  return { x: Math.round(n.left + n.width / 2), y: Math.round(n.top + n.height / 2) };
})()`);
const shot = await cdp.send('Page.captureScreenshot', {
  format: 'png', clip: { x: mid.x, y: mid.y, width: 1, height: 1, scale: 1 },
});
const px = await cdp.eval(`(async () => {
  const img = new Image();
  img.src = 'data:image/png;base64,${shot.data}';
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 1; c.height = 1;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2] };
})()`);
// 无头 Chrome 截图有色彩偏移（蓝色通道偏低），用整体亮度判断明暗更可靠
const brightness = (px.r + px.g + px.b) / 3;
check('中间节点中心是底色（线确实绕开了）', brightness > 180,
      `像素 rgb(${px.r},${px.g},${px.b}) 亮度 ${brightness.toFixed(0)}`);

// ---------- 场景 2：竖直线被挡 ----------
await setup([
  { id: 'T', x: 300, y: 60,  w: 120, h: 60, text: '上', kind: 'box' },
  { id: 'B', x: 300, y: 620, w: 120, h: 60, text: '下', kind: 'box' },
  { id: 'W', x: 270, y: 330, w: 180, h: 80, text: '挡路', kind: 'box' },
], [{ from: 'T', to: 'B', fromSide: 'bottom', toSide: 'top' }]);
await sleep(300);
bad = await cdp.eval('window.__overlaps()');
ortho = await orthoOk();
check('竖向挡路：路径不穿过障碍', bad.length === 0, bad.length ? JSON.stringify(bad) : '无重叠');
check('竖向挡路：仍是全直角', ortho.every(o => o.ok), JSON.stringify(ortho));

// ---------- 场景 3：连续两个障碍 ----------
await setup([
  { id: 'A', x: 60,  y: 400, w: 110, h: 60, text: 'A', kind: 'box' },
  { id: 'Z', x: 830, y: 400, w: 110, h: 60, text: 'Z', kind: 'box' },
  { id: 'O1', x: 260, y: 360, w: 100, h: 140, text: '障1', kind: 'box' },
  { id: 'O2', x: 450, y: 360, w: 100, h: 140, text: '障2', kind: 'box' },
  { id: 'O3', x: 640, y: 360, w: 100, h: 140, text: '障3', kind: 'box' },
], [{ from: 'A', to: 'Z', fromSide: 'right', toSide: 'left' }]);
await sleep(300);
bad = await cdp.eval('window.__overlaps()');
ortho = await orthoOk();
check('连续多障碍：路径不穿过任何障碍', bad.length === 0, bad.length ? JSON.stringify(bad) : '无重叠');
check('连续多障碍：仍是全直角', ortho.every(o => o.ok), JSON.stringify(ortho));

// ---------- 场景 4：容器内的方框连线，不应穿过容器边框内的其它方框 ----------
await setup([
  { id: 'G', x: 100, y: 100, w: 400, h: 260, text: '分组', kind: 'group' },
  { id: 'P', x: 140, y: 160, w: 100, h: 50, text: 'P', kind: 'box' },
  { id: 'Q', x: 340, y: 160, w: 100, h: 50, text: 'Q', kind: 'box' },
  { id: 'MID', x: 240, y: 150, w: 80, h: 70, text: '挡', kind: 'box' },
], [{ from: 'P', to: 'Q', fromSide: 'right', toSide: 'left' }]);
await sleep(300);
bad = await cdp.eval('window.__overlaps()');
check('容器内连线也绕开挡路方框', bad.length === 0, bad.length ? JSON.stringify(bad) : '无重叠');

// ---------- 场景 5：无障碍时应尽量少拐弯 ----------
await setup([
  { id: 'S', x: 100, y: 100, w: 120, h: 60, text: 'S', kind: 'box' },
  { id: 'E', x: 500, y: 100, w: 120, h: 60, text: 'E', kind: 'box' },
], [{ from: 'S', to: 'E', fromSide: 'right', toSide: 'left' }]);
await sleep(250);
const straight = await cdp.eval(`(() => {
  const geo = edgeGeometry(state.edges[0]);
  return { n: geo.points.length, pts: geo.points };
})()`);
check('无障碍同高度时是直线（2 个点）', straight.n === 2,
      JSON.stringify(straight.pts));

// ---------- 场景 6：拖动节点后重新绕行 ----------
await setup([
  { id: 'L', x: 60,  y: 300, w: 120, h: 60, text: '左', kind: 'box' },
  { id: 'R', x: 620, y: 300, w: 120, h: 60, text: '右', kind: 'box' },
  { id: 'M', x: 330, y: 270, w: 140, h: 120, text: '中间', kind: 'box' },
], [{ from: 'L', to: 'R', fromSide: 'right', toSide: 'left' }]);
await sleep(250);
const beforeMove = await cdp.eval(`edgeGeometry(state.edges[0]).points.length`);
// 把中间那个节点挪到别处，线应恢复成直的快路径
await cdp.eval(`(() => {
  const m = state.nodes.find(n => n.id === 'M');
  m.y = 620; m.x = 330;
  render();
})()`);
await sleep(250);
const afterMove = await cdp.eval(`(() => ({
  n: edgeGeometry(state.edges[0]).points.length,
  overlaps: window.__overlaps().length,
}))()`);
check('挪走障碍后连线恢复直线', afterMove.n === 2 && afterMove.overlaps === 0,
      `拐弯前 ${beforeMove} 点 -> 挪走后 ${afterMove.n} 点，重叠=${afterMove.overlaps}`);

// ---------- 场景 7：性能（拖动时不卡）----------
await setup(
  Array.from({ length: 12 }, (_, i) => ({
    id: 'n' + i, x: 60 + (i % 4) * 170, y: 80 + Math.floor(i / 4) * 180,
    w: 120, h: 60, text: 'n' + i, kind: 'box',
  })),
  Array.from({ length: 10 }, (_, i) => ({
    from: 'n' + i, to: 'n' + (i + 2), fromSide: 'right', toSide: 'left',
  }))
);
await sleep(300);
const perf = await cdp.eval(`(() => {
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) {
    routeStamp = '';       // 强制清缓存，模拟节点移动
    drawEdges();
  }
  return { ms: (performance.now() - t0) / 20 };
})()`);
check('12 节点 10 连线单帧耗时 < 40ms', perf.ms < 40, `平均 ${perf.ms.toFixed(1)}ms/帧`);

bad = await cdp.eval('window.__overlaps()');
check('12 节点场景也无重叠', bad.length === 0, bad.length ? `重叠 ${bad.length} 处` : '无重叠');

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
