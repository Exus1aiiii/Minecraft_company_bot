// ============================================================================
// MCBOT 小屋建造器 —— "帮忙建房子" 的确定性实现
//
// 为什么必须自己写：引擎【没有】任何"盖房子"的命令。
//   · `actions.js` 里跟建造沾边的只有 `!placeHere(type)`，官方描述明确写着
//     "Do NOT use to build structures, only use for single blocks/torches."
//   · 引擎的蓝图系统（`src/agent/tasks/construction_tasks.js`，42K 字符）只能通过
//     `!newAction` 让大模型写代码来驱动 —— 而 `!newAction` 是我们的安全红线，
//     已进 `blocked_actions`（模型写的代码不许在本机执行）。
//   · `queries.js` 里的 `!checkBlueprint/!getBlueprint` 只是**只读查询**。
//
// 所以"盖房子"这一能力只能长在我们这一层。好在我们不需要自己实现"放方块"：
// 引擎的 `skills.placeBlock(bot, type, x, y, z)`（skills.js:611）已经是一个
// 相当结实的原语 —— 它会自己清掉挡路的方块、自动找一个相邻实体方块当支撑面、
// 太近会后退、太远会走过去，最后 equip + lookAt + placeBlock。
//
// 我们在这之上只做三件事：
//   1. 把"一栋小屋"拆成一个**有序**的方块列表（顺序保证每块都有支撑）；
//   2. 算清要多少材料，不够就用中文说人话，能自己合成木板就自己合成；
//   3. 一块一块地放，中途可以被打断（`bot.interrupt_code`）。
// ============================================================================

/**
 * 找地基时可以踩/可以穿过去的方块名（挑地点、判断地面平不平都靠它）。
 *
 * ⚠️ 这里面**必须同时有 `grass` 和 `short_grass`**：Minecraft 1.20.1 那株矮草叫
 * `grass`，1.21.1 改名成了 `short_grass`（1.20.1 上根本没有 `short_grass` 这个方块）。
 * 导出出去是为了让 `tools/test-versions.mjs` 能逐版本核对这张表。
 */
export const AIR_LIKE = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'tall_grass', 'grass', 'snow', 'dead_bush', 'fern']);

/** 木屋尺寸预设。"帮我盖个小屋" -> small，"盖个大点的" -> big。 */
export const HUT_PRESETS = {
    small: { w: 3, d: 3, h: 2, label: '3×3 的小木屋' },
    big: { w: 5, d: 5, h: 3, label: '5×5 的大一点的屋子' },
};

/**
 * 生成一栋小屋的方块清单（**相对坐标**，原点在屋子西南下角的地面那一层）。
 *
 * 顺序本身就是正确性的一部分：每个方块都必须"底下或旁边已经有一块"，
 * 否则 `placeBlock` 会报 `nothing to place on`。因此：
 *   · 墙：按层（y 从低到高）；
 *   · 屋顶：从西南角开始按行铺 —— 每行第一格要么在墙上、要么紧邻上一行的格子。
 * 这个不变式由 `tools/test-builder.mjs` 逐块断言，不靠人眼看。
 *
 * @param {{w:number,d:number,h:number,block:string,door?:boolean}} spec
 * @returns {Array<{x:number,y:number,z:number,block:string}>}
 */
export function hutPlan(spec) {
    const { w, d, h, block } = spec;
    const door = spec.door !== false;
    if (!(w >= 3 && d >= 3)) throw new Error('房子至少要有 3×3 的底，不然放不下门');
    if (!(h >= 2)) throw new Error('墙至少要有 2 格高，不然放不下门');

    const plan = [];
    const push = (x, y, z) => plan.push({ x, y, z, block });

    // ── 1. 四面墙，逐层往上 ──
    // 注意：门**只开在南面**（z = 0）。南北两面用同一个 `isDoor` 判断会把屋子
    // 打成两头通的穿堂 —— 这是单元测试抓出来的真 bug，不是笔误。
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!isDoor(x, y, w)) push(x, y, 0);
            push(x, y, d - 1);
        }
        for (let z = 1; z < d - 1; z++) {
            push(0, y, z);
            push(w - 1, y, z);
        }
    }

    // ── 2. 屋顶：整片铺满，从西南角按行推进 ──
    for (let z = 0; z < d; z++) {
        for (let x = 0; x < w; x++) push(x, h, z);
    }

    return plan;
}

/** 门开在南面（z = 0）正中，占 1 格宽 2 格高。 */
function isDoor(x, y, w) {
    return y < 2 && x === Math.floor((w - 1) / 2);
}

/** 这栋房子一共要多少块某种方块。 */
export function countMaterials(plan) {
    const out = {};
    for (const b of plan) out[b.block] = (out[b.block] || 0) + 1;
    return out;
}

/** 给玩家看的中文说明，例如 "3×3 的小木屋（23 块橡木木板）"。 */
export function describePlan(plan, presetLabel) {
    const m = countMaterials(plan);
    const parts = Object.entries(m).map(([k, v]) => `${v} 块${ITEM_LABEL[k] || k}`);
    return `${presetLabel}（需要 ${parts.join('、')}）`;
}

const ITEM_LABEL = {
    oak_planks: '橡木木板',
    spruce_planks: '云杉木板',
    birch_planks: '白桦木板',
    cobblestone: '圆石',
    stone: '石头',
    dirt: '泥土',
    oak_log: '橡木',
};

/** 一块木板要用几个原木合成（1 原木 -> 4 木板）。 */
const PLANK_PER_LOG = 4;

/** 哪些原木能合成哪种木板 —— 引擎的 craftRecipe 按产物名找配方，我们只需给出候选顺序。 */
const LOG_TO_PLANKS = [
    ['oak_log', 'oak_planks'],
    ['spruce_log', 'spruce_planks'],
    ['birch_log', 'birch_planks'],
    ['jungle_log', 'jungle_planks'],
    ['acacia_log', 'acacia_planks'],
    ['dark_oak_log', 'dark_oak_planks'],
];

/** 数一数背包里某种东西有几件。 */
export function countInInventory(bot, names) {
    const want = new Set(Array.isArray(names) ? names : [names]);
    let n = 0;
    for (const it of bot?.inventory?.items?.() ?? []) {
        if (want.has(it.name)) n += it.count;
    }
    return n;
}

/**
 * 材料够不够？不够时给出**能直接说给玩家听的中文**。
 *
 * @returns {{ok:true} | {ok:false, message:string, canCraft?:boolean, craftFrom?:string, craftTimes?:number}}
 */
export function checkMaterials(bot, plan) {
    const need = countMaterials(plan);
    for (const [block, n] of Object.entries(need)) {
        const have = countInInventory(bot, block);
        if (have >= n) continue;

        // 木板不够但手里有原木 -> 我们可以自己合成，不用麻烦玩家
        const recipe = LOG_TO_PLANKS.find(([, planks]) => planks === block);
        if (recipe) {
            const logs = countInInventory(bot, recipe[0]);
            const shortfall = n - have;
            const logsNeeded = Math.ceil(shortfall / PLANK_PER_LOG);
            if (logs >= logsNeeded) {
                // ★ message 也必须给出一句人话。调用方万一把合成做砸了（原木不够、
                //   配方受限少合几次），最终还是要靠这句话回给玩家 —— 绝不能是空字符串，
                //   否则屏幕上会出现"盖房材料不足："这种半截话。
                return {
                    ok: false, canCraft: true, craftFrom: recipe[0], craftTimes: logsNeeded,
                    message: `木板不太够，我得再拿${ITEM_LABEL[recipe[0]] || recipe[0]}合一点。`,
                };
            }
        }

        return {
            ok: false,
            message: `盖这栋房子要 ${n} 块${ITEM_LABEL[block] || block}，我手里只有 ${have} 块。`
                + `你先给我 ${n - have} 块，或者让我先去砍点木头。`,
        };
    }
    return { ok: true };
}

/**
 * mineflayer 的 `bot.blockAt()` **只认 Vec3 实例** —— 世界层会调 `pos.floored()`，
 * 传普通 `{x,y,z}` 会抛 `TypeError: pos.floored is not a function`
 * （`prismarine-world/src/worldsync.js:102`）。这里从 bot 自己身上借 Vec3 构造器，
 * 免得 builder.mjs 去 import 引擎的依赖；单元测试的假 bot 没有 entity，
 * 就退回普通对象（假 bot 的 blockAt 本来也不挑）。
 */
export function vecAt(bot, x, y, z) {
    const V = bot?.entity?.position?.constructor;
    if (typeof V === 'function' && V !== Object) {
        try { return new V(x, y, z); } catch { /* 退回普通对象 */ }
    }
    return { x, y, z };
}

/**
 * 找一个合适的地面高度：从 fromY 往下找到第一块实地，返回"第一块墙应该放的那一层"。
 * @returns {number|null} null = 下面是空的（悬空/虚空），不适合盖房
 */
export function findGroundY(bot, x, z, fromY) {
    let y = Math.floor(fromY);
    for (let i = 0; i < 24; i++) {
        const here = bot.blockAt(vecAt(bot, Math.floor(x), y, Math.floor(z)));
        const below = bot.blockAt(vecAt(bot, Math.floor(x), y - 1, Math.floor(z)));
        if (!here || !below) return null;
        if (!AIR_LIKE.has(below.name) && AIR_LIKE.has(here.name)) return y;
        y -= 1;
    }
    return null;
}

/**
 * 这一整列能不能在 baseY 这层起墙。
 *
 * 两个条件：
 *   1. 这一列自己的地面在 baseY 或 baseY−1 —— 允许 1 格高差（缓坡上墙块彼此相邻，
 *      `placeBlock` 找得到支撑面）。差 2 格以上就不行，屋子会悬空一截。
 *   2. 从 baseY 往上 h+1 格全是空气 —— 头顶有天花板/树冠就盖不下。
 *
 * 为什么只看四角不够：四角齐平、中间却杵着一堵墙或一棵树，方块照样放不上去
 * （真机现场：新房子和上一栋只差一格，`placeBlock` 连着 5 次报
 *  "放不上去（周围没有支撑面或工具不对）"，最后 18/23）。整列检查才是真正的条件。
 */
function columnClear(bot, x, z, baseY, h) {
    const gx = Math.floor(x);
    const gz = Math.floor(z);
    // 从 baseY+1 往下扫：拿到这一列**自己**的地面高度
    const g = findGroundY(bot, gx, gz, baseY + 1);
    if (g === null || g > baseY || g < baseY - 1) return false;
    for (let dy = 0; dy <= h; dy++) {
        const b = bot.blockAt(vecAt(bot, gx, baseY + dy, gz));
        if (!b || !AIR_LIKE.has(b.name)) return false;
    }
    return true;
}

/**
 * 在玩家附近挑一块能盖房的地方。
 *
 * 只试"玩家 +2,+2"那一个点太脆，真机上就是这么失败的（玩家 (-10,116,4)，13 个候选点
 * 没一个四角齐平）。所以改成**由近及远扫一片**：以玩家为中心 19×19 的格子里，
 * 按到玩家的距离排序，逐点检查。
 *
 * 两轮：
 *   1. 整个地基**完全齐平**且每列都空 → 最理想，屋子稳稳落在地上；
 *   2. 找不到齐平的，退一步接受四角相差 1 格，用**最高**那层当地基
 *      （低的那角底下空一格，但墙块彼此相邻，`placeBlock` 照样搭得起来）。
 * 都不行才返回 null，让上层说"你带我找块平整的草地吧"。
 *
 * @param {object} bot
 * @param {number} cx @param {number} cz 玩家所在列
 * @param {number} preferY 从这个高度往下找地面
 * @param {number} w @param {number} d 屋子尺寸
 * @param {number} [h] 墙高（不传就只查地基那一层的高度，向后兼容老调用）
 * @returns {{x:number,y:number,z:number}|null} 屋子西南下角的绝对坐标
 */
export function findBuildSite(bot, cx, cz, preferY, w, d, h = 0) {
    const cx0 = Math.floor(cx);
    const cz0 = Math.floor(cz);

    const cands = [];
    for (let dx = -9; dx <= 9; dx++) {
        for (let dz = -9; dz <= 9; dz++) {
            // 不要盖在玩家脚下（会把人封在墙里），留一圈 1 格的空
            if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) continue;
            cands.push([dx, dz, dx * dx + dz * dz]);
        }
    }
    cands.sort((a, b) => a[2] - b[2]);

    // 整块地基的每一列都满足"地面正好在这一层 + 上面 h+1 格是空的"
    const footprintClear = (x, z, baseY) => {
        for (let ax = 0; ax < w; ax++) {
            for (let az = 0; az < d; az++) {
                if (!columnClear(bot, x + ax, z + az, baseY, h)) return false;
            }
        }
        return true;
    };

    // footprint 里每一列自己的地面高度 —— null 表示有列下面是空的/区块没加载
    const footprintGrounds = (x, z) => {
        const gs = [];
        for (let ax = 0; ax < w; ax++) {
            for (let az = 0; az < d; az++) {
                const g = findGroundY(bot, x + ax, z + az, preferY);
                if (g === null) return null;
                gs.push(g);
            }
        }
        return gs;
    };

    let fallback = null;
    for (const [dx, dz] of cands) {
        const x = cx0 + dx;
        const z = cz0 + dz;
        const ys = [[0, 0], [w - 1, 0], [0, d - 1], [w - 1, d - 1]]
            .map(([ax, az]) => findGroundY(bot, x + ax, z + az, preferY));
        if (ys.some((y) => y === null)) continue;
        if (Math.min(...ys) === Math.max(...ys) && footprintClear(x, z, ys[0])) return { x, y: ys[0], z };

        if (fallback === null) {
            // ★ 不能拿"四角的最高"当地基：3×3 的四个角 x 坐标同奇偶，缓坡上四角
            //   永远一样高，中间那一列反而更高（真机上就是这么漏过去的）。
            //   要拿**整块地基**的最高那一层。
            const gs = footprintGrounds(x, z);
            if (gs) {
                const top = Math.max(...gs);
                const bottom = Math.min(...gs);
                // 高差 ≤1 才退让：低的那列底下空一格，但墙块彼此相邻，placeBlock
                // 照样搭得起来；差 2 格以上屋子会悬空，宁可不盖。
                if (top - bottom <= 1 && footprintClear(x, z, top)) fallback = { x, y: top, z };
            }
        }
    }
    return fallback;
}

/**
 * 真正动手盖。
 *
 * @param {object} agent 引擎 Agent（我们要它的 bot）
 * @param {Array} plan   hutPlan() 的结果
 * @param {{x:number,y:number,z:number}} origin 屋子西南下角
 * @param {(done:number,total:number)=>void} [onProgress]
 * @param {{placeBlock:Function}} [skills] 注入用（测试时给假实现）
 * @returns {Promise<{placed:number,total:number,failed:number,interrupted:boolean}>}
 */
export async function runBuild(agent, plan, origin, onProgress, skills) {
    const bot = agent.bot;
    const total = plan.length;
    let placed = 0;
    let failed = 0;
    let interrupted = false;
    let lastError = null;

    const tryPlace = async (b) => {
        const x = origin.x + b.x;
        const y = origin.y + b.y;
        const z = origin.z + b.z;
        try {
            const ok = await skills.placeBlock(bot, b.block, x, y, z, 'bottom');
            if (ok) return true;
            if (lastError === null) lastError = `(${x},${y},${z}) 放不上去（周围没有支撑面或工具不对）`;
            return false;
        } catch (err) {
            // 不要静默吞掉：盖房失败时玩家和日志都得知道为什么
            if (lastError === null) lastError = `(${x},${y},${z}) ${err?.message || err}`;
            return false;
        }
    };

    let missing = [];
    for (const b of plan) {
        // 引擎的"打断"约定：`bot.interrupt_code` 被置真就尽快收手。
        // 玩家说"停下"时，`!stop` 会把它置真 —— 我们必须尊重它，
        // 否则"停下"对一个正在盖房的 bot 就成了空话。
        if (bot.interrupt_code) { interrupted = true; break; }

        if (await tryPlace(b)) placed += 1;
        else { failed += 1; missing.push(b); }
        if (onProgress) onProgress(placed, total);
    }

    // 补一遍。真机实测：盖到一半被僵尸打，引擎切去战斗、pathfinder 的目标被抢走，
    // 那几块就会以 "The goal was changed before it could be completed!" 失败。
    // 等它打完、目标空出来，第二遍通常就放得上 —— 值得补，而且只补一次。
    if (!interrupted && missing.length > 0) {
        const again = missing;
        missing = [];
        for (const b of again) {
            if (bot.interrupt_code) { interrupted = true; missing.push(b); break; }
            if (await tryPlace(b)) { placed += 1; failed -= 1; }
            else missing.push(b);
        }
        if (onProgress) onProgress(placed, total);
    }

    return { placed, total, failed, interrupted, lastError, missing: missing.length };
}
