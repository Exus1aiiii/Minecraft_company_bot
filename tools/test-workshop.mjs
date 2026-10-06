/**
 * 工坊（`runner/workshop.mjs`）单元测试。
 *
 * 第 1 节最重要：拿**引擎自己那份 minecraft-data** 逐条校验配方表里的
 * 每个物品 id 真实存在。配方表是我们手写的（不解析 minecraft-data 的配方树），
 * 拼错一个 id 在真机上表现为"craftRecipe 说这不是个物品"，
 * 而那种报错要跑到服上才看得见。
 *
 * 用法：node tools\test-workshop.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    LOGS, PLANK_PER_LOG, RECIPES, NEEDS_TABLE, TOOL_TIERS, BLOCK_TOOL, PICKAXE_FOR,
    SMELT_FROM, ORE_BLOCK, FUELS,
    counts, have, haveAny, logCount, plankCount, resolvePlanks, bestTool, poolFrom,
    planFor, alreadyHave, canCraft, describeNeeds, runPlan, verifyCrafted, finalizeSteps,
    parseCraftIntent, craftLabel,
} from '../runner/workshop.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'vendor', 'mindcraft-develop');

let pass = 0; const fails = [];
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fails.push(label); console.log(`  ✗ ${label}${extra ? '  → ' + extra : ''}`); } };
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const sec = (t) => console.log(`\n=== ${t} ===`);

// ───────────────────────────────────────────── 假 bot
/** 假背包：`slots` 是 mineflayer 的形状（可能有 null）。 */
function fakeBot(items = {}) {
    const slots = [];
    for (const [name, count] of Object.entries(items)) slots.push({ name, count });
    slots.push(null);
    return { inventory: { slots }, interrupt_code: false };
}

// ═════════════════════════════════════════════ 1. 配方表 vs minecraft-data
sec('1. 配方表里的物品 id 都是真的吗（拿引擎那份 minecraft-data 校验）');
{
    const require = createRequire(path.join(ENGINE, 'package.json'));
    const mcData = require('minecraft-data')('1.21.1');

    const ids = new Set();
    for (const [name, r] of Object.entries(RECIPES)) {
        if (name !== 'planks') ids.add(name);
        for (const ing of Object.keys(r.in)) {
            if (ing === '_log' || ing === '_planks') continue;
            ids.add(ing);
        }
    }
    for (const n of Object.keys(NEEDS_TABLE)) ids.add(n);
    for (const tier of Object.values(TOOL_TIERS)) for (const n of tier) ids.add(n);
    for (const n of Object.values(PICKAXE_FOR)) ids.add(n);
    for (const n of LOGS) ids.add(n);

    // ★ `mcData.items` 是按**数字 id** 索引的，`mcData.itemsByName` 才是按名字。
    //   第一版写成 `mcData.items['wooden_pickaxe']`，于是所有工具都被判成"不存在"。
    const missing = [];
    for (const id of ids) if (!mcData.itemsByName[id]) missing.push(id);
    ok(missing.length === 0, `配方表 ${ids.size} 个 id 全部存在`, missing.join(', '));

    // BLOCK_TOOL 的值是**工具类别**（pickaxe/axe/…），必须都在 TOOL_TIERS 里有对应链
    const badKind = Object.values(BLOCK_TOOL).filter(k => !TOOL_TIERS[k]);
    ok(badKind.length === 0, 'BLOCK_TOOL 里的工具类别都有对应的升级链', badKind.join(', '));

    // 原木 id 与「<原木>_planks」的对应关系
    const badPlanks = LOGS.filter(l => !mcData.itemsByName[l.replace(/_log$/, '_planks')]);
    ok(badPlanks.length === 0, `${LOGS.length} 种原木都能推出对应的木板`, badPlanks.join(', '));

    // 每块木板确实是 4 块（Minecraft 规则，写错会影响算账）
    ok(PLANK_PER_LOG === 4, 'PLANK_PER_LOG = 4');

    // ★ 引擎的 `getItemCraftingRecipes` 是它自己 `src/utils/mcdata.js` 里的包装，
    //   原始 minecraft-data 上**没有**这个方法。第一版拿它校验，于是"全都不认识"。
    //   真正的入口是 `mcData.recipes[itemId]`。
    const unknown = Object.keys(RECIPES)
        .filter(n => n !== 'planks')
        .filter(n => (mcData.recipes[mcData.itemsByName[n].id] || []).length === 0);
    ok(unknown.length === 0, 'minecraft-data 的配方表里有我们列的每个产物', unknown.join(', '));

    // 反过来：配方表里每种材料在游戏里确实拿得到
    const AIR = new Set(['_log', '_planks']);
    const badIng = [];
    for (const [name, r] of Object.entries(RECIPES)) {
        for (const ing of Object.keys(r.in)) if (!AIR.has(ing) && !mcData.itemsByName[ing]) badIng.push(`${name} <- ${ing}`);
    }
    ok(badIng.length === 0, '每种材料都是真实存在的物品', badIng.join(', '));
}

// ═════════════════════════════════════════════ 2. 背包读数
sec('2. 数背包');
{
    const bot = fakeBot({ oak_log: 3, birch_log: 2, oak_planks: 5, stick: 7, cobblestone: 12 });
    eq(have(bot, 'oak_log'), 3, 'have 读单件');
    eq(have(bot, 'diamond'), 0, '没有的东西是 0 而不是 undefined');
    eq(logCount(bot), 5, 'logCount 把所有原木加起来（3 橡木 + 2 白桦）');
    eq(plankCount(bot), 5, 'plankCount 把所有木板加起来');
    eq(haveAny(bot, ['oak_planks', 'birch_planks']), 5, 'haveAny');
    eq(counts({}), {}, '没有 inventory 的 bot 给空表而不是抛错');
    eq(counts(null), {}, 'null bot 给空表');
    eq(counts({ inventory: { slots: [null, null] } }), {}, '全 null 的背包给空表');

    // 挑木板：用原木最多的那一类
    eq(resolvePlanks(bot).planks, 'oak_planks', '原木最多的是橡木 → 用橡木木板');
    eq(resolvePlanks(bot).log, 'oak_log', '同时给出对应的原木');
    eq(resolvePlanks(fakeBot({ spruce_log: 9, oak_log: 1 })).planks, 'spruce_planks', '云杉多就用云杉');
    eq(resolvePlanks(fakeBot({ birch_planks: 4 })).planks, 'birch_planks', '没原木时用现成木板');
    eq(resolvePlanks(fakeBot({})).planks, 'oak_planks', '空手时给个默认值，不返回 undefined');

    // 工具链：有好的就不拿差的
    eq(bestTool(fakeBot({ wooden_pickaxe: 1, stone_pickaxe: 1 }), 'pickaxe'), 'stone_pickaxe', '木镐石镐都有 → 用石镐');
    eq(bestTool(fakeBot({ wooden_pickaxe: 1 }), 'pickaxe'), 'wooden_pickaxe', '只有木镐就用木镐');
    eq(bestTool(fakeBot({}), 'pickaxe'), null, '什么都没有返回 null');
    eq(bestTool(fakeBot({}), '不存在的工具'), null, '不认识工具类别返回 null');

    // 折成池子
    const p = poolFrom(bot);
    eq([p._log, p._planks], [5, 5], 'poolFrom 把原木 / 木板并起来');
    eq(p.cobblestone, 12, 'poolFrom 保留其他物品原样');
}

// ═════════════════════════════════════════════ 3. 算账
sec('3. 算账：做一件东西要几步、还差多少料');
{
    // 空手做木镐：3 木板 + 2 木棍 + 1 工作台（4 木板）
    // = 9 木板 = ceil(9/4) = 3 根木头
    const r1 = planFor('wooden_pickaxe', 1, { inv: {}, hasTable: false });
    ok(r1.ok, '空手能算出做木镐的步骤');
    eq(r1.plan.map(s => s.item), ['planks', 'stick', 'crafting_table', 'wooden_pickaxe'],
        '步骤顺序是 木板 → 木棍 → 工作台 → 木镐（依赖在前）');
    eq(r1.plan[0].times, 3, '一次合成 3 根木头份的木板（9 块木板 = 3 根木头）');
    eq(r1.plan[0].as, 'oak_planks', '木板那一步换成具体的 oak_planks');
    eq(r1.plan[1].times, 1, '木棍合 1 次（出 4 根，只要 2 根）');
    eq(r1.plan[2].times, 1, '工作台只做 1 个');
    eq(r1.plan[3].times, 1, '木镐做 1 把');
    eq(r1.missing, { _log: 3 }, '还差 3 根木头（这是说给人听的那个数）');
    ok(r1.needsTable, '没工作台 → 需要做工作台');
    eq(describeNeeds(r1.missing), '3 根木头', 'describeNeeds 说人话');

    // 旁边就有工作台 → 省掉 4 块木板，只要 5 块 = 2 根木头
    const r2 = planFor('wooden_pickaxe', 1, { inv: {}, hasTable: true });
    eq(r2.plan.map(s => s.item), ['planks', 'stick', 'wooden_pickaxe'], '有工作台就不再做工作台');
    eq(r2.plan[0].times, 2, '有工作台只要 2 根木头份的木板');
    eq(r2.missing, { _log: 2 }, '有工作台少要 1 根木头');
    ok(!r2.needsTable, 'hasTable=true 时 needsTable 为 false');

    // 手上料够 → 一步不排
    const r3 = planFor('stick', 1, { inv: { stick: 4 } });
    eq(r3.plan.map(s => s.item), [], '木棍够就一步都不排');
    eq(r3.missing, {}, '什么都不缺');
    ok(r3.alreadyHave, '并且标记 alreadyHave');

    // 只差一点
    const r4 = planFor('wooden_pickaxe', 1, { inv: { _log: 1 }, hasTable: true });
    eq(r4.missing, { _log: 1 }, '手上有 1 根木头 → 还差 1 根');

    // 石镐要圆石
    const r5 = planFor('stone_pickaxe', 1, { inv: { cobblestone: 3, stick: 2, crafting_table: 1 }, hasTable: true });
    ok(r5.ok, '有料时石镐只排目标那一步');
    eq(r5.missing, {}, '石镐材料齐了');
    eq(r5.plan.map(s => s.item), ['stone_pickaxe'], '不需要额外步骤');

    const r6 = planFor('stone_pickaxe', 1, { inv: {}, hasTable: true });
    eq(r6.missing.cobblestone, 3, '空手做石镐 → 差 3 个圆石');
    eq(r6.missing._log, 1, '木棍要 2 块木板 → 差 1 根木头');

    // 熔炉：8 圆石，不需要木棍
    const r7 = planFor('furnace', 1, { inv: { cobblestone: 8, crafting_table: 1 }, hasTable: true });
    eq(r7.plan.map(s => s.item), ['furnace'], '熔炉材料齐了就是一步');
    eq(r7.missing, {}, '熔炉不缺料');

    // 不认识的东西
    ok(!planFor('钻石剑').ok, '配方表里没有的东西返回 ok:false');
    eq(planFor('钻石剑').reason, 'unknown', '理由是 unknown');
    ok(!planFor('wooden_pickaxe', 0).ok, '做 0 件返回 ok:false');
    eq(planFor('wooden_pickaxe', 0).reason, 'count', '理由是 count');

    // 做多件
    const r8 = planFor('wooden_pickaxe', 2, { inv: {}, hasTable: true });
    eq(r8.plan.at(-1).times, 2, '做 2 把 → 目标那一步 times=2');
    eq(r8.missing._log, 3, '2 把木镐要 10 块木板 = 3 根木头');

    // alreadyHave
    ok(alreadyHave(fakeBot({ wooden_pickaxe: 1 }), 'wooden_pickaxe'), '手里有就不必再做');
    ok(!alreadyHave(fakeBot({}), 'wooden_pickaxe'), '手里没有就要做');
}

// ═════════════════════════════════════════════ 4. finalizeSteps
sec('4. 步骤合并与排序');
{
    const merged = finalizeSteps([
        { item: 'planks', as: 'oak_planks', times: 1, label: '木板' },
        { item: 'crafting_table', as: 'crafting_table', times: 1, label: '工作台' },
        { item: 'planks', as: 'oak_planks', times: 2, label: '木板' },
        { item: 'stick', as: 'stick', times: 1, label: '木棍' },
        { item: 'wooden_pickaxe', as: 'wooden_pickaxe', times: 1, label: '木镐' },
    ], 'wooden_pickaxe');
    eq(merged.map(s => s.item), ['planks', 'stick', 'crafting_table', 'wooden_pickaxe'], '重排成依赖顺序');
    eq(merged[0].times, 3, '两次木板合成并成一次（1+2=3）');
    ok(merged.at(-1).item === 'wooden_pickaxe', '目标永远排最后');
}

// ═════════════════════════════════════════════ 5. 动手
sec('5. runPlan：真做一遍，每一步都数背包');
{
    /** 假引擎：真把东西加进假背包，返回 craftRecipe 那种布尔值。 */
    function craftInto(bot, { fail = [], silent = [] } = {}) {
        const calls = [];
        const ONE = { planks: 'oak_planks', stick: 'stick', crafting_table: 'crafting_table' };
        const fn = async (name, times) => {
            calls.push([name, times]);
            if (fail.includes(name)) return false;
            if (silent.includes(name)) return true;             // 说做成了，背包里没有
            const n = name === 'oak_planks' ? times * 4 : (ONE[name] ? times : times);
            const slot = bot.inventory.slots.find(s => s && s.name === name);
            if (slot) slot.count += n; else bot.inventory.slots.push({ name, count: n });
            return true;
        };
        return { fn, calls };
    }

    // 正常一路做下来
    {
        const bot = fakeBot({ oak_log: 3 });
        const { fn, calls } = craftInto(bot);
        const logs = [];
        // 模拟"原木被消耗掉"——真实世界里合成会扣原料
        const wrapped = async (name, times) => {
            if (name === 'oak_planks') {
                const s = bot.inventory.slots.find(x => x && x.name === 'oak_log');
                if (s) { s.count -= times; if (s.count <= 0) bot.inventory.slots = bot.inventory.slots.filter(x => x !== s); }
            }
            if (name === 'stick') {
                const s = bot.inventory.slots.find(x => x && x.name === 'oak_planks');
                if (s) { s.count -= times * 2; if (s.count <= 0) bot.inventory.slots = bot.inventory.slots.filter(x => x !== s); }
            }
            if (name === 'crafting_table') {
                const s = bot.inventory.slots.find(x => x && x.name === 'oak_planks');
                if (s) { s.count -= times * 4; if (s.count <= 0) bot.inventory.slots = bot.inventory.slots.filter(x => x !== s); }
            }
            if (name === 'wooden_pickaxe') {
                const s = bot.inventory.slots.find(x => x && x.name === 'stick');
                if (s) { s.count -= times * 2; if (s.count <= 0) bot.inventory.slots = bot.inventory.slots.filter(x => x !== s); }
                const p = bot.inventory.slots.find(x => x && x.name === 'oak_planks');
                if (p) { p.count -= times * 3; if (p.count <= 0) bot.inventory.slots = bot.inventory.slots.filter(x => x !== p); }
            }
            return fn(name, times);
        };
        const r = await runPlan({ bot }, planFor('wooden_pickaxe', 1, { inv: poolFrom(bot), hasTable: false }).plan,
            { craftOne: wrapped, onProgress: m => logs.push(m), wait: 0 });
        ok(r.ok, '空手 → 木镐，一路做成功');
        eq(r.done.map(d => d.item), ['planks', 'stick', 'crafting_table', 'wooden_pickaxe'], '四步都记在 done 里');
        ok(verifyCrafted(bot, 'wooden_pickaxe'), '背包里真的多了一把木镐');
        eq(have(bot, 'wooden_pickaxe'), 1, '而且只有一把');
        eq(calls.map(c => c[0]), ['oak_planks', 'stick', 'crafting_table', 'wooden_pickaxe'], '按顺序调了引擎');
        ok(logs.some(l => l.includes('木镐')), '进度里报了木镐');
    }

    // ★ 引擎"说做成了"但背包里没有 —— 这是 skills.js:103 少合几次的真实形态
    {
        const bot = fakeBot({ oak_log: 3 });
        const { fn } = craftInto(bot, { silent: ['oak_planks'] });
        const r = await runPlan({ bot }, planFor('wooden_pickaxe', 1, { inv: poolFrom(bot), hasTable: true }).plan,
            { craftOne: fn, wait: 0 });
        ok(!r.ok, '引擎说做成了但背包没变 → 判失败');
        eq(r.failed.map(f => f.item), ['planks'], '失败的就是木板那一步');
        ok(r.failed[0].error.includes('没数到产出') || r.failed[0].error.includes('材料'), '给出「没数到产出」这种实话', r.failed[0].error);
        eq(r.done.length, 0, '没有一步算成功');
    }

    // 第一步就失败 → 后面不再调
    {
        const bot = fakeBot({ oak_log: 3 });
        const { fn, calls } = craftInto(bot, { fail: ['oak_planks'] });
        const r = await runPlan({ bot }, planFor('wooden_pickaxe', 1, { inv: poolFrom(bot), hasTable: true }).plan,
            { craftOne: fn, wait: 0 });
        ok(!r.ok, '第一步没成就收手');
        eq(calls.length, 1, '只调了一次引擎，没有硬着头皮往下做');
        eq(r.done.length, 0, 'done 是空的');
    }

    // craftOne 抛异常 → 不炸出来，变成失败
    {
        const bot = fakeBot({ oak_log: 3 });
        const r = await runPlan({ bot }, planFor('stick', 1, { inv: poolFrom(bot) }).plan,
            { craftOne: async () => { throw new Error('配方不存在'); }, wait: 0 });
        ok(!r.ok, 'craftOne 抛异常被兜住');
        ok(r.failed[0].error.includes('配方不存在'), '异常信息保留在 failed 里', r.failed[0].error);
    }

    // 被叫停
    {
        const bot = fakeBot({ oak_log: 3 });
        bot.interrupt_code = true;
        const r = await runPlan({ bot }, planFor('stick', 1, { inv: poolFrom(bot) }).plan,
            { craftOne: async () => true, wait: 0 });
        ok(!r.ok, '被叫停 → ok:false');
        ok(r.interrupted, '带 interrupted 标记');
        eq(r.message, '好，我停下了。', '给玩家一句人话');
    }

    // 池子里有料 → 只剩目标那一步
    {
        const bot = fakeBot({ oak_planks: 5, stick: 4 });
        const { fn, calls } = craftInto(bot);
        const r = await runPlan({ bot }, planFor('wooden_pickaxe', 1, { inv: poolFrom(bot), hasTable: true }).plan,
            { craftOne: fn, wait: 0 });
        ok(r.ok, '料齐 → 直接合成');
        eq(calls.length, 1, '只调一次引擎（不做木板也不做木棍）');
    }
}

// ═════════════════════════════════════════════ 6. 块 → 工具 的映射
sec('6. 挖什么要什么镐');
{
    eq(BLOCK_TOOL.stone, 'pickaxe', '石头要镐');
    eq(BLOCK_TOOL.diamond_ore, 'pickaxe', '钻石矿要镐');
    eq(BLOCK_TOOL.oak_log, undefined, '原木不需要工具（表里没有就是不需要）');
    eq(PICKAXE_FOR.stone, 'wooden_pickaxe', '挖石头 → 木镐就够');
    eq(PICKAXE_FOR.iron_ore, 'stone_pickaxe', '挖铁矿 → 要石镐');
    eq(PICKAXE_FOR.diamond_ore, 'iron_pickaxe', '挖钻石 → 要铁镐');
    // ★ 这个断言本来写的是"提到的镐我们都会做"，但 `iron_pickaxe` 我们**故意不做**
    //   （要铁锭 → 得先有熔炉和燃料）。真正该保证的是：**会说清楚哪些做不出来**，
    //   而不是把做不出来的东西悄悄写进升级链里当空许诺。
    const kinds = [...new Set(Object.values(PICKAXE_FOR))];
    const canMake = kinds.filter(canCraft);
    const cannot = kinds.filter(k => !canCraft(k));
    ok(canMake.includes('wooden_pickaxe') && canMake.includes('stone_pickaxe'), '木镐石镐我们真的会做');
    eq(cannot.sort(), ['diamond_pickaxe'], '只有钻石镐是我们造不出来的（木/石/铁三级都覆盖了）');
    ok(canCraft('iron_pickaxe'), 'canCraft 对铁镐说"会"——铁锭能靠烧原铁矿得到');
    ok(!canCraft('diamond_pickaxe'), 'canCraft 对钻石镐说"不会"（好让门禁说实话，而不是空许诺）');
    ok(canCraft('wooden_pickaxe'), 'canCraft 对木镐说"会"');
}

// ═════════════════════════════════════════════ 7. 烧炼链
sec('7. 铁镐：铁锭不是合成的，是烧出来的');
{
    // 空手要铁镐 → 3 铁锭 → 3 原铁矿 + 燃料 + 熔炉（8 圆石）
    const p = planFor('iron_pickaxe', 1, { inv: {}, hasTable: true });
    ok(p.ok, '空手也能规划出铁镐的路线（不报 unknown）');
    const smelt = p.plan.filter(s => s.kind === 'smelt');
    eq(smelt.length, 1, '恰好一步烧炼');
    eq(smelt[0].item, 'raw_iron', '烧的是原铁矿（引擎的 isSmeltable 只认带 raw 的名字）');
    eq(smelt[0].as, 'iron_ingot', '烧出来是铁锭');
    eq(smelt[0].times, 3, '铁镐要 3 个铁锭 → 烧 3 次');
    ok(p.missing.raw_iron === 3, '缺的原料是 3 个原铁矿（不是 iron_ore）');
    // 木棍不是"缺的原料"——它是能现做的，账要一直折到原木那一层
    eq(p.missing.stick, undefined, '木棍不算缺的原料（它能用木板现做）');
    eq(p.missing._log, 1, '2 根木棍 → 1 块木板 → 折成 1 根原木');

    // 烧炼步骤必须排在最终合成之前
    const iSmelt = p.plan.findIndex(s => s.kind === 'smelt');
    const iTarget = p.plan.findIndex(s => s.item === 'iron_pickaxe');
    ok(iSmelt >= 0 && iTarget > iSmelt, '烧炼排在合成铁镐之前');

    // 手上已经有铁锭 → 就不该再排烧炼
    const p2 = planFor('iron_pickaxe', 1, { inv: { iron_ingot: 3, stick: 2 }, hasTable: true });
    eq(p2.plan.filter(s => s.kind === 'smelt').length, 0, '铁锭够了就不再排烧炼');
    eq(p2.plan.length, 1, '只剩"合成铁镐"一步');

    // 直接说"烧点铁锭"
    const p3 = planFor('iron_ingot', 2, { inv: { raw_iron: 2 }, hasFurnace: true });
    ok(p3.ok && p3.plan.length === 1 && p3.plan[0].kind === 'smelt', '直接要铁锭 → 一步烧炼');

    // ★ 没有熔炉就必须先排一个 —— 第一版漏了这条，`smeltItem` 找不到熔炉直接失败
    const p3b = planFor('iron_ingot', 2, { inv: { raw_iron: 2, cobblestone: 8 }, hasFurnace: false });
    ok(p3b.plan.some(s => s.item === 'furnace'), '没有熔炉 → 计划里先做一个熔炉');
    ok(p3b.plan.findIndex(s => s.item === 'furnace') < p3b.plan.findIndex(s => s.kind === 'smelt'), '熔炉排在烧炼之前');
    ok(p3b.needsTable, '熔炉是 3×3 配方 → 连带要工作台');
    eq(p3b.missing.cobblestone, undefined, '有 8 圆石就不算缺料');

    // 熔炉本身：8 个圆石，而且它是 3×3 配方、要工作台
    ok(NEEDS_TABLE.has('furnace'), '熔炉需要工作台');
    eq(planFor('furnace', 1, { inv: { cobblestone: 8 }, hasTable: true }).plan.length, 1, '有 8 圆石就一步做出熔炉');

    // 原铜 / 金也要能算
    eq(SMELT_FROM.copper_ingot.raw, 'raw_copper', '铜锭来自原铜矿');
    eq(SMELT_FROM.gold_ingot.raw, 'raw_gold', '金锭来自原金矿');
    eq(ORE_BLOCK.iron_ore, 'raw_iron', '挖铁矿掉原铁矿');
    eq(ORE_BLOCK.deepslate_iron_ore, 'raw_iron', '深板岩铁矿也掉原铁矿');
    eq(ORE_BLOCK.coal_ore, 'coal', '挖煤矿直接掉煤炭（当燃料）');
    eq(FUELS[0], 'coal', '首选燃料是煤炭');
}

// ═════════════════════════════════════════════ 8. 烧炼步骤真的会被执行
sec('8. runPlan 遇到烧炼步骤会调 smeltOne 而不是 craftOne');
{
    const bot = fakeBot({ raw_iron: 3, cobblestone: 8 });
    const agent = { bot };
    const plan = [
        { item: 'furnace', as: 'furnace', times: 1, out: 1, label: '熔炉' },
        { kind: 'smelt', item: 'raw_iron', as: 'iron_ingot', times: 3, out: 'iron_ingot', label: '铁锭' },
    ];
    const calls = [];
    const res = await runPlan(agent, plan, {
        wait: 0,
        craftOne: async (name) => { calls.push(`craft:${name}`); bot.inventory.slots.push({ name, count: 1 }); return true; },
        smeltOne: async (raw, n) => { calls.push(`smelt:${raw}x${n}`); bot.inventory.slots.push({ name: 'iron_ingot', count: n }); return true; },
        onProgress: () => {},
    });
    ok(res.ok, '两个步骤都成功');
    eq(calls, ['craft:furnace', 'smelt:raw_ironx3'], '烧炼走的是 smeltOne');
    ok(res.done[1].gained === 3, '烧炼拿到 3 个铁锭');

    // 没有 smeltOne 时必须判失败，而不是悄悄当成合成
    const bot2 = fakeBot({ raw_iron: 3 });
    const res2 = await runPlan({ bot: bot2 }, [{ kind: 'smelt', item: 'raw_iron', as: 'iron_ingot', times: 3, label: '铁锭' }], {
        wait: 0, craftOne: async () => { throw new Error('不该被调用'); }, onProgress: () => {},
    });
    ok(!res2.ok, '没给 smeltOne → 判失败');
    ok(String(res2.failed[0].error).includes('烧炼'), '失败原因说清是缺烧炼实现');
}

// ═════════════════════════════════════════════ 9. 烧炼意图
sec('9. "烧点铁锭"这种话也认得出来');
{
    eq(parseCraftIntent('烧点铁锭')?.item, 'iron_ingot', '"烧点铁锭" → iron_ingot');
    eq(parseCraftIntent('烧点铁锭')?.kind, 'smelt', '标成烧炼而不是合成');
    eq(parseCraftIntent('烧点铁锭')?.label, '铁锭', '话术里说的是"铁锭"不是 iron_ingot');
    eq(parseCraftIntent('炼一炉玻璃')?.item, 'glass', '"炼一炉玻璃" → glass');
    eq(parseCraftIntent('烧几个木炭')?.item, 'charcoal', '"烧几个木炭" → charcoal');
    eq(craftLabel('iron_ingot'), '铁锭', 'craftLabel 也认识烧出来的东西');
    eq(parseCraftIntent('你好呀'), null, '纯打招呼 → null');
    eq(parseCraftIntent('今天天气不错'), null, '闲聊 → null');
}

// ───────────────────────────────────────────── 汇总
console.log(`\n${'─'.repeat(60)}`);
if (fails.length === 0) console.log(`结果：✓ 全部通过（共 ${pass} 项检查）`);
else { console.log(`结果：✗ ${fails.length} 项失败 / 共 ${pass + fails.length} 项`); for (const f of fails) console.log(`   - ${f}`); }
process.exit(fails.length ? 1 : 0);
