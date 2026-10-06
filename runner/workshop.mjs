/**
 * 工坊：把"我想要一把镐子"翻译成一串能真正做出来的步骤。
 *
 * 为什么不直接用引擎的 `!craftRecipe`：它只会做**一步**。
 * 玩家说"挖点石头"，bot 手里没镐子 —— 正确的回应不是"我没有镐子"，
 * 而是"我先砍两根木头……好了，镐子有了，现在去挖"。
 *
 * 设计原则（和 vocab/builder/explorer/memory 一致）：
 *   1. **账要先算清楚再说**。开工前算出"总共要几根木头"，说不出来就别开工。
 *   2. **每一步之后都数一遍背包**。引擎的 `bot.craft()` 材料不够时会
 *      `Math.min(craftLimit.num, num)` —— 少合几次就返回，不报错（skills.js:103）。
 *      所以"让它做了"和"它真做出来了"是两件事。
 *   3. **不做没有把握的配方**。配方表里没有的东西老实说不会，交给大模型。
 *
 * 配方表由本文件自己维护（不解析 minecraft-data 的配方树，那要处理"任意木板"
 * 这种通配），代价是物品 id 可能写错 —— 所以 `tools/test-workshop.mjs`
 * 会拿引擎自己那份 minecraft-data 逐条校验每个 id 真实存在。
 */
import { cnToNumber } from './vocab.mjs';

/** 可用于合成的原木（1 根 = 4 块木板）。 */
export const LOGS = ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];

/** 1 根原木出几块木板。 */
export const PLANK_PER_LOG = 4;

/** 合成本模块内所有产物时一律用这一种木板（实际是哪种由 `resolvePlanks()` 现算）。 */
export const DEFAULT_PLANKS = 'oak_planks';

/**
 * 配方表。`in` 是**每次**合成消耗的材料，`out` 是一次合成产出几件。
 * `_log` / `_planks` 是占位符，实际用哪一种原木/木板由调用方解析。
 */
export const RECIPES = {
    planks: { in: { _log: 1 }, out: 4, label: '木板' },
    stick: { in: { _planks: 2 }, out: 4, label: '木棍' },
    crafting_table: { in: { _planks: 4 }, out: 1, label: '工作台' },
    wooden_pickaxe: { in: { _planks: 3, stick: 2 }, out: 1, label: '木镐' },
    wooden_axe: { in: { _planks: 3, stick: 2 }, out: 1, label: '木斧' },
    wooden_sword: { in: { _planks: 2, stick: 1 }, out: 1, label: '木剑' },
    wooden_shovel: { in: { _planks: 1, stick: 2 }, out: 1, label: '木锹' },
    wooden_hoe: { in: { _planks: 2, stick: 2 }, out: 1, label: '木锄' },
    stone_pickaxe: { in: { cobblestone: 3, stick: 2 }, out: 1, label: '石镐' },
    stone_axe: { in: { cobblestone: 3, stick: 2 }, out: 1, label: '石斧' },
    stone_sword: { in: { cobblestone: 2, stick: 1 }, out: 1, label: '石剑' },
    stone_shovel: { in: { cobblestone: 1, stick: 2 }, out: 1, label: '石锹' },
    furnace: { in: { cobblestone: 8 }, out: 1, label: '熔炉' },
    chest: { in: { _planks: 8 }, out: 1, label: '箱子' },
    torch: { in: { coal: 1, stick: 1 }, out: 4, label: '火把' },
    iron_pickaxe: { in: { iron_ingot: 3, stick: 2 }, out: 1, label: '铁镐' },
    iron_axe: { in: { iron_ingot: 3, stick: 2 }, out: 1, label: '铁斧' },
    iron_sword: { in: { iron_ingot: 2, stick: 1 }, out: 1, label: '铁剑' },
    iron_shovel: { in: { iron_ingot: 1, stick: 2 }, out: 1, label: '铁锹' },
};

/**
 * 熔炉产物 → 原料。**铁锭不是合成出来的，是烧出来的。**
 *
 * ⚠️ 引擎的 `isSmeltable()`（`src/utils/mcdata.js:284`）判据是
 * `itemName.includes('raw')`，所以能烧的是 `raw_iron` 而不是 `iron_ore`
 * —— 挖铁矿挖出来的是原铁矿。
 */
export const SMELT_FROM = {
    iron_ingot: { raw: 'raw_iron', label: '铁锭' },
    gold_ingot: { raw: 'raw_gold', label: '金锭' },
    copper_ingot: { raw: 'raw_copper', label: '铜锭' },
    glass: { raw: 'sand', label: '玻璃' },
    stone: { raw: 'cobblestone', label: '石头' },
    charcoal: { raw: '_log', label: '木炭' },
};

/** 矿石方块 → 挖出来掉什么。 */
export const ORE_BLOCK = {
    coal_ore: 'coal', deepslate_coal_ore: 'coal',
    iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron',
    copper_ore: 'raw_copper', deepslate_copper_ore: 'raw_copper',
    gold_ore: 'raw_gold', deepslate_gold_ore: 'raw_gold',
};

/** 能当燃料的东西，按好用程度排（煤炭一块能烧 8 个，原木只能烧 1.5 个）。 */
export const FUELS = ['coal', 'charcoal'];

/** 需要工作台才能做的（3×3 配方）。木板、木棍、工作台自己都能在背包 2×2 里做。 */
export const NEEDS_TABLE = new Set([
    'wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'wooden_shovel', 'wooden_hoe',
    'stone_pickaxe', 'stone_axe', 'stone_sword', 'stone_shovel',
    'iron_pickaxe', 'iron_axe', 'iron_sword', 'iron_shovel',
    'furnace', 'chest',
]);

/** 一套工具的升级链：从高到低找，手里有哪把就用哪把。 */
export const TOOL_TIERS = {
    pickaxe: ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'],
    axe: ['wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe'],
    sword: ['wooden_sword', 'stone_sword', 'iron_sword', 'diamond_sword'],
    shovel: ['wooden_shovel', 'stone_shovel', 'iron_shovel', 'diamond_shovel'],
};

/** 挖什么要什么工具 —— 供"挖点石头"这条链判断该做哪把镐。 */
export const BLOCK_TOOL = {
    stone: 'pickaxe', cobblestone: 'pickaxe', deepslate: 'pickaxe',
    coal_ore: 'pickaxe', iron_ore: 'pickaxe', copper_ore: 'pickaxe',
    diamond_ore: 'pickaxe', emerald_ore: 'pickaxe', gold_ore: 'pickaxe',
    redstone_ore: 'pickaxe', lapis_ore: 'pickaxe', obsidian: 'pickaxe',
};

/** 合一套工具至少要哪种镐 —— 石镐能挖铁，木镐只能挖石头。 */
export const PICKAXE_FOR = {
    stone: 'wooden_pickaxe', cobblestone: 'wooden_pickaxe', coal_ore: 'wooden_pickaxe',
    iron_ore: 'stone_pickaxe', copper_ore: 'stone_pickaxe', lapis_ore: 'stone_pickaxe',
    gold_ore: 'iron_pickaxe', redstone_ore: 'iron_pickaxe', diamond_ore: 'iron_pickaxe',
    emerald_ore: 'iron_pickaxe', obsidian: 'diamond_pickaxe', deepslate: 'wooden_pickaxe',
};

// ────────────────────────────────────────────────────────────── 背包

/**
 * 数背包。`bot.inventory.slots` 里可能有 null。
 * 读不到（假 bot / 还没登录）就返回空表，**不抛** —— 上层靠"数量为 0"给出人话。
 */
export function counts(bot) {
    const out = {};
    const slots = bot?.inventory?.slots;
    if (!Array.isArray(slots)) return out;
    for (const it of slots) {
        if (!it || !it.name) continue;
        out[it.name] = (out[it.name] || 0) + (it.count || 1);
    }
    return out;
}

/** 某样东西手上有几件。 */
export function have(bot, name) {
    return counts(bot)[name] || 0;
}

/** 一组东西加起来几件。 */
export function haveAny(bot, names) {
    const c = counts(bot);
    return names.reduce((n, k) => n + (c[k] || 0), 0);
}

/** 手上所有原木加起来几根。 */
export function logCount(bot) {
    return haveAny(bot, LOGS);
}

/** 手上所有木板加起来几块。 */
export function plankCount(bot) {
    return Object.entries(counts(bot))
        .filter(([k]) => k.endsWith('_planks'))
        .reduce((n, [, v]) => n + v, 0);
}

/**
 * 挑一种木板。优先用背包里原木最多的那一类 —— 免得橡木只剩 1 根、
 * 云杉有 12 根的时候偏偏去用橡木。
 */
export function resolvePlanks(bot) {
    const c = counts(bot);
    let best = null;
    for (const log of LOGS) {
        const n = c[log] || 0;
        if (n > 0 && (!best || n > best.n)) best = { log, n };
    }
    if (best) return { log: best.log, planks: best.log.replace(/_log$/, '_planks') };
    let bp = null;
    for (const [name, n] of Object.entries(c)) {
        if (!name.endsWith('_planks') || n <= 0) continue;
        if (!bp || n > bp.n) bp = { name, n };
    }
    return bp ? { log: null, planks: bp.name } : { log: null, planks: DEFAULT_PLANKS };
}

/** 手里最好的一套工具里的某一件（有石镐就不必再纠结木镐）。 */
export function bestTool(bot, kind) {
    const tier = TOOL_TIERS[kind];
    if (!tier) return null;
    const c = counts(bot);
    for (let i = tier.length - 1; i >= 0; i--) if ((c[tier[i]] || 0) > 0) return tier[i];
    return null;
}

/** 把背包折成"算账用"的池子：原木并成 `_log`，木板并成 `_planks`。 */
export function poolFrom(bot) {
    const c = counts(bot);
    const pool = { ...c };
    pool._log = LOGS.reduce((n, k) => n + (c[k] || 0), 0);
    pool._planks = Object.entries(c)
        .filter(([k]) => k.endsWith('_planks'))
        .reduce((n, [, v]) => n + v, 0);
    return pool;
}

// ────────────────────────────────────────────────────────────── 算账

/**
 * 算出做 `count` 件 `item` 需要哪些步骤、还差多少原材料。
 *
 * @param {string} item 产物（`RECIPES` 的 key）
 * @param {number} count 做几件
 * @param {{inv?: object, hasTable?: boolean, planksName?: string}} opts
 *   `inv` 用 `poolFrom(bot)` 的结果；`hasTable` 为真时跳过"做工作台"这一步
 *   —— 玩家家里就有一个，何必再砍 4 块木板。
 * @returns {{ok:boolean, plan?:Array, missing?:object, needsTable?:boolean, reason?:string, message?:string}}
 *   `plan` 是有序步骤 `[{item, as, times, out, label}]`，`as` 是真正传给
 *   `craftRecipe` 的物品名（木板那一步会被换成具体的 `oak_planks`）。
 */
export function planFor(item, count = 1, { inv = {}, hasTable = false, hasFurnace = false, planksName = DEFAULT_PLANKS } = {}) {
    if (!RECIPES[item] && !SMELT_FROM[item]) return { ok: false, reason: 'unknown', message: `我还没学会做这个。` };
    if (!Number.isFinite(count) || count < 1) return { ok: false, reason: 'count', message: '要做几件呢？' };

    const pool = { ...inv };
    const steps = [];
    const missing = {};
    let furnacePushed = false;

    // 手上已经有的先抵掉 —— 有 4 根木棍、只要 1 根，那一步就不该出现
    const owned = Math.min(pool[item] || 0, count);
    if (owned > 0) { pool[item] -= owned; count -= owned; }
    if (count <= 0) {
        return { ok: true, plan: [], missing: {}, needsTable: false, alreadyHave: true };
    }

    /** 从池子里拿 n 件，返回还差多少。 */
    const take = (name, n) => {
        const got = Math.min(pool[name] || 0, n);
        pool[name] = (pool[name] || 0) - got;
        return n - got;
    };

    /** 需要 n 块木板：够就直接扣，不够就排一步合成、并把原木也安排上。 */
    const ensurePlanks = (n) => {
        const lack = take('_planks', n);
        if (lack <= 0) return;
        const times = Math.ceil(lack / RECIPES.planks.out);
        steps.push({ item: 'planks', as: planksName, times, out: RECIPES.planks.out, label: '木板' });
        const logLack = take('_log', times * RECIPES.planks.in._log);
        if (logLack > 0) missing._log = (missing._log || 0) + logLack;
    };

    /** 需要 n 根木棍。 */
    const ensureSticks = (n) => {
        const lack = take('stick', n);
        if (lack <= 0) return;
        const times = Math.ceil(lack / RECIPES.stick.out);
        steps.push({ item: 'stick', as: 'stick', times, out: RECIPES.stick.out, label: '木棍' });
        ensurePlanks(times * RECIPES.stick.in._planks);
    };

    /**
     * 要烧东西了 —— 得先有熔炉。**这一条是漏过的**：
     * 第一版算铁镐的账时只算了铁锭，没算熔炉，于是 `smeltItem` 找不到熔炉直接失败。
     */
    const ensureFurnace = () => {
        if (furnacePushed || hasFurnace) return;
        if (take('furnace', 1) <= 0) return;      // 背包里已经有一个
        furnacePushed = true;
        steps.push({ item: 'furnace', as: 'furnace', times: 1, out: 1, label: '熔炉' });
        ensureItem('cobblestone', RECIPES.furnace.in.cobblestone);
    };

    /**
     * 需要 n 件某物。先扣库存；不够就看它是**合成的**还是**烧出来的**。
     * 铁镐 → 铁锭 → 原铁矿，这一层套一层的账全靠这里递归出来。
     */
    const ensureItem = (name, n) => {
        const lack = take(name, n);
        if (lack <= 0) return;

        const r = RECIPES[name];
        if (r) {
            const times = Math.ceil(lack / r.out);
            for (const [m, per] of Object.entries(r.in)) {
                const need = per * times;
                if (m === 'stick') ensureSticks(need);
                else if (m === '_planks') ensurePlanks(need);
                else ensureItem(m, need);
            }
            steps.push({ item: name, as: name, times, out: r.out, label: r.label });
            return;
        }

        const s = SMELT_FROM[name];
        if (s) {
            ensureFurnace();
            ensureItem(s.raw, lack);
            // 燃料：煤炭最好（一块烧 8 个），木头顶着用也行
            if (!pool.coal && !pool.charcoal && !pool._log && !pool[planksName] && !pool._planks) {
                missing.coal = Math.max(missing.coal || 0, Math.ceil(lack / 8));
            }
            steps.push({ kind: 'smelt', item: s.raw, as: name, times: lack, out: name, label: s.label });
            return;
        }

        missing[name] = (missing[name] || 0) + lack;   // 只能靠挖 / 靠玩家给
    };

    // 工作台：附近没有就现做一个（引擎做完会把台子收回来，所以永远只做一个）
    const needsTable = NEEDS_TABLE.has(item) && !hasTable;
    if (needsTable) {
        const lack = take('crafting_table', 1);
        if (lack > 0) {
            steps.push({ item: 'crafting_table', as: 'crafting_table', times: 1, out: 1, label: '工作台' });
            ensurePlanks(RECIPES.crafting_table.in._planks);
        }
    }

    // 目标物本身也要处理"要先烧出来"的情形（玩家直接说"烧点铁锭"）
    if (SMELT_FROM[item] && !RECIPES[item]) {
        const s = SMELT_FROM[item];
        ensureFurnace();
        ensureItem(s.raw, count);
        if (!pool.coal && !pool.charcoal && !pool._log && !pool[planksName]) {
            missing.coal = Math.max(missing.coal || 0, Math.ceil(count / 8));
        }
        steps.push({ kind: 'smelt', item: s.raw, as: item, times: count, out: item, label: s.label });
        return { ok: true, plan: finalizeSteps(steps, item), missing, needsTable: needsTable || (furnacePushed && !hasTable), smelts: true };
    }

    // 材料
    for (const [name, per] of Object.entries(RECIPES[item].in)) {
        const n = per * count;
        if (name === 'stick') { ensureSticks(n); continue; }
        if (name === '_planks') { ensurePlanks(n); continue; }
        ensureItem(name, n);
    }

    steps.push({ item, as: item, times: count, out: RECIPES[item].out, label: RECIPES[item].label });

    return { ok: true, plan: finalizeSteps(steps, item), missing, needsTable: needsTable || (furnacePushed && !hasTable) };
}

/**
 * 收尾整理步骤表：
 *   ① 同一件东西合成好几次就并成一次（"做 1 根木棍"×3 是三次往返，慢且没必要）
 *   ② 按依赖顺序重排：**木板 → 木棍 → 工作台 → 目标**。
 *      只按"首次出现的位置"排是不够的 —— `crafting_table` 那一步会先于
 *      它自己要用的木板被推进列表（`ensurePlanks` 是在它里面调的）。
 */
// 排序只看"谁必须先有"：木板 → 木棍 → 工作台 → 熔炉 → 烧炼 → 其它合成 → 目标
const STEP_RANK = { planks: 0, stick: 1, crafting_table: 2, furnace: 2.5, __smelt: 3 };

export function finalizeSteps(steps, target) {
    const byItem = new Map();
    for (const s of steps) {
        // 烧炼步骤用「输入>输出」当键，免得它和同名的普通步骤搅在一起
        const key = s.kind === 'smelt' ? `smelt:${s.item}>${s.as}` : s.item;
        const prev = byItem.get(key);
        if (prev) prev.times += s.times;
        else byItem.set(key, { ...s });
    }
    return [...byItem.values()].sort((a, b) => {
        const rank = (s) => {
            if (s.kind === 'smelt') return STEP_RANK.__smelt;   // 烧炼永远排在最终合成之前
            if (s.item === target) return 9;                    // 目标永远最后
            return STEP_RANK[s.item] ?? 4;
        };
        return rank(a) - rank(b);
    });
}

/**
 * 已经有一件了就别再做了。
 * 返回 `true` 表示"手里够用，不必合成"。
 */
export function alreadyHave(bot, item, count = 1) {
    return have(bot, item) >= count;
}

/**
 * 这件东西我们**会不会做**。
 *
 * `PICKAXE_FOR` 里会出现 `iron_pickaxe` 这种我们根本造不出来的东西
 * （要铁锭，得先有熔炉和燃料）。会做 ≠ 现在有料，所以这个函数回答的是
 * "配方表里有没有"，用来决定该说"我去做一把"还是"这个我暂时做不出来"。
 */
export function canCraft(item) {
    return Object.prototype.hasOwnProperty.call(RECIPES, item)
        || Object.prototype.hasOwnProperty.call(SMELT_FROM, item);
}

/** 把 `{_log: 3, cobblestone: 8}` 说成人话：「3 根木头、8 个圆石」。 */
export function describeNeeds(map) {
    const NAME = {
        _log: '木头', _planks: '木板', stick: '木棍', cobblestone: '圆石', coal: '煤炭',
        crafting_table: '工作台', furnace: '熔炉', raw_iron: '原铁矿', raw_gold: '原金矿', raw_copper: '原铜矿',
        iron_ingot: '铁锭', sand: '沙子',
    };
    const UNIT = { _log: '根' };
    const parts = [];
    for (const [k, v] of Object.entries(map || {})) {
        if (!v) continue;
        parts.push(`${v} ${UNIT[k] || '个'}${NAME[k] || k}`);
    }
    return parts.join('、');
}

// ────────────────────────────────────────────────────────────── 动手

/**
 * 按 `planFor()` 给的步骤真做一遍。
 *
 * `craftOne(itemName, times, step)` 由调用方注入（通常是 `skills.craftRecipe`
 * 的包装）—— 本模块不去 import 引擎，单元测试里可以塞假的实现。
 *
 * ★ 每一步做完都**重新数一遍背包**：引擎的 `bot.craft()` 材料不够就少合几次、
 *   不报错（`skills.js:103`），所以"调过了"不等于"做出来了"。
 * ★ 任何一步没产出就立刻收手 —— 后面必然也缺料，硬着头皮做只会多烧时间。
 */
export async function runPlan(agent, plan, { craftOne, smeltOne, onProgress = () => {}, wait = 600 } = {}) {
    const bot = agent?.bot;
    const done = [];
    const failed = [];
    // 烧炼步骤的"产出"是 `as`（铁锭），合成步骤的产出是 `item`
    const produced = step => (step.kind === 'smelt' ? step.as : (step.item === 'planks' ? plankCount(bot) : step.item));
    const before = step => (step.kind === 'smelt'
        ? have(bot, step.as)
        : (step.item === 'planks' ? plankCount(bot) : have(bot, step.item)));

    for (const step of plan) {
        if (bot?.interrupt_code) {
            return { ok: false, interrupted: true, done, failed, message: '好，我停下了。' };
        }
        const n0 = before(step);

        let threw = null;
        let returned = false;
        try {
            if (step.kind === 'smelt') {
                if (!smeltOne) throw new Error('没有可用的烧炼实现');
                returned = await smeltOne(step.item, step.times, step);
            } else {
                returned = await craftOne(step.as || step.item, step.times, step);
            }
        } catch (e) {
            threw = e;
        }
        // 引擎的 craftRecipe 直接读背包判断余量，刚合成完的包还没同步时会误判
        if (wait > 0) await new Promise(r => setTimeout(r, wait));

        const gained = before(step) - n0;
        if (gained > 0) {
            done.push({ ...step, gained });
            onProgress(`${step.kind === 'smelt' ? '烧好了' : '做好了'}${step.label}${gained > 1 ? ` ×${gained}` : ''}`);
        } else {
            failed.push({
                ...step,
                error: threw ? String(threw?.message || threw) : (returned === false ? '材料不够或被挡住' : '没数到产出'),
            });
            onProgress(`${step.label}没做成`);
            return { ok: false, done, failed, message: `${step.label}没做成。` };
        }
    }
    return { ok: true, done, failed, message: '' };
}

/** 走完一圈之后，手上到底有没有这件东西。 */
export function verifyCrafted(bot, item) {
    return have(bot, item) > 0;
}

// ────────────────────────────────────────────────────────────── 中文意图

/** 工具名词 → 工具类别。按词长降序匹配，否则"镐子"会被"镐"吃掉半截。 */
const TOOL_NOUNS = [
    ['镐子', 'pickaxe'], ['镐头', 'pickaxe'], ['镐', 'pickaxe'], ['pickaxe', 'pickaxe'],
    ['斧头', 'axe'], ['斧子', 'axe'], ['斧', 'axe'], ['axe', 'axe'],
    ['铲子', 'shovel'], ['铁锹', 'shovel'], ['锹', 'shovel'], ['铲', 'shovel'], ['shovel', 'shovel'],
    ['锄头', 'hoe'], ['锄', 'hoe'], ['hoe', 'hoe'],
    ['剑', 'sword'], ['刀', 'sword'], ['sword', 'sword'],
];

/** 材料前缀 → 工具等级。越长越先匹配（"钻石"不能被"石"抢走）。 */
const TIERS = [
    ['钻石', 'diamond'], ['diamond', 'diamond'],
    ['铁', 'iron'], ['iron', 'iron'],
    ['石头', 'stone'], ['石', 'stone'], ['stone', 'stone'],
    ['木头', 'wooden'], ['木', 'wooden'], ['wooden', 'wooden'], ['wood', 'wooden'],
];

/** 不是工具、直接给名字的几样。 */
const DIRECT = [
    ['工作台', 'crafting_table'], ['crafting_table', 'crafting_table'], ['台子', 'crafting_table'],
    ['熔炉', 'furnace'], ['furnace', 'furnace'], ['炉子', 'furnace'],
    ['箱子', 'chest'], ['chest', 'chest'], ['储物箱', 'chest'],
    ['火把', 'torch'], ['torch', 'torch'], ['火炬', 'torch'],
    ['木棍', 'stick'], ['棍子', 'stick'], ['stick', 'stick'],
];

/** 要烧的东西：「烧点铁锭」「炼一炉玻璃」。 */
const SMELT_DIRECT = [
    ['铁锭', 'iron_ingot'], ['iron_ingot', 'iron_ingot'],
    ['金锭', 'gold_ingot'], ['gold_ingot', 'gold_ingot'],
    ['铜锭', 'copper_ingot'], ['copper_ingot', 'copper_ingot'],
    ['玻璃', 'glass'], ['glass', 'glass'],
    ['木炭', 'charcoal'], ['charcoal', 'charcoal'],
    ['石头', 'stone'],
];

/** "做 / 造 / 合 / 打"这些动词。 */
const CRAFT_VERB = /(?:做|造|合|打|弄|搞|来|帮我做|给我做|帮我造)/;
/** 烧炼动词单独一套 —— "烧点铁锭"里没有"做"。 */
const SMELT_VERB = /(?:烧|炼|熔|smelt)/;
/** 数量：「两把」「3 个」「几把」。 */
const COUNT_RE = /(?:做|造|合|打|来)?\s*([0-9]{1,2}|[一二两三四五六七八九十]+)\s*(?:把|个|件|支|根|台)?/;

/**
 * 认中文的"做一把木镐"。
 *
 * 认不出返回 `null`（退回大模型）—— **绝不猜**。宁可让大模型去理解，
 * 也不要因为认错了材料而去做一把错的镐子，那比不做更糟。
 */
export function parseCraftIntent(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    const smeltMode = SMELT_VERB.test(raw);
    if (!smeltMode && !CRAFT_VERB.test(raw)) return null;

    // ⓪ 烧炼：「烧点铁锭」「炼一炉玻璃」—— 这些不是"做"出来的
    if (smeltMode) {
        for (const [word, item] of SMELT_DIRECT) {
            if (!raw.includes(word)) continue;
            return { item, as: item, count: parseCountFrom(raw), label: craftLabel(item), kind: 'smelt' };
        }
    }

    // ① 直接点名的那几样（工作台/熔炉/箱子/火把/木棍）
    for (const [word, item] of DIRECT) {
        if (!raw.includes(word)) continue;
        return { item, as: item, count: parseCountFrom(raw), label: craftLabel(item), kind: null };
    }

    // ② 工具：先认名词，再认材料
    for (const [noun, kind] of TOOL_NOUNS) {
        if (!raw.includes(noun)) continue;
        let tier = null;
        for (const [word, t] of TIERS) {
            if (raw.includes(word)) { tier = t; break; }
        }
        // 没说材料就给最便宜的那把 —— 问"做把镐子"的人不会介意先来把木的
        const item = `${tier || 'wooden'}_${kind}`;
        return { item, as: item, count: parseCountFrom(raw), label: craftLabel(item), kind };
    }

    // ③ 只说"做点木板"这种
    if (raw.includes('木板')) {
        return { item: 'planks', as: DEFAULT_PLANKS, count: parseCountFrom(raw), label: '木板', kind: null };
    }
    return null;
}

/** 从一句话里读做几件。读不到就是 1，**不返回 0**。 */
function parseCountFrom(text) {
    const m = COUNT_RE.exec(String(text ?? '').replace(/[一二两三四五六七八九十]+(?=把|个|件|支|根|台)/g, (s) => s));
    if (!m) return 1;
    const tok = m[1];
    if (/^[0-9]+$/.test(tok)) {
        const n = Number(tok);
        return n >= 1 && n <= 64 ? n : 1;
    }
    const n = cnToNumber(tok);
    return n >= 1 && n <= 64 ? n : 1;
}

/** "一把镐子"说成 "木镐"。烧出来的东西（铁锭）也要有中文名。 */
export function craftLabel(item) {
    return RECIPES[item]?.label || SMELT_FROM[item]?.label || item;
}

export default {
    LOGS, PLANK_PER_LOG, DEFAULT_PLANKS, RECIPES, NEEDS_TABLE, TOOL_TIERS, BLOCK_TOOL, PICKAXE_FOR,
    SMELT_FROM, ORE_BLOCK, FUELS,
    counts, have, haveAny, logCount, plankCount, resolvePlanks, bestTool, poolFrom,
    planFor, alreadyHave, canCraft, describeNeeds, runPlan, verifyCrafted, finalizeSteps,
    parseCraftIntent, craftLabel,
};
