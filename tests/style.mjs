// 验证选中样式：无双层环、尺寸不跳、连接点尺寸与显隐
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
await cdp.send('Page.navigate', { url: BASE + '/?sel=' + Date.now() });
await sleep(2500);

// 选中和未选中的样式对比
const style0 = await cdp.eval(`(() => {
  const n = document.querySelector('.node');
  const cs = getComputedStyle(n);
  const r = n.getBoundingClientRect();
  return { outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle,
           borderWidth: cs.borderTopWidth, padding: cs.paddingLeft,
           w: r.width, h: r.height,
           portW: parseFloat(getComputedStyle(n.querySelector('.port')).width),
           portOpacity: getComputedStyle(n.querySelector('.port')).opacity };
})()`);

await cdp.eval(`(() => {
  selection.clear(); selection.add(document.querySelector('.node').dataset.id);
  markSelection();
})()`);
await sleep(200);

const style1 = await cdp.eval(`(() => {
  const n = document.querySelector('.node');
  const cs = getComputedStyle(n);
  const r = n.getBoundingClientRect();
  const label = n.querySelector('.label').getBoundingClientRect();
  return { outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle,
           borderWidth: cs.borderTopWidth, borderColor: cs.borderTopColor,
           padding: cs.paddingLeft, w: r.width, h: r.height,
           labelX: label.left, labelY: label.top,
           portW: parseFloat(getComputedStyle(n.querySelector('.port')).width),
           portOpacity: getComputedStyle(n.querySelector('.port')).opacity };
})()`);

check('选中不再用 outline（去掉双层环）',
      style1.outlineStyle === 'none' || style1.outlineWidth === '0px',
      `outline=${style1.outlineStyle}/${style1.outlineWidth}`);
check('选中改为 2px 边框',
      style1.borderWidth === '2px',
      `border=${style0.borderWidth} -> ${style1.borderWidth}`);
check('选中后尺寸不变（不跳版）',
      Math.abs(style1.w - style0.w) < 0.5 && Math.abs(style1.h - style0.h) < 0.5,
      `${style0.w}x${style0.h} -> ${style1.w}x${style1.h}`);
check('padding 已补偿（文字位置不跳）',
      style1.padding !== style0.padding,
      `padding ${style0.padding} -> ${style1.padding}`);
check('连接点缩小到 8px',
      style0.portW === 8 && style1.portW === 8,
      `port 宽=${style0.portW}`);
check('连接点平时隐藏、选中时半透明',
      style0.portOpacity === '0' && parseFloat(style1.portOpacity) > 0 && parseFloat(style1.portOpacity) < 0.7,
      `未选中=${style0.portOpacity} 选中=${style1.portOpacity}`);

// 悬停时完全显现
const nodeBox = await cdp.eval(`(() => {
  const r = document.querySelector('.node').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nodeBox.x, y: nodeBox.y, button: 'none', buttons: 0 });
await sleep(300);
const hovered = await cdp.eval(`getComputedStyle(document.querySelector('.node .port')).opacity`);
check('鼠标悬停时连接点完全显现', parseFloat(hovered) > 0.9, `opacity=${hovered}`);

// 容器的选中样式
const groupStyle = await cdp.eval(`(() => {
  state.nodes.push({ id: 'gX', x: 40, y: 300, w: 300, h: 160, text: '分组', kind: 'group' });
  selection.clear(); selection.add('gX');
  render();
  const n = document.querySelector('.node[data-kind="group"]');
  const cs = getComputedStyle(n);
  const r = n.getBoundingClientRect();
  return { outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle,
           borderWidth: cs.borderTopWidth, borderStyle: cs.borderTopStyle,
           w: r.width, h: r.height };
})()`);
check('容器选中也无 outline 且仍是虚线',
      groupStyle.outlineStyle === 'none' && groupStyle.borderWidth === '2px' && groupStyle.borderStyle === 'dashed' && groupStyle.w === 300,
      `outline=${groupStyle.outlineStyle} border=${groupStyle.borderWidth} ${groupStyle.borderStyle} 宽=${groupStyle.w}`);

// 缩放手柄尺寸
const handleStyle = await cdp.eval(`(() => {
  const n = document.querySelector('.node:not(.group)');
  selection.clear(); selection.add(n.dataset.id);
  markSelection();
  const cs = getComputedStyle(n.querySelector('.resize'));
  return { w: parseFloat(cs.width), h: parseFloat(cs.height), opacity: cs.opacity };
})()`);
check('缩放手柄同为 8px', handleStyle.w === 8 && handleStyle.h === 8, `${handleStyle.w}x${handleStyle.h}`);

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
