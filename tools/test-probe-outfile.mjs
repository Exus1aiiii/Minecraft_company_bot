// ============================================================================
// `server:probe` 的结果文件：**子进程写的那个文件，父进程必须读得到** ——
// 哪怕 `Date.now()` 每次调用都往前跳一大步。
//
// 为什么要有这一套：`app/electron/ipc.mjs` 里的 server:probe 以前长这样 ——
//     args.push('--out', path.join(TMP_DIR, `probe-${Date.now()}.json`));
//     const res = await runTool(args, { outName: `probe-${Date.now()}.json`, … });
// 名字**各算了一次**。两次调用之间跨过一个毫秒时，子进程把结果写到 A 文件，
// 父进程去读 B 文件，读不到就报「探测进程没有返回结果（详见 runtime\tmp 下的探测日志）」。
//
// 现场唯一留下的痕迹，是父进程建的那个 **0 字节的 `probe-<另一个时间戳>.json.log`**
// —— 有 .log 却没有同名 .json，就是名字算了两遍。2026-10 就是靠它抓到的：
// 19 套自检里 `headless-main` 单红一条，报的却是"探测没有结果"，
// 而它测的是**本机一个刚关掉的端口**（一定会 ECONNREFUSED），根本不该没有结果。
//
// 这类 bug 的坏处不在"测试偶发红"，而在**用户拿它测自己的在线服务器时也会偶发**，
// 看到的是一句与真实原因（地址写错/服务器没开）毫无关系的错误。
//
// 怎么让这个"毫秒边界"必然被跨过：把 `Date.now()` 换成"每调用一次前进 997 毫秒"。
// 名字算两遍 → 必红；名字只算一遍 → 必绿。
//
// 用法：node --import ./devtools/register-electron-stub.mjs tools\test-probe-outfile.mjs
// ============================================================================

import '../devtools/sandbox-env.mjs';

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

let checks = 0;
let problems = 0;
const ok = (m) => { checks += 1; console.log('  ✓ ' + m); };
const fail = (m) => { checks += 1; problems += 1; console.log('  ✗ ' + m); };
const section = (t) => console.log(`\n=== ${t} ===`);

console.log('probe 结果文件自检（子进程写哪里、父进程读哪里）');

const stub = await import('../devtools/electron.mjs');
const paths = await import('../app/electron/paths.mjs');
const ipcMod = await import('../app/electron/ipc.mjs');

section('1. 准备');
ipcMod.registerIpc();
const { ipcMain } = stub;
ok(`IPC 已注册，探测文件写到 ${path.relative(paths.PROJECT_ROOT, paths.TMP_DIR)}`);

// 一个"一定没人听"的端口：先占用再立刻释放，拿到一个刚空出来的端口号
const deadPort = await new Promise((resolve) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
ok(`拿一个空端口来测：127.0.0.1:${deadPort}`);

// 父进程在 openSync(logFile) 时就会建出 `<outFile>.log`。名字算了两遍的话，
// 那个 .log 的主文件名**没有**对应的 .json —— 这就是那个 bug 的指纹。
const orphans = () => fs.readdirSync(paths.TMP_DIR)
  .filter((f) => f.startsWith('probe-') && f.endsWith('.json.log'))
  .filter((f) => !fs.existsSync(path.join(paths.TMP_DIR, f.replace(/\.log$/, ''))));
const orphansBefore = orphans();
if (orphansBefore.length) {
  console.log(`  · 修复前留下的孤儿日志 ${orphansBefore.length} 个：${orphansBefore.slice(0, 3).join(', ')}`
    + '（有 .log 却没有同名 .json —— 这就是"名字算了两遍"的指纹，留着当证据）');
} else {
  console.log('  · 这个沙箱里没有历史孤儿日志（不代表没发生过：每次运行会清 logs\\，tmp\\ 里的会留着）');
}

const realNow = Date.now;
let fake = 1_700_000_000_000;
/** ★ 每调用一次前进 997 毫秒 —— 两次 `Date.now()` 绝不可能相等。 */
Date.now = () => { fake += 997; return fake; };

section('2. 时间戳每次都跳，探测结果必须照样回得来（3 次）');
const results = [];
for (let i = 1; i <= 3; i += 1) {
  const r = await ipcMain.invoke('server:probe', { host: '127.0.0.1', port: deadPort, version: '' });
  results.push(r);
  const err = String(r?.error || '');
  if (r?.ok === false && /拒绝了连接/.test(err)) ok(`第 ${i} 次：翻成人话了 —— "${err}"`);
  else fail(`第 ${i} 次：拿到的是 "${err}"（期望"拒绝了连接"）。若是"探测进程没有返回结果"，说明 --out 和 outName 又各算了一次时间戳`);
}

section('3. 这轮探测没有新增孤儿日志（父进程读的文件名 == 子进程写的文件名）');
Date.now = realNow;
const orphansAfter = orphans();
if (orphansAfter.length === orphansBefore.length) ok(`孤儿日志没有新增（仍是修复前那 ${orphansBefore.length} 个）`);
else fail(`这轮多出 ${orphansAfter.length - orphansBefore.length} 个孤儿日志：${orphansAfter.filter((f) => !orphansBefore.includes(f)).join(', ')} —— 文件名多半又算了两遍`);

// 顺带确认这次跑出来的文件里确实有真结果，而不是"空文件也算过"
const done = fs.readdirSync(paths.TMP_DIR)
  .filter((f) => f.startsWith('probe-') && f.endsWith('.json'))
  .map((f) => ({ f, txt: (() => { try { return fs.readFileSync(path.join(paths.TMP_DIR, f), 'utf8').trim(); } catch { return ''; } })() }))
  .filter((p) => p.txt.includes('ECONNREFUSED'));
if (done.length >= 3) ok(`本轮留下 ${done.length} 份"连接被拒"的原始结果（父进程真的读到了它们）`);
else fail(`只找到 ${done.length} 份原始结果，期望至少 3 份 —— 探测可能没真的跑起来`);

console.log(`\n结果：${problems === 0 ? '✓ 全部通过' : '✗ 有问题'}（共 ${checks} 项检查）`);
process.exit(problems === 0 ? 0 : 1);
