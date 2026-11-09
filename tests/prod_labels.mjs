// 线上验证：连线文字标注 + 撤销
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
await cdp.send('Page.navigate', { url: BASE + '?lbl=' + Date.now() });
await sleep(4500);

const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse',
});
async function dblclick(x, y) {
  for (const cc of [1, 2]) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: cc, pointerType: 'mouse' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: cc, pointerType: 'mouse' });
    await sleep(70);
  }
  await sleep(380);
}
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
const key = async (k, code, vk, modifiers = 0) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await sleep(300);
};

const setup = () => cdp.eval(`(() => {
  state.nodes = [
    { id: 'A', x: 120, y: 220, w: 120, h: 60, text: 'A', kind: 'box' },
    { id: 'B', x: 640, y: 220, w: 120, h: 60, text: 'B', kind: 'box' },
  ];
  state.edges = [{ from: 'A', to: 'B', fromSide: 'right', toSide: 'left' }];
  selection.clear(); selectedEdge = null; view = { x: 0, y: 0 };
  undoStack.length = 0; redoStack.length = 0;
  setTool('select'); render(); applyView();
})()`);

const wireMid = () => cdp.eval(`(() => {
  const all = [...document.querySelectorAll('#hitLayer path')];
  const el2 = all.sort((a, b) => b.getTotalLength() - a.getTotalLength())[0];
  const p = el2.getAttribute('d').match(/M([-\\d.]+),([-\\d.]+) L([-\\d.]+),([-\\d.]+)/);
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { x: (+p[1] + +p[3]) / 2 + view.x + r.left, y: (+p[2] + +p[4]) / 2 + view.y + r.top };
})()`);

const wirePointAt = (t) => cdp.eval(`(() => {
  const all = [...document.querySelectorAll('#hitLayer path')];
  const el2 = all.sort((a, b) => b.getTotalLength() - a.getTotalLength())[0];
  const p = el2.getAttribute('d').match(/M([-\\d.]+),([-\\d.]+) L([-\\d.]+),([-\\d.]+)/);
  const ax = +p[1], ay = +p[2], bx = +p[3], by = +p[4];
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { x: ax + (bx - ax) * ${t} + view.x + r.left,
           y: ay + (by - ay) * ${t} + view.y + r.top };
})()`);

const labelInfo = () => cdp.eval(`(() => {
  const t = document.querySelector('#wireLabels text');
  if (!t) return null;
  const r = t.getBoundingClientRect();
  const cs = getComputedStyle(t);
  return { text: t.textContent, x: r.left + r.width / 2, y: r.top + r.height / 2,
           z: getComputedStyle(document.getElementById('wireLabels')).zIndex,
           strokeW: cs.strokeWidth, paintOrder: cs.paintOrder, pointer: cs.pointerEvents };
})()`);

// ===== 1. 部署确认 =====
const deployed = await cdp.eval(`({
  hasLayer: !!document.getElementById('wireLabels'),
  hasEditFn: typeof editEdgeLabel === 'function',
  hasUndo: typeof undo === 'function',
  hint: document.querySelector('.hint').textContent,
})`);
check('线上已部署文字层与撤销', deployed.hasLayer && deployed.hasEditFn && deployed.hasUndo,
      `文字层=${deployed.hasLayer} 撤销=${deployed.hasUndo}`);

// ===== 2. 双击连线弹出输入框 =====
await setup();
await sleep(350);
let m = await wireMid();
await dblclick(m.x, m.y);
const editor = await cdp.eval(`(() => {
  const i = document.querySelector('.edge-label-input');
  if (!i) return null;
  const r = i.getBoundingClientRect();
  return { focused: document.activeElement === i, x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
check('线上双击连线弹出输入框', !!editor && editor.focused === true,
      editor ? `已聚焦=${editor.focused}` : '没有输入框');

// ===== 3. 输入并回车 =====
await cdp.send('Input.insertText', { text: 'HTTPS 调用' });
await key('Enter', 'Enter', 13);
const saved = await cdp.eval(`({ label: state.edges[0].label || null,
  editorGone: !document.querySelector('.edge-label-input') })`);
check('线上回车写入文字', saved.label === 'HTTPS 调用' && saved.editorGone, `label=${saved.label}`);

// ===== 4. 渲染样式 =====
const li = await labelInfo();
check('线上文字渲染在线中点附近',
      li && Math.abs(li.x - m.x) < 25 && Math.abs(li.y - m.y) < 25,
      li ? `线中点(${Math.round(m.x)},${Math.round(m.y)}) 文字(${Math.round(li.x)},${Math.round(li.y)})` : '无');
check('线上文字层在连线之上且有描边',
      li && +li.z > 4 && parseFloat(li.strokeW) > 0 && li.paintOrder === 'stroke',
      li ? `z=${li.z} stroke=${li.strokeW} paint-order=${li.paintOrder}` : '无');
check('线上文字不吃鼠标事件', li && li.pointer === 'none', `pointer-events=${li ? li.pointer : '无'}`);

// ===== 5. 拖动线段，文字跟随 =====
const before5 = await labelInfo();
const p25 = await wirePointAt(0.25);
await drag(p25.x, p25.y, p25.x, p25.y + 70);
const after5 = await labelInfo();
check('线上拖线段时文字跟随',
      after5 && Math.abs(after5.y - before5.y) > 10,
      `纵向位移 ${Math.round(after5.y - before5.y)}`);

// ===== 6. 从文字正上方也能拖到线 =====
const before6 = await labelInfo();
await drag(before6.x, before6.y, before6.x, before6.y + 50);
const after6 = await labelInfo();
check('线上文字所在处也能拖线段', Math.abs(after6.y - before6.y) > 10,
      `纵向再移 ${Math.round(after6.y - before6.y)}`);

// ===== 7. 撤销文字修改 =====
await setup();
await sleep(350);
m = await wireMid();
await dblclick(m.x, m.y);
await cdp.send('Input.insertText', { text: '主链路' });
await key('Enter', 'Enter', 13);
const wrote = await cdp.eval(`state.edges[0].label || null`);
await key('z', 'KeyZ', 90, 2);
const undone = await cdp.eval(`({ label: state.edges[0]?.label || null,
  text: !!document.querySelector('#wireLabels text') })`);
check('线上 Ctrl+Z 撤销文字',
      wrote === '主链路' && undone.label === null && undone.text === false,
      `写入=${wrote} 撤销后=${undone.label}`);

// ===== 8. 存档往返 =====
await setup();
await sleep(350);
m = await wireMid();
await dblclick(m.x, m.y);
await cdp.send('Input.insertText', { text: '线上标注自检' });
await key('Enter', 'Enter', 13);
await cdp.eval(`(() => {
  document.getElementById('name').value = '线上标注自检';
  document.getElementById('save').click();
})()`);
await sleep(1300);
const doc = await fetch(BASE + 'api/diagrams/' + encodeURIComponent('线上标注自检'),
  { headers: { Authorization: auth } }).then(r => r.json());
check('线上存档写入 label', doc.edges[0].label === '线上标注自检', `label=${doc.edges[0].label}`);

await cdp.send('Page.navigate', { url: BASE + '?re=' + Date.now() });
await sleep(4200);
const reopened = await cdp.eval(`(async () => {
  await load('线上标注自检');
  return { label: state.edges[0]?.label || null,
           text: document.querySelector('#wireLabels text')?.textContent || null };
})()`);
check('线上重开还原文字', reopened.label === '线上标注自检' && reopened.text === '线上标注自检',
      `label=${reopened.label} 渲染=${reopened.text}`);

await fetch(BASE + 'api/diagrams/' + encodeURIComponent('线上标注自检'),
  { method: 'DELETE', headers: { Authorization: auth } });

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
