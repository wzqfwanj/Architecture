// 验证：连线不被节点遮挡、节点仍点得中、端口仍能拖线、点线仍能选中
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
await cdp.send('Page.navigate', { url: BASE + '/?layer=' + Date.now() });
await sleep(2500);

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

// 布置：两个节点，连线在它们之间穿过一个第三方节点的位置
await cdp.eval(`(() => {
  state.nodes = [
    { id: 'L', x: 80,  y: 300, w: 120, h: 50, text: '左', kind: 'box' },
    { id: 'R', x: 700, y: 300, w: 120, h: 50, text: '右', kind: 'box' },
    { id: 'M', x: 400, y: 275, w: 140, h: 100, text: '中间', kind: 'box' },
  ];
  // L 右边 -> R 左边，水平直线正好穿过 M
  state.edges = [{ from: 'L', to: 'R', fromSide: 'right', toSide: 'left' }];
  selection.clear(); selectedEdge = null;
  view = { x: 0, y: 0 };
  render(); applyView();
})()`);
await sleep(250);

// ---- 1. 结构：两层连线 ----
const layers = await cdp.eval(`(() => {
  const wires = document.getElementById('wires');
  const hits = document.getElementById('wireHits');
  const nodes = document.getElementById('nodes');
  const cs = e => getComputedStyle(e);
  return {
    wiresZ: cs(wires).zIndex,
    hitsZ: cs(hits).zIndex,
    nodesZ: cs(nodes).zIndex,
    // DOM 顺序：hits 在 nodes 之前
    hitsBeforeNodes: !!(hits.compareDocumentPosition(nodes) & Node.DOCUMENT_POSITION_FOLLOWING),
    wireCount: document.querySelectorAll('#wireLayer path').length,
    hitCount: document.querySelectorAll('#hitLayer path').length,
    portZ: cs(document.querySelector('.port')).zIndex,
  };
})()`);
check('连线分显示层与点击层',
      layers.wireCount === 1 && layers.hitCount === 1,
      `显示层=${layers.wireCount} 点击层=${layers.hitCount}`);
check('显示层在节点之上（线不被遮挡）',
      layers.wiresZ === '4' && layers.nodesZ === 'auto',
      `#wires z=${layers.wiresZ} #nodes z=${layers.nodesZ}`);
check('点击层在节点之下（不抢节点点击）',
      layers.hitsZ === 'auto' && layers.hitsBeforeNodes === true,
      `#wireHits z=${layers.hitsZ} DOM 在 #nodes 之前=${layers.hitsBeforeNodes}`);
check('连接点层级高于连线显示层',
      +layers.portZ > +layers.wiresZ,
      `port z=${layers.portZ} > wires z=${layers.wiresZ}`);

// ---- 2. 线与节点重叠处的像素：应该是线的颜色，而不是节点背景 ----
const overlap = await cdp.eval(`(() => {
  // M 节点中心正好被 L->R 的线穿过（y = 300 + 25 = 325）
  const m = document.querySelector('.node[data-id="M"]').getBoundingClientRect();
  return { x: Math.round(m.left + m.width / 2), y: Math.round(m.top + m.height / 2) };
})()`);
const shot = await cdp.send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: overlap.x, y: overlap.y, width: 1, height: 1, scale: 1 },
});
// 1x1 PNG：用浏览器自己解码，避免引入 PNG 解析
const pixel = await cdp.eval(`(async () => {
  const img = new Image();
  img.src = 'data:image/png;base64,${shot.data}';
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 1; c.height = 1;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2], a: d[3] };
})()`);
const isDark = pixel.r < 120 && pixel.g < 120 && pixel.b < 120;
check('线与节点重叠处画的是线（像素为深色）', isDark,
      `重叠点 (${overlap.x},${overlap.y}) 像素 rgba(${pixel.r},${pixel.g},${pixel.b},${pixel.a})`);

// ---- 3. 节点仍能被点中并拖动（线不抢事件）----
const mBox = await cdp.eval(`(() => {
  const r = document.querySelector('.node[data-id="M"]').getBoundingClientRect();
  return { x: r.left + 20, y: r.top + 20, left: parseFloat(document.querySelector('.node[data-id="M"]').style.left) };
})()`);
await drag(mBox.x, mBox.y, mBox.x + 50, mBox.y + 40);
const moved = await cdp.eval(`(() => {
  const n = state.nodes.find(n => n.id === 'M');
  return { x: n.x, y: n.y, sel: [...selection] };
})()`);
check('线下面的节点仍可点中并拖动',
      moved.x === 450 && moved.y === 315 && moved.sel.includes('M'),
      `M -> (${moved.x},${moved.y}) 选中=${JSON.stringify(moved.sel)}`);

// ---- 4. 端口仍能拖出连线（端口在线上层）----
await cdp.eval(`(() => {
  state.nodes = [
    { id: 'A', x: 100, y: 100, w: 120, h: 50, text: 'A', kind: 'box' },
    { id: 'B', x: 400, y: 100, w: 120, h: 50, text: 'B', kind: 'box' },
  ];
  state.edges = [{ from: 'A', to: 'B', fromSide: 'right', toSide: 'left' }];
  selection.clear(); selectedEdge = null; view = { x: 0, y: 0 };
  render(); applyView();
})()`);
await sleep(200);
const pts = await cdp.eval(`(() => {
  // A 的下端口（此时 A->B 的线正好从左端口的同一位置出发，最容易互相抢）
  const p = document.querySelector('.node[data-id="A"] .port[data-side="bottom"]').getBoundingClientRect();
  const t = document.querySelector('.node[data-id="B"] .port[data-side="bottom"]').getBoundingClientRect();
  return { px: p.left + p.width/2, py: p.top + p.height/2,
           tx: t.left + t.width/2, ty: t.top + t.height/2 };
})()`);
const before = await cdp.eval('state.edges.length');
await drag(pts.px, pts.py, pts.tx, pts.ty);
const after = await cdp.eval(`({ n: state.edges.length, last: state.edges[state.edges.length-1] })`);
check('端口仍能拖出新连线',
      after.n === before + 1 && after.last?.fromSide === 'bottom' && after.last?.toSide === 'bottom',
      `${before} -> ${after.n} 条，新线 ${after.last?.fromSide}->${after.last?.toSide}`);

// ---- 5. 点空白处的线仍能选中 ----
await cdp.eval(`(() => {
  state.nodes = [
    { id: 'X', x: 80, y: 80, w: 100, h: 50, text: 'X', kind: 'box' },
    { id: 'Y', x: 600, y: 500, w: 100, h: 50, text: 'Y', kind: 'box' },
  ];
  state.edges = [{ from: 'X', to: 'Y', fromSide: 'right', toSide: 'left' }];
  selection.clear(); selectedEdge = null; view = { x: 0, y: 0 };
  render(); applyView();
})()`);
await sleep(250);
// 取线上一点（远离两个节点）
const onWire = await cdp.eval(`(() => {
  const p = document.querySelector('#wireLayer path');
  const total = p.getTotalLength();
  const pt = p.getPointAtLength(total / 2);
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { x: r.left + pt.x, y: r.top + pt.y };
})()`);
await mouse('mouseMoved', onWire.x, onWire.y);
await mouse('mousePressed', onWire.x, onWire.y);
await mouse('mouseReleased', onWire.x, onWire.y);
await sleep(250);
const picked = await cdp.eval(`({ edge: selectedEdge, sel: [...selection] })`);
check('点空白处的线可选中它', !!picked.edge && picked.sel.length === 0,
      `selectedEdge=${picked.edge}`);

// ---- 6. 右下角小方块已彻底移除 ----
const noHandle = await cdp.eval(`(() => ({
  dom: document.querySelectorAll('.resize').length,
  code: /\.resize/.test(document.querySelector('style,link')?.outerHTML || '') ,
  cssHas: [...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => r.selectorText && r.selectorText.includes('.resize')); } catch { return false; } }),
  jsHas: /resize/.test(document.querySelector('script[src]')?.src || ''),
}))()`);
const resizeFn = await cdp.eval(`(async () => {
  const r = await fetch('app.js').then(r => r.text());
  const c = await fetch('style.css').then(r => r.text());
  return { js: /resize/.test(r), css: /\\.resize/.test(c) };
})()`);
check('右下角小方块已移除',
      noHandle.dom === 0 && !resizeFn.js && !resizeFn.css,
      `DOM=${noHandle.dom} app.js 含 resize=${resizeFn.js} style.css 含 .resize=${resizeFn.css}`);

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
