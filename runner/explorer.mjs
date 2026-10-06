/**
 * runner/explorer.mjs —— "陪我出去转转"
 *
 * 为什么要有这个文件：上一版里"四处走走"只是引擎的 `!moveAway(30)`，
 * 也就是"朝任意方向走开 30 格"——bot 走完什么都不知道，也说不出自己看见了什么。
 * 那不是探险，那是逃跑。引擎没有任何"探索"原语（`docs/03` §十），所以这一层只能自己写。
 *
 * 分工与 builder.mjs 一致：**我们不重写寻路**，用引擎的 `skills.goToGoal` +
 * mineflayer-pathfinder 的 `GoalXZ`（只约束水平坐标，不像 `GoalNear` 那样要求
 * 精确的三维距离 —— 野外地形高低差几十格是常态，用 GoalNear 会一直走不到）。
 * 我们负责的是"去哪里、看见什么、怎么用中文汇报"。
 *
 * 三条设计原则：
 *  1. **不往水里跳**：目标点如果落在水面/岩浆上就换一个方向（走不过去还容易淹死）。
 *  2. **一定要能回来说话**：单程距离有上限，走完还会回到玩家身边（玩家没跑远的话）。
 *  3. **说不出发现就是白走**：结束时必须报出"走了多远、到了哪、看见了什么"。
 */

import { vecAt } from './builder.mjs';

/** 四面八方。Minecraft 里 +z 是南、-z 是北、+x 是东、-x 是西。 */
export const DIRECTIONS = {
    东: { dx: 1, dz: 0 }, 西: { dx: -1, dz: 0 },
    南: { dx: 0, dz: 1 }, 北: { dx: 0, dz: -1 },
    东南: { dx: 1, dz: 1 }, 东北: { dx: 1, dz: -1 },
    西南: { dx: -1, dz: 1 }, 西北: { dx: -1, dz: -1 },
};

export const DIST_MIN = 16;
export const DIST_MAX = 80;
export const DIST_DEFAULT = 32;
/** 一次寻路最多走这么远，走完再算下一段。 */
export const HOP_MAX = 16;
/** 单段寻路的超时。 */
export const HOP_TIMEOUT_MS = 30000;

/** 值得在汇报里点名的东西。顺序即优先级（先报这个后报那个）。 */
export const NOTABLE = [
    [/^(diamond|deepslate_diamond)_ore$/, '钻石'],
    [/^(emerald|deepslate_emerald)_ore$/, '绿宝石'],
    [/^(gold|deepslate_gold)_ore$/, '金矿'],
    [/^(iron|deepslate_iron)_ore$/, '铁矿'],
    [/^(coal|deepslate_coal)_ore$/, '煤矿'],
    [/^(copper|deepslate_copper)_ore$/, '铜矿'],
    [/^lapis_ore$/, '青金石'],
    [/^redstone_ore$/, '红石'],
    [/_log$/, '树'],
    [/^(water|bubble_column)$/, '水'],
    [/^(lava|flowing_lava)$/, '岩浆'],
    [/^(sunflower|rose_bush|peony|lilac|dandelion|poppy|blue_orchid|allium|daisy|tulip|daisy)$/, '花'],
    [/^(wheat|carrots|potatoes|beetroots)$/, '庄稼'],
    [/^(pumpkin|melon)$/, '瓜'],
    [/^(sugar_cane|bamboo)$/, '甘蔗竹子'],
    [/^(sand|red_sand)$/, '沙子'],
    [/^(cactus|dead_bush)$/, '仙人掌'],
    [/^(snow|snow_block|powder_snow)$/, '雪'],
    [/^(clay)$/, '黏土'],
    [/^cave_air$/, '洞穴'],
    [/^crafting_table$/, '工作台'],
    [/^(chest|barrel)$/, '箱子'],
    [/^(villager|iron_golem)$/, '村民'],
];

/**
 * 从中文里读出行走意图。
 * @returns {{distance:number, heading:keyof DIRECTIONS|null, label:string}}
 */
export function parseExploreIntent(text = '') {
    const s = String(text);
    let heading = null;
    // 「东北」要排在「东」前面，否则永远只会匹配到「东」
    const keys = Object.keys(DIRECTIONS).sort((a, b) => b.length - a.length);
    for (const k of keys) {
        if (s.includes(k)) { heading = k; break; }
    }
    let distance = DIST_DEFAULT;
    const m = s.match(/(\d{1,3})\s*(?:格|米|步|方块)?/);
    if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > 0) distance = n;
    }
    distance = Math.max(DIST_MIN, Math.min(DIST_MAX, distance));
    return { distance, heading, label: heading ? `${heading}边` : '随便挑个方向' };
}

/**
 * 挑一个目标点。落在水/岩浆上就往回收，实在不行换方向。
 * @returns {{x:number, z:number, heading:string, distance:number}}
 */
export function pickTarget(bot, distance, heading = null, rng = Math.random) {
    const p = bot?.entity?.position;
    const ox = Math.floor(p?.x ?? 0);
    const oz = Math.floor(p?.z ?? 0);
    const names = Object.keys(DIRECTIONS);
    const first = heading && DIRECTIONS[heading] ? heading : names[Math.floor(rng() * names.length)];
    // 试 3 个方向：首选方向不行（前面是水）就换
    const order = [first, ...names.filter((n) => n !== first).sort(() => rng() - 0.5)];
    for (const name of order.slice(0, 3)) {
        const d = DIRECTIONS[name];
        const len = Math.hypot(d.dx, d.dz) || 1;
        const x = Math.round(ox + (d.dx / len) * distance);
        const z = Math.round(oz + (d.dz / len) * distance);
        if (isWalkableLooking(bot, x, z)) return { x, z, heading: name, distance };
    }
    // 三个方向都不行：宁可原地报告，也不往水里跳
    return { x: ox, z: oz, heading: first, distance: 0 };
}

/**
 * 远处区块多半还没加载（`blockAt` 返回 null），null **不算**"不能走"，
 * 只有明确读到水面/岩浆才拦。
 */
function isWalkableLooking(bot, x, z) {
    if (!bot?.blockAt) return true;
    const y = Math.floor(bot.entity?.position?.y ?? 64);
    for (let dy = 4; dy >= -2; dy--) {
        let b = null;
        try { b = bot.blockAt(vecAt(bot, x, y + dy, z)); } catch { return true; }
        if (!b) continue;                       // 区块没加载 —— 放行
        if (/^(water|lava|flowing_water|flowing_lava|powder_snow|fire|magma_block|cactus)$/.test(b.name)) return false;
        if (b.name !== 'air' && !/air$/.test(b.name)) return true;   // 踩到实地了
    }
    return true;                                // 全是空气（悬崖/虚空）也放行，pathfinder 会自己绕
}

/**
 * 走。用 `GoalXZ` 而不是 `GoalNear` —— 野外目标点的实际地面高度无从得知，
 * 三维距离会让 pathfinder 在"差 8 格高度"的地方反复横跳直到超时。
 *
 * ★ 更关键的一条：**一次寻路不能拉太远**。实测拉 48 格穿过森林，pathfinder
 *   在复杂地形里反复重算，150 秒只挪了 26 格、几乎原地打转。所以内部切成
 *   ≤`HOP_MAX` 格一段，每段重新算一次路。任一段走不通就停下，用**已走过的
 *   实际距离**如实汇报 —— 让"走不到"变成"走了几步就说话"，而不是原地转两分半。
 *
 * @returns {Promise<{ok:boolean, reason:string, from:object, to:object, moved:number}>}
 *          reason ∈ '' | 'no-target' | 'path' | 'timeout' | 'interrupted'
 */
export async function exploreTo(agent, target, {
    skills, pf, timeoutMs = 150000, hopTimeoutMs = HOP_TIMEOUT_MS, onProgress = null,
} = {}) {
    const bot = agent?.bot;
    const from = snapshotPos(bot);
    if (!target || target.distance === 0 || (target.x === Math.floor(from.x) && target.z === Math.floor(from.z))) {
        return { ok: false, reason: 'no-target', from, to: from, moved: 0 };
    }

    const hops = Math.max(1, Math.ceil(target.distance / HOP_MAX));
    const ox = from.x, oz = from.z;
    const deadline = Date.now() + timeoutMs;

    let interrupted = !!bot?.interrupt_code;
    const tick = setInterval(() => {
        if (bot?.interrupt_code) { interrupted = true; try { bot.pathfinder.stop(); } catch { /* 已经停了 */ } }
        if (onProgress) onProgress(snapshotPos(bot));
    }, 1000);
    tick.unref?.();

    let failed = null;
    let done = 0;
    try {
        for (let i = 1; i <= hops; i++) {
            if (interrupted) break;
            const left = deadline - Date.now();
            if (left <= 0) { failed = { reason: 'timeout', detail: 'timeout' }; break; }
            const wx = Math.round(ox + (target.x - ox) * (i / hops));
            const wz = Math.round(oz + (target.z - oz) * (i / hops));
            const goal = new pf.goals.GoalXZ(wx, wz);
            try {
                await withTimeout(skills.goToGoal(bot, goal), Math.min(hopTimeoutMs, left));
                done = i;
            } catch (err) {
                failed = {
                    reason: err?.message === 'timeout' ? 'timeout' : 'path',
                    detail: String(err?.message || err),
                };
                break;
            }
        }
    } finally {
        clearInterval(tick);
    }

    const to = snapshotPos(bot);
    const moved = dist2d(from, to);
    // ★ 被叫停之后寻路库**不一定抛错**（有的版本是安静地停下、goto 照常 resolve）。
    //   只看"有没有抛异常"会把"半路停下"报成"走完了"—— 那是在跟玩家撒谎。
    if (interrupted) return { ok: false, reason: 'interrupted', from, to, moved, hops, done };
    if (!failed && done === hops) return { ok: true, reason: '', from, to, moved, hops, done };
    return { ok: false, reason: failed?.reason || 'path', detail: failed?.detail, from, to, moved, hops, done };
}

/**
 * 给一个 promise 套超时。**守卫定时器不能 unref**：它是唯一还在等的东西时，
 * unref 会让 Node 直接退出（`Warning: Detected unsettled top-level await`），
 * 超时保护就永远不触发。
 */
function withTimeout(promise, ms) {
    let timer = null;
    const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); });
    return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

export function snapshotPos(bot) {
    const p = bot?.entity?.position;
    return p
        ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }
        : { x: 0, y: 0, z: 0 };
}

function dist2d(a, b) {
    return Math.round(Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.z ?? 0) - (b?.z ?? 0)));
}

/**
 * 看看周围有什么。扫描是**分层的粗扫**：水平半径 r、垂直 ±dy，逐格 `blockAt`。
 * r=16, dy=6 → 33×13×33 ≈ 14k 次查询，约几十毫秒，可以接受。
 * @returns {{counts:Object, found:string[], biome:string|null}}
 */
export function scanAround(bot, r = 16, dy = 6) {
    const out = { counts: {}, found: [], biome: null };
    const p = bot?.entity?.position;
    if (!p || !bot.blockAt) return out;
    const cx = Math.floor(p.x), cy = Math.floor(p.y), cz = Math.floor(p.z);
    for (let x = cx - r; x <= cx + r; x++) {
        for (let z = cz - r; z <= cz + r; z++) {
            for (let y = cy - dy; y <= cy + dy; y++) {
                let b = null;
                try { b = bot.blockAt(vecAt(bot, x, y, z)); } catch { continue; }
                if (!b || !b.name) continue;
                if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') continue;
                out.counts[b.name] = (out.counts[b.name] || 0) + 1;
            }
        }
    }
    for (const [re, label] of NOTABLE) {
        let n = 0;
        for (const [name, c] of Object.entries(out.counts)) if (re.test(name)) n += c;
        if (n > 0) out.found.push({ label, n });
    }
    out.found.sort((a, b) => b.n - a.n);
    out.biome = readBiome(bot, cx, cy, cz);
    return out;
}

/**
 * 生物群系。mineflayer 各版本 API 不一样（`bot.world.getBiome` / `block.biome` /
 * `bot.world.getBlock().biome`），这里逐个试，都拿不到就返回 null ——
 * **绝不能因为读不到群系就把整趟探险判成失败**。
 */
function readBiome(bot, x, y, z) {
    try {
        const g = bot?.world?.getBiome;
        if (typeof g === 'function') {
            const b = g.call(bot.world, vecAt(bot, x, y, z));
            const name = b?.name ?? b?.displayName;
            if (name) return String(name);
        }
    } catch { /* 试下一种 */ }
    try {
        const b = bot.blockAt(vecAt(bot, x, y - 1, z));
        const name = b?.biome?.name ?? b?.biome;
        if (typeof name === 'string' && name) return name;
    } catch { /* 试下一种 */ }
    return null;
}

/** 把一趟走下来的结果说成人话。 */
export function describeTrip(trip, before, after) {
    const parts = [];
    if (!trip.ok && trip.reason === 'no-target') parts.push('我看了一圈，四周好像没地方好去。');
    if (trip.ok) parts.push(`我往${trip.headingLabel || '那边'}走了 ${trip.moved} 格`);
    else if (trip.reason === 'interrupted') parts.push(`你叫我停，我就停在半路了（走了 ${trip.moved} 格）`);
    else if (trip.reason === 'timeout') parts.push(`那边太远了，我走了 ${trip.moved} 格还没到，就先回来了`);
    else parts.push(`路上不太好走，我只挪了 ${trip.moved} 格`);
    parts.push(`现在在 (${trip.to.x}, ${trip.to.y}, ${trip.to.z})`);
    if (after?.biome) parts.push(`这儿是${after.biome}`);
    const gained = diffFound(before, after);
    if (gained.length) parts.push(`一路上看见了${gained.map((f) => `${f.label}×${f.n}`).join('、')}`);
    else parts.push('没看见什么特别的东西');
    return parts.join('，') + '。';
}

/** 只报"新出现的"东西，不报本来就在脚底下的石头泥土。 */
function diffFound(before, after) {
    const b = new Map((before?.found || []).map((f) => [f.label, f.n]));
    return (after?.found || [])
        .filter((f) => f.n > (b.get(f.label) || 0))
        .filter((f) => !['水', '沙子'].includes(f.label))
        .slice(0, 5);
}
