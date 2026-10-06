// ============================================================================
// tools/check-launchers.mjs —— 钉死"要双击的脚本"的两条编码规则
//
// ★ 为什么需要这个检查（这不是洁癖，是一次真实报障）：
//   用户双击 启动.cmd，看到的是一屏
//       '竻鎺夛紝鍚﹀垯绐楀彛鏍规湰涓嶄細鍑虹幇銆?set' 不是内部或外部命令
//   而且窗口根本没出来。原因有两个，都在文件本身：
//     ① cmd.exe 用**控制台代码页**（中文 Windows = GBK/936）解码 .cmd 内容，
//        而文件是 UTF-8 存的 —— 中文注释被解成乱码，乱码又**吃掉了换行**，
//        于是 `rem 这是一句注释` 和它下面那行命令被拼成一条命令去执行；
//     ② 文件是 LF 换行，cmd.exe 期望 CRLF。
//   这两条都属于"文件字节层面"的错误：代码怎么读都挑不出毛病，
//   node --check 也永远通过，只有真的双击一次才会暴露。所以必须用检查兜住。
//
// 规则：
//   .cmd / .bat  —— 纯 ASCII（一个 >127 的字节都不许有）+ CRLF + 不许有 BOM
//   .ps1        —— UTF-8 **带 BOM**（PowerShell 5.1 见 BOM 才按 UTF-8 读）+ CRLF
//
// 但"字节对了"只保证脚本**能跑**，不保证它**还干着该干的事**。所以还有第二节：
// ★ 第二节：启动器的内容不变量。2026-02 用户报障「双击之后只有一句
//   Electron 自己没能启动起来（退出码 0x80000003）」——那次查到根因是这台机器上
//   Chromium 的沙箱起不来（连 `electron.exe --version` 都崩，加 `--no-sandbox` 就正常），
//   修法是让启动器崩了自动换个方式再启动一次。这种"少了一行回退代码"的回归，
//   编码检查看不见、node --check 也看不见，所以在这里钉死。
// ★ 第三节：Electron 沙箱体检（只报告，不判失败——这是机器环境，不是我们的代码）。
//
// 用法：
//   node tools/check-launchers.mjs          检查
//   node tools/check-launchers.mjs --fix    顺手修好编码（改字节，不改内容）
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIX = process.argv.includes('--fix');

// 只看我们自己写的目录。runtime/ 与 vendor/ 是整包下发的第三方东西（node 发行版
// 自带一堆 .cmd），它们的编码不归我们管，也不该被我们乱改。
const SCAN_DIRS = ['.', 'tools', 'devtools', 'docs', 'app', 'runner'];

/** @returns {string[]} 待检查文件的绝对路径 */
function collect() {
  const out = new Set();
  for (const dir of SCAN_DIRS) {
    const abs = path.resolve(ROOT, dir);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (/\.(cmd|bat|ps1)$/i.test(e.name)) out.add(path.join(abs, e.name));
    }
  }
  return [...out].sort();
}

function utf8Ok(buf) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; }
  catch { return false; }
}

function toCrlf(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

const problems = [];
const fixed = [];
let checked = 0;

for (const file of collect()) {
  const rel = path.relative(ROOT, file);
  const raw = fs.readFileSync(file);
  const isCmd = /\.(cmd|bat)$/i.test(file);
  const bad = [];

  if (isCmd) {
    const high = [...raw].filter((b) => b > 127).length;
    if (high > 0) {
      bad.push(`有 ${high} 个非 ASCII 字节 —— cmd.exe 会按 GBK 解码它们，中文注释会把下一行命令吃掉`);
    }
    if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
      bad.push('带 UTF-8 BOM —— cmd.exe 会把 BOM 当成一条命令，报"锘? 不是内部或外部命令"');
    }
  } else {
    const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
    if (!hasBom) bad.push('没有 UTF-8 BOM —— PowerShell 5.1 会按 GBK 读，中文全变乱码');
    else if (!utf8Ok(raw.subarray(3))) bad.push('BOM 之后不是合法的 UTF-8');
  }

  const text = raw.toString('latin1');
  const lf = (text.match(/\n/g) || []).length;
  const crlf = (text.match(/\r\n/g) || []).length;
  if (lf !== crlf) bad.push(`有 ${lf - crlf} 处是 LF 换行（cmd.exe / PowerShell 5.1 都期望 CRLF）`);

  checked++;
  if (!bad.length) continue;

  if (!FIX) {
    problems.push({ rel, bad });
    continue;
  }

  // 修复：只动字节，不动内容
  let body;
  if (isCmd) {
    body = raw.toString('utf8');
    if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
  } else {
    body = raw.toString('utf8');
    if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
  }
  const bytes = Buffer.from(toCrlf(body), 'utf8');
  fs.writeFileSync(file, isCmd ? bytes : Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]));
  fixed.push({ rel, bad });
  console.log(`  ✎ 已修好 ${rel}：${bad.length} 处`);
}

if (problems.length) {
  console.log('');
  for (const p of problems) {
    console.log(`  ✗ ${p.rel}`);
    for (const b of p.bad) console.log(`      · ${b}`);
  }
  console.log('');
  console.log(`✗ 启动脚本编码检查：${problems.length} 个文件不合格（共检查 ${checked} 个）。`);
  console.log('  跑 `node tools/check-launchers.mjs --fix` 可以自动修好。');
  console.log('  ★ 这不是格式洁癖：这些文件只要字节不对，双击就一定失败，而且代码层面完全看不出来。');
  process.exit(1);
}

if (fixed.length) {
  console.log(`✓ 启动脚本编码检查：修好了 ${fixed.length} 个文件（共检查 ${checked} 个）。`);
} else {
  console.log(`✓ 启动脚本编码检查通过：${checked} 个启动脚本的字节都是对的（.cmd 纯 ASCII+CRLF，.ps1 UTF-8 BOM+CRLF）。`);
}

// ============================================================================
// 第二节：启动器的内容不变量
//   为什么要有：用户那次报障的**根因**（Chromium 沙箱起不来 → 0x80000003）不在
//   代码风格里，而在"启动器有没有那一步回退"。少了它，用户看到的就只有一句
//   "Electron 自己没能启动起来"，窗口永远出不来 —— 而所有测试都还是绿的。
// ============================================================================

const LAUNCHER = path.join(ROOT, 'tools', 'launch-gui.ps1');
const CMD_ENTRY = path.join(ROOT, '启动.cmd');
const invariants = [];
function must(label, ok, hint) { invariants.push({ label, ok: !!ok, hint }); }

// ★ 先剥掉注释再断言 —— 否则注释里的反例会把自己判成违规。
//   这不是假想：第一版就是这么写的，启动器注释里那句"绝对不能写成 `& $electron $appDir`"
//   直接把"没有退回 & $electron"这条判成了红 —— 教训是**断言的对象是代码，不是文本**。
function stripPsComments(src) {
  const noBlocks = src.replace(/<#[\s\S]*?#>/g, '');
  return noBlocks.split(/\r?\n/).map((line) => {
    if (line.trimStart().startsWith('#')) return '';
    const m = line.match(/(^|\s)#/);
    if (m) {
      const head = line.slice(0, m.index + m[1].length);
      if (((head.match(/["']/g) || []).length) % 2 === 0) return head;
    }
    return line;
  }).join('\n');
}

let ps1 = '';
try { ps1 = fs.readFileSync(LAUNCHER, 'utf8'); } catch { }
if (!ps1) {
  must('tools\\launch-gui.ps1 存在', false, '启动器不见了 —— 双击 启动.cmd 会直接失败');
} else {
  const code = stripPsComments(ps1);
  must(
    '用 .NET Process API 等 Electron 结束（.WaitForExit）',
    /\.WaitForExit\(/.test(code),
    'PowerShell 用 & 调 GUI 程序根本不等它、也拿不到退出码（第一版就是这么坏的）',
  );
  must(
    '没有退回 `& $electron` 那种写法',
    !/&[ \t]*\$electron\b/.test(code),
    '那样双击后黑窗口会自己关掉，看着像什么都没发生，下面的诊断代码永远跑不到',
  );
  must(
    '认得出「Chromium 沙箱起不来」（0x80000003）',
    /0x80000003/.test(code),
    '这台机器实测就是这个码：连 electron.exe --version 都崩，加 --no-sandbox 才正常',
  );
  must(
    '崩了会自动换 --no-sandbox 再启动一次',
    /--no-sandbox/.test(code) && /\$attempt/.test(code),
    '少了这一步，用户只能看到一句"Electron 没能启动起来"，界面永远出不来',
  );
  must(
    '-Check 会真的跑一次 Electron（不只是 Test-Path）',
    /Invoke-Electron[ \t]+['"]--version['"]/.test(code),
    '只看"文件在不在"查不出"文件在、一跑就崩"这个最常见的故障',
  );
}
let cmdText = '';
try { cmdText = fs.readFileSync(CMD_ENTRY, 'utf8'); } catch { }
must(
  '双击 启动.cmd 真的会走到 launch-gui.ps1',
  /launch-gui\.ps1/.test(cmdText),
  '入口没指向启动器的话，启动器改得再好也没用',
);

// ── 一键 bootstrap 链路 ────────────────────────────────────────────────────
// ★ 为什么也要钉住：从 GitHub 下载的源码里**没有** Node 运行时、引擎依赖
//   （714 MB）、Electron（380 MB）—— 它们都被 .gitignore 排除了。所以"下载下来
//   双击就能跑"这件事，全靠这三个文件配合：启动器缺依赖 → install-node.ps1（先
//   搞到 Node）→ bootstrap.mjs（装剩下两样）。任何一环被删掉/改回"只报错"，
//   别人拿到源码就是双击一片红。
const BOOTSTRAP = path.join(ROOT, 'tools', 'bootstrap.mjs');
const INSTALL_NODE = path.join(ROOT, 'tools', 'install-node.ps1');
must('tools\\bootstrap.mjs 存在（一键补齐依赖）', fs.existsSync(BOOTSTRAP), '没有它，从 GitHub 下的源码没法自己装依赖');
must('tools\\install-node.ps1 存在（没 Node 时先用它下一份）', fs.existsSync(INSTALL_NODE), '干净 Windows 上可能一个 Node 都没有，bootstrap.mjs 自己是跑不起来的');
const launcherCode = ps1 ? stripPsComments(ps1) : '';
must(
  '启动器缺依赖时会自己调 bootstrap.mjs，而不是只报错',
  /bootstrap\.mjs/.test(launcherCode),
  '上一版只打印"请自己 cd app && npm install" —— 对不写代码的人等于走到这里就没了',
);
must(
  '启动器没 Node 时会先调 install-node.ps1',
  /install-node\.ps1/.test(launcherCode),
  '第一条命令就是 node；没有 Node 连 bootstrap.mjs 都起不来（先有鸡还是先有蛋）',
);

// ── bootstrap 的"自证"能力 ────────────────────────────────────────────────
// 引擎依赖装没装对**不能只看 npm 的退出码**：node_modules 里是源码，补丁打没打上、
// 版本对不对，只有证据串能证明。这几条串就是 docs\05 第五节里那三条判据的落地。
let bsText = '';
try { bsText = fs.readFileSync(BOOTSTRAP, 'utf8'); } catch { }
const PATCH_NEEDLES = [
  'incorrect_for_wooden_tool', 'timeout: 500', 'physicsTick', '0.175', "// console.log('Chunk size is",
];
const missingNeedles = PATCH_NEEDLES.filter((n) => !bsText.includes(n));
must(
  'bootstrap.mjs 保留了 5 条补丁证据串',
  missingNeedles.length === 0,
  `少的证据串：${missingNeedles.join(' / ')} —— 少了就查不出"补丁没打上"，装完是坏的却报成功`,
);
must(
  'bootstrap.mjs 用 npm ci（按 lockfile 装）',
  /'ci'/.test(bsText),
  '补丁能不能打上取决于依赖版本不漂移，所以必须走 lockfile（npm install 会松开它）',
);
// ★ 这条是用户双击报障换来的：bootstrap.mjs 自己坏掉时（下载不完整 / 被编辑器存成 GBK），
//   Node 抛 SyntaxError，而启动器原来会把整个失败说成"依赖没补齐"——用户去查网络，
//   真相是文件坏了、要重新下载源码。所以启动器必须先 node --check 一眼再报错。
//   ⚠️ 正则里必须写 `[ \t]+` 而不是 `\s+`：`\s` 能跨行，于是上一行任意一句以
//   `--check` 收尾（比如 `Say '【依赖清单（tools\bootstrap.mjs --check）】'`）、
//   下一行又以 `$bs` 开头，就能把这句已经删掉的代码匹配回来 —— 断言看着在，
//   其实谁删了都不报。第一版正是这么写的，负数验证当场把它抓了出来。
must(
  '启动器会先 node --check 看 bootstrap.mjs 是否完整',
  /&\s*\$node[ \t]+--check[ \t]+\$bs/.test(launcherCode),
  '少了它，脚本坏掉时报的是"依赖没补齐"，把"文件坏了"和"网络问题"混成一句话',
);
// 乱码哨兵自己也得有人看着：它要是被删了/被注释掉了，前面那节扫描就静默失效。
const selfPath = path.join(ROOT, 'tools', 'check-launchers.mjs');
const selfText = fs.existsSync(selfPath) ? fs.readFileSync(selfPath, 'utf8') : '';
must(
  '乱码哨兵还在（MOJI_MARKERS + 报红退出）',
  selfText.includes('MOJI_MARKERS') && /process\.exit\(1\)/.test(selfText),
  '哨兵自己没了，就没有任何东西能发现"用 PowerShell 往返改文件"把中文和换行一起毁掉',
);

// 冷目录真跑一次换来的三条（docs\08 §七·补十二）：
//   · install-node.ps1 的失败文案承诺"手动下好 zip 再跑一次就会用它" —— 第一版代码里
//     根本没有这个分支，用户会掉进一个永远走不通的循环。所以钉住这条分支本身。
//   · npm 真实报错常常只是最后一句 `Exit handler never called!`（看着像 npm 坏了），
//     人话原因在它自己的 _logs 里；bootstrap 必须去读、并且直连失败后要换镜像再试。
let installNodeText = '';
try { installNodeText = fs.readFileSync(INSTALL_NODE, 'utf8'); } catch { }
// ★ 判据要落在**代码**上，不能落在注释/文案上：第一版用整个文件的正则，
//   结果头部说明里那句"HTTP 客户端先 WebClient 再 curl.exe"就能满足断言 ——
//   把真正的下载分支整段删掉，断言照样绿（负数验证当场抓到）。
//   同一个教训在启动器那条（`& $electron`）上也出现过一次，见下面 7l.5。
const installNodeCode = stripPsComments(installNodeText);
must(
  'install-node.ps1 认已经下好的 zip（不再重复下载）',
  /Test-Path[ \t]+\$zip(?![A-Za-z])/.test(installNodeCode) && installNodeCode.includes('$preExisting'),
  '失败文案让用户"手动下好放这里再跑一次"，代码里却没有这个分支 —— 那句话会把人送进死循环',
);
must(
  'install-node.ps1 除了 WebClient 还有 curl 这条下载路',
  /curl\.exe/.test(installNodeCode),
  '有些代理/公司网只认系统证书，WebClient 连不上而 curl 能连（两个源 × 两种方式都试过再认输）',
);
must(
  'bootstrap.mjs 直连 npm 失败会换国内镜像重试',
  /registry\.npmmirror\.com/.test(bsText),
  '国内直连 registry.npmjs.org 常被代理换证书（ERR_TLS_CERT_ALTNAME_INVALID）—— 不换源就等于装不上',
);
must(
  'bootstrap.mjs 会把 npm 的失败原因翻成人话',
  bsText.includes('npmFailureHint') && /ERR_TLS_CERT_ALTNAME_INVALID/.test(bsText),
  'npm 只会吐 `Exit handler never called!`，不读它的 _logs 就没人知道是网络/证书问题',
);
must(
  'bootstrap.mjs 两个源都失败时会把两次原因都摆出来',
  /function[ \t]+npmWithMirror[ \t]*\(/.test(bsText) && bsText.includes('第一次（官方源）失败的原因'),
  '只报第一次（证书）会把人引偏 —— 我们冷跑时第二次其实是镜像缺包 404',
);
must(
  'bootstrap.mjs 认得"镜像上没有这个包"（404）这种失败',
  // ★ 不能用 /\bE404\b/ 去检源码：源码里写的是**字面量** `\bE404\b`，
  //   而正则里的 \b 是词边界 —— `b` 和 `E` 都是词字符，边界根本不存在，永远匹配不上（踩过）。
  //   写在源码里的正则，只能按"这段字面量在不在"来检。
  bsText.includes('E404') && bsText.includes('minecraft-assets'),
  '换镜像之后 npm 报 404 不是用户配错了 —— 是镜像没同步全这个包',
);

const brokenInvariants = invariants.filter((i) => !i.ok);
if (brokenInvariants.length) {
  console.log('');
  for (const i of brokenInvariants) {
    console.log(`  ✗ ${i.label}`);
    console.log(`      · ${i.hint}`);
  }
  console.log('');
  console.log(`✗ 启动器内容不变量：${brokenInvariants.length} / ${invariants.length} 条被破坏了。`);
  process.exit(1);
}
console.log(`✓ 启动器内容不变量：${invariants.length} 条都还在（等进程 / 沙箱回退 / -Check 真跑 / 一键 bootstrap）。`);

// ============================================================================
// 第二节之二：乱码哨兵（★ 这条是拿真事故换来的）
//   这套代码里满屏中文注释与中文文案，而**这个开发环境的 pwsh 实际是
//   Windows PowerShell 5.1**：`Set-Content -Encoding utf8` 会写 BOM，`Get-Content`
//   读**无 BOM 的 UTF-8** 时按 GBK 解码。于是"读出来改一处再写回去"会把中文变成
//   `鈥斺€?` 这类乱码，而且**落在行尾的多字节字符会留下悬空引导字节、把紧随的换行
//   一起吃掉**（488 行并成 449 行、字符串收尾引号消失）。这份文件曾经就这样毁过
//   一份源码（tools\bootstrap.mjs），只能靠反压缩原文救回来。
//   用 Node 读写永远看不出这个毛病，所以在这里放一道哨兵：谁再用 PowerShell 文本
//   往返改文件，下一次自检立刻报红。
// ============================================================================

const MOJI_MARKERS = [
  '鈥', '锛', '銆', '鏂', '涓', '鍜', '寮', '鐨', '鎴', '鎬', '璁', '鍒',
  '娓', '閫', '鍑', '鐢', '鐩', '鏄', '鍦', '绛', '鍚', '鐨', '涓€',
];
// moji-scan:ignore —— 本文件必须原样列出这些特征字，否则哨兵自己没法工作；
//   它也必然引用乱码样本（下面注释里就有一处）。所以按"自带豁免标记"跳过自己。
const MOJI_EXEMPT = 'moji-scan:ignore';
const SCAN_SKIP_DIRS = new Set([
  'node_modules', '.git', 'runtime', 'vendor', 'testserver', 'testserver2',
  '.npm-cache', '.spike', '.probe', '.vscode', 'dist', 'build',
]);
const SCAN_EXTS = new Set(['.mjs', '.js', '.cjs', '.ps1', '.cmd', '.bat', '.md', '.html', '.css', '.json', '.txt']);

function* walkScannable(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      yield* walkScannable(full);
    } else if (e.isFile()) {
      if (e.name.startsWith('.')) continue;
      if (SCAN_EXTS.has(path.extname(e.name).toLowerCase())) yield full;
    }
  }
}

const mojiHits = [];
let scannedFiles = 0;
for (const file of walkScannable(ROOT)) {
  scannedFiles += 1;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  // 有的文件**必须**照引乱码（docs\08 里就存着用户那次报障的原文，乱码本身就是证据），
  // 这类文件自己在开头写一行 moji-scan:ignore 声明豁免 —— 显式豁免，而不是让哨兵闭嘴。
  if (text.includes(MOJI_EXEMPT)) continue;
  const counts = MOJI_MARKERS.map((m) => [m, text.split(m).length - 1]).filter(([, n]) => n > 0);
  const total = counts.reduce((s, [, n]) => s + n, 0);
  const distinct = counts.length;
  // 单个"涓"之类的字在正常中文里也可能出现，所以要求：总出现 ≥3 次，或者 ≥2 种特征字。
  if (total >= 3 || distinct >= 2) {
    const firstLine = text.split('\n').find((l) => MOJI_MARKERS.some((m) => l.includes(m))) || '';
    mojiHits.push({ file, total, distinct, sample: firstLine.trim().slice(0, 80) });
  }
}

if (mojiHits.length) {
  console.log('');
  for (const h of mojiHits) {
    const rel = path.relative(ROOT, h.file);
    console.log(`  ✗ ${rel} —— ${h.total} 处疑似乱码（${h.distinct} 种特征字）`);
    console.log(`      · ${h.sample}`);
  }
  console.log('');
  console.log(`✗ 疑似被 GBK 往返毁过的文件：${mojiHits.length} 个。`);
  console.log('  · 成因：用 PowerShell 的 Get-Content / Set-Content 改过这个文件（中文 + 换行会被一起毁掉，不可逆）。');
  console.log('  · 处理：用 git 或反压缩原文取回原文件，之后只用 edit / write 工具或 node -e 改文件。');
  console.log(`（本轮扫了 ${scannedFiles} 个文本文件，跳过 node_modules / runtime / vendor。）`);
  process.exit(1);
}
console.log(`✓ 没有乱码文件（扫了 ${scannedFiles} 个文本文件 —— 防的是"用 PowerShell 往返改文件"这个坑）。`);

// ============================================================================
// 第三节：Electron 沙箱体检（只报告，不影响退出码）
//   这是**机器环境**的属性，不是我们代码的属性：同一份 electron.exe 在有的机器上
//   带沙箱跑不起来（这里实测 0x80000003），换一台就正常。报出来是为了少一轮猜。
// ============================================================================

const ELECTRON_EXE = path.join(ROOT, 'app', 'node_modules', 'electron', 'dist', 'electron.exe');
if (fs.existsSync(ELECTRON_EXE)) {
  // ★ 探测时必须把 NODE_OPTIONS / ELECTRON_RUN_AS_NODE 从环境里**摘掉**：
  //   自检自己就是靠 `--import register-electron-stub.mjs` 跑的，而这两个变量会被
  //   子进程继承 —— 真实 electron.exe 会把那个 stub 也加载进去，于是 `--version`
  //   打印出 stub 的假版本号 v24.21.0、退出码 0，体检报告就会**假绿**
  //   （第一版正是如此：明明这台机器沙箱起不来，却报"正常"）。
  //   用户双击 启动.cmd 时环境里根本没有这两个变量 —— 体检要复现的是那一边。
  const probeEnv = { ...process.env };
  delete probeEnv.NODE_OPTIONS;
  delete probeEnv.ELECTRON_RUN_AS_NODE;
  const probe = (args) => {
    const r = spawnSync(ELECTRON_EXE, args, { timeout: 30000, encoding: 'utf8', env: probeEnv });
    const code = typeof r.status === 'number' ? r.status : null;
    // ★ 记下"探测本身有没有跑起来"：在某些受限环境里 spawnSync 连进程都拉不起来
    //   （实测这里会 EPERM —— 沙箱不允许子进程用管道收集输出）。那种情况下
    //   status 是 null、stdout 是空的，如果只看 status 就会**误判成"Electron 坏了"**，
    //   而真相是"这次体检没跑成"。两者必须分开说。
    const err = r.error ? (r.error.code || r.error.message || '未知错误') : null;
    return { code, out: ((r.stdout || '') + (r.stderr || '')).trim(), err };
  };
  const hex = (c) => (c === null ? '（没起来）' : '0x' + (c >>> 0).toString(16).padStart(8, '0').toUpperCase());
  const normal = probe(['--version']);
  if (normal.code === 0) {
    console.log(`· Electron 沙箱体检：正常（${normal.out || '能跑'}）—— 启动器会保留沙箱。`);
  } else if (normal.err) {
    console.log(`· Electron 沙箱体检：这次没跑成（${normal.err}）—— 是当前执行环境不让起子进程，不是 Electron 的问题。`);
    console.log('    真实结论请在你自己的电脑上双击启动，或跑 tools\\launch-gui.ps1 -Check。');
  } else {
    const fb = probe(['--version', '--no-sandbox']);
    if (fb.code === 0) {
      console.log(`· Electron 沙箱体检：带沙箱 ${hex(normal.code)}，关掉沙箱 OK（${fb.out}）`);
      console.log('  → 这台机器的 Chromium 沙箱起不来（多半是安全软件或系统的「内存完整性」）。');
      console.log('     双击 启动.cmd 时程序会自动改用 --no-sandbox，界面照样能出来。');
      console.log('     想彻底修好：把本目录加进安全软件的信任名单，或关掉内存完整性后重启。');
    } else if (fb.err) {
      console.log(`· Electron 沙箱体检：关掉沙箱那次没跑成（${fb.err}）—— 探测环境的问题，不是 Electron 的问题。`);
    } else {
      console.log(`· Electron 沙箱体检：带沙箱 ${hex(normal.code)}，关掉沙箱也 ${hex(fb.code)} —— Electron 本身有问题。`);
      console.log('    双击一次 启动.cmd 会自动重装；也可以跑 tools\\bootstrap.mjs（加 --force 强制重下）。');
    }
  }
} else {
  console.log('· Electron 沙箱体检：app\\node_modules\\electron 不在，跳过（还没装依赖 —— 双击 启动.cmd 会自动装）。');
}
process.exit(0);
