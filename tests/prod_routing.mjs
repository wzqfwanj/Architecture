// 线上验证：连线绕开节点
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
await cdp.send('Page.navigate', { url: BASE + '?rt=' + Date.now() });
await sleep(4500);

// 线上装一个重叠检测
const probe = await cdp.eval(`(() => {
  window.__bad = () => {
    const out = [];
    for (const e of state.edges) {
      const geo = edgeGeometry(e);
      if (!geo) continue;
      const pts = geo.points;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        for (const n of state.nodes) {
          if (n.id === e.from || n.id === e.to || n.kind === 'group') continue;
          const eps = 1.2;
          if (a.y === b.y) {
            const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
            if (a.y > n.y + eps && a.y < n.y + n.h - eps && hi > n.x + eps && lo < n.x + n.w - eps) out.push(n.id);
          } else if (a.x === b.x) {
            const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
            if (a.x > n.x + eps && a.x < n.x + n.w - eps && hi > n.y + eps && lo < n.y + n.h - eps) out.push(n.id);
          } else {
            out.push('diag:' + n.id);
          }
        }
      }
    }
    return out;
  };
  return typeof astar === 'function' && typeof routePoints === 'function';
})()`);
check('线上已部署绕行逻辑', probe === true, `astar/routePoints 存在=${probe}`);

const setup = (nodes, edges) => cdp.eval(`(() => {
  state.nodes = ${JSON.stringify(nodes)};
  state.edges = ${JSON.stringify(edges)};
  selection.clear(); selectedEdge = null; view = { x: 0, y: 0 };
  setTool('select'); render(); applyView();
})()`);

// 1. 横穿场景
await setup([
  { id: 'L', x: 60,  y: 300, w: 120, h: 60, text: '左', kind: 'box' },
  { id: 'R', x: 620, y: 300, w: 120, h: 60, text: '右', kind: 'box' },
  { id: 'M', x: 330, y: 270, w: 140, h: 120, text: '中间', kind: 'box' },
], [{ from: 'L', to: 'R', fromSide: 'right', toSide: 'left' }]);
await sleep(350);

const bad1 = await cdp.eval('window.__bad()');
const geo1 = await cdp.eval(`(() => {
  const g = edgeGeometry(state.edges[0]);
  return { n: g.points.length, ortho: g.points.slice(1).every((p, i) => p.x === g.points[i].x || p.y === g.points[i].y) };
})()`);
check('线上横穿障碍时绕开', bad1.length === 0, bad1.length ? JSON.stringify(bad1) : '无重叠');
check('线上绕行仍是全直角', geo1.ortho === true, `折点数=${geo1.n}`);

// 2. 像素：中间节点中心是底色
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
const bright = (px.r + px.g + px.b) / 3;
check('线上节点中心是底色（线真的绕开了）', bright > 180, `像素 rgb(${px.r},${px.g},${px.b}) 亮度 ${bright.toFixed(0)}`);

// 3. 多障碍
await setup([
  { id: 'A', x: 60,  y: 420, w: 110, h: 60, text: 'A', kind: 'box' },
  { id: 'Z', x: 860, y: 420, w: 110, h: 60, text: 'Z', kind: 'box' },
  { id: 'O1', x: 260, y: 380, w: 100, h: 140, text: '障1', kind: 'box' },
  { id: 'O2', x: 450, y: 380, w: 100, h: 140, text: '障2', kind: 'box' },
  { id: 'O3', x: 640, y: 380, w: 100, h: 140, text: '障3', kind: 'box' },
], [{ from: 'A', to: 'Z', fromSide: 'right', toSide: 'left' }]);
await sleep(350);
const bad2 = await cdp.eval('window.__bad()');
check('线上连续障碍也绕开', bad2.length === 0, bad2.length ? JSON.stringify(bad2) : '无重叠');

// 4. 容器内成员互连不受容器影响
await setup([
  { id: 'G', x: 100, y: 100, w: 420, h: 260, text: '分组', kind: 'group' },
  { id: 'P', x: 140, y: 160, w: 100, h: 50, text: 'P', kind: 'box' },
  { id: 'Q', x: 380, y: 160, w: 100, h: 50, text: 'Q', kind: 'box' },
  { id: 'MID', x: 250, y: 150, w: 80, h: 70, text: '挡', kind: 'box' },
], [{ from: 'P', to: 'Q', fromSide: 'right', toSide: 'left' }]);
await sleep(350);
const bad3 = await cdp.eval('window.__bad()');
check('线上容器内连线绕开挡路方框', bad3.length === 0, bad3.length ? JSON.stringify(bad3) : '无重叠');

// 5. 空白处双击仍能新建（绕行后点线不误伤）
await setup([
  { id: 'S', x: 100, y: 100, w: 120, h: 60, text: 'S', kind: 'box' },
  { id: 'E', x: 700, y: 400, w: 120, h: 60, text: 'E', kind: 'box' },
], [{ from: 'S', to: 'E', fromSide: 'right', toSide: 'top' }]);
await sleep(300);
const onWire = await cdp.eval(`(() => {
  const p = document.querySelector('#wireLayer path');
  const pt = p.getPointAtLength(p.getTotalLength() / 2);
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { x: Math.round(r.left + pt.x), y: Math.round(r.top + pt.y) };
})()`);
const countBefore = await cdp.eval("document.querySelectorAll('.node').length");
for (const cc of [1, 2]) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: onWire.x, y: onWire.y, button: 'left', buttons: 1, clickCount: cc, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: onWire.x, y: onWire.y, button: 'left', buttons: 0, clickCount: cc, pointerType: 'mouse' });
  await sleep(70);
}
await sleep(400);
const countAfter = await cdp.eval("document.querySelectorAll('.node').length");
check('线上在连线位置双击也能新建节点', countAfter === countBefore + 1,
      `${countBefore} -> ${countAfter}（双击点 ${onWire.x},${onWire.y}）`);

// 6. 性能
const perf = await cdp.eval(`(() => {
  state.nodes = Array.from({ length: 12 }, (_, i) => ({
    id: 'n' + i, x: 60 + (i % 4) * 170, y: 80 + Math.floor(i / 4) * 180,
    w: 120, h: 60, text: 'n' + i, kind: 'box',
  }));
  state.edges = Array.from({ length: 10 }, (_, i) => ({
    from: 'n' + i, to: 'n' + (i + 2), fromSide: 'right', toSide: 'left',
  }));
  setTool('select'); render(); applyView();
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) { routeStamp = ''; drawEdges(); }
  return { ms: (performance.now() - t0) / 20, bad: window.__bad().length };
})()`);
check('线上 12 节点 10 连线单帧 < 40ms', perf.ms < 40, `${perf.ms.toFixed(1)}ms/帧`);
check('线上 12 节点场景无重叠', perf.bad === 0, `重叠 ${perf.bad} 处`);

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
