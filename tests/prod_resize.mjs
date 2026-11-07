// 线上验证：容器手柄可放大缩小
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
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: BASE + '?rs=' + Date.now() });
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

// 布置：一个容器 + 两个方框在容器内
await cdp.eval(`(() => {
  state.nodes = [
    { id: 'G', x: 100, y: 100, w: 260, h: 160, text: '分组', kind: 'group' },
    { id: 'A', x: 140, y: 150, w: 120, h: 50, text: 'A', kind: 'box' },
    { id: 'B', x: 140, y: 220, w: 120, h: 50, text: 'B', kind: 'box' },
  ];
  state.edges = [];
  selection.clear(); selectedEdge = null; view = { x: 0, y: 0 };
  setTool('select'); render(); applyView();
})()`);
await sleep(300);

// 1. 角标存在且是细线
const grip = await cdp.eval(`(() => {
  const g = document.querySelector('.node[data-kind="group"] .resize');
  const cs = getComputedStyle(g);
  const r = g.getBoundingClientRect();
  return { exists: !!g, bg: cs.backgroundColor, bw: cs.borderRightWidth, cursor: cs.cursor,
           opacity: cs.opacity, pointer: cs.pointerEvents,
           x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
check('线上容器有细线角标', grip.exists && grip.bw === '1px' &&
      (grip.bg === 'rgba(0, 0, 0, 0)' || grip.bg === 'transparent'),
      `边框=${grip.bw} 背景=${grip.bg} 光标=${grip.cursor}`);
check('未选中时角标不可点', grip.pointer === 'none' && grip.opacity === '0',
      `opacity=${grip.opacity} pointer-events=${grip.pointer}`);

// 2. 选中容器后角标可点
await cdp.eval(`selection.clear(); selection.add('G'); markSelection();`);
await sleep(200);
const grip2 = await cdp.eval(`(() => {
  const g = document.querySelector('.node[data-kind="group"] .resize');
  const cs = getComputedStyle(g);
  return { opacity: cs.opacity, pointer: cs.pointerEvents };
})()`);
check('选中后角标显现且可拖', grip2.pointer === 'auto' && parseFloat(grip2.opacity) > 0.5,
      `opacity=${grip2.opacity} pointer-events=${grip2.pointer}`);

// 3. 拖动放大
const before = await cdp.eval(`(() => {
  const g = state.nodes.find(n => n.kind === 'group');
  const r = document.querySelector('.node[data-kind="group"] .resize').getBoundingClientRect();
  return { w: g.w, h: g.h, members: membersOf(g).map(m => m.id).sort(),
           gx: r.left + r.width / 2, gy: r.top + r.height / 2 };
})()`);
await drag(before.gx, before.gy, before.gx + 100, before.gy + 60);
const after = await cdp.eval(`(() => {
  const g = state.nodes.find(n => n.kind === 'group');
  const dom = document.querySelector('.node[data-kind="group"]').getBoundingClientRect();
  return { w: g.w, h: g.h, domW: dom.width, domH: dom.height,
           members: membersOf(g).map(m => m.id).sort() };
})()`);
check('线上拖角标可放大容器',
      after.w - before.w === 100 && after.h - before.h === 60,
      `${before.w}x${before.h} -> ${after.w}x${after.h}`);
check('线上 DOM 尺寸同步',
      Math.abs(after.domW - after.w) < 1 && Math.abs(after.domH - after.h) < 1,
      `DOM ${after.domW}x${after.domH} 数据 ${after.w}x${after.h}`);
check('放大后成员仍是 A、B', JSON.stringify(after.members) === JSON.stringify(['A', 'B']),
      JSON.stringify(after.members));

// 4. 拖动缩小
const s0 = await cdp.eval(`(() => {
  const g = state.nodes.find(n => n.kind === 'group');
  const r = document.querySelector('.node[data-kind="group"] .resize').getBoundingClientRect();
  return { w: g.w, h: g.h, gx: r.left + r.width / 2, gy: r.top + r.height / 2 };
})()`);
await drag(s0.gx, s0.gy, s0.gx - 120, s0.gy - 80);
const s1 = await cdp.eval(`(() => {
  const g = state.nodes.find(n => n.kind === 'group');
  return { w: g.w, h: g.h, members: membersOf(g).map(m => m.id) };
})()`);
check('线上拖角标可缩小容器',
      s1.w < s0.w && s1.h < s0.h,
      `${s0.w}x${s0.h} -> ${s1.w}x${s1.h}，成员=${JSON.stringify(s1.members)}`);

// 5. 缩到极限仍不小于最小尺寸
const m0 = await cdp.eval(`(() => {
  const r = document.querySelector('.node[data-kind="group"] .resize').getBoundingClientRect();
  return { gx: r.left + r.width / 2, gy: r.top + r.height / 2 };
})()`);
await drag(m0.gx, m0.gy, m0.gx - 500, m0.gy - 500);
const minSize = await cdp.eval(`(() => {
  const g = state.nodes.find(n => n.kind === 'group');
  return { w: g.w, h: g.h };
})()`);
check('线上容器有最小尺寸 80x60', minSize.w >= 80 && minSize.h >= 60,
      `缩到 ${minSize.w}x${minSize.h}`);

// 6. 改尺寸不会挪动容器位置
const pos = await cdp.eval(`(() => {
  const g = state.nodes.find(n => n.kind === 'group');
  return { x: g.x, y: g.y };
})()`);
check('改尺寸不影响容器位置', pos.x === 100 && pos.y === 100, `位置 (${pos.x},${pos.y})`);

// 7. 存档往返保留新尺寸
await cdp.eval(`(() => {
  document.getElementById('name').value = '缩放自检';
  document.getElementById('save').click();
})()`);
await sleep(1200);
const doc = await fetch(BASE + 'api/diagrams/' + encodeURIComponent('缩放自检'),
  { headers: { Authorization: auth } }).then(r => r.json());
const gDoc = doc.nodes.find(n => n.id === 'G');
check('线上存档保存新尺寸', gDoc.w === minSize.w && gDoc.h === minSize.h,
      `存档 ${gDoc.w}x${gDoc.h}`);

await cdp.send('Page.navigate', { url: BASE + '?re=' + Date.now() });
await sleep(4200);
const reopened = await cdp.eval(`(() => {
  const g = state.nodes.find(n => n.id === 'G');
  const dom = document.querySelector('.node[data-id="G"]').getBoundingClientRect();
  return { w: g.w, h: g.h, domW: dom.width, domH: dom.height };
})()`);
check('线上重开还原新尺寸',
      reopened.w === minSize.w && reopened.h === minSize.h &&
      Math.abs(reopened.domW - reopened.w) < 1,
      `${reopened.w}x${reopened.h} DOM ${reopened.domW}x${reopened.domH}`);

await fetch(BASE + 'api/diagrams/' + encodeURIComponent('缩放自检'), { method: 'DELETE', headers: { Authorization: auth } });

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
