/**
 * runner/engine-speak.mjs —— 把引擎吐给玩家的英文回执翻成中文。
 *
 * 为什么需要这一层：引擎的 `log(bot, message)` 是
 *
 *     export function log(bot, message) { bot.output += message + '\n'; }   // skills.js:10-12
 *
 * 也就是**逐行累加**，最后由 `action_manager.js:158-162` 统一包一层
 * `'Action output:\n' + output` 交回来。所以玩家在聊天框里看到的是：
 *
 *     Action output:
 *     Failed to collect iron_ore: Timeout: Took to long to decide path to goal!.
 *     Collected 11 iron_ore.
 *
 * 信息量其实很足（挖到 11 个就走不过去了），但读起来是英文 + 内部术语。
 * 一个"陪伴"型的 bot 不该让主人去读日志。**我们不是把引擎的话丢掉，是把它转述清楚。**
 *
 * 设计原则（三条，缺一条都会变成"看起来更好"的坏事）：
 *  1. **认不出的原样返回**。宁可给英文，也不要胡编一句听起来合理的话 ——
 *     玩家看到英文至少知道出了没预料到的事，看到编的中文反而会被误导。
 *  2. **数字一个不改**。挖到几个、差几格、要几个，全部照抄。
 *  3. **名字靠已有的表**。方块名查 `vocab.mjs` 的词典、产物名查 `workshop.mjs` 的配方表，
 *     不另起一份 —— 三份名字表迟早会互相打架。
 */

import { BLOCK_WORDS } from './vocab.mjs';
import { RECIPES, SMELT_FROM } from './workshop.mjs';

/** 方块 id → 中文名（直接借词典那张表，保证和玩家说的话对得上）。 */
const BLOCK_CN = new Map();
for (const entry of BLOCK_WORDS) {
    if (!BLOCK_CN.has(entry.block)) BLOCK_CN.set(entry.block, entry.label);
}

/** 词典和配方表里都没有、但一定会出现在回执里的那些。 */
const EXTRA_CN = {
    oak_log: '橡木', spruce_log: '云杉木', birch_log: '白桦木', jungle_log: '丛林木',
    acacia_log: '金合欢木', dark_oak_log: '深色橡木', mangrove_log: '红树原木', cherry_log: '樱花木',
    stone: '石头', cobblestone: '圆石', deepslate: '深板岩', dirt: '泥土', grass_block: '草方块',
    sand: '沙子', gravel: '砂砾', coal: '煤炭', charcoal: '木炭', iron_ingot: '铁锭',
    gold_ingot: '金锭', copper_ingot: '铜锭', raw_iron: '原铁矿', raw_gold: '原金矿',
    raw_copper: '原铜矿', glass: '玻璃', stick: '木棍', crafting_table: '工作台',
    furnace: '熔炉', chest: '箱子', torch: '火把', wooden_pickaxe: '木镐', hand: '手',
    // 挖矿挖出来的石头家族（玩家背包里天天有，英文名很容易漏出来）
    andesite: '安山岩', diorite: '闪长岩', granite: '花岗岩', tuff: '凝灰岩',
    calcite: '方解石', deepslate_bricks: '深板岩砖', cobbled_deepslate: '深板岩圆石',
    // 树的周边（砍树一定会掉）
    oak_sapling: '橡树树苗', spruce_sapling: '云杉树苗', birch_sapling: '白桦树苗',
    jungle_sapling: '丛林树苗', acacia_sapling: '金合欢树苗', dark_oak_sapling: '深色橡树树苗',
    cherry_sapling: '樱花树苗', mangrove_propagule: '红树胎生苗',
    // 打怪掉落
    bone: '骨头', string: '线', feather: '羽毛', leather: '皮革', rotten_flesh: '腐肉',
    gunpowder: '火药', spider_eye: '蜘蛛眼', ender_pearl: '末影珍珠', slime_ball: '黏液球',
    arrow: '箭', bow: '弓', shield: '盾牌', egg: '鸡蛋', wheat: '小麦',
    wheat_seeds: '小麦种子', apple: '苹果', bread: '面包', flint: '燧石',
    flint_and_steel: '打火石', shears: '剪刀', bucket: '桶', water_bucket: '水桶',
    lava_bucket: '岩浆桶', milk_bucket: '奶桶', book: '书', paper: '纸',
    ladder: '梯子', oak_door: '橡木门', red_bed: '红床', bed: '床', bucket_of_water: '水桶',
};

/**
 * 装备家族：`<材质>_<部件>` —— 用两条小表拼，而不是列 40 条。
 *
 * ★ 这是被 `tools/test-self-report.mjs` 抓出来的真 bug：
 *   玩家戴着铁头盔说「看一下背包」，回出来的是 `iron_helmet`。
 *   护甲和工具是**玩家身上最显眼的东西**，露英文最扎眼。
 */
const MATERIAL_CN = {
    wooden: '木', stone: '石', leather: '皮革', chainmail: '锁链', iron: '铁',
    golden: '金', diamond: '钻石', netherite: '下界合金', turtle: '海龟', copper: '铜',
};
const PIECE_CN = {
    helmet: '头盔', chestplate: '胸甲', leggings: '护腿', boots: '靴子',
    pickaxe: '镐', axe: '斧', shovel: '锹', hoe: '锄', sword: '剑',
};


/** 原木种类 → 中文木名。用来拼 `birch_planks` 这种"XX木板"。 */
const WOOD_CN = {
    oak: '橡木', spruce: '云杉', birch: '白桦', jungle: '丛林', acacia: '金合欢',
    dark_oak: '深色橡木', mangrove: '红树', cherry: '樱花', bamboo: '竹子',
    crimson: '绯红', warped: '诡异',
};

/** 一件东西的中文名。查不到就原样返回 —— 不编。 */
export function nameOf(id) {
    const k = String(id ?? '').trim();
    if (!k) return k;
    if (RECIPES[k]?.label) return RECIPES[k].label;
    if (SMELT_FROM[k]?.label) return SMELT_FROM[k].label;
    if (BLOCK_CN.has(k)) return BLOCK_CN.get(k);
    if (EXTRA_CN[k]) return EXTRA_CN[k];

    // 装备家族：`iron_helmet` → 铁头盔、`diamond_pickaxe` → 钻石镐
    const gear = /^(wooden|stone|leather|chainmail|iron|golden|diamond|netherite|turtle|copper)_(helmet|chestplate|leggings|boots|pickaxe|axe|shovel|hoe|sword)$/.exec(k);
    if (gear) return `${MATERIAL_CN[gear[1]]}${PIECE_CN[gear[2]]}`;

    // 深板岩变种：`deepslate_iron_ore` → 深板岩 + nameOf('iron_ore')
    const deep = /^deepslate_(.+)$/.exec(k);
    if (deep) {
        const inner = nameOf(deep[1]);
        if (inner !== deep[1]) return `深板岩${inner}`;
    }
    // 木制品家族：`birch_planks` → 白桦木板、`birch_log` → 白桦原木
    const wood = /^(.+)_(planks|log)$/.exec(k);
    if (wood && WOOD_CN[wood[1]]) {
        return `${WOOD_CN[wood[1]]}${wood[2] === 'planks' ? '木板' : '原木'}`;
    }
    // 其它 `*_ore`：剥掉后缀再查一次表（`copper_ore` 这类词典里没有的）
    if (k.endsWith('_ore')) {
        const base = k.slice(0, -4);
        if (EXTRA_CN[base]) return `${EXTRA_CN[base]}矿石`;
    }
    // 到这里还认不出 —— 原样返回，不拿半中半英的名字糊弄人
    return k;
}

/**
 * 一条一条对着 `skills.js` 里**真实存在**的 `log(bot, ...)` 写（原字符串直接抄的，
 * 没凭印象造句式）。每条正则都锚在行的两端 —— 因为引擎本来就是一行一条。
 */
const RULES = [
    // ── 采集 ────────────────────────────────────────────────
    [/^Failed to collect (\w+): Timeout: Took to long to decide path to goal!?\.?$/i,
        (m) => `挖${nameOf(m[1])}的时候走不过去了，就先挖到这儿。`],
    [/^Failed to collect (\w+): Inventory full, no place to deposit\.$/i,
        (m) => `背包塞满了，${nameOf(m[1])}装不下了。`],
    [/^Failed to collect (\w+): (.+?)\.?$/i,
        (m) => `挖${nameOf(m[1])}没成功：${m[2]}`],
    [/^Collected (\d+) (\w+)\.$/i,
        (m) => `挖到了 ${m[1]} 个${nameOf(m[2])}。`],
    [/^No more (\w+) nearby to collect\.$/i,
        (m) => `附近的${nameOf(m[1])}都挖完了。`],
    [/^No (\w+) nearby to collect\.$/i,
        (m) => `附近没有${nameOf(m[1])}。`],
    [/^Don't have right tools to harvest (\w+)\.$/i,
        (m) => `我手上没有能挖${nameOf(m[1])}的工具。`],
    [/^Don't have right tools to break (.+?)\.$/i,
        (m) => `我手上没有能挖${nameOf(m[1])}的工具。`],
    [/^Don't have bucket to harvest (\w+)\.$/i,
        (m) => `挖${nameOf(m[1])}得先有个桶。`],
    [/^Invalid number of blocks to collect: (-?\d+)\.$/i,
        () => `这个数量我挖不了，换个说法吧。`],
    [/^Picked up (\d+) items\.$/i, (m) => `顺手捡了 ${m[1]} 件东西。`],

    // ── 找路 / 移动 ──────────────────────────────────────────
    [/^Found (\w+) at (.+?)\. Navigating\.\.\.$/i,
        (m) => `找到${nameOf(m[1])}了，在 ${m[2]}，我过去。`],
    [/^Could not find any source (\w+) in (\d+) blocks, looking for uncollectable flowing instead\.\.\.$/i,
        (m) => `方圆 ${m[2]} 格没找到${nameOf(m[1])}。`],
    [/^Could not find any (\w+) in (\d+) blocks\.$/i,
        (m) => `方圆 ${m[2]} 格没找到${nameOf(m[1])}。`],
    [/^Found (\w+) (\d+) blocks away\.$/i,
        (m) => `发现${nameOf(m[1])}了，离这儿 ${m[2]} 格。`],
    [/^Pathfinding stopped: Cannot break (.+?) with current tools\.$/i,
        (m) => `路被${nameOf(m[1])}挡住了，我现在的工具挖不动。`],
    [/^Pathfinding stopped: (.+?)\.?$/i, (m) => `走不过去：${m[1]}`],
    [/^Unable to reach (.+?), you are (\d+) blocks away\.$/i,
        (m) => `到不了 ${m[1]}，还差 ${m[2]} 格。`],
    [/^You have reached at (.+?)\.$/i, (m) => `我到 ${m[1]} 了。`],
    [/^You have reached (\w+)\.$/i, (m) => `我到 ${m[1]} 身边了。`],
    [/^You are already at (\w+)\.$/i, (m) => `我就在 ${m[1]} 旁边呀。`],
    [/^Moved away from (.+?) to (.+?)\.$/i, (m) => `从 ${m[1]} 挪到了 ${m[2]}。`],
    [/^Moved (\d+) away from enemies\.$/i, (m) => `躲开敌人 ${m[1]} 格。`],
    [/^You are now actively following player (\w+)\.$/i, (m) => `好，我跟着 ${m[1]}。`],
    [/^Stayed for ([\d.]+) seconds\.$/i, (m) => `在原地待了 ${Math.round(Number(m[1]))} 秒。`],
    [/^Going to the surface at y=(-?\d+)\.$/i, (m) => `我往地面走，到 y=${m[1]}。`],
    [/^Dug down (\d+) blocks\.$/i, (m) => `往下挖了 ${m[1]} 格。`],
    [/^Dug down (\d+) blocks, but reached the end of the world\.$/i,
        (m) => `往下挖了 ${m[1]} 格就到世界底了。`],
    // 「找到一条路」这两句是真机上抓到的 —— 原本没翻译，玩家看到的是
    // `Found non-destructive path.` 这种半截英文。
    [/^Found non-destructive path\.$/i, () => `找到一条不用拆方块的路。`],
    [/^Found destructive path\.$/i, () => `只能边拆边走了。`],
    [/^Path not found, but attempting to navigate anyway using destructive movements\.$/i,
        () => `没找到现成的路，我边拆边走试试。`],
    [/^Maximum search range capped at (\d+)\.$/i, (m) => `我最远只能找 ${m[1]} 格。`],
    [/^Block (.+?) is in the way, moving closer\.\.\.$/i,
        (m) => `${nameOf(m[1])}挡住路了，我凑近点。`],
    [/^Block (.+?) is in the way, not using (.+?)\.$/i,
        (m) => `${nameOf(m[1])}挡着，${nameOf(m[2])}用不上。`],
    [/^Dug down (\d+) blocks, but reached a drop below the next block\.$/i,
        (m) => `往下挖了 ${m[1]} 格，再往下是空的，我停了。`],
    [/^Dug down (\d+) blocks, but reached (.+?)\.$/i,
        (m) => `往下挖了 ${m[1]} 格就撞见${nameOf(m[2])}了。`],

    // ── 合成 ────────────────────────────────────────────────
    [/^Successfully crafted (\w+), you now have (\d+) (\w+)\.$/i,
        (m) => `做好了${nameOf(m[1])}，现在手上有 ${m[2]} 个。`],
    [/^Not enough (\w+) to craft (\d+), crafted (\d+)\. You now have (\d+) (\w+)\.$/i,
        (m) => `${nameOf(m[1])}只够做 ${m[3]} 个${nameOf(m[5])}，现在手上有 ${m[4]} 个。`],
    [/^Crafting (\w+) requires a crafting table\.$/i,
        (m) => `做${nameOf(m[1])}得有工作台。`],
    [/^You do not have the resources to craft a (\w+)\. It requires: (.+?)\.$/i,
        (m) => `材料不够做${nameOf(m[1])}，要 ${m[2]}。`],
    [/^(\w+) is either not an item, or it does not have a crafting recipe!$/i,
        (m) => `${nameOf(m[1])}这个东西我合成不出来。`],

    // ── 烧炼 ────────────────────────────────────────────────
    [/^Successfully smelted (\w+), got (\d+) (\w+)\.$/i,
        (m) => `烧好了 ${m[2]} 个${nameOf(m[3])}。`],
    [/^Only smelted (\d+) (\w+)\.$/i,
        (m) => `只烧出来 ${m[1]} 个${nameOf(m[2])}。`],
    [/^Failed to smelt (\w+)\.$/i, (m) => `${nameOf(m[1])}没烧成。`],
    [/^Cannot smelt (\w+)\. Hint: make sure you are smelting the 'raw' item\.$/i,
        (m) => `${nameOf(m[1])}烧不了 —— 得烧带"原"字的那种（原铁矿、原金矿）。`],
    [/^There is no furnace nearby and you have no furnace\.$/i,
        () => `手边没有熔炉，我先做一个。`],
    [/^The furnace is currently smelting (.+?)\.$/i,
        (m) => `熔炉里正在烧${nameOf(m[1])}呢。`],
    [/^You have no fuel to smelt (\w+), you need coal, charcoal, or wood\.$/i,
        () => `没有燃料了 —— 得先有煤炭、木炭或者木头。`],
    [/^You don't have enough (\w+) to smelt (\d+) (\w+); you need (\d+)\.$/i,
        (m) => `${nameOf(m[1])}不够烧 ${m[2]} 个${nameOf(m[3])}，要 ${m[4]} 个。`],
    [/^Using (.+?) as fuel\.$/i, (m) => `拿${nameOf(m[1])}当燃料。`],
    [/^Added (\d+) (.+?) to furnace fuel\.$/i, (m) => `往熔炉里添了 ${m[1]} 个${nameOf(m[2])}当燃料。`],
    [/^You do not have enough (\w+) to smelt\.$/i, (m) => `${nameOf(m[1])}不够烧。`],

    // ── 装备 / 手持 ──────────────────────────────────────────
    [/^You do not have any (.+?) to equip\.$/i, (m) => `我手上没有${nameOf(m[1])}。`],
    [/^Equipped (.+?)\.$/i, (m) => `拿起了${nameOf(m[1])}。`],
    [/^Could not equip (.+?)\.$/i, (m) => `${nameOf(m[1])}拿不到手上。`],
    [/^Unequipped hand\.$/i, () => `把手里的东西收起来了。`],
    [/^You do not have any (.+?) to use\.$/i, (m) => `我手上没有${nameOf(m[1])}。`],
    // ⚠️ `Used X.` 和 `Used X on Y.` 这两条**必须排在所有具体 "Used …" 之后**
    // （`Used /setblock to …`、`Used door at …`），否则 `(.+?)` 会把它们整句吞掉。
    // 这是 check-speak-coverage.mjs 当场抓出来的：`Used /setblock to place … at …`
    // 被翻成了「用了/setblock to place … at …」。

    // ── 放置 / 破坏 ──────────────────────────────────────────
    [/^Placed (.+?) at (.+?)\.$/i, (m) => `在 ${m[2]} 放了${nameOf(m[1])}。`],
    [/^Failed to place (.+?) at (.+?)\.$/i, (m) => `${m[2]} 这块地方放不下${nameOf(m[1])}。`],
    [/^Cannot place (.+?) at (.+?): block in the way\.$/i,
        (m) => `${m[2]} 那儿被挡住了，放不下${nameOf(m[1])}。`],
    [/^Don't have any (.+?) to place\.$/i, (m) => `我手上没有${nameOf(m[1])}可放。`],
    [/^(.+?) already at (.+?)\.$/i, (m) => `${m[2]} 那里本来就是${nameOf(m[1])}。`],
    [/^Broke (.+?) at x:(.+?), y:(.+?), z:(.+?)\.$/i,
        (m) => `挖掉了 ${m[2]}, ${m[3]}, ${m[4]} 的${nameOf(m[1])}。`],
    [/^(.+?) in the way at (.+?)\.$/i, (m) => `${nameOf(m[1])}挡在 ${m[2]} 那儿。`],
    [/^Cannot place (.+?) at (.+?): nothing to place on\.$/i,
        (m) => `${m[2]} 那儿没东西可以靠着放${nameOf(m[1])}。`],
    [/^Cannot place (.+?), you are restricted to your current inventory\.$/i,
        (m) => `我现在只能用手上的东西，${nameOf(m[1])}做不了。`],
    [/^Don't have right tools to break (.+?)\.$/i,
        (m) => `我现在的工具挖不动${nameOf(m[1])}。`],
    [/^Failed to dig block at position:(.+?)$/i, (m) => `${m[1]} 那格没挖动。`],
    [/^Placing air \(removing block\) at (.+?)\.$/i, (m) => `把 ${m[1]} 那格清掉。`],
    [/^Skipping block at (.+?) because it is (.+?)\.$/i,
        (m) => `跳过 ${m[1]}（那里是${nameOf(m[2])}）。`],
    [/^Skipping air block$/i, () => `跳过一格空气。`],
    [/^Used \/setblock to place (.+?) at (.+?)\.$/i,
        (m) => `直接在 ${m[2]} 放上了${nameOf(m[1])}。`],
    [/^Used \/setblock to break block at (.+?)\.$/i, (m) => `直接清掉了 ${m[1]} 那格。`],

    // ── 战斗 ────────────────────────────────────────────────
    [/^Successfully killed (.+?)\.$/i, (m) => `打死了${m[1]}。`],
    [/^Successfully defended self\.$/i, () => `打退了。`],
    [/^No enemies nearby to defend self from\.$/i, () => `附近没有敌人。`],
    [/^Could not find any (.+?) to attack\.$/i, (m) => `附近没找到${nameOf(m[1])}。`],
    [/^Could not find any (.+?) to activate\.$/i, (m) => `附近没有能按的${nameOf(m[1])}。`],
    [/^Moved (\d+) away from enemies\.$/i, (m) => `躲开敌人 ${m[1]} 格。`],

    // ── 容器 / 库存杂项 ──────────────────────────────────────
    [/^Could not find a chest nearby\.$/i, () => `附近没有箱子。`],
    [/^You do not have any (.+?) to put in the chest\.$/i, (m) => `我手上没有${nameOf(m[1])}可放。`],
    [/^Successfully put (\d+) (.+?) in the chest\.$/i, (m) => `往箱子里放了 ${m[1]} 个${nameOf(m[2])}。`],
    [/^Could not find any (.+?) in the chest\.$/i, (m) => `箱子里没有${nameOf(m[1])}。`],
    [/^Successfully took (\d+) (.+?) from the chest\.$/i, (m) => `从箱子里拿了 ${m[1]} 个${nameOf(m[2])}。`],
    [/^The chest is empty\.$/i, () => `箱子是空的。`],
    [/^You do not have any (.+?) to discard\.$/i, (m) => `我手上没有${nameOf(m[1])}可丢。`],
    [/^Discarded (\d+) (.+?)\.$/i, (m) => `丢掉了 ${m[1]} 个${nameOf(m[2])}。`],
    [/^You do not have any (.+?) to eat\.$/i, (m) => `我手上没有${nameOf(m[1])}可吃。`],
    [/^Consumed (.+?)\.$/i, (m) => `吃掉了${nameOf(m[1])}。`],

    // ── 兜底（放在最后，免得把上面更具体的句子吞了）──────────
    [/^No furnace nearby to clear\.$/i, () => `附近没有熔炉可以收。`],
    [/^Cleared furnace, received (.+?), (.+?), and (.+?)\.$/i,
        (m) => `收工，熔炉里拿回了${nameOf(m[1])}、${nameOf(m[2])}和${nameOf(m[3])}。`],
    [/^The chest contains:$/i, () => `箱子里有这些东西：`],
    [/^You cannot give items to yourself\.$/i, () => `东西没法给自己。`],
    [/^Failed to give (.+?) to (.+?), too close\.$/i, () => `离得太近了，东西递不过去。`],
    [/^Failed to give (.+?) to (.+?), it was never received\.$/i, (m) => `${m[2]} 好像没收到。`],
    // ⚠️ 说话人必须是**一个词**（`\w+`）。写成 `(.+?)` 会把
    // `Cleared furnace, received A, B, and C.` 整句吞掉 ——
    // 这个就是 check-speak-coverage.mjs 抓出来的。
    [/^(\w+) received (.+?)\.$/i, (m) => `${m[1]} 收到了${nameOf(m[2])}。`],
    [/^Failed to collect (.+?): Inventory full, no place to deposit\.$/i,
        (m) => `背包满了，${nameOf(m[1])}装不下了。`],
    [/^Teleported to (-?\d+), (-?\d+), (-?\d+)\.$/i, (m) => `瞬移到 ${m[1]}, ${m[2]}, ${m[3]} 了。`],
    [/^Teleported to (.+?)\.$/i, (m) => `瞬移到 ${m[1]} 那儿了。`],
    [/^Missing coordinates, given x:(.+?) y:(.+?) z:(.+?)$/i,
        () => `没说清楚坐标，我不知道去哪儿。`],
    [/^Could not find a bed to sleep in\.$/i, () => `附近没有床，睡不了。`],
    [/^Could not find a door to use\.$/i, () => `附近没有门。`],
    [/^Used door at (.+?)\.$/i, (m) => `开了 ${m[1]} 的门。`],
    [/^You are in bed\.$/i, () => `我躺下了。`],
    [/^You have woken up\.$/i, () => `我起来了。`],
    // 「any / a / the」是英文的冠词，中文里没有对应的东西，得吃掉。
    [/^Could not find any source (.+?)\.$/i, (m) => `附近没有${nameOf(m[1])}源。`],
    [/^Could not find (?:any |a |the )?(.+?)\.$/i, (m) => `找不到${nameOf(m[1])}。`],
    [/^Activated (.+?) at x:(.+?), y:(.+?), z:(.+?)\.$/i,
        (m) => `在 ${m[2]}, ${m[3]}, ${m[4]} 用了一下${nameOf(m[1])}。`],
    [/^Unknown placeOn value "(.+?)"\. Defaulting to bottom\.$/i,
        () => `放置方式我没看懂，就按默认的来。`],

    // ── 「用了某个东西」的通用说法（必须排在所有具体 Used 之后）──
    [/^Used (.+?) on (.+?)\.$/i, (m) => `用${nameOf(m[1])}处理了${nameOf(m[2])}。`],
    [/^Used (.+?)\.$/i, (m) => `用了${nameOf(m[1])}。`],

    // ── 回执本身 ────────────────────────────────────────────
    [/^Action output is very long \((\d+) chars\) and has been shortened\.$/i,
        () => `（引擎这次说的话太长，我挑重点说）`],
];

/**
 * 把引擎的一句英文回执翻成中文。
 *
 * 引擎的输出是**多行**的（`skills.js:11` 逐行 `+=`，`action_manager.js:162` 包一层
 * `Action output:\n`），所以这里按行翻译、再用空格接起来 —— 一行一条正好对上
 * `skills.js` 里的一处 `log()`。
 *
 * 认不出的行**原样返回**：绝不因为"看起来像"就编一句。
 */
export function translateEngineReply(text) {
    const raw = String(text ?? '')
        .replace(/^Action output:\s*/i, '')
        .trim();
    if (!raw) return '';

    const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const line of lines) {
        let hit = match(line);
        // 引擎偶尔漏掉句末的句号（`log()` 里写死了句号的反而少见）。
        // 只是为了"能对上"，对不上时绝不改动原文 —— 所以补句号只用于试匹配。
        if (hit === null && !/[.!?]$/.test(line)) hit = match(`${line}.`);
        out.push(hit ?? line);   // 认不出 → 英文原样带出去
    }
    // 同样的句子连着出现两次（引擎有时会重复 log）就只说一遍
    return out.filter((s, i) => s !== out[i - 1]).join(' ');
}

/** 拿一条原文去撞规则，撞上返回中文，撞不上返回 null。 */
function match(line) {
    for (const [re, fn] of RULES) {
        const m = re.exec(line);
        if (m) return fn(m);
    }
    return null;
}

export default { translateEngineReply, nameOf };
