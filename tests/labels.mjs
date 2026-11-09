// 验证连线文字：双击加文字、位置、跟随、取消、清空、存档、R 恢复布线
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
await cdp.send('Page.navigate', { url: BASE + '/?label=' + Date.now() });
await sleep(2500);

const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse',
});
async function dblclick(x, y) {
  for (const cc of [1, 2]) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: cc, pointerType: 'mouse' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: cc, pointerType: 'mouse' });
    await sleep(70);
  }
  await sleep(350);
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
const key = async (k, code, vk) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  await sleep(250);
};

const setup = () => cdp.eval(`(() => {
  state.nodes = [
    { id: 'A', x: 120, y: 200, w: 120, h: 60, text: 'A', kind: 'box' },
    { id: 'B', x: 620, y: 200, w: 120, h: 60, text: 'B', kind: 'box' },
  ];
  state.edges = [{ from: 'A', to: 'B', fromSide: 'right', toSide: 'left' }];
  selection.clear(); selectedEdge = null; view = { x: 0, y: 0 };
  setTool('select'); render(); applyView();
})()`);

// 取最长那一段的中点屏幕坐标（文字就挂在这里）
const wireMid = () => cdp.eval(`(() => {
  const all = [...document.querySelectorAll('#hitLayer path')];
  const el2 = all.sort((a, b) => b.getTotalLength() - a.getTotalLength())[0];
  const p = el2.getAttribute('d').match(/M([-\\d.]+),([-\\d.]+) L([-\\d.]+),([-\\d.]+)/);
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { x: (+p[1] + +p[3]) / 2 + view.x + r.left, y: (+p[2] + +p[4]) / 2 + view.y + r.top };
})()`);

// 沿最长那段按比例取屏幕坐标（避开正中间的文字）
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
           strokeW: cs.strokeWidth, paintOrder: cs.paintOrder };
})()`);

// ===== 1. 双击连线弹出输入框 =====
await setup();
await sleep(350);
let m = await wireMid();
await dblclick(m.x, m.y);
const editor = await cdp.eval(`(() => {
  const i = document.querySelector('.edge-label-input');
  if (!i) return null;
  const r = i.getBoundingClientRect();
  return { value: i.value, focused: document.activeElement === i,
           x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
check('双击连线弹出输入框', !!editor && editor.focused === true,
      editor ? `已聚焦=${editor.focused}` : '没有输入框');
check('输入框出现在线中点附近',
      editor && Math.abs(editor.x - m.x) < 20 && Math.abs(editor.y - m.y) < 20,
      editor ? `线中点(${Math.round(m.x)},${Math.round(m.y)}) 输入框(${Math.round(editor.x)},${Math.round(editor.y)})` : '无');

// ===== 2. 输入文字并回车 =====
await cdp.send('Input.insertText', { text: 'HTTPS 调用' });
await key('Enter', 'Enter', 13);
const saved1 = await cdp.eval(`({ label: state.edges[0].label || null,
  editorGone: !document.querySelector('.edge-label-input') })`);
check('回车后写入连线文字', saved1.label === 'HTTPS 调用', `label=${saved1.label}`);
check('回车后输入框收起', saved1.editorGone === true, `输入框已移除=${saved1.editorGone}`);

// ===== 3. 文字渲染在线上，且带底色描边 =====
let li = await labelInfo();
check('文字渲染出来', !!li && li.text === 'HTTPS 调用', li ? `文本=${li.text}` : '没有文字元素');
check('文字位置在线的中点附近',
      li && Math.abs(li.x - m.x) < 25 && Math.abs(li.y - m.y) < 25,
      li ? `线中点(${Math.round(m.x)},${Math.round(m.y)}) 文字(${Math.round(li.x)},${Math.round(li.y)})` : '无');
check('文字层在连线之上（不被线穿过）', li && +li.z > 4, `z-index=${li ? li.z : '无'}`);
check('文字有底色描边，压线也读得清',
      li && parseFloat(li.strokeW) > 0 && li.paintOrder === 'stroke',
      li ? `stroke-width=${li.strokeW} paint-order=${li.paintOrder}` : '无');

// ===== 4. 拖动节点，文字跟着线走 =====
// 文字挂在「最长那段的中点」，节点一挪布线就变，位移不必等于节点位移，
// 判定标准是：位置有变化，且仍贴着新的线中点。
const bBefore = await labelInfo();
const aBox = await cdp.eval(`(() => {
  const r = document.querySelector('.node[data-id="A"]').getBoundingClientRect();
  return { x: r.left + 20, y: r.top + 20 };
})()`);
await drag(aBox.x, aBox.y, aBox.x + 80, aBox.y + 60);
const bAfter = await labelInfo();
const midAfter = await wireMid();
const moved = Math.abs(bAfter.x - bBefore.x) + Math.abs(bAfter.y - bBefore.y);
check('拖动节点后文字跟随连线',
      moved > 0 && Math.abs(bAfter.x - midAfter.x) < 25 && Math.abs(bAfter.y - midAfter.y) < 25,
      `文字位移 ${Math.round(moved)}，距新线中点 (${Math.round(bAfter.x - midAfter.x)},${Math.round(bAfter.y - midAfter.y)})`);

// ===== 5. 拖动线段，文字跟着走 =====
// 从 25% 处下手，避开正中间的文字（文字已设为不吃鼠标，这里顺带验证不挡操作）
const segBefore = await labelInfo();
const segPoint = await wirePointAt(0.25);
await drag(segPoint.x, segPoint.y, segPoint.x, segPoint.y + 70);
const segAfter = await labelInfo();
check('拖动线段后文字跟随',
      segAfter && Math.abs(segAfter.y - segBefore.y) > 10,
      `纵向位移 ${Math.round(segAfter.y - segBefore.y)}`);

// 再从正中间（文字所在处）拖一次，应该也能拖到线
const onLabel = await labelInfo();
await drag(segAfter.x, segAfter.y, segAfter.x, segAfter.y + 50);
const segMoved2 = await labelInfo();
check('文字所在处也能拖线段（文字不挡操作）',
      Math.abs(segMoved2.y - segAfter.y) > 10,
      `纵向再移 ${Math.round(segMoved2.y - segAfter.y)}`);

// ===== 6. 再双击可修改已有文字 =====
m = await wireMid();
await dblclick(m.x, m.y);
const editor2 = await cdp.eval(`(() => {
  const i = document.querySelector('.edge-label-input');
  return i ? { value: i.value, focused: document.activeElement === i } : null;
})()`);
check('再次双击能看到原文字便于修改',
      !!editor2 && editor2.value === 'HTTPS 调用',
      editor2 ? `输入框内容=${editor2.value}` : '没有输入框');

// ===== 7. Esc 取消不改变原文字 =====
await cdp.send('Input.insertText', { text: ' 改坏了' });
await key('Escape', 'Escape', 27);
const afterEsc = await cdp.eval(`({ label: state.edges[0].label || null,
  editorGone: !document.querySelector('.edge-label-input') })`);
check('Esc 取消不改原文字',
      afterEsc.label === 'HTTPS 调用' && afterEsc.editorGone === true,
      `label=${afterEsc.label}`);

// ===== 8. 清空文字会去掉标注 =====
m = await wireMid();
await dblclick(m.x, m.y);
await cdp.eval(`(() => {
  const i = document.querySelector('.edge-label-input');
  i.value = '';
})()`);
await key('Enter', 'Enter', 13);
const cleared = await cdp.eval(`({ label: state.edges[0].label || null,
  textEl: !!document.querySelector('#wireLabels text') })`);
check('清空输入后移除文字',
      cleared.label === null && cleared.textEl === false,
      `label=${cleared.label} 还有文字元素=${cleared.textEl}`);

// ===== 9. 点空白处不产生文字；双击空白仍是新建方框 =====
const before = await cdp.eval("document.querySelectorAll('.node').length");
await dblclick(900, 620);
const afterBlank = await cdp.eval(`({ nodes: document.querySelectorAll('.node').length,
  label: state.edges[0].label || null })`);
check('双击空白仍新建方框（没被文字功能抢走）',
      afterBlank.nodes === before + 1 && afterBlank.label === null,
      `节点 ${before} -> ${afterBlank.nodes}`);

// ===== 10. R 键恢复自动布线 =====
await setup();
await sleep(300);
const segR = await wireMid();
await drag(segR.x, segR.y, segR.x, segR.y + 80);
const manualNow = await cdp.eval(`(() => ({
  manual: !!(state.edges[0].bends || []).length,
  edge: (() => { const e = state.edges[0]; return e.from + '->' + e.to + '@' + e.fromSide + '|' + e.toSide; })(),
}))()`);
check('拖动线段后进入手动布线', manualNow.manual === true, `bends 存在=${manualNow.manual}`);
// 先选中这条线，再按 R
await cdp.eval(`(() => {
  const e = state.edges[0];
  selectedEdge = e.from + '->' + e.to + '@' + e.fromSide + '|' + e.toSide;
})()`);
await sleep(150);
await key('r', 'KeyR', 82);
const afterR = await cdp.eval(`({ bends: state.edges[0].bends || null })`);
check('R 键恢复自动布线', afterR.bends === null, `bends=${JSON.stringify(afterR.bends)}`);

// ===== 11. 存档往返保留文字 =====
await setup();
await sleep(300);
m = await wireMid();
await dblclick(m.x, m.y);
await cdp.send('Input.insertText', { text: '主链路' });
await key('Enter', 'Enter', 13);
await cdp.eval(`(() => {
  document.getElementById('name').value = '文字测试';
  document.getElementById('save').click();
})()`);
await sleep(1200);
const doc = await fetch(BASE + '/api/diagrams/' + encodeURIComponent('文字测试')).then(r => r.json());
check('存档写入 label', doc.edges[0].label === '主链路', `label=${doc.edges[0].label}`);

await cdp.send('Page.navigate', { url: BASE + '/?re=' + Date.now() });
await sleep(2200);
const reopened = await cdp.eval(`(async () => {
  await load('文字测试');
  return { label: state.edges[0]?.label || null,
           text: document.querySelector('#wireLabels text')?.textContent || null,
           n: document.querySelectorAll('#wireLabels text').length };
})()`);
check('重开还原连线文字',
      reopened.label === '主链路' && reopened.text === '主链路' && reopened.n === 1,
      `label=${reopened.label} 渲染=${reopened.text}`);

await fetch(BASE + '/api/diagrams/' + encodeURIComponent('文字测试'), { method: 'DELETE' });

// ===== 12. 撤销能撤回文字修改 =====
await setup();
await sleep(300);
m = await wireMid();
await dblclick(m.x, m.y);
await cdp.send('Input.insertText', { text: '第一步' });
await key('Enter', 'Enter', 13);
const hasLabel = await cdp.eval(`state.edges[0].label || null`);
await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
await sleep(350);
const undone = await cdp.eval(`({ label: state.edges[0]?.label || null,
  text: document.querySelector('#wireLabels text')?.textContent || null })`);
check('Ctrl+Z 撤销文字修改',
      hasLabel === '第一步' && undone.label === null && undone.text === null,
      `写入=${hasLabel} 撤销后=${undone.label}`);

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
