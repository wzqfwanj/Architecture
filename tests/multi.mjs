// 验证框选、多选拖动、容器（分组）节点
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
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: BASE + '/?multi=' + Date.now() });
await sleep(2500);

const mouse = (type, x, y, mods = 0) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
  clickCount: 1, pointerType: 'mouse', modifiers: mods,
});

async function drag(x1, y1, x2, y2, mods = 0, steps = 8) {
  await mouse('mouseMoved', x1, y1, mods);
  await mouse('mousePressed', x1, y1, mods);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', x1 + ((x2 - x1) / steps) * i, y1 + ((y2 - y1) / steps) * i, mods);
    await sleep(25);
  }
  await mouse('mouseReleased', x2, y2, mods);
  await sleep(300);
}

// 布置三个方框：两个在左上，一个在右下
const setup = async () => {
  await cdp.eval(`(() => {
    state.nodes = [
      { id: 'b1', x: 60,  y: 60,  w: 120, h: 50, text: 'A', kind: 'box' },
      { id: 'b2', x: 240, y: 60,  w: 120, h: 50, text: 'B', kind: 'box' },
      { id: 'b3', x: 500, y: 400, w: 120, h: 50, text: 'C', kind: 'box' },
    ];
    state.edges = [];
    selection.clear(); selectedEdge = null;
    view = { x: 0, y: 0 };
    setTool('select');
    render(); applyView();
  })()`);
  await sleep(150);
};

const state_ = () => cdp.eval(`(() => ({
  sel: [...selection],
  nodes: state.nodes.map(n => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, kind: n.kind })),
  selCount: document.querySelectorAll('.node.sel').length,
  marqueeHidden: document.getElementById('marquee').hidden,
}))()`);

const canvasRect = () => cdp.eval(`(() => {
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
})()`);

// ===== 1. 框选两个节点 =====
await setup();
let rect = await canvasRect();
await drag(rect.left + 40, rect.top + 30, rect.left + 420, rect.top + 140);
let s = await state_();
check('框选选中相交的节点', s.sel.length === 2 && s.sel.includes('b1') && s.sel.includes('b2'),
      `选中 ${JSON.stringify(s.sel)}`);
check('框选后 DOM 有选中样式', s.selCount === 2, `.sel 元素数=${s.selCount}`);
check('松手后框选矩形隐藏', s.marqueeHidden === true, `hidden=${s.marqueeHidden}`);

// ===== 2. 拖动其中一个 → 两个一起移动 =====
const before = await state_();
const b1 = before.nodes.find(n => n.id === 'b1');
await drag(rect.left + b1.x + 20, rect.top + b1.y + 20,
           rect.left + b1.x + 20 + 80, rect.top + b1.y + 20 + 50);
let after = await state_();
const moved1 = after.nodes.find(n => n.id === 'b1');
const moved2 = after.nodes.find(n => n.id === 'b2');
const stayed3 = after.nodes.find(n => n.id === 'b3');
check('拖动选中之一，多选整体移动',
      moved1.x - b1.x === 80 && moved1.y - b1.y === 50 &&
      moved2.x - 240 === 80 && moved2.y - 60 === 50 &&
      stayed3.x === 500 && stayed3.y === 400,
      `A(${moved1.x},${moved1.y}) B(${moved2.x},${moved2.y}) C(${stayed3.x},${stayed3.y})`);

// ===== 3. 点空白取消选择 =====
await cdp.eval('selection.clear(); selectedEdge = null; render();');
rect = await canvasRect();
await drag(rect.left + 700, rect.top + 600, rect.left + 700, rect.top + 600);
s = await state_();
check('单击空白取消选择', s.sel.length === 0, `选中 ${JSON.stringify(s.sel)}`);

// ===== 4. shift 加选 =====
await setup();
rect = await canvasRect();
const b1c = (await state_()).nodes.find(n => n.id === 'b1');
const b3c = (await state_()).nodes.find(n => n.id === 'b3');
await mouse('mouseMoved', rect.left + b1c.x + 20, rect.top + b1c.y + 20);
await mouse('mousePressed', rect.left + b1c.x + 20, rect.top + b1c.y + 20);
await mouse('mouseReleased', rect.left + b1c.x + 20, rect.top + b1c.y + 20);
await sleep(150);
await mouse('mouseMoved', rect.left + b3c.x + 20, rect.top + b3c.y + 20, 8);
await mouse('mousePressed', rect.left + b3c.x + 20, rect.top + b3c.y + 20, 8);
await mouse('mouseReleased', rect.left + b3c.x + 20, rect.top + b3c.y + 20, 8);
await sleep(200);
s = await state_();
check('shift 点选可加选', s.sel.length === 2, `选中 ${JSON.stringify(s.sel)}`);

// ===== 5. 左侧栏创建容器 =====
await setup();
await cdp.eval(`document.querySelector('.tool[data-tool="group"]').click()`);
const toolNow = await cdp.eval('tool');
check('左侧栏可切换到容器工具', toolNow === 'group', `tool=${toolNow}`);

rect = await canvasRect();
// 从 (30,30) 拖到 (420,180)，把 A、B 包进去
await drag(rect.left + 30, rect.top + 30, rect.left + 420, rect.top + 180);
const groupInfo = await cdp.eval(`(() => {
  const g = state.nodes.find(n => n.kind === 'group');
  return g ? { id: g.id, x: g.x, y: g.y, w: g.w, h: g.h, text: g.text,
               members: membersOf(g).map(m => m.id).sort(), tool } : null;
})()`);
check('拖出范围创建容器', !!groupInfo && groupInfo.w > 300 && groupInfo.h > 100,
      groupInfo ? `尺寸 ${groupInfo.w}x${groupInfo.h} 位置(${groupInfo.x},${groupInfo.y})` : '没有容器');
check('容器包住的方框成为成员', JSON.stringify(groupInfo?.members) === JSON.stringify(['b1', 'b2']),
      `成员 ${JSON.stringify(groupInfo?.members)}`);
check('创建后自动回到选择工具', groupInfo?.tool === 'select', `tool=${groupInfo?.tool}`);

// ===== 6. 拖动容器 → 成员一起走 =====
const g0 = groupInfo;
const gDom = await cdp.eval(`(() => {
  const n = document.querySelector('.node[data-kind="group"]');
  const r = n.getBoundingClientRect();
  // 点容器内没有方框覆盖的地方：右下角空白
  return { x: r.left + 20, y: r.bottom - 15 };
})()`);
const beforeG = await state_();
await drag(gDom.x, gDom.y, gDom.x + 60, gDom.y + 40);
const afterG = await state_();
const g1 = afterG.nodes.find(n => n.id === g0.id);
const a1 = afterG.nodes.find(n => n.id === 'b1');
const b1m = beforeG.nodes.find(n => n.id === 'b1');
check('拖动容器整体移动成员',
      g1.x - g0.x === 60 && g1.y - g0.y === 40 &&
      a1.x - b1m.x === 60 && a1.y - b1m.y === 40,
      `容器(${g1.x},${g1.y}) A(${a1.x},${a1.y})`);

// ===== 7. 容器渲染在下层、样式正确 =====
// 现在靠 DOM 顺序保证层级：容器先渲染，方框后渲染压在上面
const layer = await cdp.eval(`(() => {
  const g = document.querySelector('.node[data-kind="group"]');
  const box = document.querySelector('.node[data-kind="box"]');
  const all = [...document.querySelectorAll('#nodes .node')];
  const gi = all.indexOf(g);
  const bi = all.indexOf(box);
  const gRect = g.getBoundingClientRect();
  const bRect = box.getBoundingClientRect();
  // 成员方框中心处点到的应该是方框，不是容器
  const hitAtMember = document.elementFromPoint(
    bRect.left + bRect.width / 2, bRect.top + bRect.height / 2);
  return {
    borderStyle: getComputedStyle(g).borderStyle,
    firstKind: all[0].dataset.kind,
    groupBeforeBox: gi < bi,
    // 容器内部空白处（右下角）点到的应该是容器本身
    hitAtGroupBlank: (() => {
      const e = document.elementFromPoint(gRect.right - 8, gRect.bottom - 8);
      return e?.closest('.node')?.dataset.kind || null;
    })(),
    hitAtMemberKind: hitAtMember?.closest('.node')?.dataset.kind || null,
  };
})()`);
check('容器先渲染且在方框下层',
      layer.firstKind === 'group' && layer.groupBeforeBox === true &&
      layer.borderStyle === 'dashed' &&
      layer.hitAtMemberKind === 'box' && layer.hitAtGroupBlank === 'group',
      JSON.stringify(layer));

// ===== 8. 右下角缩放手柄已移除 =====
await setup();
await cdp.eval(`(() => {
  const n = document.querySelector('.node[data-id="b1"]');
  selection.clear(); selection.add('b1'); markSelection();
})()`);
await sleep(150);
const handleGone = await cdp.eval(`(() => {
  const n = document.querySelector('.node.sel');
  return {
    domCount: document.querySelectorAll('.resize').length,
    childCount: n ? n.children.length : 0,   // 只剩 label + 4 个端口 = 5
    childClasses: n ? [...n.children].map(c => c.className) : [],
  };
})()`);
check('选中后也没有右下角手柄',
      handleGone.domCount === 0 && handleGone.childCount === 5 &&
      !handleGone.childClasses.includes('resize'),
      `DOM=${handleGone.domCount} 子元素=${JSON.stringify(handleGone.childClasses)}`);

// ===== 9. 容器 kind 存进存档并能还原 =====
await cdp.eval(`(() => {
  state.nodes = [
    { id: 'g1', x: 40, y: 40, w: 300, h: 180, text: '分组', kind: 'group' },
    { id: 'c1', x: 100, y: 100, w: 120, h: 50, text: '在组内', kind: 'box' },
  ];
  state.edges = [];
  selection.clear(); selectedEdge = null; view = { x: 0, y: 0 };
  setTool('select'); render();
  document.getElementById('name').value = '容器测试';
  document.getElementById('save').click();
})()`);
await sleep(1000);
const doc = await fetch(BASE + '/api/diagrams/' + encodeURIComponent('容器测试')).then(r => r.json());
check('存档保存 kind 字段',
      doc.nodes.find(n => n.id === 'g1')?.kind === 'group' &&
      doc.nodes.find(n => n.id === 'c1')?.kind === 'box',
      JSON.stringify(doc.nodes.map(n => [n.id, n.kind])));

await cdp.send('Page.navigate', { url: BASE + '/?reload=' + Date.now() });
await sleep(2200);
const restored = await cdp.eval(`(() => {
  const g = state.nodes.find(n => n.kind === 'group');
  return { kind: g?.kind, members: g ? membersOf(g).map(m => m.id) : [],
           groupDom: document.querySelectorAll('.node[data-kind="group"]').length };
})()`);
check('重开还原容器与成员关系',
      restored.kind === 'group' && restored.groupDom === 1 &&
      JSON.stringify(restored.members) === JSON.stringify(['c1']),
      JSON.stringify(restored));

await fetch(BASE + '/api/diagrams/' + encodeURIComponent('容器测试'), { method: 'DELETE' });

// ===== 10. Delete 删除多选 =====
await setup();
rect = await canvasRect();
await drag(rect.left + 40, rect.top + 40, rect.left + 420, rect.top + 140);
const delBefore = (await state_()).nodes.length;
await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
await sleep(300);
const delAfter = (await state_()).nodes.length;
check('Delete 删除多选节点', delAfter === delBefore - 2, `${delBefore} -> ${delAfter}`);

const failed = results.filter(r => !r).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
