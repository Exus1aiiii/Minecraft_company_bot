// 多版本兼容自检：**逐个 Minecraft 版本**核对"我们按名字写死的那些表"。
//
// 为什么需要它：我们的中文通路把"砍点木头"翻译成 `oak_log` 这种**英文方块名**，
// 合成表写的是 `iron_ingot` 这种**物品名**，挖掘判断靠 minecraft-data 的
// `material` / `harvestTools` 字段。这些东西在版本之间会改名、会变形状：
//
//   · 1.20.1 那株矮草叫 `grass`，1.21.1 改叫 `short_grass`（互不存在）；
//   · `dirt` 两版都空手可挖（`harvestTools === undefined`），`stone` 两版都必须要镐；
//   · `iron_ore.material` 在 1.20.1 是 `mineable/pickaxe`，在 1.21.1 变成
//     `incorrect_for_wooden_tool`（这正是我们打在 mineflayer 上那段 digging.js
//     补丁要改写的东西）。
//
// 名字写错的代价是**运行时才炸**：用户说"挖点石头"，bot 那边抛
// `Invalid block type: xxx`，而用户只看到 bot 不动。所以这些名字必须按版本核对。
//
// 跑法：node tools/test-versions.mjs
//
// 断言分两层：
//   ① 真断言 —— `mc-versions.mjs` 里 `DATA_VERIFIED_VERSIONS` 列的版本（＝我们对外
//      声称"数据核对过"的版本）。这里红了就是真的不能声称支持。
//   ② 顺带检查 —— 其它版本只打印"哪些名字缺"，**不算失败**。它的价值是告诉我们要
//      再支持一个版本还差多少（差 0 个 = 只差真机跑一次）。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { BLOCK_WORDS } from '../runner/vocab.mjs';
import {
    LOGS, RECIPES, SMELT_FROM, ORE_BLOCK, FUELS, NEEDS_TABLE, TOOL_TIERS,
    BLOCK_TOOL, PICKAXE_FOR, DEFAULT_PLANKS, resolvePlanks,
} from '../runner/workshop.mjs';
import { AIR_LIKE } from '../runner/builder.mjs';
import {
    DEFAULT_VERSION, DATA_VERIFIED_VERSIONS, REAL_SERVER_VERSIONS,
    judgeVersion, describeVersionOptions,
} from '../runner/mc-versions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const ENGINE_DIR = path.join(PROJECT_ROOT, 'vendor', 'mindcraft-develop');
const requireEngine = createRequire(path.join(ENGINE_DIR, 'package.json'));
const minecraftData = requireEngine('minecraft-data');

let checks = 0;
let problems = 0;
function ok(msg) { checks++; console.log(`  ✓ ${msg}`); }
function fail(msg) { checks++; problems++; console.log(`  ✗ ${msg}`); }
function eq(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) ok(`${msg} → ${a}`);
    else fail(`${msg}\n      期望 ${e}\n      实际 ${a}`);
}
function section(t) { console.log(`\n=== ${t} ===`); }

// ---------------------------------------------------------------------------
// 要逐一核对的名字（都从真表里取，不另抄一份）
//
// 用途不同所以分开：
//   · BLOCK_NAMES —— 要塞给 `!collectBlocks` / `blockAt` 的**方块**名；
//   · ITEM_NAMES  —— 合成、烧炼、背包里比的**物品**名。
const BLOCK_NAMES = new Set();
const ITEM_NAMES = new Set();

for (const e of BLOCK_WORDS) BLOCK_NAMES.add(e.block);
for (const l of LOGS) BLOCK_NAMES.add(l);
for (const b of Object.keys(ORE_BLOCK)) BLOCK_NAMES.add(b);
for (const b of Object.keys(BLOCK_TOOL)) BLOCK_NAMES.add(b);
for (const b of Object.keys(PICKAXE_FOR)) BLOCK_NAMES.add(b);
for (const n of AIR_LIKE) BLOCK_NAMES.add(n);

ITEM_NAMES.add(DEFAULT_PLANKS);
for (const log of LOGS) ITEM_NAMES.add(log.replace(/_log$/, '_planks'));   // resolvePlanks 就是这么推的
for (const out of Object.keys(RECIPES)) ITEM_NAMES.add(out);
for (const rec of Object.values(RECIPES)) {
    for (const ing of Object.keys(rec.in)) {
        if (ing === '_log' || ing === '_planks') continue;                 // 占位符，实际名字由调用方解析
        ITEM_NAMES.add(ing);
    }
}
for (const [out, spec] of Object.entries(SMELT_FROM)) {
    ITEM_NAMES.add(out);
    if (spec.raw !== '_log') ITEM_NAMES.add(spec.raw);
}
for (const drop of Object.values(ORE_BLOCK)) ITEM_NAMES.add(drop);
for (const f of FUELS) ITEM_NAMES.add(f);
for (const tier of Object.values(TOOL_TIERS)) for (const t of tier) ITEM_NAMES.add(t);
for (const need of NEEDS_TABLE) ITEM_NAMES.add(need);
for (const p of Object.values(PICKAXE_FOR)) ITEM_NAMES.add(p);

const BLOCK_LIST = [...BLOCK_NAMES].sort();
const ITEM_LIST = [...ITEM_NAMES].sort();

// 两个**故意**不在"必须存在"名单里的东西：
//
//   · `grass` / `short_grass` —— 同一株矮草在两个版本里的两个名字。`AIR_LIKE` 是
//     **跨版本的并集**（哪个版本叫哪个名字就用哪个），所以"其中一个不存在"是设计，
//     不是错。这里改成断言"每个版本至少认得当地那一种"（见 2.3）。
//   · `planks` —— 我们内部的**计划用伪物品名**（`RECIPES.planks` / `step.item === 'planks'`），
//     真正要塞给引擎的是 `oak_planks` 这种具体名字（`step.as`）。它从来不会被当成
//     物品名查 minecraft-data，所以不能要求它存在。
const CROSS_VERSION_UNION = new Set(['grass', 'short_grass']);
const PSEUDO_ITEMS = new Set(['planks']);
const MUST_BLOCK_LIST = BLOCK_LIST.filter((n) => !CROSS_VERSION_UNION.has(n));
const MUST_ITEM_LIST = ITEM_LIST.filter((n) => !PSEUDO_ITEMS.has(n));

// 有几个名字只当方块存在、或者只当物品存在，核对时分开看，别互相冒充。
function blockOf(md, name) { return md.blocksByName[name] || null; }
function itemOf(md, name) { return md.itemsByName[name] || null; }

// ---------------------------------------------------------------------------
section('1. 版本判定（mc-versions.mjs）本身说得对不对');

if (DATA_VERIFIED_VERSIONS.length === 0) fail('DATA_VERIFIED_VERSIONS 是空的 —— 那"核对过"就没有意义了');
else ok(`声称核对过的版本：${DATA_VERIFIED_VERSIONS.join(', ')}`);

for (const v of DATA_VERIFIED_VERSIONS) {
    const md = minecraftData(v);
    if (md) ok(`DATA_VERIFIED_VERSIONS 里的 ${v} 在 minecraft-data 里真的有数据`);
    else fail(`DATA_VERIFIED_VERSIONS 声称核对过 ${v}，但 minecraft-data 里没有它 —— 这话是假的`);
}

for (const v of REAL_SERVER_VERSIONS) {
    if (DATA_VERIFIED_VERSIONS.includes(v)) ok(`真连过的 ${v} 也在"核对过"名单里（真连过必然核对过）`);
    else fail(`REAL_SERVER_VERSIONS 里的 ${v} 不在 DATA_VERIFIED_VERSIONS 里 —— 真连过的版本怎么会没核对过数据`);
}

const autoJudge = judgeVersion('');
eq([autoJudge.ok, autoJudge.mode, autoJudge.version], [true, 'auto', DEFAULT_VERSION], "judgeVersion('') 走默认版本");
const autoJudge2 = judgeVersion('auto');
eq([autoJudge2.ok, autoJudge2.mode], [true, 'auto'], "judgeVersion('auto') 认 auto");
const autoJudge3 = judgeVersion(' 自动 ');
eq([autoJudge3.ok, autoJudge3.mode], [true, 'auto'], "judgeVersion(' 自动 ') 认中文 auto（带空白）");

const j20 = judgeVersion('1.20.1');
eq([j20.ok, j20.mode, j20.version, j20.tested], [true, 'explicit', '1.20.1', true], "judgeVersion('1.20.1')");
const jV = judgeVersion(' V1.20.1 ');
eq([jV.ok, jV.version], [true, '1.20.1'], "judgeVersion(' V1.20.1 ') 去 v、去空白、大小写不敏感");

const jTypo = judgeVersion('1.20.11');
if (!jTypo.ok && jTypo.suggestions.includes('1.20.1')) ok(`judgeVersion('1.20.11') 判红并猜中 1.20.1（候选 ${jTypo.suggestions.join(' / ')}）`);
else fail(`judgeVersion('1.20.11') 应该判红并把 1.20.1 列进候选，实际 ok=${jTypo.ok} 候选=${JSON.stringify(jTypo.suggestions)}`);

// 完全不认识时**不许瞎猜**：要么给 ≤3 个像样的候选，要么老实说"协议库不认识它"并列出可用版本。
const jFoo = judgeVersion('foo');
if (!jFoo.ok && jFoo.suggestions.length <= 3 && /auto/.test(jFoo.hint || '')) {
    ok(`judgeVersion('foo') 判红、最多给 3 个候选、并且提示可以填 auto（候选 ${jFoo.suggestions.length} 个）`);
} else {
    fail(`judgeVersion('foo') 行为不对：ok=${jFoo.ok} 候选=${JSON.stringify(jFoo.suggestions)} hint=${jFoo.hint}`);
}

const opts = describeVersionOptions();
if (opts.ok) ok(`describeVersionOptions() 可用版本 ${opts.options.length} 个，默认 ${opts.default}`);
else fail(`describeVersionOptions() 失败：${JSON.stringify(opts)}`);

// 候选列表里的协议号必须和 minecraft-data 自己说的一致（不然界面在骗用户）
let protoBad = 0;
for (const o of opts.options || []) {
    const md = minecraftData(o.version);
    if (!md) { protoBad++; console.log(`      · ${o.version} 没有数据，却有协议号 ${o.protocol}`); continue; }
    if (md.version.version !== o.protocol) { protoBad++; console.log(`      · ${o.version} 协议号对不上：候选表 ${o.protocol}，minecraft-data ${md.version.version}`); }
}
if (protoBad === 0) ok('候选表里每个版本的协议号都与 minecraft-data 一致');
else fail(`候选表里有 ${protoBad} 个版本的协议号与 minecraft-data 不一致`);

if (DEFAULT_VERSION === '1.21.1') ok('DEFAULT_VERSION 仍是 1.21.1（我们真连过的那一版）');
else fail(`DEFAULT_VERSION 变成了 ${DEFAULT_VERSION} —— 换默认版本要同时确认真机跑过`);

// ---------------------------------------------------------------------------
section('2. 每个"核对过"的版本：名字、配方、烧炼、挖掘规则');

for (const version of DATA_VERIFIED_VERSIONS) {
    const md = minecraftData(version);
    if (!md) { fail(`minecraft-data 里没有 ${version}`); continue; }

    console.log(`\n  ── ${version}（protocol ${md.version.version}）──`);
    ok(`${version}：${Object.keys(md.blocksByName).length} 个方块 / ${Object.keys(md.itemsByName).length} 个物品 / ${Object.keys(md.recipes).length} 条配方索引`);

    // ── 2.1 方块名 ──
    const missingBlocks = MUST_BLOCK_LIST.filter((n) => !blockOf(md, n));
    if (missingBlocks.length === 0) ok(`${version}：按名字用的 ${MUST_BLOCK_LIST.length} 个方块全都在`);
    else fail(`${version}：这些方块名不存在 → ${missingBlocks.join(', ')}`);

    // ── 2.2 物品名 ──
    const missingItems = MUST_ITEM_LIST.filter((n) => !itemOf(md, n));
    if (missingItems.length === 0) ok(`${version}：按名字用的 ${MUST_ITEM_LIST.length} 个物品全都在`);
    else fail(`${version}：这些物品名不存在 → ${missingItems.join(', ')}`);

    // ── 2.3 草的名字：两版之间改过名，找地基必须认得出当地那一种 ──
    const grassNames = ['grass', 'short_grass'].filter((n) => blockOf(md, n));
    if (grassNames.length > 0 && grassNames.some((n) => AIR_LIKE.has(n))) {
        ok(`${version}：当地那株矮草叫 ${grassNames.join(' / ')}，AIR_LIKE 认得它`);
    } else {
        fail(`${version}：AIR_LIKE 认不出当地那株矮草（这版叫 ${grassNames.join(' / ') || '两个名字都没有'}）`);
    }

    // ── 2.4 每个产物在 minecraft-data 的配方索引里真的有配方 ──
    //    注意索引是**按产物 id** 的（每条 entry 的 result.id 都等于索引 id），
    //    但烧炼产物（玻璃、石头、木炭）不在这个索引里 —— 所以只断言合成产物。
    const smeltOnly = new Set(Object.keys(SMELT_FROM));
    const noRecipe = [];
    for (const [out, rec] of Object.entries(RECIPES)) {
        if (smeltOnly.has(out)) continue;
        const it = itemOf(md, out);
        if (!it) continue;                                   // 名字缺失已在 2.2 报过
        const list = md.recipes[it.id] || [];
        if (list.length === 0) { noRecipe.push(out); continue; }
        if (list.some((r) => r.result && r.result.id !== it.id)) {
            fail(`${version}：${out} 的配方索引里有"产物不是它"的条目 —— 我们对 md.recipes 的理解错了`);
        }
    }
    if (noRecipe.length === 0) ok(`${version}：合成产物在 minecraft-data 里都有配方`);
    else fail(`${version}：这些产物在 minecraft-data 里没有配方 → ${noRecipe.join(', ')}`);

    // ── 2.5 烧炼：引擎认的是 raw/`*log`/misc 名单，我们表里的原料必须落在里面 ──
    const notSmeltable = [];
    for (const [out, spec] of Object.entries(SMELT_FROM)) {
        const raw = spec.raw === '_log' ? LOGS[0] : spec.raw;
        if (!itemOf(md, out)) { notSmeltable.push(`${out}(产物不存在)`); continue; }
        if (!itemOf(md, raw) && !blockOf(md, raw)) { notSmeltable.push(`${out}←${raw}(原料不存在)`); continue; }
        // 引擎的 isSmeltable 判据（src/utils/mcdata.js:284）
        const misc = ['beef', 'chicken', 'cod', 'mutton', 'porkchop', 'rabbit', 'salmon', 'tropical_fish', 'potato', 'kelp', 'sand', 'cobblestone', 'clay_ball'];
        const okByEngine = raw.includes('raw') || raw.includes('log') || misc.includes(raw);
        if (!okByEngine) notSmeltable.push(`${out}←${raw}(引擎的 isSmeltable 不认它)`);
    }
    if (notSmeltable.length === 0) ok(`${version}：${Object.keys(SMELT_FROM).length} 条烧炼原料引擎都认`);
    else fail(`${version}：这些烧炼链条断了 → ${notSmeltable.join(', ')}`);

    // ── 2.6 挖掘规则：要镐的真的必须要有镐，空手能挖的真的没有 harvestTools ──
    const items = md.itemsByName;
    const woodenPick = items.wooden_pickaxe;
    const stoneBlock = blockOf(md, 'stone');
    const dirtBlock = blockOf(md, 'dirt');
    if (stoneBlock?.harvestTools && woodenPick && stoneBlock.harvestTools[woodenPick.id]) ok(`${version}：石头必须用镐（木镐就能挖）`);
    else fail(`${version}：石头居然不需要（木）镐 —— harvestTools=${JSON.stringify(stoneBlock?.harvestTools)}`);
    if (dirtBlock && dirtBlock.harvestTools === undefined) ok(`${version}：泥土空手就能挖（harvestTools 为空）`);
    else fail(`${version}：泥土的 harvestTools 不是空的 —— ${JSON.stringify(dirtBlock?.harvestTools)}`);

    // 我们自己的 PICKAXE_FOR 表说"哪个矿至少要哪把镐"必须与 minecraft-data 一致
    const pickBad = [];
    for (const [block, pick] of Object.entries(PICKAXE_FOR)) {
        const b = blockOf(md, block);
        const p = items[pick];
        if (!b || !p) continue;                              // 名字缺失已在别处报过
        if (!b.harvestTools || !b.harvestTools[p.id]) pickBad.push(`${block} 用 ${pick}`);
    }
    if (pickBad.length === 0) ok(`${version}：PICKAXE_FOR 里每条"哪把镐能挖什么"都与 minecraft-data 一致`);
    else fail(`${version}：PICKAXE_FOR 与 minecraft-data 不一致 → ${pickBad.join('；')}`);

    // 要镐的方块必须真的有 harvestTools（否则我们的"先做镐"逻辑会白做功）
    const noTools = Object.keys(BLOCK_TOOL).filter((b) => {
        const blk = blockOf(md, b);
        return blk && !blk.harvestTools;
    });
    if (noTools.length === 0) ok(`${version}：BLOCK_TOOL 里的方块都确实需要工具`);
    else fail(`${version}：这些方块被 BLOCK_TOOL 认为要工具，实际空手就能挖 → ${noTools.join(', ')}`);

    // `iron_ore.material` 会随版本变，但必须落在我们补丁认得的两种写法里
    const ironOre = blockOf(md, 'iron_ore');
    const okMaterials = ['mineable/pickaxe', 'incorrect_for_wooden_tool'];
    if (ironOre && okMaterials.includes(ironOre.material)) ok(`${version}：铁矿 material = ${ironOre.material}（在补丁认得的两种之内）`);
    else fail(`${version}：铁矿 material = ${ironOre?.material} —— 不在 ${okMaterials.join(' / ')} 里，digging.js 补丁可能不生效`);
}

// ---------------------------------------------------------------------------
section('3. resolvePlanks 推出来的木板名在每个版本都存在');

for (const version of DATA_VERIFIED_VERSIONS) {
    const md = minecraftData(version);
    if (!md) continue;
    const bad = LOGS.filter((log) => {
        const planks = log.replace(/_log$/, '_planks');
        return !md.itemsByName[planks];
    });
    if (bad.length === 0) ok(`${version}：${LOGS.length} 种原木都能推出存在的木板物品`);
    else fail(`${version}：这些原木推不出木板 → ${bad.map((l) => `${l}→${l.replace(/_log$/, '_planks')}`).join(', ')}`);
}

// ── 顺带看看别的版本：只报告，不算失败 ──
// 想让某个版本从"顺带看看"升成"核对过"，把它加进 DATA_VERIFIED_VERSIONS 再跑这个自检。
section('4. 顺带检查：名字表在其它版本上还成立吗（只报告，不算失败）');

const EXTRA_VERSIONS = ['1.20', '1.20.4', '1.21', '1.21.4', '1.21.6', '26.1'];
let extraClean = 0;
for (const version of EXTRA_VERSIONS) {
    const md = minecraftData(version);
    if (!md) { console.log(`  · ${version}：minecraft-data 里没有这一版`); continue; }
    const missB = MUST_BLOCK_LIST.filter((n) => !blockOf(md, n));
    const missI = MUST_ITEM_LIST.filter((n) => !itemOf(md, n));
    const ironMat = blockOf(md, 'iron_ore')?.material;
    if (missB.length === 0 && missI.length === 0) {
        extraClean++;
        console.log(`  · ${version}：名字全都在（铁矿 material=${ironMat}）→ 想支持它只差真机跑一次`);
    } else {
        const bits = [];
        if (missB.length) bits.push(`方块缺 ${missB.join(', ')}`);
        if (missI.length) bits.push(`物品缺 ${missI.join(', ')}`);
        console.log(`  · ${version}：${bits.join('；')}`);
    }
}
console.log(`  · 顺带检查的 ${EXTRA_VERSIONS.length} 个版本里，有 ${extraClean} 个名字表直接成立`);

// ---------------------------------------------------------------------------
console.log(`\n结果：${problems === 0 ? '✓ 全部通过' : '✗ ' + problems + ' 个问题'}（共 ${checks} 项检查）`);
process.exit(problems === 0 ? 0 : 1);
