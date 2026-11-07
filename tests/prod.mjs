// 对线上 https://wkeeli.cn/arch/ 做回归：拖拽、双击编辑、连线、删档
import { readFileSync } from 'node:fs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const URL_ = 'https://wkeeli.cn/arch/';

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
await cdp.send('Network.setExtraHTTPHeaders', { headers: { Authorization: auth } });
await cdp.send('Page.navigate', { url: URL_ + '?prod=' + Date.now() });
await sleep(4000);

const title = await cdp.eval('document.title');
check('线上页面加载', title === 'Architecture', `title=${title}`);

const meta = await cdp.eval(`(() => ({
  hasMaybeEdit: typeof markSelection === 'function',
  touchAction: getComputedStyle(document.getElementById('canvas')).touchAction,
  nodes: document.querySelectorAll('.node').length
}))()`);
check('线上是最新前端代码', meta.hasMaybeEdit === true && meta.touchAction === 'none', JSON.stringify(meta));

const nodeInfo = () => cdp.eval(`(() => {
  const n = document.querySelector('.node');
  const r = n.getBoundingClientRect();
  return { left: parseFloat(n.style.left), top: parseFloat(n.style.top),
           cx: r.left + r.width / 2, cy: r.top + r.height / 2, editing: !!n.querySelector('[contenteditable="true"]') };
})()`);

const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse',
});

// 场景 1：普通拖动
let b = await nodeInfo();
await mouse('mouseMoved', b.cx, b.cy);
await mouse('mousePressed', b.cx, b.cy);
for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', b.cx + 15 * i, b.cy + 10 * i); await sleep(25); }
await mouse('mouseReleased', b.cx + 90, b.cy + 60);
await sleep(300);
let a = await nodeInfo();
check('线上拖动', a.left - b.left === 90 && a.top - b.top === 60, `(${b.left},${b.top}) -> (${a.left},${a.top})`);

// 场景 2：点一下再拖（曾经拖不动）
b = await nodeInfo();
await mouse('mouseMoved', b.cx, b.cy);
await mouse('mousePressed', b.cx, b.cy);
await mouse('mouseReleased', b.cx, b.cy);
await sleep(120);
await mouse('mouseMoved', b.cx, b.cy);
await mouse('mousePressed', b.cx, b.cy);
for (let i = 1; i <= 5; i++) { await mouse('mouseMoved', b.cx + 6 * i, b.cy + 4 * i); await sleep(25); }
await mouse('mouseReleased', b.cx + 30, b.cy + 20);
await sleep(300);
a = await nodeInfo();
check('线上「点一下再拖」', a.left - b.left === 30 && a.top - b.top === 20 && !a.editing,
      `位移 (${a.left - b.left},${a.top - b.top}) 编辑态=${a.editing}`);

// 场景 3：双击进编辑
b = await nodeInfo();
await mouse('mouseMoved', b.cx, b.cy);
await mouse('mousePressed', b.cx, b.cy);
await mouse('mouseReleased', b.cx, b.cy);
await sleep(80);
await mouse('mousePressed', b.cx, b.cy);
await mouse('mouseReleased', b.cx, b.cy);
await sleep(300);
a = await nodeInfo();
check('线上双击编辑', a.editing === true, `编辑态=${a.editing}`);
await cdp.eval("document.activeElement && document.activeElement.blur && document.activeElement.blur()");
await sleep(200);

// 场景 4：线上存档往返
await cdp.eval(`(() => { document.getElementById('name').value = '线上自检'; document.getElementById('save').click(); })()`);
await sleep(1200);
const names = await fetch(URL_ + 'api/diagrams', { headers: { Authorization: auth } }).then(r => r.json());
check('线上保存', names.includes('线上自检'), JSON.stringify(names));

const doc = await fetch(URL_ + 'api/diagrams/' + encodeURIComponent('线上自检'), { headers: { Authorization: auth } }).then(r => r.json());
check('线上读取存档', doc.nodes?.length === 2 && doc.edges?.length === 1, `nodes=${doc.nodes?.length} edges=${doc.edges?.length}`);

// 无凭据应 401
const noAuth = await fetch(URL_ + 'api/diagrams');
check('线上未登录被拒', noAuth.status === 401, `status=${noAuth.status}`);

// 清理
await fetch(URL_ + 'api/diagrams/' + encodeURIComponent('线上自检'), { method: 'DELETE', headers: { Authorization: auth } });

const failed = results.filter(r => !r.ok).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
