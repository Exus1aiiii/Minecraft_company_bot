/**
 * runner/self-report.mjs —— 用中文汇报自己的状态。
 *
 * ★ 为什么不直接把引擎的 `!stats` / `!inventory` 回执转述给玩家：
 *   引擎那两份是**给模型看的内部转储**，不是给人看的话 ——
 *   `!stats` 会吐出 15 行，包括一长串 Agent Modes（self_preservation(ON)、
 *   unstuck(ON)…），实测在聊天框里**被拆成两条消息**发出去。
 *   一个陪伴型 bot 报个坐标不该刷屏。
 *
 *   所以这两个动作我们**自己组织中文**：从 `bot` 上直接读数据，
 *   一句话说完。顺带解决了两件事 —— 物品名走 `nameOf()` 翻译成中文，
 *   而且完全不经过引擎的英文模板。
 *
 * ★ 这里只做"说人话"，不做任何决策。读不到的数据就**不说**，
 *   绝不补一个"大概是这样"的值（血量读不到就说"血量看不到"，
 *   不能显示 20/20 —— 那是在编）。
 */

import { nameOf } from './engine-speak.mjs';

/**
 * 直接敲命令时，哪些引擎 query 命令**被我们抢在前面**自己用中文回答。
 *
 * ★ 引擎的 query 命令是"给模型看的内部转储"，不是"给人看的话"：
 *   `!stats` 吐 15 行（含 self_preservation(ON) 那一长串 modes），
 *   `!inventory` 吐一份英文清单。玩家说「报一下坐标」我们已经回中文了，
 *   他要是直接敲 `!stats` 却收到一堆英文，那就是**同一个问题两个答案**。
 *
 * ★ 这份表是**唯一的一份**：`runner/mcbot-gate.mjs` 拿它做接管，
 *   `tools/check-speak-coverage.mjs` 拿它做边界核对。两处各写一份迟早会分家。
 *
 * 值是 `runSelfReportTask()` 认的动作名。
 */
export const LOCAL_REPORTS = { '!stats': 'stats', '!inventory': 'inventory' };

/**
 * 生物群系中英对照。
 *
 * 引擎回的是 `sparse_jungle` 这种 id（`world.getBiomeName` 直接取
 * minecraft-data 里的 name）。玩家听到「这是稀疏丛林」会心一笑，
 * 听到「这是 sparse_jungle」会觉得 bot 没做完。
 *
 * ★ 认不出时**返回 null**，让调用方整句不提群系 —— 不返回
 *   `sparse_jungle` 这种半成品，也不硬造一个中文名。
 */
const BIOME_CN = {
    plains: '平原', sunflower_plains: '向日葵平原', forest: '森林', flower_forest: '繁花森林',
    birch_forest: '白桦森林', old_growth_birch_forest: '原始白桦森林',
    dark_forest: '黑森林', pale_garden: '苍白之园',
    taiga: '针叶林', snowy_taiga: '积雪针叶林', old_growth_pine_taiga: '原始松树针叶林',
    old_growth_spruce_taiga: '原始云杉针叶林',
    jungle: '丛林', sparse_jungle: '稀疏丛林', bamboo_jungle: '竹林',
    desert: '沙漠', savanna: '热带草原', savanna_plateau: '热带草原高地',
    windswept_savanna: '风袭热带草原', windswept_hills: '风袭丘陵', windswept_forest: '风袭森林',
    windswept_gravelly_hills: '风袭砂砾丘陵',
    swamp: '沼泽', mangrove_swamp: '红树林沼泽',
    river: '河流', frozen_river: '冻河', beach: '沙滩', snowy_beach: '积雪沙滩', stony_shore: '石岸',
    ocean: '海洋', deep_ocean: '深海', warm_ocean: '温暖海洋', lukewarm_ocean: '温水海洋',
    cold_ocean: '冷水海洋', frozen_ocean: '冻洋', deep_lukewarm_ocean: '深温水海洋',
    deep_cold_ocean: '深冷水海洋', deep_frozen_ocean: '深冻洋',
    mushroom_fields: '蘑菇岛', stony_peaks: '裸岩山峰', jagged_peaks: '尖峭山峰',
    frozen_peaks: '冰封山峰', snowy_slopes: '积雪山坡', snowy_plains: '积雪平原',
    grove: '雪林', meadow: '草甸', cherry_grove: '樱花树林',
    ice_spikes: '冰刺之地', snowy_taiga_hills: '积雪针叶林丘陵',
    badlands: '恶地', eroded_badlands: '被风蚀的恶地', wooded_badlands: '疏林恶地',
    nether_wastes: '下界荒地', soul_sand_valley: '灵魂沙峡谷', crimson_forest: '绯红森林',
    warped_forest: '诡异森林', basalt_deltas: '玄武岩三角洲',
    the_end: '末地', end_highlands: '末地高地', end_midlands: '末地内陆', small_end_islands: '末地小岛',
    the_void: '虚空', dripstone_caves: '溶洞', lush_caves: '繁茂洞穴', deep_dark: '深暗之域',
};

/** 群系 id → 中文；认不出返回 null（调用方就整句不提群系）。 */
export function biomeCn(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    if (BIOME_CN[key]) return BIOME_CN[key];
    // 认不出就返回 null，**不返回原名** —— 「这是 sparse_jungle」比不说更难看
    return null;
}

/** 引擎的 timeOfDay / weather 判断（照抄 `commands/queries.js:34-47` 的口径）。 */
function timeWord(bot) {    const t = bot?.time?.timeOfDay;
    if (typeof t !== 'number') return null;
    if (t < 6000) return '早上';
    if (t < 12000) return '下午';
    return '晚上';
}

function weatherWord(bot) {
    if (bot?.thunderState > 0) return '打雷';
    if (bot?.rainState > 0) return '下雨';
    return '晴';
}

function round1(n) {
    return Math.round(n * 10) / 10;
}

/**
 * 坐标 + 状态，一句话。
 * @param {object} bot mineflayer 的 bot
 * @param {{biome?: string|null, action?: string|null, players?: string[], bots?: string[]}} extra
 * @returns {string}
 */
export function formatStats(bot, { biome = null, action = null, players = [], bots = [] } = {}) {
    const pos = bot?.entity?.position;
    const parts = [];

    if (pos) {
        parts.push(`我在 (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})`);
    } else {
        parts.push('我这边读不到自己的坐标');
    }
    if (biome) parts.push(`这是${biome}`);

    const hp = typeof bot?.health === 'number' ? Math.round(bot.health) : null;
    const food = typeof bot?.food === 'number' ? Math.round(bot.food) : null;
    if (hp !== null) parts.push(`血量 ${hp}/20`);
    if (food !== null) parts.push(`饱食度 ${food}/20`);

    const t = timeWord(bot);
    if (t) parts.push(`现在是${t}`);
    parts.push(`天气${weatherWord(bot)}`);

    if (action) parts.push(`手上在忙：${action}`);

    let line = parts.join('，') + '。';

    const others = [];
    if (players.length) others.push(players.join('、'));
    if (bots.length) others.push(`${bots.join('、')}（bot）`);
    if (others.length) line += `附近能看到 ${others.join(' 和 ')}。`;

    return line;
}

/**
 * 背包 + 身上穿的。
 * @param {object} bot
 * @param {Record<string, number>} counts 物品名 → 数量（调用方给，便于单测）
 * @returns {string}
 */
export function formatInventory(bot, counts = null) {
    const inv = counts || countSlots(bot);
    const items = Object.entries(inv)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    // 空的就直说 —— 「背包里：」后面接一个空列表最难读
    const bag = items.length
        ? `背包里：${items.map(([id, n]) => `${nameOf(id)}×${n}`).join('、')}。`
        : '我背包里什么都没有。';

    const armor = armorOf(bot);
    const worn = [];
    if (armor.head) worn.push(`头 ${nameOf(armor.head)}`);
    if (armor.torso) worn.push(`身上 ${nameOf(armor.torso)}`);
    if (armor.legs) worn.push(`腿 ${nameOf(armor.legs)}`);
    if (armor.feet) worn.push(`脚 ${nameOf(armor.feet)}`);
    const wearing = worn.length ? `身上穿着：${worn.join('、')}。` : '身上没穿装备。';

    return bag + wearing;
}

/** 照抄引擎的口径（`library/world.js:262 getInventoryCounts`）：整个窗口的槽位都算。 */
export function countSlots(bot) {
    const out = {};
    for (const slot of bot?.inventory?.slots || []) {
        if (slot && slot.name) out[slot.name] = (out[slot.name] || 0) + (slot.count || 0);
    }
    return out;
}

/** 护甲槽。索引是 mineflayer 玩家窗口的固定位置，引擎也用同样四个（`queries.js:87-90`）。 */
export function armorOf(bot) {
    const s = bot?.inventory?.slots || [];
    return {
        head: s[5]?.name || null,
        torso: s[6]?.name || null,
        legs: s[7]?.name || null,
        feet: s[8]?.name || null,
    };
}
