/**
 * tools/run-all-tests.mjs —— 一把跑完全部自检。
 *
 * ★ 为什么要有这个：以前每轮收尾都是我手打一段 PowerShell，把十几套命令抄一遍。
 *   抄漏过一次 `--import ./devtools/register-electron-stub.mjs`，结果
 *   `test-llm-errors` 报 `SyntaxError: Named export 'safeStorage' not found`，
 *   看上去像代码坏了，其实只是**跑法不对** —— 白查一轮。
 *
 *   把「哪几套、各自怎么跑」变成一份代码里的清单，这件事就不再靠记忆。
 *
 * 跑法：
 *   node --import ./devtools/register-electron-stub.mjs tools\run-all-tests.mjs
 *   （本身也要带 stub，因为它会用子进程去跑那些需要的套件）
 *
 * 退出码：0 = 全绿；1 = 有失败（并列出是哪几套）；2 = 有套件**因前置条件没跑**
 *   （本机测试服没开，例如 headless-multibot / headless-multiserver）——
 *   未跑不等于通过，所以它既不报绿也不报红。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/** 用哪个 node —— 不借 PATH，免得跑到系统那个版本上。 */
const NODE = path.join(ROOT, 'runtime', 'node-v22.23.3-win-x64', 'node.exe');

// ★★ 这里必须是 `--import xxx`，不能只写文件名。
//   我第一版写的就是 `const STUB = ['./devtools/register-electron-stub.mjs']`，
//   拼出来是 `node ./devtools/register-electron-stub.mjs devtools/headless-main.mjs`
//   —— 等于**把 stub 文件当入口脚本跑**，它注册完就退了，退出码 0、输出空。
//   于是四套 headless 全部"80ms 通过"，运行器报「14 套全绿」。
//   假绿比红灯危险得多：红灯你会去查，假绿你会直接信。
const STUB = ['--import', './devtools/register-electron-stub.mjs'];

/**
 * 全套自检。
 * `stub: true` 的套件会 import 到 electron（`app/electron/*` 都是），
 * 在真实 Electron 之外跑必须挂 `devtools/electron-loader.mjs` 那个假实现。
 *
 * `expect` —— ★ 每套**跑完时必须打出的那句话**。
 *   光看退出码不够：上面那个 `--import` 漏写的 bug，子进程的退出码也是 0。
 *   一个"什么都没跑"的进程和一个"全跑通了"的进程，返回值一模一样。
 *   所以要盯着**成果**，不是盯着**没报错**。
 */
const SUITES = [
    { name: 'render-headless', file: 'devtools/render-headless.mjs', stub: true, what: '8 个界面页能渲染出来', expect: /全部通过/ },
    { name: 'headless-main', file: 'devtools/headless-main.mjs', stub: true, what: '主进程 IPC / 配置 / 状态机', expect: /全部通过/ },
    { name: 'headless-multibot', file: 'devtools/headless-multibot.mjs', stub: true, needsLocalServer: true, what: '两个 bot 同时在线', expect: /全部通过/ },
    { name: 'headless-multiserver', file: 'devtools/headless-multiserver.mjs', stub: true, needsLocalServer: true, what: '两台服务器同时在线', expect: /全部通过/ },
    { name: 'test-vocab', file: 'tools/test-vocab.mjs', what: '中文方块词 / 数量 / 意图解析', expect: /全部通过/ },
    { name: 'test-builder', file: 'tools/test-builder.mjs', what: '找地基 / 盖房子', expect: /全部通过/ },
    { name: 'test-explorer', file: 'tools/test-explorer.mjs', what: '探索距离与分腿寻路', expect: /全部通过/ },
    { name: 'test-memory', file: 'tools/test-memory.mjs', what: '长期记忆读写与检索', expect: /全部通过/ },
    { name: 'test-workshop', file: 'tools/test-workshop.mjs', what: '配方算账 / 烧炼链', expect: /全部通过/ },
    { name: 'test-speak', file: 'tools/test-speak.mjs', what: '引擎回执翻中文', expect: /全部通过/ },
    { name: 'test-self-report', file: 'tools/test-self-report.mjs', what: '用中文汇报坐标与背包', expect: /项通过/ },
    { name: 'test-kick-reason', file: 'tools/test-kick-reason.mjs', what: '被服务器断开时说出原因', expect: /项通过/ },
    { name: 'test-firstrun', file: 'devtools/test-firstrun.mjs', stub: true, what: '主人名单"配没配过"这条链路', expect: /项通过/ },
    { name: 'test-llm-errors', file: 'tools/test-llm-errors.mjs', stub: true, what: '大模型报错翻人话', expect: /全部通过/ },
    { name: 'check-imports', file: 'tools/check-imports.mjs', stub: true, what: '静态查"用了却没 import"', expect: /没有"用了却没 import"/ },
    { name: 'check-speak-coverage', file: 'tools/check-speak-coverage.mjs', stub: true, what: '引擎每句话都翻了吗', expect: /玩家能敲的每条命令/ },
    // 这套查的是**字节**，不是逻辑：.cmd 里混进中文、或者换行变成 LF，双击就是
    // 满屏「'xxx' 不是内部或外部命令」而窗口根本不出现。用户真踩过（见 README 坑表）。
    { name: 'check-launchers', file: 'tools/check-launchers.mjs', stub: true, what: '启动脚本的字节编码', expect: /启动脚本编码检查通过/ },
    // 这套守的是"别把不该发的东西发出去"：真密钥、你的游戏 ID、密钥文件本身。
    // 它不需要 electron stub（只用 node 内置模块），也**故意不依赖沙箱** ——
    // 它要读的就是你**真实**的 runtime/config.json（里面才有需要比对的那几个值）。
    { name: 'check-publish', file: 'tools/check-publish.mjs', what: '推上 GitHub 会不会漏东西', expect: /结果：✓ 发布体检通过/ },
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const picked = only.length ? SUITES.filter((s) => only.includes(s.name)) : SUITES;

if (picked.length === 0) {
    console.error(`✗ 没匹配到套件。可用的：${SUITES.map((s) => s.name).join(', ')}`);
    process.exit(1);
}

const results = [];
const skipped = [];

// ★ 前置条件先探一次：`headless-multibot` / `headless-multiserver` 要**真的登录**本机
//   测试服（`testserver\`，127.0.0.1:25565）。服没开的时候它们会卡满 150 秒再去报
//   「小豆 没连上」，看报告的人会以为产品连不上服务器 —— 其实是这台机器上根本没服。
//   未跑 ≠ 失败，所以用第三种记号（⊘）和第三种退出码（2）分开说。
const LOCAL_SERVER = { host: '127.0.0.1', port: 25565 };

async function portOpen(host, port, timeoutMs = 1500) {
    return await new Promise((resolve) => {
        const sock = net.connect({ host, port });
        let settled = false;
        const done = (v) => {
            if (settled) return;
            settled = true;
            try { sock.destroy(); } catch { /* 关不掉就算了，反正马上退出 */ }
            resolve(v);
        };
        sock.setTimeout(timeoutMs, () => done(false));
        sock.on('connect', () => done(true));
        sock.on('error', () => done(false));
    });
}

const needServer = picked.some((s) => s.needsLocalServer);
const localServerUp = needServer ? await portOpen(LOCAL_SERVER.host, LOCAL_SERVER.port) : true;

for (const s of picked) {
    if (s.needsLocalServer && !localServerUp) {
        skipped.push(s);
        console.log(`⊘ ${s.name.padEnd(22)} ${'—'.padStart(6)}   本机测试服 ${LOCAL_SERVER.host}:${LOCAL_SERVER.port} 没在跑 —— 这套要真的登录服务器，未跑（不是产品失败）`);
        continue;
    }
    const args = [...(s.stub ? STUB : []), s.file];
    let t0 = Date.now();
    let r = spawnSync(NODE, args, { cwd: ROOT, encoding: 'utf8' });
    let stdout = r.stdout || '';
    let stderr = (r.stderr || '').trim();

    // ★★ 受限沙箱里 spawnSync 默认用**管道**收输出，而那种模式禁止建命名管道，
    //    于是每一套都报 `EPERM`、退出码 null —— 看上去像"17 套全挂了"，其实
    //    一行被测代码都没跑到。这里退一步：改用**文件**接输出（普通文件不是管道），
    //    跑完再读回来，判据完全不变。环境限制不该伪装成项目失败。
    if (r.error && r.error.code === 'EPERM') {
        const outFile = path.join(ROOT, 'runtime', 'tmp', `suite-${s.name}.out`);
        const errFile = path.join(ROOT, 'runtime', 'tmp', `suite-${s.name}.err`);
        const fdOut = fs.openSync(outFile, 'w');
        const fdErr = fs.openSync(errFile, 'w');
        let viaFile = null;
        t0 = Date.now();   // ★ 计时从**真跑**那一刻算：第一次是被环境拒掉的，几毫秒
        try {
            viaFile = spawnSync(NODE, args, { cwd: ROOT, stdio: ['ignore', fdOut, fdErr] });
        } finally {
            fs.closeSync(fdOut);
            fs.closeSync(fdErr);
        }
        stdout = fs.readFileSync(outFile, 'utf8');
        stderr = fs.readFileSync(errFile, 'utf8').trim();
        r = { status: viaFile.status, error: viaFile.error, stdout, stderr };
        if (r.status === null && r.error) {
            r.error.message = `${r.error.message}（用文件接输出也不行）`;
        }
    }

    // ★ 计时在**真正跑的那一次**之后取（走了文件回退的话，上面已经把 t0 重置过）。
    const ms = Date.now() - t0;

    // ★ 两道判据，缺一不可：
    //   1) 退出码是 0；
    //   2) 打出了那句"跑完了"的汇总 —— 否则就是**根本没跑**。
    //      只判退出码会在"子进程什么都没干就退了"时给出假绿（真实发生过）。
    const code = r.status;
    const ran = s.expect.test(stdout);
    let why = '';
    if (code !== 0) why = `退出码 ${code === null ? `null（子进程没起来：${r.error?.message || '未知'}）` : code}`;
    else if (!ran) why = `退出码 0，但没打出汇总行（${s.expect}）—— 这套多半根本没跑起来`;

    results.push({ ...s, code, ms, ran, why, stdout, tail: stdout.trim().split('\n').slice(-1)[0] || '', stderr });
    const mark = why ? '✗' : '✓';
    console.log(`${mark} ${s.name.padEnd(22)} ${String(ms).padStart(6)}ms  ${(why || results.at(-1).tail).slice(0, 90)}`);
}

const bad = results.filter((r) => r.why);
console.log('');
if (bad.length === 0 && skipped.length === 0) {
    console.log(`✓ ${results.length} 套自检全绿`);
    process.exit(0);
}

if (bad.length === 0) {
    console.log(`✓ 跑了的 ${results.length} 套全绿；另有 ${skipped.length} 套**没跑**：${skipped.map((s) => s.name).join('、')}`);
    console.log(`  原因：本机测试服 ${LOCAL_SERVER.host}:${LOCAL_SERVER.port} 没在跑（这两套要真的登录服务器）。`);
    console.log('  → 想跑全：先把 testserver 起起来，再重跑一次。**未跑不等于通过**，所以退出码是 2。');
    process.exit(2);
}

console.log(`✗ ${bad.length} / ${results.length} 套失败：`);

// ★ 十七套一起红、而且全是"子进程没起来"时，先别去查代码：那是**这个执行环境**不让
//   用管道收集子进程输出（沙箱限制，EPERM），一行被测代码都没跑到。运行器有义务把
//   这两件事分开说 —— 否则一次环境限制看起来就像"项目全坏了"。
if (bad.every((b) => b.code === null && /EPERM/.test(b.why))) {
    console.log('');
    console.log('  注意：这些失败全是 EPERM —— 当前执行环境不允许用管道收集子进程输出，');
    console.log('        被测代码一行都没跑到，不是项目的问题。请在普通终端里重跑，');
    console.log('        或逐套直接跑（PowerShell 的 *> 重定向不受这个限制）。');
}
for (const b of bad) {
    console.log(`\n── ${b.name}（${b.what}）${b.why} ──`);
    console.log(`   跑法：${b.file}`);
    // ★ 失败的那几行必须出现在这里。这些自检把进度写在 stderr 上，一跑就是几十上百行，
    //   原来只取**头 8 行** —— 于是"哪一条断言红了"永远被埋在中间看不见，
    //   只能自己去翻全套输出。凡是要给人看的失败报告，都必须先挑出 ✗ 那些行。
    //   ★★ 而且** stdout 也要一起找**：有的套件（如 headless-multibot）把进度写在 stdout，
    //   只翻 stderr 的结果是"报告里一条红行都没有"，还是得回去重跑一遍才知道哪条红了。
    const lines = `${b.stderr}\n${b.stdout}`
        .split('\n')
        .map((l) => l.trimEnd())
        .filter(Boolean);
    const badLines = lines.filter((l) => l.includes('✗'));
    const show = (badLines.length ? badLines : lines).slice(0, 12);
    if (badLines.length) console.log(`   红掉的 ${badLines.length} 行：`);
    console.log(show.map((l) => `   ${l}`).join('\n'));
    // 没跑起来的套件，把它仅有的一点输出也打出来 —— 线索通常就在这几行里
    if (!b.ran && b.stdout) console.log(b.stdout.trim().split('\n').slice(-8).map((l) => `   ${l}`).join('\n'));
}
process.exit(1);
