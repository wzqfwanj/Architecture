// 线上验证：线不被节点遮挡、手柄已移除、交互不回退
import { readFileSync } from 'node:fs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'https://wkeeli.cn/arch/';
const pwd = readFileSync('arch_password.txt', 'utf8').trim();
const auth = 'Basic ' + Buffer.from('admin:' + pwd, '').toString('base64') ||
             'Basic ' + Buffer.from('admin:' + pwd, 'utf8').toString('base64');

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
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: BASE + '?lay=' + Date.now() });
await sleep(4500);

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

// 1. 结构
const layers = await cdp.eval(`(() => {
  const wires = document.getElementById('wires');
  const hits = document.getElementById('wireHits');
  const nodes = document.getElementById('nodes');
  return {
    hasHitLayer: !!document.getElementById('hitLayer'),
    wiresZ: getComputedStyle(wires).zIndex,
    nodesZ: getComputedStyle(nodes).zIndex,
    hitsBeforeNodes: !!(hits.compareDocumentPosition(nodes) & Node.DOCUMENT_POSITION_FOLLOWING),
    handleDom: document.querySelectorAll('.resize').length,
  };
})()`);
check('线上已分两层连线', layers.hasHitLayer === true, `hitLayer=${layers.hasHitLayer}`);
check('线上连线在节点之上', layers.wiresZ === '4' && layers.nodesZ === 'auto',
      `wires=${layers.wiresZ} nodes=${layers.nodesZ}`);
check('线上点击层在节点之下', layers.hitsBeforeNodes === true, `DOM 顺序=${layers.hitsBeforeNodes}`);
check('线上无右下角手柄', layers.handleDom === 0, `DOM=${layers.handleDom}`);

// 2. 线与节点重叠处像素
await cdp.eval(`(() => {
  state.nodes = [
    { id: 'L', x: 80,  y: 300, w: 120, h: 50, text: '左', kind: 'box' },
    { id: 'R', x: 700, y: 300, w: 120, h: 50, text: '右', kind: 'box' },
    { id: 'M', x: 400, y: 275, w: 140, h: 100, text: '中间', kind: 'box' },
  ];
  state.edges = [{ from: 'L', to: 'R', fromSide: 'right', toSide: 'left' }];
  selection.clear(); selectedEdge = null; view = { x: 0, y: 0 };
  render(); applyView();
})()`);
await sleep(300);
const at = await cdp.eval(`(() => {
  const m = document.querySelector('.node[data-id="M"]').getBoundingClientRect();
  return { x: Math.round(m.left + m.width / 2), y: Math.round(m.top + m.height / 2) };
})()`);
const shot = await cdp.send('Page.captureScreenshot', {
  format: 'png', clip: { x: at.x, y: at.y, width: 1, height: 1, scale: 1 },
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
check('线上线与节点重叠处显示的是线', px.r < 120 && px.g < 120 && px.b < 120,
      `像素 rgb(${px.r},${px.g},${px.b})`);

// 3. 被线穿过的节点仍可拖动
const mBox = await cdp.eval(`(() => {
  const r = document.querySelector('.node[data-id="M"]').getBoundingClientRect();
  return { x: r.left + 20, y: r.top + 20 };
})()`);
await drag(mBox.x, mBox.y, mBox.x + 50, mBox.y + 40);
const moved = await cdp.eval(`(() => {
  const n = state.nodes.find(n => n.id === 'M');
  return { x: n.x, y: n.y, sel: [...selection] };
})()`);
check('线上线下面的节点仍可拖动', moved.x === 450 && moved.y === 315 && moved.sel.includes('M'),
      `M -> (${moved.x},${moved.y})`);

// 4. 端口拖线仍正常
await cdp.eval(`(() => {
  state.nodes = [
    { id: 'A', x: 100, y: 100, w: 120, h: 50, text: 'A', kind: 'box' },
    { id: 'B', x: 400, y: 100, w: 120, h: 50, text: 'B', kind: 'box' },
  ];
  state.edges = [];
  selection.clear(); selectedEdge = null; view = { x: 0, y: 0 };
  render(); applyView();
})()`);
await sleep(250);
const pts = await cdp.eval(`(() => {
  const p = document.querySelector('.node[data-id="A"] .port[data-side="bottom"]').getBoundingClientRect();
  const t = document.querySelector('.node[data-id="B"] .port[data-side="left"]').getBoundingClientRect();
  return { px: p.left + p.width/2, py: p.top + p.height/2,
           tx: t.left + t.width/2, ty: t.top + t.height/2 };
})()`);
await drag(pts.px, pts.py, pts.tx, pts.ty);
const wire = await cdp.eval(`(() => {
  const e = state.edges[0];
  if (!e) return null;
  const geo = edgeGeometry(e);
  return { sides: [geo.s1, geo.s2],
           ortho: geo.points.slice(1).every((p, i) => p.x === geo.points[i].x || p.y === geo.points[i].y) };
})()`);
check('线上端口拖线仍是直角', wire && wire.ortho && wire.sides[0] === 'bottom' && wire.sides[1] === 'left',
      wire ? `${wire.sides.join('->')} 直角=${wire.ortho}` : '没连上');

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
