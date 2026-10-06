/**
 * 静态检查：**用到了却没 import 的符号**。
 *
 * 为什么专门写这个：这个 bug 真的发生过，而且骗过了 `node --check`。
 * 我给门禁加了一层引擎回执翻译，写好了新模块、改好了调用点，唯独忘了加 `import`。
 * `node --check runner\mcbot-gate.mjs` 报 exit=0 —— 它只做**语法**分析，
 * 看不见"这个名字在当前作用域里根本不存在"。于是真机上：
 *
 *     命令执行失败（!searchForBlock(...)）：translateEngineReply is not defined
 *
 * 表现是"bot 收到了玩家的话、也执行了，就是一声不吭"。这类 bug 的共同点是
 * **只在运行时、只在某条分支上**才炸，单元测试和语法检查都拦不住。
 *
 * 做法很土但够用：把每个模块 `export` 出来的名字收集起来，再去别的模块里
 * 找"用了这个名字、但又没 import、也没在自己文件里声明"的地方。
 * 判定故意保守（名字必须**只被一个模块**导出、且没被本地声明才算），
 * 宁可漏报也不误报 —— 一个天天误报的检查等于没有检查。
 *
 * 用法：node tools\check-imports.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 要检查的源码目录（都是我们自己的代码）。
 *
 * `app/renderer/` **故意不查**：那里的 `mock.js` 本来就是"照着主进程 API 表面
 * 抄一份假实现"，方法名和主进程重名是它的职责，不是 bug；而渲染层已经被
 * `devtools\render-headless.mjs` 把八个页面全部真跑过一遍了。
 * 真正会一声不吭死掉的是 `runner/`（引擎里跑的）和 `app/electron/`（主进程）。 */
const SCAN = [
    path.join(ROOT, 'runner'),
    path.join(ROOT, 'app', 'electron'),
    path.join(ROOT, 'devtools'),
    path.join(ROOT, 'tools'),
];

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            walk(p, out);
        } else if (/\.(mjs|js)$/.test(e.name)) {
            out.push(p);
        }
    }
    return out;
}

/** 把注释、字符串、正则字面量抹掉 —— 否则注释里提一个函数名、
 *  或者正则里写着 `you now have (`，都会被当成"这个符号被用过了"。
 *  （正则字面量那两条规则是补的：第一版漏了，`engine-speak.mjs` 里的
 *   `/^… you now have (\d+) …$/` 就被误判成"调用了 have()"。） */
function strip(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
        // 行首的正则字面量（`[/^…$/i,` 这种规则表最常见）
        .replace(/^[ \t]*\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/gm, ' ')
        // 跟在 `=` `(` `,` `[` `:` 后面的正则字面量
        .replace(/([=(,:[!&|?{};])\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/g, '$1 ');
}

/** 这个文件导出了哪些顶层名字。 */
function exportsOf(src) {
    const names = new Set();
    for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
        names.add(m[1]);
    }
    for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
        for (const part of m[1].split(',')) {
            const t = part.trim().split(/\s+as\s+/).pop().trim();
            if (t) names.add(t);
        }
    }
    return names;
}

/** 这个文件 import 进来的名字（各种写法）。 */
function importsOf(src) {
    const names = new Set();
    for (const m of src.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s+['"]/gm)) {
        const clause = m[1];
        const braces = /\{([\s\S]*)\}/.exec(clause);
        if (braces) {
            for (const part of braces[1].split(',')) {
                const t = part.trim().split(/\s+as\s+/).pop().trim();
                if (t) names.add(t);
            }
        }
        const def = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, ' ').trim();
        if (def && !def.startsWith('*')) names.add(def.split(/\s+/)[0]);
        const star = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
        if (star) names.add(star[1]);
    }
    return names;
}

/** 这个文件自己声明/定义的名字（含函数参数、解构、catch、for-of）。 */
function declaredOf(src) {
    const names = new Set();
    const add = (...pats) => { for (const p of pats) for (const m of src.matchAll(p)) names.add(m[1]); };
    add(
        /(?:^|[\s;{(,])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
        /(?:^|[\s;{(,])class\s+([A-Za-z_$][\w$]*)/g,
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
        /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g,
    );
    // 解构：`const { a, b: c } = …`
    for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
        for (const part of m[1].split(',')) {
            const t = part.trim().split(':').pop().trim().split('=')[0].trim();
            if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
        }
    }
    // 函数参数：粗一点，把所有形参名都算"本地声明"
    for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
        for (const part of m[1].split(',')) {
            const t = part.trim().split('=')[0].replace(/^\.\.\./, '').split(':').pop().trim();
            if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
        }
    }
    return names;
}

// ── 收集
const files = SCAN.flatMap((d) => walk(d));
const owners = new Map();          // 导出的名字 → 导出它的文件列表
const info = [];                   // {file, src, code, imported, declared}

for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const code = strip(src);
    info.push({ file: f, code, imported: importsOf(src), declared: declaredOf(code) });
    for (const n of exportsOf(src)) {
        if (!owners.has(n)) owners.set(n, []);
        owners.get(n).push(f);
    }
}

// ── 检查
//
// 判定条件故意收得很紧。第一版什么都报（29 处里 28 处是误报：`on`、`h`、`app`、
// `counts` 这种短名字被当成"用过"，其实只是对象属性或局部变量），
// 而**一个天天误报的检查等于没有检查** —— 人看两眼就不看了。
// 收紧到四条同时成立才报：只有这一个模块导出它、长度≥4、是**被调用**的形状、
// 不是本文件里的属性名/键名。
let bad = 0;
const rel = (p) => path.relative(ROOT, p);
const CHECKED_OWNER = /^runner[\\/]|^app[\\/]electron[\\/]/;
for (const { file, code, imported, declared } of info) {
    for (const [name, from] of owners) {
        if (from.length !== 1) continue;                       // 有人重名 → 说不清，跳过
        if (from[0] === file) continue;                        // 自己导出的
        if (name.length < 4) continue;                         // `on`/`h` 这类太吵
        if (!CHECKED_OWNER.test(rel(from[0]))) continue;       // 只查我们自己这几个运行时的模块
        if (imported.has(name) || declared.has(name)) continue;
        // 必须是"调用"的形状：`name(` —— 而不是当属性名、键名、字符串用
        if (!new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(code)) continue;
        const asKey = new RegExp(`(?:^|[{,\\s])${name}\\s*[:,}]`).test(code);
        if (asKey) continue;                                   // 出现在对象字面量里，八成是键名
        console.log(`✗ ${rel(file)} 用了 ${name}(…)，但没 import（它由 ${rel(from[0])} 导出）`);
        bad++;
    }
}

console.log(`\n扫描了 ${files.length} 个文件、${owners.size} 个导出名。`);
if (bad === 0) {
    console.log('✓ 没有"用了却没 import"的符号');
    process.exit(0);
} else {
    console.log(`✗ 发现 ${bad} 处`);
    process.exit(1);
}
