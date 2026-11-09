// 用 CDP 驱动无头 Chrome，验证拖动 / 双击编辑 / 先点后拖 三种交互
const CDP_BASE = 'http://127.0.0.1:9222';
const PAGE_URL = 'http://127.0.0.1:8123/';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch(CDP_BASE + '/json/list').then(r => r.json());
      const page = list.find(t => t.type === 'page');
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error('CDP 没起来');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.waiters.has(msg.id)) {
        const { res, rej } = c.waiters.get(msg.id);
        c.waiters.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiters.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiters.has(id)) { this.waiters.delete(id); rej(new Error('超时: ' + method)); }
      }, 10000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.result?.description || ''));
    return r.result.value;
  }
}

const mouse = (cdp, type, x, y) =>
  cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1, pointerType: 'mouse',
  });

// 真实的分步拖动
async function dragBy(cdp, x, y, dx, dy, steps = 6) {
  await mouse(cdp, 'mouseMoved', x, y);
  await mouse(cdp, 'mousePressed', x, y);
  for (let i = 1; i <= steps; i++) {
    await mouse(cdp, 'mouseMoved', x + (dx / steps) * i, y + (dy / steps) * i);
    await sleep(25);
  }
  await mouse(cdp, 'mouseReleased', x + dx, y + dy);
  await sleep(200);
}

const firstNode = cdp => cdp.eval(`(() => {
  const n = document.querySelector('.node');
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return { left: parseFloat(n.style.left), top: parseFloat(n.style.top),
           cx: r.left + r.width / 2, cy: r.top + r.height / 2,
           editing: !!n.querySelector('.label[contenteditable="true"]') };
})()`);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
};

(async () => {
  const target = await getPageTarget();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Page.navigate', { url: PAGE_URL + '?t=' + Date.now() });
  await sleep(2500);

  // ===== 场景 1：普通拖动 =====
  let b = await firstNode(cdp);
  await dragBy(cdp, b.cx, b.cy, 120, 80);
  let a = await firstNode(cdp);
  check('普通拖动', a.left - b.left === 120 && a.top - b.top === 80,
        `(${b.left},${b.top}) -> (${a.left},${a.top})`);

  // ===== 场景 2：快速点一下，再按下拖动（曾经会被误判成双击）=====
  b = await firstNode(cdp);
  await mouse(cdp, 'mouseMoved', b.cx, b.cy);
  await mouse(cdp, 'mousePressed', b.cx, b.cy);
  await mouse(cdp, 'mouseReleased', b.cx, b.cy);
  await sleep(120);                       // 120ms 后立刻再按下并拖动
  await dragBy(cdp, b.cx, b.cy, 60, 40);
  a = await firstNode(cdp);
  check('先点一下再拖', a.left - b.left === 60 && a.top - b.top === 40 && !a.editing,
        `位移 (${a.left - b.left},${a.top - b.top}) 编辑态=${a.editing}`);

  // ===== 场景 3：快速双击进入编辑 =====
  b = await firstNode(cdp);
  await mouse(cdp, 'mouseMoved', b.cx, b.cy);
  await mouse(cdp, 'mousePressed', b.cx, b.cy);
  await mouse(cdp, 'mouseReleased', b.cx, b.cy);
  await sleep(80);
  await mouse(cdp, 'mousePressed', b.cx, b.cy);
  await mouse(cdp, 'mouseReleased', b.cx, b.cy);
  await sleep(250);
  a = await firstNode(cdp);
  check('双击进入编辑', a.editing === true, `编辑态=${a.editing} 位置未变=${a.left === b.left && a.top === b.top}`);

  // 退出编辑，免得影响后续
  await cdp.eval("document.activeElement && document.activeElement.blur && document.activeElement.blur()");
  await sleep(200);

  // ===== 场景 4：画布空白处双击新建 =====
  // 双击连线的行为已经改成「编辑连线文字」，所以这里要挑一个既不在节点上、
  // 也不在任何线段上的空白点，否则测的就不是这个功能了。
  const countBefore = await cdp.eval("document.querySelectorAll('.node').length");
  const blank = await cdp.eval(`(() => {
    const c = document.getElementById('canvas').getBoundingClientRect();
    const onAnything = (x, y) => {
      const e = document.elementFromPoint(x, y);
      return !!(e && (e.closest('.node') || e.closest('#wireHits path') || e.closest('#wireLabels text')));
    };
    for (let y = c.top + 40; y < c.bottom - 40; y += 20) {
      for (let x = c.left + 40; x < c.right - 40; x += 20) {
        if (!onAnything(x, y)) {
          // 再确认一下这个点周围 4px 也是空的，避免边界抖动
          if (!onAnything(x - 4, y - 4) && !onAnything(x + 4, y + 4)) return { x, y };
        }
      }
    }
    return null;
  })()`);
  if (!blank) throw new Error('找不到空白处');
  const bx = Math.round(blank.x);
  const by = Math.round(blank.y);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bx, y: by, button: 'none', buttons: 0 });
  for (const cc of [1, 2]) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bx, y: by, button: 'left', buttons: 1, clickCount: cc, pointerType: 'mouse' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bx, y: by, button: 'left', buttons: 0, clickCount: cc, pointerType: 'mouse' });
    await sleep(60);
  }
  await sleep(300);
  const countAfter = await cdp.eval("document.querySelectorAll('.node').length");
  check('空白处双击新建', countAfter === countBefore + 1, `${countBefore} -> ${countAfter}`);

  // ===== 场景 5：圆点拖出连线 =====
  const wireBefore = await cdp.eval("document.querySelectorAll('#wireLayer path').length");
  const port = await cdp.eval(`(() => {
    const nodes = document.querySelectorAll('.node');
    const n = nodes[nodes.length - 1];
    const p = n.querySelector('.port');
    const r = p.getBoundingClientRect();
    const t = nodes[0].getBoundingClientRect();
    return { px: r.left + r.width/2, py: r.top + r.height/2,
             tx: t.left + t.width/2, ty: t.top + t.height/2 };
  })()`);
  await dragBy(cdp, port.px, port.py, port.tx - port.px, port.ty - port.py, 8);
  const wireAfter = await cdp.eval("document.querySelectorAll('#wireLayer path').length");
  check('拖圆点连线', wireAfter === wireBefore + 1, `${wireBefore} -> ${wireAfter} 条`);

  // ===== 场景 6：Delete 删除选中节点 =====
  const before = await cdp.eval("document.querySelectorAll('.node').length");
  await cdp.eval(`(() => {
    const n = document.querySelectorAll('.node')[0];
    const r = n.getBoundingClientRect();
    n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5, pointerId: 1, isPrimary: true }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5, pointerId: 1, isPrimary: true }));
  })()`);
  await sleep(150);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await sleep(250);
  const after = await cdp.eval("document.querySelectorAll('.node').length");
  check('Delete 删除节点', after === before - 1, `${before} -> ${after}`);

  const failed = results.filter(r => !r.ok);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(2); });
