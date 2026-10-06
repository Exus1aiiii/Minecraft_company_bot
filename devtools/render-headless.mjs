// devtools/render-headless.mjs
// 仅开发期使用：在 Node 里用 linkedom 无头跑一遍渲染进程。
//
// 为什么需要它：这个环境里 Electron 起不来（启动即 0xC0000005 / 0x80000003），
// 所以我没法截图验证界面。这个脚本能抓住 90% 的低级错误 —— import 路径写错、
// 视图没导出 render、拼错的 DOM id、初始化时抛异常、某个视图点进去是空白。
//
// 它**不**验证像素效果（没有真实排版引擎），最终视觉仍要人来跑 npm start 看。
//
// 用法：node devtools/render-headless.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseHTML } from 'linkedom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(HERE, '..', 'app', 'renderer');

const problems = [];
const notes = [];

function fail(msg) { problems.push(msg); console.log(`  ✗ ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function note(msg) { notes.push(msg); console.log(`  · ${msg}`); }

// ── 一、静态检查：HTML 引用的资源都存在 ───────────────────────────────────────

console.log('=== 1. HTML 资源引用 ===');
const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const rel = m[1];
  if (/^(https?:|data:|#)/.test(rel)) { fail(`index.html 引用了外部资源：${rel}`); continue; }
  const p = path.join(RENDERER, rel);
  if (fs.existsSync(p)) ok(`${rel}`);
  else fail(`index.html 引用的文件不存在：${rel}`);
}

// ── 二、静态检查：所有 import 路径可解析 ─────────────────────────────────────

console.log('=== 2. 模块 import 路径 ===');
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const jsFiles = walk(RENDERER);
let importCount = 0;
for (const file of jsFiles) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
    const spec = m[1];
    if (!spec.startsWith('.')) { fail(`${path.relative(RENDERER, file)} 引入非相对模块：${spec}`); continue; }
    importCount++;
    const target = path.resolve(path.dirname(file), spec);
    if (!fs.existsSync(target)) fail(`${path.relative(RENDERER, file)} → ${spec} 不存在`);
  }
}
ok(`${jsFiles.length} 个 JS 文件，${importCount} 处相对 import 全部可解析`);

// ── 三、静态检查：每个视图都导出 id / label / render ─────────────────────────

console.log('=== 3. 视图导出契约 ===');
const viewsDir = path.join(RENDERER, 'views');
const viewFiles = fs.readdirSync(viewsDir).filter(f => f.endsWith('.js'));
for (const f of viewFiles) {
  const src = fs.readFileSync(path.join(viewsDir, f), 'utf8');
  const missing = ['export const id', 'export const label', 'export function render', 'export async function render']
    .filter(() => true)
    .filter(() => false); // 占位：真正的检查在动态导入之后做
  void missing;
  const hasId = /export\s+const\s+id\s*=/.test(src);
  const hasLabel = /export\s+const\s+label\s*=/.test(src);
  const hasRender = /export\s+(async\s+)?function\s+render|export\s+const\s+render\s*=/.test(src);
  if (hasId && hasLabel && hasRender) ok(`views/${f}`);
  else fail(`views/${f} 缺少导出：${[!hasId && 'id', !hasLabel && 'label', !hasRender && 'render'].filter(Boolean).join(', ')}`);
}

// ── 四、动态检查：真的把界面装配起来 ─────────────────────────────────────────

console.log('=== 4. 无头装配（linkedom）===');
const { window } = parseHTML(html);
const g = globalThis;

/** Node 里有些全局（navigator）是只读 getter，直接赋值会 TypeError */
function setGlobal(key, value) {
  try { g[key] = value; return; } catch { /* 只读，往下走 */ }
  try { Object.defineProperty(g, key, { value, writable: true, configurable: true }); }
  catch { /* 实在不行就算了，缺这个全局时下面的动态检查会报出来 */ }
}

setGlobal('window', window);
setGlobal('document', window.document);
setGlobal('navigator', window.navigator);
setGlobal('location', window.location);
setGlobal('HTMLElement', window.HTMLElement);
setGlobal('HTMLInputElement', window.HTMLInputElement || window.HTMLElement);
setGlobal('Element', window.Element);
setGlobal('Node', window.Node);
setGlobal('Event', window.Event);
setGlobal('CustomEvent', window.CustomEvent || window.Event);
setGlobal('MouseEvent', window.MouseEvent || window.Event);
setGlobal('KeyboardEvent', window.KeyboardEvent || window.Event);
setGlobal('getComputedStyle', window.getComputedStyle
  ? window.getComputedStyle.bind(window)
  : () => ({ getPropertyValue: () => '', width: '0px', height: '0px' }));
setGlobal('requestAnimationFrame', (fn) => setTimeout(() => fn(Date.now()), 0));
setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
setGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
if (!g.ResizeObserver) setGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
if (!g.IntersectionObserver) setGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
setGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {}, clear() {} });
setGlobal('alert', () => {});
setGlobal('confirm', () => true);

const runtimeErrors = [];
process.on('unhandledRejection', (r) => runtimeErrors.push(`未处理的 Promise 拒绝：${r?.stack || r}`));
process.on('uncaughtException', (e) => runtimeErrors.push(`未捕获异常：${e?.stack || e}`));
window.addEventListener?.('error', (e) => runtimeErrors.push(`window error: ${e?.message || e}`));

const origError = console.error;
console.error = (...a) => { runtimeErrors.push(`console.error: ${a.map(String).join(' ')}`); origError(...a); };

try {
  await import(pathToFileURL(path.join(RENDERER, 'app.js')).href);
} catch (e) {
  fail(`导入 app.js 就抛了：${e?.stack || e}`);
}
await new Promise(r => setTimeout(r, 400));

const doc = window.document;
const nav = doc.getElementById('nav');
const content = doc.getElementById('content');

const navButtons = nav ? [...nav.querySelectorAll('.nav-item')] : [];
if (navButtons.length) ok(`导航栏渲染出 ${navButtons.length} 个入口：${navButtons.map(b => b.textContent.trim()).join(' / ')}`);
else {
  fail('导航栏是空的（#nav 里没有 .nav-item）');
  console.log('  #nav 实际内容：', nav ? nav.innerHTML.slice(0, 400) : '(#nav 不存在)');
}

if (content && content.innerHTML.length > 40) ok(`#content 有内容（${content.innerHTML.length} 字符）`);
else fail('#content 是空的，界面没装配起来');

// 逐个点进去，确认每个视图都能渲染
if (navButtons.length) {
  for (const btn of navButtons) {
    const name = btn.textContent.trim();
    const before = content.innerHTML.length;
    try {
      btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    } catch (e) {
      fail(`点击「${name}」抛错：${e?.message || e}`);
      continue;
    }
    await new Promise(r => setTimeout(r, 350));
    const after = content.innerHTML.length;
    if (after > 60) ok(`视图「${name}」渲染出 ${after} 字符`);
    else fail(`视图「${name}」几乎是空白（${after} 字符，点击前 ${before}）`);
  }
}

// 有些视图会先画兜底内容、再去主进程取数据重画（例如人格页的预设列表）。
// 异步那一拍如果抛错，上面的同步断言是抓不到的，所以再等一会儿回头看一眼。
await new Promise(r => setTimeout(r, 800));
if (content && content.innerHTML.length > 60) ok(`异步刷新之后 #content 仍有内容（${content.innerHTML.length} 字符）`);
else fail(`异步刷新把 #content 弄空了（${content ? content.innerHTML.length : 0} 字符）`);

// 确认 mock 有被启用（无 Electron 时的降级路径）
if (g.window.__MCBOT_MOCK__) note('已启用内置演示数据（mock）—— 这正是浏览器直开时的预期行为');

// ===========================================================================
// 5. 首跑引导卡与机器人编辑器（这一轮新加的东西，光"渲染出字符"看不出对错）
// ===========================================================================
//
// 为什么必须在这里查：这两个东西的价值全在**文案与字段**上 ——
// 卡片的正文要能把"为什么喊它没反应"讲明白，编辑区要真的把 bot 字段露出来。
// 只断言"页面有 6295 字符"是抓不到的：把整段删掉，字符数照样够。
console.log('=== 5. 首跑引导卡与机器人编辑器 ===');

const botNavBtn = navButtons.find((b) => b.textContent.trim().includes('机器人'));
if (botNavBtn) {
  botNavBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));

  const txt = content.innerHTML;

  // —— 首跑引导卡 ——
  // mock 里「小豆」的主人还是出厂占位（ownersConfigured 缺省/false）→ 卡片必须出现
  if (txt.includes('firstrun')) ok('未认领的 bot 存在时，首跑引导卡出现了（.firstrun）');
  else fail('没有渲染出首跑引导卡 —— 用户还是会遇到"喊它一声不吭"而界面上什么都没说');

  for (const kw of ['认得出你', '游戏 ID', '一句话都不会回']) {
    if (txt.includes(kw)) ok(`引导卡文案里有「${kw}」`);
    else fail(`引导卡文案里缺「${kw}」—— 光给个输入框解释不清为什么要填`);
  }

  const frInput = content.querySelector('.firstrun input');
  if (frInput) ok('引导卡里有输入框（不是只让用户自己去找配置文件）');
  else fail('引导卡里没有输入框');

  // —— 真的走一遍：填错 → 拦住；填对 → 卡片消失 ——
  // 只查"卡片渲染出来了"是不够的：按钮接没接上、校验拦不拦得住、
  // 改完卡片会不会消失，这三件事全靠点一下才知道。
  const applyBtn = [...content.querySelectorAll('.firstrun button')][0];
  if (frInput && applyBtn) {
    // ① 中文名（真实玩家最容易犯的错：MC 账号名不收中文）
    frInput.value = '我的世界';
    applyBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const afterBad = content.innerHTML;
    if (afterBad.includes('只能是 3~16 位字母')) ok('填中文名被当场拦下并说明了原因（不会等到进游戏才失败）');
    else fail('填了中文名没有任何提示 —— 用户会以为改好了');
    if (afterBad.includes('firstrun')) ok('填错时引导卡还在（没有把没生效的改动当成成功）');
    else fail('填错了卡片却消失了 —— 用户会以为已经改好');

    // ② 合法名字
    frInput.value = 'Notch';
    applyBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    if (!content.innerHTML.includes('firstrun')) ok('★ 填对之后引导卡消失 —— 首跑流程能走完');
    else fail('填了合法名字卡片还在，用户会以为没生效');
  } else {
    fail('找不到引导卡的输入框或按钮，首跑流程没法验证');
  }

  // —— 机器人编辑器 ——
  //
  // ★ 动手之前必须先等"保存引起的那次整页重挂"落定：
  //   首跑那一步的 ctx.save() 是异步的，成功之后 app.js 会调 remountView() 把当前
  //   视图**整个重挂**一遍（那是它有意为之：避免视图抱着旧配置对象）。如果我们
  //   在重挂之前就去点「详情」，点到的是马上要被丢掉的那棵 DOM —— 断言看到的现象
  //   是"按钮已经写着收起详情、里面却是空的"，看起来像 renderEdit 坏了，其实只是
  //   点早了。第一版就是这么误判的（也正因为这个坑，展开状态被提到了模块级，
  //   见 app/renderer/views/bots.js 顶部的 openCards）。
  await new Promise(r => setTimeout(r, 600));

  const detailBtn = [...content.querySelectorAll('.bot-card button')].find((b) => /详情/.test(b.textContent));
  if (detailBtn) {
    if (/收起/.test(detailBtn.textContent)) {
      // 上一次重挂已经把它恢复成展开状态了 —— 这时再点一下反而会折叠回去
      ok('重挂之后展开的卡片会自己恢复成展开（openCards 生效）');
    } else {
      try {
        detailBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      } catch (e) {
        fail(`点击「详情」抛错：${e?.stack || e}`);
      }
    }
    await new Promise(r => setTimeout(r, 350));

    const grid = content.querySelector('.edit-grid');
    if (grid) ok('展开详情后有编辑区（.edit-grid）—— 以前 GUI 里根本没有改 bot 的地方');
    else fail('展开详情后没有编辑区（.edit-grid 没渲染出来）');

    // ★ 这几条必须只看编辑区自己的文本，不能拿整个 innerHTML 去 includes：
    //   toast 文案里也带着"主人"「小豆」这些词，用整页文本查会得到假阳性 ——
    //   第一版就这样"通过"过两条，字段根本不在编辑区里。
    for (const label of ['MC 账号名', '中文名', '唤醒称谓', '主人']) {
      if (grid && grid.textContent.includes(label)) ok(`编辑区里有「${label}」字段`);
      else fail(`编辑区里缺「${label}」字段${grid ? '' : '（编辑区本身就没渲染出来）'}`);
    }
    if (content.innerHTML.includes('新建机器人')) ok('头部有「新建机器人」按钮');
    else fail('头部没有「新建机器人」按钮');

    // —— 回归守卫：保存不能把用户正在编辑的卡片折叠掉 ——
    // 保存成功 → app.js remountView() → 视图被重建。展开状态如果存在 render() 内部，
    // 用户点开卡片、改字段、一按保存，编辑区当场消失，看着就像改动被丢了。
    const saveBtn = [...content.querySelectorAll('.bot-edit button')].find((b) => /保存/.test(b.textContent));
    if (saveBtn) {
      saveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 700));   // 等 save → getConfig → remount 走完
      if (content.querySelector('.edit-grid')) {
        ok('★ 点「保存配置」之后编辑区还在 —— 保存不会把正在编辑的卡片折叠掉');
      } else {
        fail('保存之后编辑区没了（整页重挂把展开状态丢了）—— 用户会以为改动被丢了');
      }
    } else {
      fail('编辑区里找不到「保存配置」按钮');
    }
  } else {
    fail('找不到卡片上的「详情」按钮，后面的编辑区检查没法做');
  }
} else {
  fail('导航栏里找不到「机器人」入口');
}

// ===========================================================================
// 6. 模型页：'已保存' 与 '已保存、但这把密钥看着是假的' 必须是两种样子
// ===========================================================================
//
// 为什么值得断言：这两种状态**在数据上是同一件事**（hasKey 都是 true），
// 只在界面上分得开。分不开的后果真发生过 —— 用户对着一个假 Key 反复点「测试」，
// 每次都报"密钥无效"，而界面一直写着"已保存"。
console.log('=== 6. 模型页的密钥状态 ===');

const modelNavBtn = navButtons.find((b) => b.textContent.trim().includes('模型'));
if (modelNavBtn) {
  modelNavBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));

  const mtext = content.textContent || '';
  if (mtext.includes('看着像测试用的假密钥')) ok('★ 假密钥被单独标出来了（不再和真密钥一样只写"已保存"）');
  else fail('模型页没把"看着像假密钥"标出来 —— 用户会以为密钥已经填好了');

  if (content.querySelector('.key-state.warn')) ok('假密钥用了警示样式（.key-state.warn）');
  else fail('假密钥没有警示样式（.key-state.warn 找不到）');

  // ★ 这条要查"那块说明到底说了什么"，不能只查 `.notice.warn` 存不存在 ——
  //   页面上本来就有别的黄条（例如"没有密钥的模型不会被启动"），
  //   只查选择器会拿到假阳性。第一版就是这么"通过"的。
  const fakeNotice = [...content.querySelectorAll('.notice.warn')]
    .find((el) => el.textContent.includes('测试用的假密钥'));
  if (fakeNotice && fakeNotice.textContent.includes('保存密钥')) {
    ok('假密钥下面有一块说明，且说清了"粘真 Key 进来覆盖它"');
  } else {
    fail('假密钥没有对应的说明块（没有哪条 .notice.warn 在讲"测试用的假密钥"）');
  }

  if (mtext.includes('还没保存密钥')) ok('没填密钥的模型仍然写「还没保存密钥」（三种状态没被混成两种）');
  else fail('没填密钥的模型没有显示「还没保存密钥」');

  if (mtext.includes('已保存（sk-…3f2a）')) ok('真密钥照旧显示「已保存（掩码）」');
  else fail('真密钥的显示被改坏了（找不到「已保存（sk-…3f2a）」）');
} else {
  fail('导航栏里找不到「模型」入口');
}

if (runtimeErrors.length) {
  console.log('=== 运行期错误 ===');
  for (const e of runtimeErrors.slice(0, 20)) fail(e.split('\n')[0]);
}

console.log('');
console.log(`结果：${problems.length ? `✗ ${problems.length} 个问题` : '✓ 全部通过'}`);
process.exit(problems.length ? 1 : 0);
