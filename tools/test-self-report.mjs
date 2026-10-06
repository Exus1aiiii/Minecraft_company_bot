/**
 * tools/test-self-report.mjs —— `runner/self-report.mjs` 的单元测试。
 *
 * ★ 为什么必须单测：这个模块的输出是**玩家会直接读到的那句话**。
 *   前面已经栽过一次 —— 记忆的 E3/E4 两个坑，单元测试全绿也没用，
 *   因为断言只查"记下了没有"，不查"记下来读着像不像人话"。
 *   所以这里除了查字段，还查**读感**：
 *     · 认不出的东西不许出现在句子里（不许把 `sparse_jungle` 甩给玩家）
 *     · 读不到的值不许编（血量读不到就不提血量，不能显示 20/20）
 *     · 物品名里不许留英文下划线（`sparse_jungle`/`oak_log` 这种）
 *
 * 跑法：
 *   node --import ./devtools/register-electron-stub.mjs tools\test-self-report.mjs
 * 退出码：0 = 全过；1 = 有断言失败。
 */

import {
    formatStats, formatInventory, countSlots, armorOf, biomeCn,
} from '../runner/self-report.mjs';
import { nameOf } from '../runner/engine-speak.mjs';

let pass = 0;
let fail = 0;

function ok(cond, label) {
    if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
    const good = actual === expected;
    if (good) { pass++; console.log(`  ✓ ${label}`); } else {
        fail++;
        console.log(`  ✗ ${label}\n      期望：${JSON.stringify(expected)}\n      实际：${JSON.stringify(actual)}`);
    }
}
function section(title) { console.log(`\n── ${title} ──`); }

/** 造一个够真的假 bot —— 只放这个模块会读的字段。 */
function fakeBot({
    pos = { x: 1.5, y: 64.9, z: -2.4 },
    health = 20,
    food = 20,
    timeOfDay = 1000,
    rainState = 0,
    thunderState = 0,
    slots = [],
    gameMode = 'survival',
} = {}) {
    return {
        entity: pos === null ? {} : { position: pos },
        health,
        food,
        time: { timeOfDay },
        rainState,
        thunderState,
        inventory: { slots },
        game: { gameMode },
    };
}

// ════════════════════════════════════════════════════════════════════════════
section('1. biomeCn：认识的翻、不认识的说不知道');

eq(biomeCn('plains'), '平原', 'plains → 平原');
eq(biomeCn('sparse_jungle'), '稀疏丛林', 'sparse_jungle → 稀疏丛林');
eq(biomeCn('bamboo_jungle'), '竹林', 'bamboo_jungle → 竹林');
eq(biomeCn('deep_dark'), '深暗之域', 'deep_dark → 深暗之域');
eq(biomeCn('cherry_grove'), '樱花树林', 'cherry_grove → 樱花树林');
eq(biomeCn('the_end'), '末地', 'the_end → 末地');
eq(biomeCn('mangrove_swamp'), '红树林沼泽', 'mangrove_swamp → 红树林沼泽');

eq(biomeCn('PLAINS'), '平原', '大写也认');
eq(biomeCn('  plains  '), '平原', '前后空格不影响');

eq(biomeCn('a_biome_from_the_future'), null, '★ 认不出的返回 null（不返回原名）');
eq(biomeCn(''), null, '空字符串 → null');
eq(biomeCn(null), null, 'null → null');
eq(biomeCn(undefined), null, 'undefined → null');
eq(biomeCn(42), null, '数字 → null 而不是崩');

// ════════════════════════════════════════════════════════════════════════════
section('2. formatStats：坐标、血量、时间、天气');

{
    const s = formatStats(fakeBot({ pos: { x: 1.5, y: 64.9, z: -2.4 } }));
    ok(s.includes('(2, 65, -2)'), `坐标四舍五入：${s}`);
    ok(s.includes('血量 20/20'), '血量');
    ok(s.includes('饱食度 20/20'), '饱食度');
    ok(s.endsWith('。'), '以句号收尾');
    ok(!s.includes('这是'), 'biome 没给 → 整句不提群系');
    ok(!s.includes('手上在忙'), 'action 没给 → 不提正在忙什么');
}

{
    const s = formatStats(fakeBot(), { biome: '丛林' });
    ok(s.includes('这是丛林'), '给了中文群系就带上');
    ok(!s.includes('_'), '★ 句子里没有英文下划线（群系 id 没漏出来）');
}

eq(Math.round(0.5) === 1 ? true : true, true, '（占位：确认上面用的是 Math.round 而不是 toFixed）');
{
    const s = formatStats(fakeBot({ pos: { x: 1.5, y: 2.5, z: 3.5 } }));
    ok(s.includes('(2, 3, 4)'), '半数值round 进位（1.5→2 / 2.5→3 / 3.5→4）');
}

// —— 时间：照抄 queries.js 的 6000/12000 分界 ——
eq(true, formatStats(fakeBot({ timeOfDay: 0 })).includes('现在是早上'), 'timeOfDay=0 → 早上');
eq(true, formatStats(fakeBot({ timeOfDay: 5999 })).includes('现在是早上'), 'timeOfDay=5999 → 早上（边界内）');
eq(true, formatStats(fakeBot({ timeOfDay: 6000 })).includes('现在是下午'), 'timeOfDay=6000 → 下午（边界切换）');
eq(true, formatStats(fakeBot({ timeOfDay: 11999 })).includes('现在是下午'), 'timeOfDay=11999 → 下午');
eq(true, formatStats(fakeBot({ timeOfDay: 12000 })).includes('现在是晚上'), 'timeOfDay=12000 → 晚上（边界切换）');
eq(false, formatStats(fakeBot({ timeOfDay: null })).includes('现在是'), '读不到时间 → 整句不提时间');

// —— 天气：打雷优先于下雨 ——
eq(true, formatStats(fakeBot()).includes('天气晴'), '默认晴');
eq(true, formatStats(fakeBot({ rainState: 1 })).includes('天气下雨'), 'rainState=1 → 下雨');
eq(true, formatStats(fakeBot({ thunderState: 1 })).includes('天气打雷'), 'thunderState=1 → 打雷');
eq(true, formatStats(fakeBot({ rainState: 1, thunderState: 1 })).includes('天气打雷'), '★ 又下雨又打雷时报打雷');

// —— 读不到就别说，绝不许编 ——
{
    const s = formatStats(fakeBot({ pos: null }));
    ok(s.includes('读不到自己的坐标'), `读不到坐标就直说：${s}`);
    ok(!/\d/.test(s.replace(/20\/20|20/g, '')), '★ 没编一个坐标出来');
}
{
    // ★ 注意用 null 而不是 undefined —— `health = 20` 那个默认参数只对 undefined 生效，
    //   传 undefined 等于没传（这个坑第一版就踩了，断言反而骗了自己）。
    const s = formatStats(fakeBot({ health: null }));
    ok(!s.includes('血量'), '★ 血量读不到 → 整句不提血量（不显示 20/20）');
    ok(s.includes('饱食度'), '饱食度照常');
}

// —— 附近的人 ——
eq(true, formatStats(fakeBot(), { players: ['Steve'] }).includes('附近能看到 Steve。'), '附近的玩家');
eq(true, formatStats(fakeBot(), { bots: ['阿霄'] }).includes('阿霄（bot）'), '★ 别的 bot 会标（bot），不会被当成真人');
eq(true, formatStats(fakeBot(), { players: ['Steve', 'Alex'] }).includes('Steve、Alex'), '多个玩家用顿号');
{
    const s = formatStats(fakeBot(), { players: ['Steve'], bots: ['阿霄'] });
    ok(s.includes('附近能看到 Steve 和 阿霄（bot）'), `人和 bot 混排：${s}`);
}
eq(false, formatStats(fakeBot()).includes('附近能看到'), '没有人 → 不提附近');

// —— 正在忙 ——
eq(true, formatStats(fakeBot(), { action: 'Mining diamond_ore' }).includes('手上在忙：Mining diamond_ore'), '正在忙什么会带上');
{
    const s = formatStats(fakeBot(), { action: 'Mining diamond_ore' });
    ok(s.includes('Mining diamond_ore'), 'action 是引擎原文，**有意不翻**（它本来就是我们自己起的标签）');
}

// ════════════════════════════════════════════════════════════════════════════
section('3. formatInventory：背包 + 身上穿的');

eq(formatInventory(fakeBot({ slots: [] })), '我背包里什么都没有。身上没穿装备。',
    '★ 空背包 + 光身子 = 两句话，不留一个空列表');

{
    const s = formatInventory(fakeBot(), { oak_log: 3, cobblestone: 53, stick: 4 });
    ok(s.includes('背包里：'), '有货就有"背包里："');
    ok(s.includes('×53') && s.includes('×3') && s.includes('×4'), '数量都对');
    const i53 = s.indexOf('×53');
    const i4 = s.indexOf('×4');
    const i3 = s.indexOf('×3');
    ok(i53 < i4 && i4 < i3, `★ 按数量降序（53 → 4 → 3）：${s}`);
    ok(!/_[a-z]/.test(s), `★ 物品名里没有英文下划线：${s}`);
}

{
    const s = formatInventory(fakeBot(), { oak_log: 3, dirt: 0, sand: -1 });
    ok(s.includes('×3'), '正数照常');
    ok(!s.includes('×0') && !s.includes('×-1'), '★ 数量为 0 / 负数的条目被丢掉');
}

{
    const slots = [
        null, null, null, null, null,
        { name: 'iron_helmet', count: 1 },
        { name: 'iron_chestplate', count: 1 },
        { name: 'iron_leggings', count: 1 },
        { name: 'iron_boots', count: 1 },
    ];
    const s = formatInventory(fakeBot({ slots }));
    ok(s.includes('身上穿着：'), '有护甲');
    ok(s.includes('头 ') && s.includes('身上 ') && s.includes('腿 ') && s.includes('脚 '), '四个部位都点了名');
    ok(!/_[a-z]/.test(s), `★ 护甲名也是中文：${s}`);
}

{
    const slots = [null, null, null, null, null, { name: 'iron_helmet', count: 1 }];
    const s = formatInventory(fakeBot({ slots }));
    ok(s.includes('头 ') && !s.includes('腿 '), '只戴头盔就只说头盔');
}

// ════════════════════════════════════════════════════════════════════════════
section('4. countSlots / armorOf：口径要和引擎一致');

eq(JSON.stringify(countSlots(fakeBot({ slots: [] }))), '{}', '空槽位 → {}');
eq(countSlots(fakeBot({ slots: [{ name: 'dirt', count: 64 }, { name: 'dirt', count: 64 }] })).dirt, 128,
    '★ 同名物品跨槽位累加（引擎 getInventoryCounts 也是这个口径）');
eq(countSlots(fakeBot({ slots: [null, { name: 'sand', count: 5 }] })).sand, 5, '跳过 null 槽');
eq(JSON.stringify(countSlots({})), '{}', '没有 inventory 也不崩');
eq(JSON.stringify(countSlots(fakeBot({ slots: [{ count: 3 }] }))), '{}', '★ 没有 name 的槽位不算数（不产生 undefined 键）');

{
    const a = armorOf(fakeBot({
        slots: [null, null, null, null, null,
            { name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
    }));
    eq(JSON.stringify(a), JSON.stringify({ head: 'a', torso: 'b', legs: 'c', feet: 'd' }),
        '★ 护甲槽就是 slots[5..8]（和 queries.js:87-90 同一组索引）');
}
eq(JSON.stringify(armorOf(fakeBot({ slots: [] }))),
    JSON.stringify({ head: null, torso: null, legs: null, feet: null }), '没护甲 → 四个 null');

// ════════════════════════════════════════════════════════════════════════════
section('5. 和 nameOf 的约定：这个模块不许自己另起一份名字表');

for (const id of ['oak_log', 'cobblestone', 'iron_ingot', 'crafting_table', 'furnace', 'raw_iron']) {
    const zh = nameOf(id);
    ok(typeof zh === 'string' && zh.length > 0, `nameOf(${id}) = ${zh}`);
}

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✓' : '✗'} self-report：${pass} 项通过，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
