// 验证画布平移：拖空白处移动视图、节点和连线跟随、双击新建坐标正确、Home 复位
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
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
};

const list = await fetch('http://127.0.0.1:9222/json/list').then(r => r.json());
const page = list.find(t => t.type === 'page');
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Network.enable');
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 620, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: BASE + '/?pan=' + Date.now() });
await sleep(2500);

const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse',
});

async function dragBlank(x, y, dx, dy, steps = 8) {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', x + (dx / steps) * i, y + (dy / steps) * i);
    await sleep(25);
  }
  await mouse('mouseReleased', x + dx, y + dy);
  await sleep(250);
}

const snapshot = () => cdp.eval(`(() => {
  const n = document.querySelector('.node');
  const r = n.getBoundingClientRect();
  return {
    view: { x: view.x, y: view.y },
    nodeLeft: parseFloat(n.style.left),
    screenCx: r.left + r.width / 2,
    screenCy: r.top + r.height / 2,
    nodesTransform: getComputedStyle(document.getElementById('nodes')).transform,
    wireTransform: document.getElementById('wireLayer').getAttribute('transform'),
    bgPos: document.getElementById('canvas').style.backgroundPosition,
    wireD: document.querySelector('#wireLayer path:not(.hit)')?.getAttribute('d') || null,
    count: document.querySelectorAll('.node').length,
  };
})()`);

// ---- 1. 平移空白处 ----
const s0 = await snapshot();
await dragBlank(500, 480, 130, 90);
const s1 = await snapshot();

check('拖动空白处平移画布', s1.view.x === 130 && s1.view.y === 90,
      `view (${s0.view.x},${s0.view.y}) -> (${s1.view.x},${s1.view.y})`);
check('节点屏幕位置跟随平移', Math.abs(s1.screenCx - s0.screenCx - 130) < 1 && Math.abs(s1.screenCy - s0.screenCy - 90) < 1,
      `屏幕位移 (${Math.round(s1.screenCx - s0.screenCx)},${Math.round(s1.screenCy - s0.screenCy)})`);
check('节点自身坐标不变', s1.nodeLeft === s0.nodeLeft, `left=${s1.nodeLeft}`);
check('连线随画布一起移动', s1.wireTransform === 'translate(130 90)', `wireLayer=${s1.wireTransform}`);
check('背景网格跟随', /130px\s+90px/.test(s1.bgPos || ''), `bgPos=${s1.bgPos}`);

// ---- 2. 平移后双击空白新建，节点应落在鼠标处 ----
const before = (await snapshot()).count;
const clickX = 600, clickY = 380;
for (const cc of [1, 2]) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', buttons: 1, clickCount: cc, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', buttons: 0, clickCount: cc, pointerType: 'mouse' });
  await sleep(60);
}
await sleep(350);
const created = await cdp.eval(`(() => {
  const nodes = [...document.querySelectorAll('.node')];
  const n = nodes[nodes.length - 1];
  const r = n.getBoundingClientRect();
  return { count: nodes.length, cx: r.left + r.width / 2, cy: r.top + r.height / 2,
           left: parseFloat(n.style.left), top: parseFloat(n.style.top), view: { x: view.x, y: view.y } };
})()`);
check('平移后双击建节点落点正确',
      created.count === before + 1 &&
      Math.abs(created.cx - clickX) <= 2 && Math.abs(created.cy - clickY) <= 2,
      `鼠标(${clickX},${clickY}) 节点屏幕中心(${Math.round(created.cx)},${Math.round(created.cy)}) 画布坐标(${created.left},${created.top})`);

// ---- 3. 平移后拖节点，位移要准 ----
const nodeBefore = await cdp.eval(`(() => {
  const n = document.querySelector('.node');
  const r = n.getBoundingClientRect();
  return { cx: r.left + r.width/2, cy: r.top + r.height/2, left: parseFloat(n.style.left), top: parseFloat(n.style.top) };
})()`);
await dragBlank(nodeBefore.cx, nodeBefore.cy, 40, 30);
const nodeAfter = await cdp.eval(`(() => {
  const n = document.querySelector('.node');
  return { left: parseFloat(n.style.left), top: parseFloat(n.style.top), view: { x: view.x, y: view.y } };
})()`);
check('平移后拖动节点位移正确',
      nodeAfter.left - nodeBefore.left === 40 && nodeAfter.top - nodeBefore.top === 30,
      `节点 (${nodeBefore.left},${nodeBefore.top}) -> (${nodeAfter.left},${nodeAfter.top})，视图未动=${nodeAfter.view.x === 130}`);

// ---- 4. Home 键把节点框回视野 ----
await dragBlank(500, 480, -400, -300);   // 先把视图推到离谱的位置
await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
await sleep(300);
const home = await cdp.eval(`(() => {
  const r = document.getElementById('canvas').getBoundingClientRect();
  const nodes = [...document.querySelectorAll('.node')].map(n => n.getBoundingClientRect());
  const inside = nodes.every(b => b.left >= r.left && b.right <= r.right && b.top >= r.top && b.bottom <= r.bottom);
  return { view: { x: view.x, y: view.y }, inside, n: nodes.length };
})()`);
check('Home 键框回所有节点', home.inside === true, `view=(${home.view.x},${home.view.y}) 全部在视野内=${home.inside} 节点数=${home.n}`);

// ---- 5. 平移状态存进存档 ----
await cdp.eval(`(() => { document.getElementById('name').value = '平移测试'; document.getElementById('save').click(); })()`);
await sleep(1000);
const savedDoc = await fetch(BASE + '/api/diagrams/' + encodeURIComponent('平移测试')).then(r => r.json());
check('存档里带 view', savedDoc.view && savedDoc.view.x === home.view.x && savedDoc.view.y === home.view.y,
      JSON.stringify(savedDoc.view));

await cdp.send('Page.navigate', { url: BASE + '/?reload=' + Date.now() });
await sleep(2200);
const reloaded = await cdp.eval(`({ view: { x: view.x, y: view.y }, name: document.getElementById('name').value })`);
check('重开页面还原平移', reloaded.view.x === home.view.x && reloaded.view.y === home.view.y,
      `view=${JSON.stringify(reloaded.view)} 存档=${reloaded.name}`);

await fetch(BASE + '/api/diagrams/' + encodeURIComponent('平移测试'), { method: 'DELETE' });

const failed = results.filter(r => !r.ok).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
