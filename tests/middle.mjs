// 验证鼠标中键拖拽画布，以及左键拖空白处改为框选
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
await cdp.send('Page.navigate', { url: BASE + '/?mid=' + Date.now() });
await sleep(2500);

const mouseBtn = (type, x, y, button, buttons) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button, buttons, clickCount: 1, pointerType: 'mouse',
});

async function dragWith(button, buttons, x, y, dx, dy, steps = 8) {
  await mouseBtn('mouseMoved', x, y, 'none', 0);
  await mouseBtn('mousePressed', x, y, button, buttons);
  for (let i = 1; i <= steps; i++) {
    await mouseBtn('mouseMoved', x + (dx / steps) * i, y + (dy / steps) * i, button, buttons);
    await sleep(25);
  }
  await mouseBtn('mouseReleased', x + dx, y + dy, button, 0);
  await sleep(250);
}

const snap = () => cdp.eval(`(() => {
  const n = document.querySelector('.node');
  const r = n.getBoundingClientRect();
  return { view: { x: view.x, y: view.y },
           nodeLeft: parseFloat(n.style.left), nodeTop: parseFloat(n.style.top),
           cx: r.left + r.width / 2, cy: r.top + r.height / 2,
           sel: selected, selCount: selection.size };
})()`);

// ===== 1. 中键在空白处拖动 =====
let s0 = await snap();
await dragWith('middle', 4, 700, 620, 110, 70);
let s1 = await snap();
check('中键空白处平移', s1.view.x - s0.view.x === 110 && s1.view.y - s0.view.y === 70,
      `view (${s0.view.x},${s0.view.y}) -> (${s1.view.x},${s1.view.y})`);
check('中键平移不改节点坐标', s1.nodeLeft === s0.nodeLeft && s1.nodeTop === s0.nodeTop,
      `节点 (${s0.nodeLeft},${s0.nodeTop}) -> (${s1.nodeLeft},${s1.nodeTop})`);

// ===== 2. 中键按在节点上拖动：应平移画布，不动节点 =====
s0 = await snap();
await dragWith('middle', 4, s0.cx, s0.cy, 90, 60);
s1 = await snap();
check('中键按在节点上也是平移画布',
      s1.view.x - s0.view.x === 90 && s1.view.y - s0.view.y === 60,
      `view (${s0.view.x},${s0.view.y}) -> (${s1.view.x},${s1.view.y})`);
check('中键在节点上拖动不移动节点',
      s1.nodeLeft === s0.nodeLeft && s1.nodeTop === s0.nodeTop,
      `节点 (${s0.nodeLeft},${s0.nodeTop}) -> (${s1.nodeLeft},${s1.nodeTop})`);
check('中键拖动不选中节点', s1.selCount === 0, `选中数=${s1.selCount}`);

// ===== 3. 中键拖动不触发文字编辑 =====
const editing = await cdp.eval(`!!document.querySelector('.label[contenteditable="true"]')`);
check('中键不进入编辑态', editing === false, `editing=${editing}`);

// ===== 4. 左键拖空白处：现在是框选，不再平移 =====
s0 = await snap();
await dragWith('left', 1, 700, 620, 100, 70);
s1 = await snap();
check('左键拖空白处不再平移画布',
      s1.view.x === s0.view.x && s1.view.y === s0.view.y,
      `view (${s0.view.x},${s0.view.y}) -> (${s1.view.x},${s1.view.y})`);

// ===== 5. 左键在节点上仍是移动节点（回归）=====
await cdp.eval('selection.clear(); selectedEdge = null; render();');
const n0 = await snap();
await dragWith('left', 1, n0.cx, n0.cy, 50, 40);
const n1 = await snap();
check('左键拖动节点仍正常',
      n1.nodeLeft - n0.nodeLeft === 50 && n1.nodeTop - n0.nodeTop === 40 &&
      n1.view.x === n0.view.x,
      `节点位移 (${n1.nodeLeft - n0.nodeLeft},${n1.nodeTop - n0.nodeTop}) 视图未动=${n1.view.x === n0.view.x}`);

// ===== 6. 右键不应引发任何拖动 =====
const c0 = await snap();
await dragWith('right', 2, 700, 620, 80, 80);
const c1 = await snap();
check('右键不拖动画布', c1.view.x === c0.view.x && c1.view.y === c0.view.y,
      `view (${c0.view.x},${c0.view.y}) -> (${c1.view.x},${c1.view.y})`);

// ===== 7. 中键拖动后，连线仍跟着走 =====
const wireOk = await cdp.eval(`(() => {
  const p = document.querySelector('#wireLayer path');
  const t = document.getElementById('wireLayer').getAttribute('transform');
  return { path: p?.getAttribute('d') || null, transform: t, view: { x: view.x, y: view.y } };
})()`);
check('中键平移后连线层同步',
      wireOk.transform === `translate(${wireOk.view.x} ${wireOk.view.y})`,
      `transform=${wireOk.transform} view=${JSON.stringify(wireOk.view)}`);

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
