#!/usr/bin/env node
// ============================================================================
// tools/bootstrap.mjs —— 「从 GitHub 拿到源码」到「能双击启动」之间的那一步。
//
// 仓库里**故意**没有三样东西（体积 / 许可证 / 可复现性，理由写在 .gitignore 里）：
//   ① runtime\node-v22.23.3-win-x64\        Node 22 运行时（94 MB，官方 zip 解压而来）
//   ② vendor\mindcraft-develop\node_modules\ 引擎依赖（714 MB）
//   ③ app\node_modules\                     Electron 44.5.1（380 MB）
// 这个脚本负责把它们补齐 —— 并且**验证补对了**。
//
// 三条硬约束（都是踩过的坑，不是风格偏好）：
//   ① 引擎必须跑在 Node 22：mineflayer@4.33.0 的 engines 是 >=22，而 v24 会踩原生依赖
//      与行为差异 → 固定 22.23.3，装到 runtime\ 下（启动器与 app\electron\paths.mjs
//      都是按 `runtime\node-v<major>...-win-x64\node.exe` 这个形状去找的）。
//   ② 引擎依赖必须让 patch-package 的 4 个补丁**真的打上**。只看 npm 的退出码是不够的
//      —— npm 安装成功但补丁没打上，是上游 lockfile 缺失时的经典坑。所以每个补丁都有
//      一条可验证的"证据串"（见 PATCH_EVIDENCE），装完逐条查，查不到就报红并说清楚。
//   ③ Electron 的 dist\electron.exe 必须是完整文件（半截文件双击时表现为"起不来"）。
//
// ★ 幂等、可中断续跑：每一步先体检，已经就绪就跳过；npm 的缓存留在 runtime\npm-cache，
//   下载断在半路再跑一次只补缺的部分。断网、被杀、重启都能接着来。
//
// 用法：
//   node tools/bootstrap.mjs              # 体检 + 问一句就开始补
//   node tools/bootstrap.mjs --check      # 只体检（退出码 0 = 三样都齐）
//   node tools/bootstrap.mjs --yes        # 不问，直接补（给启动器/脚本调用）
//   node tools/bootstrap.mjs --only node  # 只补某一步（node|engine|app，可逗号分隔）
//   node tools/bootstrap.mjs --force      # 已就绪的那步也重装
//
// 退出码：0 = 三样都齐（或本次补齐了）；1 = 还差东西；2 = 用法不对。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const ENGINE_DIR = path.join(ROOT, 'vendor', 'mindcraft-develop');
const ENGINE_MODULES = path.join(ENGINE_DIR, 'node_modules');
const APP_DIR = path.join(ROOT, 'app');
const NPM_CACHE = path.join(RUNTIME, 'npm-cache');
const ELECTRON_CACHE = path.join(RUNTIME, 'electron-cache');
const INSTALL_NODE_PS1 = path.join(HERE, 'install-node.ps1');

const NODE_VERSION = '22.23.3';
const NODE_DIRNAME = `node-v${NODE_VERSION}-win-x64`;
const NODE_MAJOR_MIN = 22;
const NODE_MAJOR_MAX = 23; // 排他上界：24 不在受支持区间
const MIN_ELECTRON_BYTES = 1_000_000; // 与 tools\launch-gui.ps1 里那条"半截文件"判据一致
const ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'; // 只在官方源失败后启用
const NPM_MIRROR = 'https://registry.npmmirror.com';              // 同上：官方 registry 失败后才用

// 引擎依赖里必须存在的精确版本（V-2 钉死的那些，见 docs/05-vendor补丁与依赖锁定.md）
const ENGINE_PINS = {
  mineflayer: '4.33.0',
  'mineflayer-pathfinder': '2.4.5',
  'mineflayer-pvp': '1.3.2',
  'minecraft-data': '3.117.0',
  protodef: '1.19.0',
};

// ★ 补丁的"证据串"：装完之后必须在这些文件里找得到这些字面量。
//   为什么不用"patch-package 退出码"：它可能报成功而补丁其实没匹配上（版本漂移时），
//   也可能静默 skip。物理证据才是判据。
const PATCH_EVIDENCE = [
  { patch: 'mineflayer+4.33.0.patch（挖掘判定）', file: 'mineflayer/lib/plugins/digging.js', needle: 'incorrect_for_wooden_tool', why: '缺了它，用木镐挖错方块时的判定是错的' },
  { patch: 'mineflayer+4.33.0.patch（放方块等待）', file: 'mineflayer/lib/plugins/place_block.js', needle: 'timeout: 500', why: '缺了它，放方块要白等 5 秒' },
  { patch: 'mineflayer-pvp+1.3.2.patch', file: 'mineflayer-pvp/lib/PVP.js', needle: 'physicsTick', why: "上游把事件名拼成 physicTick，永不触发 → 打了补丁战斗插件才是活的" },
  { patch: 'mineflayer-pathfinder+2.4.5.patch', file: 'mineflayer-pathfinder/index.js', needle: '0.175', why: '到点容差 0.35→0.175：缺了它 bot 会在目标附近来回蹭' },
  { patch: 'protodef+1.19.0.patch', file: 'protodef/src/serializer.js', needle: "// console.log('Chunk size is", why: '缺了它，partial packet 会刷屏' },
];

// ── 小工具 ───────────────────────────────────────────────────────────────────

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOR ? `\u001b[${code}m${s}\u001b[0m` : s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const red = (s) => c('31', s);
const cyan = (s) => c('36', s);
const dim = (s) => c('90', s);

function mb(bytes) { return `${(bytes / 1048576).toFixed(1)} MB`; }

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function fileHas(file, needle) {
  try { return fs.readFileSync(file, 'utf8').includes(needle); } catch { return false; }
}

function mkdirp(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ } }

/** PowerShell 5.1 的绝对路径（launch-gui.ps1 用的也是这一个）。 */
function powershellExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return exists(full) ? full : 'powershell.exe';
}

// ── 体检：三样东西各自的判据 ─────────────────────────────────────────────────

/** Node 运行时：runtime\ 下有没有一个能跑的 node-v22*-win-x64\node.exe */
function detectNode() {
  const dir = path.join(RUNTIME, NODE_DIRNAME);
  const exe = path.join(dir, 'node.exe');
  if (!exists(exe)) {
    // 也接受别的 22.x（用户可能自己换了小版本），但优先报告我们钉的那个
    let alt = null;
    try {
      for (const name of fs.readdirSync(RUNTIME)) {
        const m = /^node-v(\d+)\.(\d+)\.(\d+)-win-x64$/.exec(name);
        if (!m) continue;
        const e = path.join(RUNTIME, name, 'node.exe');
        if (!exists(e)) continue;
        const major = Number(m[1]);
        if (major >= NODE_MAJOR_MIN && major < NODE_MAJOR_MAX) alt = { dir: path.join(RUNTIME, name), exe: e, version: `v${m[1]}.${m[2]}.${m[3]}` };
      }
    } catch { /* runtime 不存在 */ }
    if (alt) return { ok: true, ...alt, note: '（不是我们钉的 22.23.3，但版本区间合适）' };
    return { ok: false, dir, exe, version: null, problems: [`runtime\\${NODE_DIRNAME}\\node.exe 不存在`] };
  }
  const r = runNode(exe);
  if (!r.ok) return { ok: false, dir, exe, version: null, problems: [`node.exe 在，但跑不起来（退出码 ${r.status}）—— 多半是上次解压没解完`] };
  return { ok: true, dir, exe, version: `v${NODE_VERSION}`, note: '' };
}

/** 拿这个 node.exe 跑一次 -v。★ 用 stdio:'ignore' 只取退出码：本项目的自检沙箱里管道会 EPERM。 */
function runNode(exe) {
  const r = spawnSync(exe, ['-v'], { stdio: 'ignore' });
  return { ok: r.status === 0, status: r.status };
}

/** 引擎依赖：版本钉对了 + 5 条补丁证据都在 */
function detectEngine() {
  const problems = [];
  const versions = {};
  if (!exists(path.join(ENGINE_DIR, 'main.js'))) problems.push(`找不到引擎本体：${ENGINE_DIR}\\main.js`);
  if (!exists(ENGINE_MODULES)) {
    problems.push('引擎依赖没装：vendor\\mindcraft-develop\\node_modules 不存在');
    return { ok: false, problems, versions };
  }
  for (const [pkg, want] of Object.entries(ENGINE_PINS)) {
    const v = readJson(path.join(ENGINE_MODULES, pkg, 'package.json'))?.version || null;
    versions[pkg] = v;
    if (v !== want) problems.push(`${pkg} 实际是 ${v || '缺失'}，应该是 ${want}（依赖漂移会让补丁打不上）`);
  }
  for (const ev of PATCH_EVIDENCE) {
    if (!fileHas(path.join(ENGINE_MODULES, ev.file), ev.needle)) {
      problems.push(`补丁没生效：${ev.patch} —— ${ev.file} 里找不到 "${ev.needle}"。${ev.why}`);
    }
  }
  return { ok: problems.length === 0, problems, versions };
}

/** 应用依赖：electron.exe 存在且是完整文件 */
function detectApp() {
  const exe = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!exists(exe)) {
    return { ok: false, exe, bytes: 0, problems: ['app\\node_modules\\electron\\dist\\electron.exe 不存在（app 依赖还没装）'] };
  }
  const bytes = fs.statSync(exe).size;
  if (bytes < MIN_ELECTRON_BYTES) {
    return { ok: false, exe, bytes, problems: [`electron.exe 只有 ${bytes} 字节，是半截文件（正常约 2.4 亿字节）—— 下载没下完`] };
  }
  return { ok: true, exe, bytes, problems: [] };
}

/**
 * 最终判据：**用应用自己的环境自检**（app\electron\env.mjs）来判，而不是我另写一套。
 * 好处是"bootstrap 说好了"和"界面「环境」页说好了"永远是同一个结论；坏处是这条判据
 * 会随应用演进而变 —— 但那正是我们要的。
 * 唯一要滤掉的是 Java：它只对"自建服务端 / 跨版本代理"需要，不是硬前提。
 */
async function appEnvVerdict() {
  try {
    const mod = await import(pathToFileURL(path.join(APP_DIR, 'electron', 'env.mjs')).href);
    const env = mod.getEnv();
    const problems = env.problems.filter((p) => !String(p).includes('Java'));
    return { ok: problems.length === 0, problems, env };
  } catch (e) {
    return { ok: false, problems: [`跑环境自检时出错：${e.message}`], env: null };
  }
}

function detectAll() {
  return { node: detectNode(), engine: detectEngine(), app: detectApp() };
}

// ── 三步各自的"干活" ────────────────────────────────────────────────────────

/** ① Node 运行时：交给 install-node.ps1（这一步必须由 PowerShell 做，见那个文件的注释） */
function installNodeStep() {
  if (!exists(INSTALL_NODE_PS1)) throw new Error(`找不到 ${INSTALL_NODE_PS1}`);
  const r = spawnSync(powershellExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALL_NODE_PS1, '-Version', NODE_VERSION], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`install-node.ps1 退出码 ${r.status} —— 看它上面的输出，它会说清卡在哪一步`);
}

/** npm 的位置：官方 Node 发行版自带 npm（node_modules\npm\bin\npm-cli.js） */
function npmCliFor(nodeExe) {
  const dir = path.dirname(nodeExe);
  const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (exists(cli)) return { exe: nodeExe, args: [cli] };
  const cmd = path.join(dir, 'npm.cmd');
  if (exists(cmd)) return { exe: cmd, args: [] };
  return null;
}

/**
 * 跑 npm 的环境。三处讲究：
 *   · PATH 前面插上这个 Node —— patch-package 的 postinstall 会 spawn 子进程，
 *     必须让子进程也用 Node 22（否则可能落到系统那个 v24 上）。
 *   · 缓存与 Electron 的下载缓存都收进 runtime\ —— 用户删项目目录时就一起没了，
 *     不会在 %LOCALAPPDATA% 里留 1 GB 垃圾；而且重装/续跑能复用。
 *   · 摘掉 ELECTRON_RUN_AS_NODE / NODE_OPTIONS —— 开发环境（DSH、编辑器）会注入它们，
 *     注入后 Electron 会把自己当成"纯 Node"，postinstall 下载完装出来的东西是坏的。
 */
function npmEnv(nodeExe, { electronMirror = null } = {}) {
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[key] = path.dirname(nodeExe) + path.delimiter + (env[key] || '');
  env.npm_config_cache = NPM_CACHE;
  env.npm_config_audit = 'false';
  env.npm_config_fund = 'false';
  env.ELECTRON_CACHE = ELECTRON_CACHE;
  if (electronMirror) env.ELECTRON_MIRROR = electronMirror;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

/**
 * npm 失败时，去它自己的调试日志里找"人话原因"。
 * 为什么要这一步：npm 真实的报错常常是最后一行 `Exit handler never called!`（我们冷启动
 * 实测过一次），用户根本看不出是网络问题；而日志里明明白白写着
 * `ERR_TLS_CERT_ALTNAME_INVALID`。把日志翻译成人话，比让用户去翻 _logs 目录有用得多。
 */
function npmFailureHint() {
  try {
    const dir = path.join(NPM_CACHE, '_logs');
    if (!exists(dir)) return null;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('-debug-0.log')).sort();
    if (!files.length) return null;
    const file = path.join(dir, files[files.length - 1]);
    const text = fs.readFileSync(file, 'utf8').slice(-200_000);
    const rules = [
      [/ERR_TLS_CERT_ALTNAME_INVALID|SELF_SIGNED_CERT_IN_CHAIN|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS[_:]/,
        'npm 报的是证书对不上（ERR_TLS…）—— 这台电脑的网络上有个代理或安全软件在换证书。关掉代理 / 换个网络再试，或直接用国内镜像装。'],
      [/EAI_AGAIN|ENOTFOUND|getaddrinfo/,
        'npm 说域名解析不了（ENOTFOUND / EAI_AGAIN）—— 检查网络，或公司网是不是拦了 registry.npmjs.org。'],
      [/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ERR_SOCKET_TIMEOUT|network timeout/i,
        'npm 说连不上、超时（ETIMEDOUT / ECONNRESET）—— 多半是防火墙或代理。'],
      [/E401|E403/,
        'npm 说 registry 拒绝了（401/403）—— 这台机器可能配了需要登录的私有源。'],
      [/ENOSPC/,
        'npm 说磁盘满了（ENOSPC）—— 清点空间再跑一次。'],
      [/\bE404\b|\b404 Not Found\b/,
        'npm 说 registry 上没有这个包或这个版本（404）—— 如果这是**换成国内镜像之后**才出现的，说明镜像没同步全这个包（我们实测过一次：`minecraft-assets@1.19.0` 在镜像上就是 404）。换回官方源、或换一条网络再试。'],
    ];
    for (const [re, msg] of rules) if (re.test(text)) return `${msg}\n  （npm 的完整日志：${file}）`;
    return `（这条错误没被认出来，npm 的完整日志在：${file}）`;
  } catch { return null; }
}

function runNpm(nodeExe, cwd, args, opts = {}) {
  const npm = npmCliFor(nodeExe);
  if (!npm) throw new Error(`找不到 npm：${path.dirname(nodeExe)} 下既没有 node_modules\\npm\\bin\\npm-cli.js 也没有 npm.cmd`);
  mkdirp(NPM_CACHE);
  console.log(dim(`    $ ${path.basename(nodeExe)} ${npm.args.join(' ')} ${args.join(' ')}   （cwd=${path.relative(ROOT, cwd) || '.'}）`));
  const r = spawnSync(npm.exe, [...npm.args, ...args], { cwd, stdio: 'inherit', env: npmEnv(nodeExe, opts) });
  if (r.error) throw new Error(`npm 起不来：${r.error.message}`);
  if (r.status !== 0) {
    const hint = npmFailureHint();
    throw new Error(`npm ${args[0]} 退出码 ${r.status}` + (hint ? `\n  ${hint}` : ''));
  }
}

/** 先直连官方源；失败就换国内镜像重试一次（镜像上的包与 lockfile 里记的完整性哈希是同一份，
 *  换源不会让版本漂移，只是换一条路）。两个源都失败时，把**两次**的失败原因都摆出来 ——
 *  只报第一次会把人引偏：我们冷跑时第一次是"证书对不上"，第二次其实是"镜像缺这个包（404）"。 */
function npmWithMirror(nodeExe, cwd, args, opts = {}) {
  try {
    runNpm(nodeExe, cwd, args, opts);
    return;
  } catch (e1) {
    console.log('');
    console.log(yellow(`  直连 npm 官方源没成，换国内镜像再试一次：${NPM_MIRROR}`));
    try {
      runNpm(nodeExe, cwd, [...args, `--registry=${NPM_MIRROR}`], opts);
    } catch (e2) {
      const lines = String(e2.message).split('\n');
      const extra = lines.slice(1).join('\n');
      throw new Error([
        '第一次（官方源）失败的原因：',
        ...String(e1.message).split('\n').map((l) => '  ' + l),
        `换成 ${NPM_MIRROR} 也不行：${lines[0]}`,
        ...(extra ? extra.split('\n') : []),
        '  （两个源都失败时，先按上面最后那条提示处理。）',
      ].join('\n'));
    }
  }
}

/** ② 引擎依赖：npm ci（有 lockfile → 可复现），装完立刻做证据校验 */
function installEngineStep(nodeExe) {
  if (!exists(path.join(ENGINE_DIR, 'package-lock.json'))) {
    // 没有 lockfile 时 npm ci 会直接拒绝 —— 那是"依赖又漂移了"的信号，要说清楚
    throw new Error('vendor\\mindcraft-develop\\package-lock.json 不见了。它是 V-2 故意保留的（可复现构建），不要删；没有它就用 `npm install` 装，但版本会漂移、补丁可能打不上。');
  }
  const args = ['ci', '--no-audit', '--no-fund', '--include=dev'];
  npmWithMirror(nodeExe, ENGINE_DIR, args);
  const after = detectEngine();
  if (!after.ok) {
    throw new Error([
      'npm 装完了，但引擎依赖**没有达到可用状态**：',
      ...after.problems.map((p) => `  · ${p}`),
      '  排查顺序（docs\\05 第五节）：先确认 patches\\ 下 4 个补丁文件都在，再删掉 node_modules 重装一次。',
    ].join('\n'));
  }
  return after;
}

/** ③ 应用依赖：npm ci；如果 electron.exe 没下来，换国内镜像再试一次 */
function installAppStep(nodeExe) {
  const args = ['ci', '--no-audit', '--no-fund', '--include=dev'];
  npmWithMirror(nodeExe, APP_DIR, args);
  let after = detectApp();
  if (after.ok) return after;

  console.log('');
  console.log(yellow('  Electron 的二进制没下来（这个包把真正的桌面运行时放在 postinstall 里现下）。'));
  console.log(yellow(`  换国内镜像再试一次：${ELECTRON_MIRROR}`));
  runNpm(nodeExe, APP_DIR, ['install', '--no-audit', '--no-fund', '--include=dev', `--registry=${NPM_MIRROR}`], { electronMirror: ELECTRON_MIRROR });
  after = detectApp();
  if (!after.ok) {
    throw new Error([
      'Electron 还是没装好：',
      ...after.problems.map((p) => `  · ${p}`),
      '  手动兜底：删掉 app\\node_modules\\electron，然后',
      `    set ELECTRON_MIRROR=${ELECTRON_MIRROR}`,
      '    cd /d app && npm install',
    ].join('\n'));
  }
  return after;
}

// ── 报告与流程 ──────────────────────────────────────────────────────────────

const STEPS = [
  { id: 'node', title: 'Node 22 运行时', size: '下载约 30 MB / 占用约 95 MB', probe: detectNode, run: installNodeStep },
  { id: 'engine', title: '引擎依赖 vendor\\mindcraft-develop', size: '下载约 300 MB / 占用约 714 MB', probe: detectEngine, run: installEngineStep },
  { id: 'app', title: '应用依赖 app（Electron 44.5.1）', size: '下载约 130 MB / 占用约 380 MB', probe: detectApp, run: installAppStep },
];

function printState(state) {
  console.log('【当前状态】');
  for (const step of STEPS) {
    const s = state[step.id];
    const mark = s.ok ? green('✓') : red('✗');
    console.log(`  ${mark} ${step.title}  ${dim(step.size)}`);
    if (s.ok) {
      const extra = step.id === 'node' ? s.exe : step.id === 'app' ? `${mb(s.bytes)}` : `补丁与版本都对`;
      console.log(dim(`      ${extra}${s.note || ''}`));
    } else {
      for (const p of s.problems) console.log(`      ${yellow('·')} ${p}`);
    }
  }
}

function usage() {
  console.log(`用法: node tools/bootstrap.mjs [选项]

  --check        只体检，不下载（退出码 0 = 三样都齐）
  --yes, -y      不问，直接开始补装
  --only <列表>  只补指定步骤，可逗号分隔：node,engine,app
  --force        已经就绪的步骤也重装
  --help, -h     看这个
`);
}

function parseArgs(argv) {
  const out = { check: false, yes: false, force: false, only: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--only') {
      const v = argv[++i];
      if (!v) throw Object.assign(new Error('--only 后面要跟 node / engine / app'), { usage: true });
      out.only = v.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = out.only.filter((s) => !STEPS.some((st) => st.id === s));
      if (bad.length) throw Object.assign(new Error(`--only 里有不认识的步骤：${bad.join(', ')}（只有 node / engine / app）`), { usage: true });
    } else if (a.startsWith('-')) {
      throw Object.assign(new Error(`不认识的参数：${a}`), { usage: true });
    }
  }
  return out;
}

/** 交互式问一句。非 TTY（被脚本/启动器调）时默认"是"。 */
function askYesNo(question) {
  process.stdout.write(question);
  if (!process.stdin.isTTY) { console.log('（非交互环境，默认继续）'); return true; }
  const buf = Buffer.alloc(1);
  let s = '';
  try {
    for (;;) {
      const n = fs.readSync(0, buf, 0, 1, null);
      if (!n) break;
      const ch = buf.toString('utf8', 0, n);
      if (ch === '\n' || ch === '\r') break;
      s += ch;
    }
  } catch { return true; }
  const t = s.trim().toLowerCase();
  return t === '' || t === 'y' || t === 'yes' || t === '是';
}

function banner() {
  console.log('');
  console.log(cyan('MC 陪伴机器人 · 依赖补齐（从源码到能启动）'));
  console.log(dim(`  项目目录：${ROOT}`));
  console.log(dim(`  这一步要装的东西：Node ${NODE_VERSION} 运行时 + 引擎依赖 + Electron 44.5.1`));
  console.log(dim('  合计下载约 460 MB，装完约占 1.2 GB 磁盘；中途断了再跑一次会接着装。'));
  console.log('');
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.log(red(String(e.message))); usage(); return 2; }
  if (opts.help) { usage(); return 0; }

  banner();
  let state = detectAll();
  printState(state);

  if (opts.check) {
    const verdict = await appEnvVerdict();
    console.log('');
    if (verdict.ok) {
      console.log(green('✓ 三步都齐了，可以直接双击 启动.cmd。'));
      return 0;
    }
    console.log(red('✗ 还差东西（下面这些是应用自己的环境自检说的）：'));
    for (const p of verdict.problems) console.log(`  · ${p}`);
    return 1;
  }

  // 哪些步骤需要动手
  let pending = STEPS.filter((s) => (opts.only ? opts.only.includes(s.id) : true) && (opts.force || !state[s.id].ok));
  // 只装了其中几步时，最终体检里"别的步骤还缺"不算这次失败（--only node 的退出码不该是 1）
  const narrowed = !!opts.only && opts.only.length < STEPS.length;

  if (!pending.length) {
    const verdict = await appEnvVerdict();
    console.log('');
    if (verdict.ok) {
      console.log(green('✓ 不用补任何东西：三样都已经就绪。'));
    } else if (narrowed) {
      console.log(yellow('· 你点名的 ' + opts.only.join(', ') + ' 已经是好的；下面这些是你没点名的：'));
      for (const p of verdict.problems) console.log(`  · ${p}`);
      console.log(dim('  想一次补全就跑：node tools/bootstrap.mjs'));
      return 0;
    } else {
      console.log(yellow('· 三样依赖都齐了，但应用的环境自检还是有问题：'));
      for (const p of verdict.problems) console.log(`  · ${p}`);
      return 1;
    }
    printNextSteps();
    return 0;
  }

  console.log('');
  console.log('【要做的事】');
  for (const s of pending) console.log(`  · ${s.title}  ${dim(s.size)}`);
  console.log('');

  if (!opts.yes && !askYesNo('现在开始？（回车 = 开始，n = 先不动） ')) {
    console.log('好，什么都没改。想装的时候再跑一次就行。');
    return 1;
  }

  mkdirp(RUNTIME);

  for (const step of pending) {
    console.log('');
    console.log(cyan(`━━ ${step.title} ━━`));
    try {
      if (step.id === 'engine' || step.id === 'app') {
        const nodeState = detectNode();
        if (!nodeState.ok) throw new Error('引擎/应用依赖必须用 Node 22 来装，但 Node 运行时还没装好（先跑 `--only node`）');
        step.run(nodeState.exe);
      } else {
        step.run();
      }
    } catch (e) {
      console.log('');
      console.log(red(`✗ ${step.title} 没装上：`));
      for (const line of String(e.message).split('\n')) console.log(`  ${line}`);
      console.log('');
      console.log(yellow('  修掉上面这个问题，然后**再跑一次本脚本** —— 已经装好的步骤不会重来。'));
      return 1;
    }
    state = detectAll();
    const after = state[step.id];
    if (!after.ok) {
      console.log(red(`✗ ${step.title} 装完了但体检还是不过：`));
      for (const p of after.problems) console.log(`  · ${p}`);
      return 1;
    }
    console.log(green(`✓ ${step.title} 就绪`));
  }

  // ── 收尾：用应用自己的环境自检做最终判据 ──
  const verdict = await appEnvVerdict();
  console.log('');
  console.log(cyan('━━ 最终体检（应用自己的环境自检）━━'));
  if (verdict.env) {
    console.log(`  Node       : ${verdict.env.nodeVersion || '（没有）'}${verdict.env.nodeSupported ? '' : dim('  ← 不在受支持的 22.x 区间')}`);
    console.log(`  引擎依赖   : ${verdict.env.engineOk ? 'OK' : '缺失'}`);
    const v = verdict.env.versions || {};
    console.log(`  依赖版本   : mineflayer ${v.mineflayer} / minecraft-data ${v.minecraftData} / minecraft-protocol ${v.minecraftProtocol}`);
    console.log(`  人格预设   : ${verdict.env.personas?.length || 0} 个`);
  }
  if (!verdict.ok) {
    console.log('');
    if (narrowed) {
      console.log(yellow('· 你这次只点名了 ' + opts.only.join(', ') + '，这几步都好了。下面这些是你没点名的：'));
      for (const p of verdict.problems) console.log(`  · ${p}`);
      console.log(dim('  想一次补全就跑：node tools/bootstrap.mjs'));
      return 0;
    }
    console.log(red('✗ 还有问题：'));
    for (const p of verdict.problems) console.log(`  · ${p}`);
    return 1;
  }
  console.log('');
  console.log(green('✓ 全部就绪。'));
  printNextSteps();
  return 0;
}

function printNextSteps() {
  console.log('');
  console.log('【下一步】');
  console.log('  1) 双击项目根目录的 启动.cmd —— 窗口应该就出来了。');
  console.log('  2) 在「服务器」页填你要让 bot 进去的那个服务器地址（默认是占位符，指向哪都连不上）。');
  console.log('  3) 在「模型」页填 BigModel/DeepSeek 之类的 API Key，填完点一下「测试」。');
  console.log('  4) 出问题先看窗口里的「环境」和「日志」两页，它们说的是中文。');
}

main().then((code) => process.exit(code)).catch((e) => {
  console.log('');
  console.log(red(`✗ 出错了：${e && e.stack ? e.stack : e}`));
  process.exit(1);
});
