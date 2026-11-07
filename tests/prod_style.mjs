// 线上验证选中样式
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
await cdp.send('Page.navigate', { url: BASE + '?st=' + Date.now() });
await sleep(4500);

// 真实点击选中第一个节点
const box = await cdp.eval(`(() => {
  const r = document.querySelector('.node').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
})()`);

const before = await cdp.eval(`(() => {
  const n = document.querySelector('.node');
  const cs = getComputedStyle(n);
  return { outline: cs.outlineStyle, border: cs.borderTopWidth,
           portW: parseFloat(getComputedStyle(n.querySelector('.port')).width),
           portOp: getComputedStyle(n.querySelector('.port')).opacity };
})()`);

await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
await sleep(300);

// 把鼠标移开节点，避免 hover 影响透明度判断
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 950, y: 660, button: 'none', buttons: 0 });
await sleep(300);

const after = await cdp.eval(`(() => {
  const n = document.querySelector('.node');
  const cs = getComputedStyle(n);
  const r = n.getBoundingClientRect();
  return { outline: cs.outlineStyle, outlineWidth: cs.outlineWidth,
           border: cs.borderTopWidth, borderColor: cs.borderTopColor,
           w: r.width, h: r.height, selected: n.classList.contains('sel'),
           portW: parseFloat(getComputedStyle(n.querySelector('.port')).width),
           portOp: getComputedStyle(n.querySelector('.port')).opacity };
})()`);

check('线上点击后节点被选中', after.selected === true, `sel=${after.selected}`);
check('线上选中无 outline 双层环',
      after.outline === 'none' || after.outlineWidth === '0px',
      `outline=${after.outline}/${after.outlineWidth}`);
check('线上选中是 2px 边框', after.border === '2px', `${before.border} -> ${after.border}`);
check('线上选中后尺寸不跳',
      Math.abs(after.w - box.w) < 0.5 && Math.abs(after.h - box.h) < 0.5,
      `${box.w}x${box.h} -> ${after.w}x${after.h}`);
check('线上连接点 8px', before.portW === 8 && after.portW === 8, `port=${after.portW}px`);
check('线上连接点选中时半透明（非全亮）',
      parseFloat(after.portOp) < 0.7,
      `未选中=${before.portOp} 选中=${after.portOp}`);

// 容器选中
const group = await cdp.eval(`(() => {
  state.nodes.push({ id: 'gz', x: 40, y: 320, w: 300, h: 160, text: '分组', kind: 'group' });
  selection.clear(); selection.add('gz'); render();
  const n = document.querySelector('.node[data-kind="group"]');
  const cs = getComputedStyle(n);
  return { outline: cs.outlineStyle, border: cs.borderTopWidth, style: cs.borderTopStyle, w: n.getBoundingClientRect().width };
})()`);
check('线上容器选中也无 outline 且虚线',
      group.outline === 'none' && group.border === '2px' && group.style === 'dashed' && group.w === 300,
      `outline=${group.outline} ${group.border} ${group.style} 宽=${group.w}`);

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
