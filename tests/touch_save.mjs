// 触屏拖动 + 存档往返验证
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
      setTimeout(() => { if (this.w.has(id)) { this.w.delete(id); rej(new Error('timeout ' + method)); } }, 8000);
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
await cdp.send('Network.enable');
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
await cdp.send('Page.enable');

// ---- 触屏模拟需要设备指标 ----
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 754, height: 480, deviceScaleFactor: 1, mobile: true,
});
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
await cdp.send('Page.navigate', { url: BASE + '/?touch=' + Date.now() });
await sleep(2500);

const nodeInfo = () => cdp.eval(`(() => {
  const n = document.querySelector('.node');
  const r = n.getBoundingClientRect();
  return { left: parseFloat(n.style.left), top: parseFloat(n.style.top),
           cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
})()`);

// ---- 触屏拖动：touchStart -> 多点 touchMove -> touchEnd ----
const b = await nodeInfo();
await cdp.send('Input.dispatchTouchEvent', {
  type: 'touchStart', touchPoints: [{ x: b.cx, y: b.cy, id: 1 }],
});
for (let i = 1; i <= 8; i++) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove', touchPoints: [{ x: b.cx + 9 * i, y: b.cy + 5 * i, id: 1 }],
  });
  await sleep(25);
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(400);

const a = await nodeInfo();
check('触屏拖动', Math.abs(a.left - b.left - 72) <= 3 && Math.abs(a.top - b.top - 40) <= 3,
      `(${b.left},${b.top}) -> (${a.left},${a.top}) 期望 +72/+40`);

// 是否发生 pointercancel（touch-action 没设对时会取消）
const cancelled = await cdp.eval(`(() => {
  window.__cancelled = 0;
  document.getElementById('nodes').addEventListener('pointercancel', () => window.__cancelled++);
  return 'ok';
})()`);

await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
await cdp.send('Emulation.clearDeviceMetricsOverride');

// ---- 存档往返 ----
await cdp.send('Page.navigate', { url: BASE + '/?save=' + Date.now() });
await sleep(2200);

await cdp.eval(`(() => {
  document.getElementById('name').value = '往返测试';
  document.getElementById('save').click();
  return 'clicked';
})()`);
await sleep(900);

const saved = await fetch(BASE + '/api/diagrams').then(r => r.json());
check('保存后出现在列表', saved.includes('往返测试'), JSON.stringify(saved));

const doc = await fetch(BASE + '/api/diagrams/' + encodeURIComponent('往返测试')).then(r => r.json());
check('存档内容含节点和连线', Array.isArray(doc.nodes) && doc.nodes.length === 2 && doc.edges.length === 1,
      `nodes=${doc.nodes?.length} edges=${doc.edges?.length} text=${doc.nodes?.[1]?.text}`);

// 重新打开页面，应从后端载入存档
await cdp.send('Page.navigate', { url: BASE + '/?reopen=' + Date.now() });
await sleep(2200);
const reopened = await cdp.eval(`(() => {
  const nodes = [...document.querySelectorAll('.node')];
  return { count: nodes.length, texts: nodes.map(n => n.textContent.trim()),
           name: document.getElementById('name').value,
           wires: document.querySelectorAll('#wireLayer path').length };
})()`);
check('重开页面自动载入存档', reopened.count === 2 && reopened.name === '往返测试' && reopened.wires === 1,
      JSON.stringify(reopened));

// 明暗切换
const theme = await cdp.eval(`(() => {
  const before = document.documentElement.dataset.theme;
  document.getElementById('theme').click();
  return { before, after: document.documentElement.dataset.theme };
})()`);
check('明暗切换', theme.before !== theme.after, JSON.stringify(theme));

// 清理
await fetch(BASE + '/api/diagrams/' + encodeURIComponent('往返测试'), { method: 'DELETE' });

const failed = results.filter(r => !r.ok).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
