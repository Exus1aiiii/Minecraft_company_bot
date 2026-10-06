// ============================================================================
// check-speak-coverage.mjs —— 引擎里每一句「会说给玩家听的话」，我们翻了吗？
//
// 为什么要有这个：真机上抓到过一次 `Found non-destructive path.` 原样漏给玩家，
// 是玩家在聊天框里看见半截英文才发现的。靠"想起来去补一条"迟早还会漏。
//
// 这个脚本反过来做：**从引擎源码里把所有 log(bot, ...) 抠出来**，给每个模板
// 的 `${...}` 塞一个长得像的样本值，再喂给 translateEngineReply()；
// 翻完还是英文的，就是漏网的。
//
// 用法：
//   & $node tools\check-speak-coverage.mjs            # 列出没翻译的
//   & $node tools\check-speak-coverage.mjs --all      # 连翻译好的也列
//
// 退出码：0 = 该翻的都翻了；1 = 有漏网的（可以接进自检）。
//
// ⚠️ 它只保证"这条模板的形状我们见过"，不保证译文写得对 ——
// 译文质量靠 tools\test-speak.mjs 里那 66 项逐条断言。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translateEngineReply } from '../runner/engine-speak.mjs';
import { LOCAL_REPORTS } from '../runner/self-report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SKILLS = path.join(ROOT, 'vendor', 'mindcraft-develop', 'src', 'agent', 'library', 'skills.js');

const showAll = process.argv.includes('--all');

/**
 * 从 skills.js 里抠出所有 `log(bot, <字面量>)` 的模板。
 * 认三种写法：模板字符串（反引号）、普通字符串（单/双引号）、
 * 以及用 `+` 拼起来的（`'Could not find any ' + mobType + ' to attack.'`）。
 */
function extractLogTemplates(src) {
    const out = [];
    const re = /log\(\s*bot\s*,\s*/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const tpl = [];
        let i = m.index + m[0].length;
        let ok = true;
        // 循环吃掉 `'字面量' + 表达式 + '字面量' …` 这种拼接
        for (;;) {
            const quote = src[i];
            if (quote !== '`' && quote !== "'" && quote !== '"') {
                if (tpl.length === 0) { ok = false; }
                break;
            }
            i += 1;
            const start = i;
            let buf = '';
            let lastExpr = null;
            const flushLiteral = () => { if (buf !== '') { tpl.push(buf); buf = ''; } };
            while (i < src.length) {
                const c = src[i];
                if (c === '\\') { buf += src[i + 1] ?? ''; i += 2; continue; }
                if (c === quote) break;
                if (quote === '`' && c === '$' && src[i + 1] === '{') {
                    let depth = 0, j = i + 1;
                    for (; j < src.length; j++) {
                        if (src[j] === '{') depth++;
                        else if (src[j] === '}') { depth--; if (depth === 0) break; }
                    }
                    flushLiteral();
                    lastExpr = src.slice(i + 2, j).trim();
                    tpl.push({ expr: lastExpr });
                    i = j + 1;
                    continue;
                }
                if (lastExpr !== null) { tpl.push(''); lastExpr = null; }   // 表达式后面接字面量了
                buf += c;
                i += 1;
            }
            if (i >= src.length && src[start - 1] !== quote) break;
            i += 1;                                            // 吃掉收尾引号
            flushLiteral();
            // 拼接的下一段？
            const rest = src.slice(i);
            const plus = rest.match(/^\s*\+\s*/);
            if (!plus) break;
            i += plus[0].length;
            const next = src[i];
            if (next === '`' || next === "'" || next === '"') continue;   // 又一段字面量
            // 是一段表达式，抠到下一个 `+` 或 `)`
            let j = i, depth = 0;
            for (; j < src.length; j++) {
                const c = src[j];
                if (c === '(' || c === '[') depth++;
                else if (c === ')' || c === ']') { if (depth === 0) break; depth--; }
                else if (c === '+' && depth === 0) break;
            }
            tpl.push({ expr: src.slice(i, j).trim() });
            i = j;
            const more = src.slice(i).match(/^\s*\+\s*/);
            if (!more) break;
            i += more[0].length;
        }
        if (!ok) continue;
        const line = src.slice(0, m.index).split('\n').length;
        out.push({ parts: tpl, line });
    }
    return out;
}

/** 给一个 `${...}` 表达式编一个"长得像"的样本值。 */
function sampleFor(expr) {
    const e = expr.trim();
    // 先认那些一眼就知道是数字的：库存计数、全大写常量、裸的 x/y/z
    if (/getInventoryCounts|MAX_RANGE/.test(e)) return '3';
    if (/^[xyz]$/.test(e)) return '3';
    if (/^[A-Z_]{2,}$/.test(e)) return '3';
    if (/position|pos\b|floored\(\)|target_dest|door_pos/.test(e)) return '(1, 2, 3)';
    if (/\.name\b|itemName|blockType|fuel\.name|toolName|username|seedType|targetName|mobType|entityType|type\b|item_name/.test(e)) return 'oak_log';
    if (/err|message/.test(e)) return 'something went wrong';
    if (/output|tradeInfo|villager_list|stringifyItem/.test(e)) return 'oak_log';
    if (/\d|\bnum\b|count|total|distance|times|index|range|length|\bi\b|put_fuel|collected|pickedUp|discarded|totalTaken|actualCount|to_put|belowBlock/.test(e)) return '3';
    return 'oak_log';
}

/** 把模板拼成一句可以直接喂给翻译层的假回执。 */
function render(parts) {
    return parts.map((p) => (typeof p === 'string' ? p : sampleFor(p.expr))).join('');
}

/** 翻译完还有多少英文字母？用来判断"到底翻了没有"。 */
function leftoverEnglish(s) {
    return (s.match(/[A-Za-z]{3,}/g) || []).length;
}

// ── 有意不翻的：这些能力我们**根本没开放**，翻了也是死代码 ────────────
// 关键不是"它们没翻"，而是"它们是被有意识地放着的"。哪天开了这些能力，
// 从这张表里删掉对应那条，检查就会立刻逼着我们补翻译。
const OUT_OF_SCOPE = [
    [/^(Planting|Planted|No .+ to plant|Cannot till|Tilled block|Land is already farmed|Cannot cannot break above)/,
        '种地 / 耕地 —— 我们没开放 farming'],
    [/^(Cannot find villager|No villagers found|Entity is not a villager|This is either a baby villager|Villager is |Successfully reached villager|Failed to reach villager|This villager has no trades|Villager has |Failed to open villager trading|Trade \d|Trading |Don't have enough resources to execute trade|Executing trade|Successfully traded|An error occurred while trying to execute the trade)/,
        '村民交易 —— 引擎的 trading 命令我们没接'],
];

function outOfScopeReason(line) {
    for (const [re, why] of OUT_OF_SCOPE) if (re.test(line)) return why;
    return null;
}

// ── 跑 ────────────────────────────────────────────────────────────────────
if (!fs.existsSync(SKILLS)) {
    console.error(`✗ 找不到引擎源码：${SKILLS}`);
    process.exit(1);
}
const src = fs.readFileSync(SKILLS, 'utf8');
const templates = extractLogTemplates(src);

if (templates.length === 0) {
    console.error('✗ 一句 log(bot, ...) 都没抠出来 —— 是不是引擎升级换了写法？');
    process.exit(1);
}

const missed = [];
const covered = [];
const skipped = [];
for (const t of templates) {
    const raw = render(t.parts);
    if (!raw.trim()) continue;                       // log(bot, 变量) 这种本来就抠不出字面量
    const zh = translateEngineReply(raw);
    // 译文里还剩 3 个以上连续英文字母 → 认为没翻（数字、坐标不算）
    const stillEnglish = leftoverEnglish(zh.replace(/oak_log|something went wrong/g, '')) > 0;
    if (!stillEnglish) { covered.push({ line: t.line, raw, zh }); continue; }
    const why = outOfScopeReason(raw);
    (why ? skipped : missed).push({ line: t.line, raw, why });
}

console.log(`引擎 skills.js 里有字面量的 log(bot, ...) 共 ${templates.length} 句`);
console.log(`已翻译 ${covered.length} 句 · 有意不翻 ${skipped.length} 句 · 漏掉 ${missed.length} 句\n`);

if (showAll) {
    for (const c of covered) console.log(`  ✓ ${c.raw}\n      → ${c.zh}`);
    console.log('');
}

if (skipped.length > 0) {
    const byWhy = new Map();
    for (const s of skipped) byWhy.set(s.why, (byWhy.get(s.why) ?? 0) + 1);
    console.log('有意不翻（我们还没开放这个能力）：');
    for (const [why, n] of byWhy) console.log(`  · ${why}（${n} 句）`);
    console.log('');
}

if (missed.length > 0) {
    console.log('漏掉的（玩家会看到英文）：');
    for (const m of missed) console.log(`  skills.js:${m.line}  ${m.raw}`);
    console.log('');
    console.log('要么给 engine-speak.mjs 加一条规则，要么在 OUT_OF_SCOPE 里写清楚为什么不管。');
    process.exit(1);
}

console.log('✓ 引擎会说的每一句，要么翻了，要么写清楚了为什么不翻');

// ════════════════════════════════════════════════════════════════════════════
// 第二段：玩家能直接敲的那些 `!命令`，我们接管了哪些？
//
// 为什么单开一段：`skills.js` 的 log() 只是"引擎自己冒出来的话"。
// 还有一整类文本是**玩家主动敲命令**才产生的（`commands\queries.js` /
// `commands\actions.js`），第一段完全扫不到 —— 上一轮真机上就是这么漏的：
// 玩家说「报一下坐标」我们回中文，他改敲 `!stats` 却收到 15 行英文内部转储。
//
// 判定方式是"逐条登记"，不是"猜"：
//   · 在 LOCAL_REPORTS 里 → 我们抢在引擎前面用中文答（表只有一份，见 runner/self-report.mjs）
//   · 在 ENGINE_ONLY 里    → 有意交给引擎（必须写清理由）
//   · 两边都不在           → 漏掉，退出码 1
// 这样"哪些接管了、哪些故意没接"变成一份**能跑出来的名单**，而不是记忆。

const CMD_DIR = path.join(ROOT, 'vendor', 'mindcraft-develop', 'src', 'agent', 'commands');

/**
 * 有意交给引擎、不做中文包装的命令。
 * 每一条都得写清楚"为什么可以不管"，否则下一个人不敢动。
 */
const ENGINE_ONLY = new Map([
    // —— 模型自己的工具，玩家没有理由敲 ——
    ['!nearbyBlocks', '模型看的方块清单（玩家想问"附近有什么"有中文话头：找找/附近有）'],
    ['!craftable', '模型看的可合成清单（玩家说「能做点什么」走 craft 规则）'],
    ['!entities', '模型看的实体清单'],
    ['!modes', '引擎内部开关说明书（self_preservation 之类），玩家不该看见'],
    ['!help', '引擎自己的命令总表 —— 本来就只有主人能敲，而且是排错用的'],
    ['!savedPlaces', '引擎自带的记忆地名；我们有 runner/memory.mjs 那套中文的'],
    ['!getCraftingPlan', '模型用的配方推导'],
    ['!searchWiki', '联网查 wiki，回的是网页正文，翻了也不通顺'],
    ['!checkBlueprint', '蓝图是建造任务的功能，我们没开放'],
    ['!checkBlueprintLevel', '同上'],
    ['!getBlueprint', '同上'],
    ['!getBlueprintLevel', '同上'],
    // —— actions：执行动作，回执已经由 translateEngineReply 按行翻 ——
    ['!newAction', '让模型现写代码 —— 主人手打等于自己开一局，回执照样翻'],
    ['!stop', '★ 必须永远能用、必须零延迟：这是"停下"'],
    ['!stfu', '同上（闭嘴）'],
    ['!restart', '重启引擎，主人排错用'],
    ['!clearChat', '清空对话历史'],
    ['!goToPlayer', '定位/寻路，回执走翻译'],
    ['!followPlayer', '跟随，回执走翻译'],
    ['!goToCoordinates', '走路，回执走翻译'],
    ['!searchForBlock', '找方块，回执走翻译'],
    ['!searchForEntity', '找生物，回执走翻译'],
    ['!moveAway', '躲开，回执走翻译'],
    ['!rememberHere', '引擎自带的地名记忆（我们有中文的 runner/memory.mjs）'],
    ['!goToRememberedPlace', '同上'],
    ['!givePlayer', '给东西，回执走翻译'],
    ['!consume', '吃东西，回执走翻译'],
    ['!equip', '穿装备，回执走翻译'],
    ['!putInChest', '放箱子，回执走翻译'],
    ['!takeFromChest', '拿箱子，回执走翻译'],
    ['!viewChest', '看箱子，回执走翻译'],
    ['!discard', '扔东西，回执走翻译'],
    ['!collectBlocks', '★ 采集的命令层入口（中文话头由 runner/vocab.mjs 解析）'],
    ['!craftRecipe', '★ 合成的命令层入口（中文流程由 runner/workshop.mjs 算账）'],
    ['!smeltItem', '★ 这个命令**在引擎里会自杀重启**（actions.js:284-291），我们只在库层调它'],
    ['!clearFurnace', '清空熔炉，回执走翻译'],
    ['!placeHere', '放方块，回执走翻译'],
    ['!attack', '攻击，回执走翻译'],
    ['!attackPlayer', '攻击玩家，回执走翻译'],
    ['!goToBed', '睡觉，回执走翻译'],
    ['!stay', '原地待命，回执走翻译'],
    ['!setMode', '切引擎开关，回执走翻译'],
    ['!goal', '给自己定目标 —— 我们这条通路的存在意义就是少让模型插手'],
    ['!endGoal', '同上'],
    ['!showVillagerTrades', '村民交易我们还没接'],
    ['!tradeWithVillager', '同上'],
    ['!startConversation', '多 bot 之间对话'],
    ['!endConversation', '同上'],
    ['!lookAtPlayer', '转头看人，回执走翻译'],
    ['!lookAtPosition', '转头看坐标，回执走翻译'],
    ['!digDown', '往下挖，回执走翻译'],
    ['!goToSurface', '回到地面，回执走翻译'],
    ['!useOn', '对某个方块用东西，回执走翻译'],
]);

function extractCommandNames(file) {
    const s = fs.readFileSync(path.join(CMD_DIR, file), 'utf8');
    const out = [];
    for (const m of s.matchAll(/name:\s*["'`](![^"'`]+)["'`]/g)) out.push(m[1]);
    return out;
}

const allCommands = [...new Set([...extractCommandNames('queries.js'), ...extractCommandNames('actions.js')])];

if (allCommands.length === 0) {
    console.error('✗ 一条 `!命令` 都没扫到 —— 引擎是不是改名了？');
    process.exit(1);
}

const takenOver = [];
const delegated = [];
const unclassified = [];
for (const cmd of allCommands) {
    if (LOCAL_REPORTS[cmd]) { takenOver.push(cmd); continue; }
    if (ENGINE_ONLY.has(cmd)) { delegated.push(cmd); continue; }
    unclassified.push(cmd);
}

console.log(`\n玩家能敲的 \`!命令\` 共 ${allCommands.length} 条`);
console.log(`我们抢前接管 ${takenOver.length} 条 · 有意交给引擎 ${delegated.length} 条 · 没登记的 ${unclassified.length} 条\n`);

if (showAll) {
    for (const c of delegated) console.log(`  → ${c}\n      ${ENGINE_ONLY.get(c)}`);
    console.log('');
}

if (unclassified.length > 0) {
    console.log('没登记的命令（玩家敲下去会拿到引擎原样英文，而我们没表过态）：');
    for (const c of unclassified) console.log(`  · ${c}`);
    console.log('');
    console.log('要么加进 runner/self-report.mjs 的 LOCAL_REPORTS 接管，');
    console.log('要么加进本文件的 ENGINE_ONLY 并写清理由。');
    process.exit(1);
}

// ENGINE_ONLY 里写了但不存在的命令，是过期的登记，也该清掉
const stale = [...ENGINE_ONLY.keys()].filter((c) => !allCommands.includes(c));
if (stale.length > 0) {
    console.log('ENGINE_ONLY 里登记了、但引擎里已经没有的命令（该删了）：');
    for (const c of stale) console.log(`  · ${c}`);
    process.exit(1);
}

console.log('我们抢前接管的：');
for (const c of takenOver) console.log(`  ★ ${c} → ${LOCAL_REPORTS[c]}（中文，走 runner/self-report.mjs）`);
console.log('');
console.log('✓ 玩家能敲的每条命令，要么我们接管了，要么写清楚了为什么交给引擎');

