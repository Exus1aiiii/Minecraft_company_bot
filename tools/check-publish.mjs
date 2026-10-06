// ============================================================================
// 发布体检（publish audit）
//
// 回答一个很具体的问题：**"如果现在 `git add .` 并推到 GitHub，会漏出去什么？"**
//
// 为什么要专门写一个工具：
//   1. 这个仓库里躺着 660 MB 不该发布的东西（早期实验的 npm 缓存、两台本地测试服），
//      而 `.gitignore` 一度只盖住了 node_modules/runtime —— `git add .` 会一口全吞。
//   2. 更危险的是**个人信息**：你的服务器地址、你的游戏 ID、你的 API Key。
//      它们一旦进了公开仓库，删掉历史很难（要改写 commit + 强推 + 等人清缓存）。
//   3. "我小心一点"不是工程手段。能跑起来的检查才是 —— 这条和项目里其它 16 套自检同源。
//
// 判定分两档，刻意不混在一起：
//   ✗ 红线（blocker）—— 明确不能发的东西：真密钥、你的游戏 ID、密钥文件本身。
//                        有红线就退出码 1（接进 `run-all-tests.mjs` 会直接变红）。
//   ! 留意（warn）  —— 需要你**判断**的事，不算失败：服务器地址出现在说明文档里、
//                        项目还没有 LICENSE、某个文件特别大。工具不替你决定。
//
// ★ 本机专属的值**不写死在这个文件里**（否则体检工具自己就成了第 7 处泄漏），
//   而是每次从 `runtime/config.json` 现场读出来：里面有哪些服务器地址、哪些主人名单，
//   就拿这些串去要提交的文件里搜。
//
// 用法：
//   node tools\check-publish.mjs            # 体检
//   node tools\check-publish.mjs --list     # 额外列出"会提交的每一个文件"
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const listAll = process.argv.includes('--list');

// 单文件超过这个大小就值得问一句"它真的该进仓库吗"
const BIG_FILE = 2 * 1024 * 1024;
// 内容扫描只做文本文件，且跳过特别大的（避免把那个 50MB 的 jar 读进内存）
const SCAN_MAX = 4 * 1024 * 1024;
const TEXT_EXT = /\.(mjs|cjs|js|json|jsonl|md|txt|css|html|ps1|cmd|bat|yml|yaml|properties|example|gitignore)$/i;

// 明写在行末的豁免标记。为什么需要它：
//   自检里**故意**要塞一些"长得像密钥但其实不是"的串 —— 比如"真密钥不许被误判成假密钥"
//   这条反向断言，夹具必须长得像真密钥才行。这种串一律靠"看"来分辨不可靠，
//   于是给一个**显式、可 grep、可复查**的出口：写清楚为什么它可以留在仓库里。
//   滥用它的成本也很明确 —— 谁写了它，谁就在这条行上签了字。
const IGNORE_MARK = /publish-audit:ignore/;
// 一眼假的密钥形态（我们的自检夹具都是这几种写法）
const FAKE_KEY_WORDS = /(^|[-_])(test|fake|headless|multibot|dummy|spike|demo|example|deliberat|bogus|invalid|wrong|nope|xxx|abc123)([-_]|$)/i;


// ── .gitignore 解析 ─────────────────────────────────────────────────────────
// 只实现我们实际用到的那几种形态（目录/、*.后缀、名字、/前缀锚定、!例外、**），
// 并且**只用来"判断会不会被提交"**，不是 git 的完整实现 —— 说清楚边界比假装完整好。
// ★ 2026-10-06 补：**要读子目录里的 .gitignore**（`prefix` 参数）。
//   原来只读根目录那份，于是 `vendor/mindcraft-develop/.gitignore` 里那条 `bots/**/`
//   不生效 —— 运行时生成的 `vendor/.../bots/Xiaodou/memory.json`（里面有主人的游戏 ID
//   和聊天记录）被当成"会提交的文件"，报了一片**假红线**。假红线会让人开始怀疑体检本身，
//   比漏报还贵：真的那条（`runner/profiles/bot-xiaodou.json`）就混在同一片里。
function loadIgnoreRules(prefix = '') {
    const file = path.join(ROOT, prefix, '.gitignore');
    const rules = [];
    if (!fs.existsSync(file)) return rules;
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const negate = line.startsWith('!');
        const pat = negate ? line.slice(1) : line;
        rules.push({
            negate,
            dirOnly: pat.endsWith('/'),
            body: prefix + pat.replace(/\/$/, '').replace(/^\//, ''),
            anchored: pat.startsWith('/'),
        });
    }
    return rules;
}

/** rel 用 / 分隔；返回这份相对路径（或它上面的某一级目录）是否被忽略 */
function isIgnored(rel, isDir, rules) {
    const segs = rel.split('/');
    let ignored = false;
    for (const r of rules) {
        let hit = false;
        if (r.body.includes('/')) {
            // 含斜杠 = 路径形态（vendor/*.tar.gz、runner/bots/*.launch.json 这种）
            // ★ 这里踩过一次：`*` 必须自己翻译成 `[^/]*`，不能指望"先转义再还原" ——
            //   escapeRe 根本不转义 `*`，于是 `runner/bots/*.launch.json` 被当成
            //   "runner/bots 后面跟零个或多个斜杠"，永远匹配不上，模式等于没写。
            hit = globToRe(r.body).test(rel);
        } else if (r.body.startsWith('*')) {
            // *.log 这类：只看基名，任何层级都算
            const suffix = r.body.slice(1);
            hit = segs[segs.length - 1].endsWith(suffix);
        } else if (r.anchored) {
            hit = segs[0] === r.body;
        } else {
            // 普通名字：任何一层叫这个名字就算（git 的实际行为）
            hit = segs.includes(r.body);
        }
        if (hit && r.dirOnly && !isDir && segs[segs.length - 1] !== r.body) {
            // `foo/` 只忽略目录，但目录本身会被上面的 segs.includes 命中，
            // 这里只需要避免把同名的普通文件也算进去
            hit = segs.slice(0, -1).includes(r.body);
        }
        if (hit) ignored = !r.negate;
    }
    return ignored;
}

function escapeRe(s) {
    return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

// 把 glob 翻成正则（`*` 不跨 `/`，`**` 跨）。注意注释里别出现星号加斜杠 —— 那会把块注释提前闭掉。
// ★ `**` 必须单独处理：`bots/**` 要能匹配 `bots/Xiaodou/memory.json`。
//   第一版把每个 `*` 都翻成 `[^/]*`，于是 `bots/**` 只匹配 `bots/` 下面**一层**，
//   子目录里的文件全漏了（假红线的根因之一）。
function globToRe(glob) {
    const conv = (s) => s.split('/').map((seg) => seg.split('*').map(escapeRe).join('[^/]*')).join('/');
    const parts = glob.split('**').map(conv);
    return new RegExp('^' + parts.join('.*') + '$');
}

// ── 遍历 ────────────────────────────────────────────────────────────────────
const rules = loadIgnoreRules();
const wouldCommit = [];   // { rel, size }
const ignoredDirs = [];   // { rel, bytes, files }
const ignoredFiles = [];  // 被忽略的单文件（不经目录剪枝的那些）

function statTree(dir) {
    let bytes = 0, files = 0;
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) stack.push(p);
            else { try { bytes += fs.statSync(p).size; files++; } catch { /* 忽略读不到的 */ } }
        }
    }
    return { bytes, files };
}

function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    // ★ 子目录里自己的 .gitignore 也要生效（并且只在这一棵子树里生效）：DFS 进出成对 push/pop。
    const relDir = path.relative(ROOT, dir).split(path.sep).join('/');
    const localRules = loadIgnoreRules(relDir ? relDir + '/' : '');
    if (localRules.length) rules.push(...localRules);
    try {
        for (const e of entries) {
            if (e.name === '.git') continue;
            const abs = path.join(dir, e.name);
            const rel = path.relative(ROOT, abs).split(path.sep).join('/');
            if (e.isDirectory()) {
                if (isIgnored(rel, true, rules)) {
                    const t = statTree(abs);
                    ignoredDirs.push({ rel: rel + '/', ...t });
                    continue; // 剪枝：一个 700MB 的目录不必进去数
                }
                walk(abs);
            } else {
                let size = 0;
                try { size = fs.statSync(abs).size; } catch { continue; }
                if (isIgnored(rel, false, rules)) ignoredFiles.push({ rel, size });
                else wouldCommit.push({ rel, size });
            }
        }
    } finally {
        if (localRules.length) rules.length -= localRules.length;
    }
}
walk(ROOT);

// ── 本机专属的值：从真配置里读，不写死 ──────────────────────────────────────
function localSecrets() {
    const out = { servers: [], owners: [], keys: [] };
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime', 'config.json'), 'utf8'));
        for (const s of cfg.servers ?? []) {
            if (s.host && !/^(127\.0\.0\.1|localhost|0\.0\.0\.0)$/.test(s.host)) {
                out.servers.push({ host: s.host, port: s.port });
            }
        }
        for (const b of cfg.bots ?? []) {
            for (const o of b.owners ?? []) if (o && o !== 'Steve') out.owners.push(o);
        }
    } catch { /* 没有配置就算了，照样能查密钥文件 */ }
    return out;
}
const local = localSecrets();

// ── 检查 ────────────────────────────────────────────────────────────────────
const blockers = [];
const warns = [];

// ① 大块垃圾是不是真的被忽略了
const MUST_IGNORE = [
    '.npm-cache', 'runtime', 'vendor', 'testserver', 'testserver2',
    'app/node_modules', 'vendor/mindcraft-develop/node_modules',
    '.spike', '.probe',
    // 生成物：里面带着你本人的服务器地址，只有本机该有
    'runner/bots/xiaodou.launch.json',
];
for (const name of MUST_IGNORE) {
    const abs = path.join(ROOT, name);
    if (!fs.existsSync(abs)) continue;
    const isDir = fs.statSync(abs).isDirectory();
    const rel = isDir ? name + '/' : name;
    const ig = isIgnored(name, isDir, rules);
    if (ig) {
        const hit = ignoredDirs.find((d) => d.rel === rel);
        console.log(`  ✓ ${rel.padEnd(38)} 已忽略（${hit ? `${(hit.bytes / 1048576).toFixed(1)} MB / ${hit.files} 文件` : '单文件'}）`);
    } else if (name.startsWith('vendor') && !name.includes('node_modules')) {
        warns.push(`${rel} 没被忽略 —— 引擎源码可以发，但它里面的 node_modules（714 MB）不行`);
        console.log(`  ! ${rel.padEnd(38)} 未忽略（源码可发，node_modules 不行）`);
    } else {
        blockers.push(`${rel} 没被忽略 —— 会跟着 git add . 一起提交`);
        console.log(`  ✗ ${rel.padEnd(38)} 未忽略！`);
    }
}

// ② 有没有密钥文件本身会被提交
for (const f of wouldCommit) {
    const base = path.basename(f.rel);
    if (/^(secrets|keys)\.json$|\.secret\.json$/i.test(base)) {
        blockers.push(`密钥文件会被提交：${f.rel}`);
    }
}

// ③ 内容扫描：真密钥 / 游戏 ID / 本机服务器地址
const hostHits = [];
const keyHits = [];
const idHits = [];
for (const f of wouldCommit) {
    if (!TEXT_EXT.test(f.rel) || f.size > SCAN_MAX) continue;
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f.rel), 'utf8'); } catch { continue; }
    const lines = text.split('\n');

    lines.forEach((line, i) => {
        if (IGNORE_MARK.test(line)) return; // 作者显式声明"这行可以留在仓库里"
        // 真密钥形态：sk- 后面跟一长串。短的/一看是假的（sk-test、sk-multibot-fake…）不算红线 ——
        // 我们的自检里本来就有很多把假密钥当夹具用。
        for (const m of line.match(/sk-[A-Za-z0-9_-]{16,}/g) ?? []) {
            const looksFake = FAKE_KEY_WORDS.test(m);
            (looksFake ? warns : blockers).push(`${f.rel}:${i + 1} 里有密钥形态的字符串 ${m.slice(0, 12)}…`);
            keyHits.push({ rel: f.rel, line: i + 1, fake: looksFake });
        }
        for (const o of local.owners) {
            if (line.includes(o)) { blockers.push(`${f.rel}:${i + 1} 里有你的游戏 ID（${o}）`); idHits.push({ rel: f.rel, line: i + 1 }); }
        }
        for (const s of local.servers) {
            if (line.includes(s.host)) hostHits.push({ rel: f.rel, line: i + 1, addr: `${s.host}:${s.port}` });
        }
    });
}
if (hostHits.length) {
    const uniq = [...new Set(hostHits.map((h) => `${h.rel}:${h.line}`))];
    warns.push(`你的服务器地址出现在 ${uniq.length} 个会提交的文件里`);
}

// ④ 许可证与归属
const ours = fs.readdirSync(ROOT).filter((n) => /^LICENSE/i.test(n));
const engineLicense = path.join(ROOT, 'vendor', 'mindcraft-develop', 'LICENSE');
if (!ours.length) warns.push('项目还没有 LICENSE（你自己那份）');
if (!fs.existsSync(engineLicense)) blockers.push('引擎的 LICENSE 不在了 —— MIT 要求必须随分发保留');
if (!fs.existsSync(path.join(ROOT, 'THIRD-PARTY.md'))) warns.push('没有 THIRD-PARTY.md（第三方归属说明）');

// ⑤ 体积与超大文件
const totalBytes = wouldCommit.reduce((a, f) => a + f.size, 0);
const big = wouldCommit.filter((f) => f.size > BIG_FILE).sort((a, b) => b.size - a.size);

// ── 输出 ────────────────────────────────────────────────────────────────────
console.log('\n=== 发布体检（假设现在 `git add .` 会提交什么）===');
console.log('\n会提交的内容：');
console.log(`  文件 ${wouldCommit.length} 个，共 ${(totalBytes / 1048576).toFixed(2)} MB`);
if (big.length) {
    console.log(`  其中超过 ${(BIG_FILE / 1048576).toFixed(0)} MB 的 ${big.length} 个：`);
    for (const f of big.slice(0, 8)) console.log(`    ${(f.size / 1048576).toFixed(1)} MB  ${f.rel}`);
}
if (listAll) for (const f of wouldCommit.sort((a, b) => a.rel.localeCompare(b.rel))) console.log(`    ${f.rel}`);
if (ignoredFiles.length) {
    console.log(`  另有 ${ignoredFiles.length} 个散落的文件被 .gitignore 忽略（如 config.local.json、*.log）`);
}

console.log('\n红线：');
if (!blockers.length) console.log('  ✓ 没有发现"绝对不能发"的东西（真密钥 / 你的游戏 ID / 密钥文件本身）');
for (const b of [...new Set(blockers)]) console.log(`  ✗ ${b}`);

console.log('\n留意（要你自己判断，不算失败）：');
if (!warns.length) console.log('  （无）');
for (const w of [...new Set(warns)]) console.log(`  ! ${w}`);
if (hostHits.length) {
    for (const h of [...new Set(hostHits.map((x) => `${x.rel}:${x.line}`))].slice(0, 12)) console.log(`      ${h}（你的服务器地址）`);
    if (hostHits.length > 12) console.log(`      …还有 ${hostHits.length - 12} 处`);
}

console.log('');
if (blockers.length) {
    console.log(`结果：✗ ${new Set(blockers).size} 项红线 —— 现在推上去会漏东西。`);
    process.exit(1);
}
console.log('结果：✓ 发布体检通过（没有红线；上面"留意"里的条目要不要处理由你决定）');
