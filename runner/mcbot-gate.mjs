// ============================================================================
// MCBOT 聊天门（chat gate）
//
// 这是整个产品最核心的一段代码。上游 Mindcraft 引擎【完全没有】唤醒称谓
// 机制：agent.js 的 respondFunc 同时挂在 'chat' 和 'whisper' 上，只按"谁
// 说的"过滤，不按"说的是什么"过滤 —— 公屏上任何人说任何话都会触发一次
// 大模型调用。同时它也没有 owner 概念，服务器上任何人都能直接敲 !stop。
//
// 我们不改引擎源码，而是通过 NODE_OPTIONS=--import 把本文件注入引擎进程与
// 每个 agent 子进程（agent_process.js 的 spawn 会继承 NODE_OPTIONS），然后
// 包一层 Agent.prototype._setupEventHandlers：让原函数照常把 respondFunc
// 挂上并赋给 this.respondFunc，随后只摘掉"它这次新加的两条监听器"，换成
// 我们自己的门。命中的消息才调用 agent.respondFunc，未命中的直接 return
// —— 零 token。
//
// 门的判定顺序（顺序本身就是产品规则，别随手调换）：
//   1. 空消息            -> BLOCK rejectedEmpty
//   2. 自己发的          -> BLOCK rejectedSelf
//   3. 不是 owner        -> BLOCK rejectedNotOwner     ← 也顺手堵死了"谁都能敲 !stop"
//   4. 公屏且无唤醒称谓  -> BLOCK rejectedNoWakeName   ← 用户的"限定称谓"需求
//   5. 限流中            -> BLOCK rejectedRateLimited
//   6. 超出当日预算      -> BLOCK rejectedBudget
//   7. 命中固定意图规则  -> PASS 走规则，直接发引擎命令，**不调大模型**
//   8. 其它              -> PASS 走大模型
//
// 配置来自环境变量 MCBOT_GATE（JSON），由启动器为每个 bot 进程单独设置。
// owners 为空 = 拒绝一切（fail closed），这是安全默认值。
// ============================================================================

import { createRequire } from 'node:module';
import { applyEnginePatches } from './engine-patches.mjs';
import { createEventLog } from './event-log.mjs';
import { parseCollectIntent, resolveBlock, BLOCK_WORDS } from './vocab.mjs';
import { matchRule as matchRuleIn } from './rulematch.mjs';
import { hutPlan, HUT_PRESETS, checkMaterials, findBuildSite, countInInventory, describePlan, runBuild, countMaterials } from './builder.mjs';
import { parseExploreIntent, pickTarget, exploreTo, scanAround, describeTrip } from './explorer.mjs';
import { Memory, memoryFileFor, parseRememberIntent, parseRecallIntent, extractFacts, digest } from './memory.mjs';
import { translateEngineReply } from './engine-speak.mjs';
import { formatStats, formatInventory, biomeCn, LOCAL_REPORTS } from './self-report.mjs';
import {
    parseCraftIntent, craftLabel, planFor, runPlan, canCraft, describeNeeds,
    poolFrom, have, bestTool, resolvePlanks, PICKAXE_FOR, TOOL_TIERS, BLOCK_TOOL,
} from './workshop.mjs';

const AGENT_URL = new URL('../vendor/mindcraft-develop/src/agent/agent.js', import.meta.url).href;
const COMMANDS_URL = new URL('../vendor/mindcraft-develop/src/agent/commands/index.js', import.meta.url).href;
const SKILLS_URL = new URL('../vendor/mindcraft-develop/src/agent/library/skills.js', import.meta.url).href;

/** 探险时往四周扫多大范围（水平半径 × 垂直半径）。16×6 → 约 14k 次方块查询，几十毫秒。 */
const SCAN_R = 16;
const SCAN_DY = 6;
/** 单程探险超时。野外地形复杂，走 48 格花一两分钟是正常的。 */
const EXPLORE_TIMEOUT_MS = 150000;
/** 超过这个距离就不硬往回走了 —— 与其花十分钟走回来，不如让玩家来接。 */
const RETURN_MAX = 120;
const RETURN_TIMEOUT_MS = 150000;

/**
 * 哪些方块**必须**有镐子才挖得动（Minecraft 规则，不是我们的限制）。
 * 木头/泥土/沙子用手就能采，只是慢；石头和矿物是硬门槛。
 */
function needsPickaxe(block) {
    const b = String(block || '');
    return b.includes('_ore') || b === 'stone' || b === 'cobblestone'
        || b === 'deepslate' || b === 'obsidian' || b === 'ancient_debris';
}

/** 把引擎的方块 id 换回中文说法，用在给玩家看的话里。 */
function blockLabelOf(block) {
    const hit = BLOCK_WORDS.find((w) => w.block === block);
    return hit ? hit.label : block;
}

/** 能拿来盖房的方块，按优先级排 —— 优先用木板，其次圆石、泥土、石头。
 *  原木**故意不在这个表里**：木板比原木适合盖房，而且 1 原木 = 4 木板，
 *  同样一把木头能盖四倍大的房子。手里只有原木时走"自己合成木板"那条路。 */
const BUILDABLE = [
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks',
    'cobblestone', 'stone', 'dirt',
];

const LOG_TO_PLANKS = [
    ['oak_log', 'oak_planks'], ['spruce_log', 'spruce_planks'], ['birch_log', 'birch_planks'],
    ['jungle_log', 'jungle_planks'], ['acacia_log', 'acacia_planks'], ['dark_oak_log', 'dark_oak_planks'],
];

/** 背包里最合适的建材。手里一件建材都没有但有原木时，返回该原木对应的木板
 *  （让 checkMaterials 走自动合成那条路，而不是直接说"材料不够"）。 */
function pickBuildMaterial(bot, preferred) {
    const counts = new Map();
    for (const it of bot?.inventory?.items?.() ?? []) {
        counts.set(it.name, (counts.get(it.name) ?? 0) + it.count);
    }
    if (preferred && (counts.get(preferred) ?? 0) > 0) return preferred;
    for (const b of BUILDABLE) if ((counts.get(b) ?? 0) > 0) return b;
    let best = null;
    let bestN = 0;
    for (const [log, planks] of LOG_TO_PLANKS) {
        const n = counts.get(log) ?? 0;
        if (n > bestN) { bestN = n; best = planks; }
    }
    return best || preferred || 'oak_planks';
}

/** 这个方块适不适合当建材（"用它盖个石头房子"要说得出道理）。 */
function isBuildable(block) {
    return BUILDABLE.includes(block);
}

// 硬化补丁先于一切生效：它们修的是"连不上服务器"这类致命问题，
// 与聊天门开不开无关，所以放在 MCBOT_GATE 判断之前。
applyEnginePatches();

const rawConfig = process.env.MCBOT_GATE;
if (!rawConfig) {
    // 没配置就不装门，让引擎保持原生行为（便于对照实验）。
    // 注意：NODE_OPTIONS=--import 会被所有后代进程继承，所以启动器自己
    // （engine-launcher.mjs）也会走到这里 —— 它本来就只负责起进程、不该装门，
    // 所以这行是正常的，不是故障。真正的门口令由启动器写进子进程的 env。
    console.log('[MCBOT-GATE] 本进程没配 MCBOT_GATE，按原生引擎运行（启动器进程属正常）');
} else {
    let config;
    try {
        config = JSON.parse(rawConfig);
    } catch (err) {
        console.error('[MCBOT-GATE] FATAL: MCBOT_GATE is not valid JSON:', err.message);
        process.exit(1);
    }

    const botId = config.botId || 'unknown';
    const eventsFile = process.env.MCBOT_EVENTS_FILE || config.eventsFile || '';
    const log = eventsFile ? createEventLog({ botId, file: eventsFile, echo: false }) : { emit: () => {} };
    const emit = log.emit;

    const wakeNames = (config.wakeNames || []).filter((w) => typeof w === 'string' && w.length > 0);
    const owners = (config.owners || []).filter((o) => typeof o === 'string' && o.length > 0);
    // ★ 主人名单"配没配过"。见 app/electron/store.mjs 的 FACTORY_OWNERS 长注释：
    //   出厂 owners 是 ['Steve']，它**非空**，所以校验和界面警告都不会响，
    //   而用户的真实游戏 ID 几乎不叫 Steve —— 他喊破嗓子也只会得到沉默，
    //   界面上还一片正常。**"什么都不发生"不是 fail-closed 该有的表现**：
    //   fail-closed 的正确表现是"拒绝并说明为什么"，不是"装作没听见"。
    //   所以只有明确知道没配过（启动器传 false）时才提示；字段缺失一律当已配置，
    //   免得在公屏上对陌生人自曝家底。
    const ownersConfigured = config.ownersConfigured === true;
    const nonOwnerHinted = new Set();
    const rateLimitMs = Number.isFinite(config.rateLimitMs) ? config.rateLimitMs : 5000;
    const dailyTokenBudget = Number.isFinite(config.dailyTokenBudget) ? config.dailyTokenBudget : 0;
    const rules = Array.isArray(config.rules) ? config.rules : [];
    /** 目标 MC 版本，由启动器通过 `MCBOT_MC_VERSION` 传进来。 */
    const MC_VERSION = process.env.MCBOT_MC_VERSION || '1.21.1';

    if (owners.length === 0) {
        console.warn('[MCBOT-GATE] WARNING: owners list is empty — every chat message will be ignored (fail closed).');
    }

    // 长期陪伴记忆。它跟引擎自己那份 history.memory 是两回事：那份是"为了省
    // token 压缩上下文"的摘要（500 字符硬上限、每次重写花一次模型调用、我们
    // 启动时 load_memory:false 所以重启归零）；这份由我们自己管，重启不丢。
    const memory = new Memory(memoryFileFor(botId, config.memoryDir || null));
    console.log(`[MCBOT-GATE] 记忆文件 ${memory.file}（已有 ${memory.size} 条）`);

    const lower = (s) => String(s ?? '').toLowerCase();
    const lastReplyAt = new Map();

    const stats = {
        seen: 0,
        rejectedSelf: 0,
        rejectedNotOwner: 0,
        rejectedNoWakeName: 0,
        rejectedRateLimited: 0,
        rejectedEmpty: 0,
        rejectedBudget: 0,
        rulesMatched: 0,
        dispatched: 0,
    };

    // 当日 token 账本。由 vendor 里的 mcbot.js provider 通过
    // globalThis.__MCBOT_ON_LLM__ 回调进来（两者在同一个 agent 子进程里）。
    const budget = { day: new Date().toDateString(), used: 0 };
    globalThis.__MCBOT_ON_LLM__ = (usage) => {
        const today = new Date().toDateString();
        if (today !== budget.day) { budget.day = today; budget.used = 0; }
        if (usage && Number.isFinite(usage.totalTokens)) budget.used += usage.totalTokens;
    };
    const overBudget = () => dailyTokenBudget > 0 && budget.used >= dailyTokenBudget;

    function hasWakeName(message) {
        const text = lower(message);
        return wakeNames.some((w) => text.includes(lower(w)));
    }

    function escapeRegExp(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function stripWakeName(message) {
        let out = String(message ?? '');
        for (const w of wakeNames) {
            out = out.replace(new RegExp(escapeRegExp(w), 'gi'), ' ');
        }
        return out.replace(/\s+/g, ' ').trim();
    }

    function reject(reason, username, message, extra = {}) {
        stats[reason] = (stats[reason] || 0) + 1;
        emit('gate', { decision: 'BLOCK', reason, from: username, msg: message, ...extra });
        console.log(`[MCBOT-GATE] BLOCK reason=${reason} from=${username} msg=${JSON.stringify(message)}`);
    }

    // ── 还没认领时的兜底提示 ────────────────────────────────────────────────
    //
    // 场景：用户装好应用、双击启动、进服务器喊「小豆 你好」—— 而配置里主人名单
    // 还是出厂的 ['Steve']。门禁会**一句话都不回**，界面也没有任何异常。
    // 用户唯一能得出的结论是"这软件坏了"。这个函数就是为这个场景写的。
    //
    // 三条约束，缺一条都会变成新的麻烦：
    //   1. **只在明确知道名单没配过时才说**（ownersConfigured === false）。
    //      配过了还回话，等于在公屏上告诉陌生人"来改我配置"。
    //   2. **每个玩家每个会话只回一次**。否则一句「小豆」刷屏换一句提示刷屏。
    //   3. **只在对方确实是在跟它说话时才回** —— 私聊永远算；公屏必须带唤醒称谓，
    //      否则站在一堆人里，每个路过的人说句话它都要插一嘴。
    const NON_OWNER_HINT =
        '我还没被认领呢。打开应用，在「机器人」页把「主人」改成你的游戏 ID，我才听得见你说话。';

    function maybeHintNotOwner(agent, username, message, channel) {
        if (ownersConfigured) return;
        if (channel === 'chat' && !hasWakeName(message)) return;
        const key = lower(username);
        if (nonOwnerHinted.has(key)) return;
        nonOwnerHinted.add(key);
        stats.ownerHints = (stats.ownerHints || 0) + 1;
        try {
            makeSayer(agent, username)(NON_OWNER_HINT);
        } catch (err) {
            console.error('[MCBOT-GATE] 提示非主人失败:', err?.message || err);
        }
        emit('log', { level: 'info', line: `「${username}」不在主人名单里，已提示他去应用里设 ID` });
    }

    /**
     * 固定意图规则：中文字符串匹配 -> 直接发引擎命令。
     * 这条路**完全不经过大模型**，是"常见指令零延迟零成本"的实现方式。
     * 返回 null 表示没有规则命中。
     *
     * 匹配逻辑本身在 `runner/rulematch.mjs` —— 单独拿出来是为了能测
     * （它判错一次，要么白花钱、要么做错事）。
     */
    function matchRule(text) {
        return matchRuleIn(rules, text);
    }

    /** 把规则翻译成引擎命令。username 是发话人（followPlayer/goToPlayer 要用），text 是去掉称谓后的话。 */
    function ruleToCommand(rule, username, text) {
        switch (rule.action) {
            case 'followPlayer': return `!followPlayer("${username}", 3)`;
            case 'goToPlayer':   return `!goToPlayer("${username}", 1)`;
            case 'stop':         return '!stop';
            // ★ 这两个**故意不走引擎命令**：引擎的 `!inventory`/`!stats` 是
            //   给模型看的内部转储（`!stats` 有 15 行，实测在聊天框里被拆成两条）。
            //   我们自己读 bot 上的数据、说一句中文 —— 见 runner/self-report.mjs。
            case 'inventory':    return '<本地汇报>';
            case 'stats':        return '<本地汇报>';

            // ── 采集原料（用户 m00001 明确要的"帮忙搜集原材料"）──
            // 参数从话里现认：认不出就返回 null，让它退回大模型，而不是瞎挖一气。
            case 'collectBlocks': {
                const intent = parseCollectIntent(text);
                if (intent) {
                    rule._resolved = `${intent.label}×${intent.count}`;
                    return `!collectBlocks("${intent.block}", ${intent.count})`;
                }
                if (rule.block) {   // 规则自己钉死了采什么（用户可以在配置里覆盖）
                    const n = rule.count || 10;
                    rule._resolved = `${rule.block}×${n}（规则固定）`;
                    return `!collectBlocks("${rule.block}", ${n})`;
                }
                return null;        // ★ 退回大模型
            }

            // ── 找某种方块（探险时"附近有没有铁矿"）──
            case 'searchForBlock': {
                const hit = resolveBlock(text);
                if (!hit) return null;      // ★ 退回大模型
                const range = Math.min(Math.max(Number(rule.range) || 64, 32), 512);
                rule._resolved = `${hit.label}（${range} 格内）`;
                return `!searchForBlock("${hit.block}", ${range})`;
            }

            // ── 四处走走。诚实说：这只是"朝某个方向走 30 格"，
            //    不等于真正的探索（引擎没有"探索"这个原语）。──
            case 'explore': {
                const dist = Math.min(Math.max(Number(rule.distance) || 30, 5), 200);
                rule._resolved = `走开 ${dist} 格`;
                return `!moveAway(${dist})`;
            }

            default: return null;
        }
    }

    let executeCommandFn = null;
    let commandsMod = null;

    /**
     * 执行一条引擎命令，并把回执送回玩家。
     *
     * ★ 为什么不能只 `await executeCommand(...)` 就完事：引擎自己的分支是
     *   `agent.js:285-287` 的 `let execute_res = await executeCommand(this, message);
     *    if (execute_res) this.routeResponse(source, execute_res);`
     *   —— 我们绕过了那条分支，回执就得自己送，否则玩家敲 `!inventory`
     *   只会在日志里看到结果，聊天框里一片安静，像是 bot 卡死了。
     */
    async function runEngineCommand(agent, username, cmd) {
        const r = await executeCommandFn(agent, cmd);
        if (typeof r === 'string' && r.trim()) {
            // 日志里留**原文**（排错要看引擎到底说了什么），玩家看到的是中文转述
            emit('log', { level: 'info', line: `命令回执：${r.replace(/\s+/g, ' ').slice(0, 300)}` });
            const spoken = translateEngineReply(r);
            try {
                if (typeof agent.routeResponse === 'function') agent.routeResponse(username, spoken);
                else agent.openChat?.(spoken);
            } catch (err) {
                console.error('[MCBOT-GATE] 回执发送失败:', err?.message || err);
            }
        }
        return r;
    }

    /**
     * 采集前的"手里有没有家伙"预检。
     *
     * 为什么值得单独做：引擎在没工具时会说
     *   `Don't have right tools to harvest stone.`
     * —— 一句英文、没有解释、也不告诉玩家该怎么办。陪伴型 bot 不该这样回话。
     * 木头/泥土/沙子用手就能采，**只有镐类方块是硬门槛**（这是 Minecraft 的规则，
     * 不是我们的限制），所以这里只拦镐。
     *
     * @returns {string|null} null = 可以采；否则是给玩家看的中文说明
     */
    function preflightCollect(agent, block) {
        if (!needsPickaxe(block)) return null;
        const items = agent?.bot?.inventory?.items?.() ?? [];
        if (items.some((it) => String(it?.name || '').endsWith('_pickaxe'))) return null;
        return `我手里没有镐子，${blockLabelOf(block)}挖不动呀。你先给我做一把木镐（三个木板加两根木棍），我马上就去。`;
    }

    /**
     * "帮忙建房子"。引擎没有任何建造命令（`!placeHere` 官方描述就写着
     * "Do NOT use to build structures"），蓝图系统又只能靠 `!newAction` 驱动，
     * 而那是我们的安全红线。所以这一整段流程长在我们这层：
     *   选尺寸 → 选材料 → 材料够不够（不够就自己合成木板 / 说中文要） →
     *   找一块平地 → 逐块放 → 中途可以被打断。
     */
    /**
     * 用中文回一句话给玩家。抽出来是因为建造和探险都要用 —— 上一版它长在
     * runBuildTask 里面，探险一调就是 `ReferenceError: say is not defined`
     * （**这个错误是运行时才炸的，`node --check` 完全看不见**）。
     */
    function makeSayer(agent, username) {
        return (msg) => {
            try {
                if (typeof agent.routeResponse === 'function') agent.routeResponse(username, msg);
                else agent.openChat?.(msg);
            } catch { /* 回话失败不影响干活 */ }
        };
    }

    // ── 汇报自己的状态 / 背包 ───────────────────────────────────────────────
    //
    // 引擎有 `!stats` 和 `!inventory`，但它们的输出是**给模型看的内部转储**：
    // `!stats` 吐 15 行（含一长串 Agent Modes），实测在聊天框里被拆成两条消息。
    // 一个陪伴型 bot 报个坐标不该刷屏 —— 所以这两个动作我们自己组织中文，
    // 从 `bot` 上直接读数据。格式化在 `runner/self-report.mjs`（可单测）。

    /** "小豆 报一下坐标" / "小豆 看一下背包" */
    async function runSelfReportTask(agent, username, action) {
        const say = makeSayer(agent, username);
        const bot = agent?.bot;

        if (action === 'inventory') {
            say(formatInventory(bot));
            emit('log', { level: 'info', line: `汇报背包：${formatInventory(bot)}` });
            return;
        }

        // stats：能拿到的都拿到，拿不到的不编
        let biome = null;
        let players = [];
        try {
            const world = await loadWorld();
            biome = world.getBiomeName(bot) || null;
            players = (world.getNearbyPlayerNames(bot) || []).filter(Boolean);
        } catch { /* 读不到就不说，绝不补一个"大概"的值 */ }

        let actionLabel = null;
        try {
            if (typeof agent.isIdle === 'function' && !agent.isIdle()) {
                actionLabel = agent.actions?.currentActionLabel || null;
            }
        } catch { /* 同上 */ }

        say(formatStats(bot, { biome: biome ? biomeCn(biome) : null, action: actionLabel, players }));
    }

    // ── 长期陪伴记忆 ────────────────────────────────────────────────────────
    //
    // 这一段是"陪伴"与"工具"的分界线：一个记不住上次一起干过什么的 bot，
    // 无论指令执行得多准，都不是陪伴。而且它**不花 token** ——
    // "记住…"和"你还记得…吗"都走规则通路，直接读写 JSON。

    /** "小豆 记住我喜欢钻石" */
    async function runRememberTask(agent, username, text) {
        const say = makeSayer(agent, username);
        const parsed = parseRememberIntent(text);
        if (!parsed) {
            // 话头对上了但没说要记什么（"记住了吗"）—— 退回大模型，别乱猜。
            emit('gate', { decision: 'FALLBACK', reason: 'ruleUnresolved', rule: 'remember', from: username, msg: text });
            return false;
        }
        const r = memory.remember({ text: parsed.text, kind: 'fact', from: username, tags: undefined });
        emit('log', {
            level: 'info',
            line: r.dup ? `记住了（更新）：${parsed.text}` : `记住了：${parsed.text}（共 ${memory.size} 条）`,
        });
        say(r.dup ? `好，我记下了：${parsed.text}` : `记住了：${parsed.text}`);
        return true;
    }

    /** "小豆 你还记得我家在哪吗" */
    async function runRecallTask(agent, username, text) {
        const say = makeSayer(agent, username);
        const parsed = parseRecallIntent(text);
        const entries = memory.recall(parsed?.query || '', 5);

        if (entries.length === 0) {
            emit('log', { level: 'info', line: `被问记忆，但我还没记住什么（query=${parsed?.query || ''}）` });
            say(parsed?.query
                ? '这个我还没记住呢 —— 你跟我说一句「记住……」，我就记下了。'
                : '我还没记住什么呢。你跟我说「记住……」，我就记下了。');
            return true;
        }

        const lines = entries.map((e) => e.text).join('；');
        emit('log', { level: 'info', line: `被问记忆，答了 ${entries.length} 条：${lines}` });
        say(parsed?.query ? `我记得：${lines}` : `我记得这些：${lines}`);
        return true;
    }

    /**
     * 走大模型之前，把**跟这句话相关**的记忆塞进上下文。
     * 只塞相关的，不无脑全塞 —— 那是钱。没有相关的就一条都不加。
     */
    async function injectMemory(agent, username, text) {
        try {
            const hits = memory.recall(text, 4);
            if (hits.length > 0 && agent?.history?.add) {
                await agent.history.add('system', `【你记得的事】\n${digest(hits, 260)}`);
                emit('log', { level: 'info', line: `想起 ${hits.length} 件相关的事` });
            }
            // 顺手把闲聊里的长期信息记下来（只认很明确的措辞，见 memory.mjs）
            for (const f of extractFacts(username, text)) {
                const r = memory.remember(f);
                if (r.ok && !r.dup) emit('log', { level: 'info', line: `顺手记住：${f.text}` });
            }
        } catch (err) {
            // 记忆出问题绝不能挡住正常对话
            console.error('[MCBOT-GATE] 记忆注入失败：', err?.message || err);
        }
    }

    /** 一起干过的事也值得记 —— 建好的房子在哪、去过哪。零 token。 */
    function recordEvent(text) {
        try {
            const r = memory.remember({ text, kind: 'event' });
            if (r.ok && !r.dup) emit('log', { level: 'info', line: `记一笔：${text}` });
        } catch { /* 记忆失败不影响干活 */ }
    }

    async function runBuildTask(agent, username, text) {
        const say = makeSayer(agent, username);

        const presetKey = /大一点|大点|大一些|大些|大屋|大房子|宽敞/.test(text) ? 'big' : 'small';
        const preset = HUT_PRESETS[presetKey];

        // 建材：用户点名了就听他的（"用石头盖"），否则挑背包里现有的
        const asked = parseCollectIntent(text);
        let material = pickBuildMaterial(agent.bot, asked?.block && isBuildable(asked.block) ? asked.block : null);

        const buildPlan = (block) => hutPlan({ ...preset, block });
        let plan = buildPlan(material);
        let check = checkMaterials(agent.bot, plan);

        // 木板不够但手里有原木 —— 自己合成，不麻烦玩家。
        //
        // ★ 必须**循环**，不能只合一次。理由在引擎里：
        //   `skills.js:103` 是 `bot.craft(recipe, Math.min(craftLimit.num, num), craftingTable)`
        //   —— 原木不够时它会**少合几次就返回**（`craftLimit.num` 是当前材料能支撑的次数），
        //   于是"差多少合多少"的一次性算法经常补不齐；补不齐就往下走，
        //   玩家只会看到一句莫名其妙的"材料不足"。
        //   实测现场：`自动合成 oak_planks ×5 次 → 现有 20 块`（要 23 块）→ 然后空话术。
        let craftRounds = 0;
        while (!check.ok && check.canCraft && craftRounds < 8) {
            craftRounds++;
            const fromLog = check.craftFrom;                       // 例如 oak_log
            const planks = fromLog.replace(/_log$/, '_planks');    // -> oak_planks
            const times = check.craftTimes;                        // ★ 先存下来，下面 check 会被重新赋值
            if (craftRounds === 1) say(`木板不太够，我先拿${blockLabelOf(fromLog)}合一点。`);
            try {
                const skills = await loadSkills();
                const before = countInInventory(agent.bot, [planks]);
                await skills.craftRecipe(agent.bot, planks, times);
                // 等背包同步：`bot.craft()` 返回时合成窗口的更新包不一定已经并进背包，
                // 立刻读会读到旧数字（实测就是这里多绕了一圈）。
                await new Promise((r) => setTimeout(r, 600));
                material = planks;
                plan = buildPlan(material);
                check = checkMaterials(agent.bot, plan);
                emit('log', { level: 'info', line: `自动合成 ${planks} ×${times} 次（${before} → ${countInInventory(agent.bot, [planks])} 块）` });
            } catch (err) {
                console.error('[MCBOT-GATE] 自动合成木板失败：', err?.message || err);
                emit('log', { level: 'warn', line: `自动合成木板失败：${err?.message || err}` });
                break;
            }
        }
        if (craftRounds >= 8) {
            emit('log', { level: 'warn', line: `自动合成 ${craftRounds} 轮仍不够，停下来看看背包` });
        }

        if (!check.ok) {
            // 兜底：任何情况下都不能给玩家一句空话
            const msg = check.message || `材料还是不够，我手里只有 ${countInInventory(agent.bot, [material])} 块${blockLabelOf(material)}。`;
            emit('log', { level: 'warn', line: `盖房材料不足：${msg}` });
            say(msg);
            return;
        }

        // 选址：在玩家旁边空出两格的地方盖，门朝南。
        // fromY 取"玩家和 bot 里更低的那个 +2"—— 玩家刚从天上掉下来时 base.y 会虚高几十格，
        // 拿它当起点会一路扫到空气里；而 bot 自己一定站在实地上。
        const p = agent.bot?.players?.[username]?.entity;
        const base = p?.position ?? agent.bot?.entity?.position;
        if (!base) { say('我现在看不清你在哪，等我站稳了再盖。'); return; }
        const botY = agent.bot?.entity?.position?.y;
        const fromY = Math.min(Math.floor(base.y) + 2, Math.floor(botY ?? base.y) + 2);
        const site = findBuildSite(agent.bot, base.x, base.z, fromY, preset.w, preset.d, preset.h);
        if (!site) {
            say(`我在你旁边（${Math.floor(base.x)}, ${Math.floor(base.z)}）没找到一块四角一样平的场地，你带我找块平整的草地吧。`);
            emit('log', { level: 'warn', line: `找不到建造场地：玩家 (${Math.floor(base.x)},${Math.floor(base.y)},${Math.floor(base.z)}) bot y=${Math.floor(botY ?? base.y)}` });
            return;
        }
        const origin = { x: site.x, z: site.z };
        const groundY = site.y;

        const desc = describePlan(plan, preset.label);
        emit('log', { level: 'info', line: `开始盖房：${desc} @ ${origin.x},${groundY},${origin.z}` });
        say(`好嘞，给你盖个${desc}。我这就动手，你看着点。`);

        agent.bot.interrupt_code = false;
        let lastReport = 0;
        const skills = await loadSkills();
        const res = await runBuild(
            agent, plan, { x: origin.x, y: groundY, z: origin.z },
            (done, total) => {
                if (done - lastReport >= 5) {
                    lastReport = done;
                    emit('log', { level: 'info', line: `盖房中 ${done}/${total}` });
                }
            },
            skills,
        );

        const done = `盖好了 ${res.placed}/${res.total} 块`
            + (res.interrupted ? '，你让我停下，我就先停了。' : res.failed ? `，有 ${res.failed} 块没放上去。` : '，你看看行不行？');
        const level = res.placed === res.total ? 'info' : 'warn';
        emit('log', { level, line: `盖房结束：${done}${res.lastError ? ' —— 第一处失败：' + res.lastError : ''}` });
        say(done);

        // 一起干过的事值得记：下次问"我们上次盖的房子在哪"要答得上来。
        if (res.placed > 0) {
            const o = origin;
            recordEvent(`${new Date().toLocaleDateString('zh-CN')} 和 ${username} 在 (${Math.floor(o.x)}, ${Math.floor(o.y)}, ${Math.floor(o.z)}) 盖了一栋${preset.label}，放了 ${res.placed} 块`);
        }
    }

    let skillsMod = null;
    async function loadSkills() {
        if (!skillsMod) skillsMod = await import(SKILLS_URL);
        return skillsMod;
    }

    // ── 工坊：做工具 ────────────────────────────────────────────────────────    //
    // 引擎的 `!craftRecipe` 只会做**一步**。玩家说"挖点石头"而 bot 手里没镐子时，
    // 正确的回应不是"我没有镐子"，而是"我先砍两根木头……好了，现在去挖"。
    // 这一整段流程长在我们这层（配方算账见 `runner\workshop.mjs`）。

    /**
     * 直接敲命令时，哪些我们**抢在引擎前面**自己用中文回答。
     * 表本身在 `runner/self-report.mjs` 里（`LOCAL_REPORTS`），因为
     * `tools/check-speak-coverage.mjs` 也要拿同一份做边界核对 —— 不许抄第二份。
     */

    const WORLD_URL = new URL('../vendor/mindcraft-develop/src/agent/library/world.js', import.meta.url).href;
    let worldMod = null;
    /** 引擎的世界查询库（拿生物群系名、附近的玩家名）。 */
    async function loadWorld() {
        if (!worldMod) worldMod = await import(WORLD_URL);
        return worldMod;
    }

    let mcdataMod = null;
    /** 引擎那份 minecraft-data（1.21.1），用来查方块 id。 */
    async function loadMcData() {
        if (!mcdataMod) {
            const require = createRequire(new URL('../vendor/mindcraft-develop/package.json', import.meta.url));
            mcdataMod = require('minecraft-data')(MC_VERSION) || require('minecraft-data')('1.21.1');
        }
        return mcdataMod;
    }

    /**
     * 旁边 16 格内有没有工作台。
     * 有的话做工具就省掉 4 块木板 —— 引擎的 `craftRecipe` 自己也会找附近的台子
     * （`skills.js:61`），我们只是把这个事实提前算进账里，好把材料需求说准。
     */
    async function hasNearbyTable(agent) {
        try {
            const mc = await loadMcData();
            const id = mc?.blocksByName?.crafting_table?.id;
            if (id == null) return false;
            return !!agent?.bot?.findBlock?.({ matching: id, maxDistance: 16 });
        } catch { return false; }
    }

    /** 把合成交给引擎（它会自己找 / 放 / 收起工作台，见 skills.js:45-108）。 */
    async function craftOne(agent, itemName, times) {
        const skills = await loadSkills();
        return skills.craftRecipe(agent.bot, itemName, times);
    }

    /**
     * 把烧炼交给引擎的**库函数**。
     *
     * 🔴 绝对不要改用 `!smeltItem` 命令：`commands\actions.js:284-291` 在烧成功之后
     *   500ms 会 `agent.cleanKill('Safely restarting to update inventory.')` **自杀重启**。
     *   玩家每要一块铁锭，面板上就多一条"意外退出"，supervisor 还得退避重连。
     *   库函数（`skills.js:142`）做完就正常返回，没有这回事。
     */
    async function smeltOne(agent, rawItem, times) {
        const skills = await loadSkills();
        return skills.smeltItem(agent.bot, rawItem, times);
    }

    /** 附近 16 格内、或者背包里有没有熔炉（`smeltItem` 两处都会找）。 */
    async function hasNearbyFurnace(agent) {
        try {
            if (have(agent.bot, 'furnace') > 0) return true;
            const mc = await loadMcData();
            const id = mc?.blocksByName?.furnace?.id;
            if (id == null) return false;
            return !!agent?.bot?.findBlock?.({ matching: id, maxDistance: 16 });
        } catch { return false; }
    }

    /** 把工具拿在手上，否则挖矿仍然失败。 */
    async function equipTool(agent, itemName) {
        try {
            const skills = await loadSkills();
            await skills.equip(agent.bot, itemName);
            return true;
        } catch (err) {
            emit('log', { level: 'warn', line: `装备 ${itemName} 失败：${err?.message || err}` });
            return false;
        }
    }

    /** 工具在升级链里排第几（木 0 / 石 1 / 铁 2 / 钻石 3）。 */
    function tierRank(item) {
        for (const tier of Object.values(TOOL_TIERS)) {
            const i = tier.indexOf(item);
            if (i >= 0) return i;
        }
        return -1;
    }

    /**
     * 缺什么就去弄什么 —— **能自己动手的绝不开口要**。
     *
     * 这是"陪伴"和"工具人"的分界线：不是回一句"你去给我砍点木头"，
     * 而是自己把整条链走完 —— 砍树 → 削木板 → 做木镐 → 挖石头 → 做石镐
     * → 挖铁矿和煤 → 做熔炉 → 烧铁锭 → 打铁镐。
     */
    const MINE_FOR = {
        _log: 'oak_log',
        cobblestone: 'stone',
        coal: 'coal_ore',
        raw_iron: 'iron_ore',
        raw_copper: 'copper_ore',
        raw_gold: 'gold_ore',
    };

    async function mineBlock(agent, block, want, { onProgress = () => {} } = {}) {
        onProgress(`去挖 ${want} 个${blockLabelOf(block)}`);
        try {
            if (!executeCommandFn) executeCommandFn = (await import(COMMANDS_URL)).executeCommand;
            await executeCommandFn(agent, `!collectBlocks("${block}", ${want})`);
            return true;   // 挖到没挖到不用猜 —— 下一步会重新数背包
        } catch (err) {
            emit('log', { level: 'warn', line: `挖${blockLabelOf(block)}失败：${err?.message || err}` });
            return false;
        }
    }

    /** 把 `missing` 里能自己弄到的都弄回来。返回"有没有真的动过手"。 */
    async function fetchMissing(agent, missing, { say = () => {}, onProgress = () => {}, depth = 0 } = {}) {
        if (depth > 2) return false;                       // 别再往下套了
        let did = false;
        for (const [raw, want] of Object.entries(missing || {})) {
            const block = MINE_FOR[raw];
            if (!block || !want) continue;
            const guard = await ensurePickaxe(agent, block, { say, onProgress, depth: depth + 1 });
            if (!guard.ok) { onProgress(`挖${blockLabelOf(block)}的家伙也没有：${guard.message}`); continue; }
            if (await mineBlock(agent, block, want, { onProgress })) did = true;
        }
        return did;
    }

    /**
     * 做一件工具。**只做一件**，缺料就自己去弄；实在弄不到再如实说缺什么。
     * @returns {{ok:boolean, already?:boolean, missing?:object, message?:string}}
     */
    async function craftTool(agent, item, { say = () => {}, onProgress = () => {}, depth = 0 } = {}) {
        const bot = agent.bot;
        if (bot?.interrupt_code) return { ok: false, message: '好，我停下了。' };

        const build = async () => {
            const pk = resolvePlanks(bot);
            const plan = planFor(item, 1, {
                inv: poolFrom(bot),
                hasTable: await hasNearbyTable(agent),
                hasFurnace: await hasNearbyFurnace(agent),
                planksName: pk.planks,
            });
            return { plan, pk };
        };

        let { plan } = await build();
        if (!plan.ok) return { ok: false, message: plan.message || `我还不会做${craftLabel(item)}。` };
        if (plan.alreadyHave) return { ok: true, already: true, message: `我手里已经有${craftLabel(item)}了。` };

        // 缺料 → 自己能弄到就先动手，弄完重新算一遍账
        if (Object.keys(plan.missing).length > 0) {
            const did = await fetchMissing(agent, plan.missing, { say, onProgress, depth });
            if (did) ({ plan } = await build());
            if (!plan.ok || plan.alreadyHave) return { ok: !plan.ok ? false : true, already: plan.alreadyHave, message: plan.message || '' };
            if (Object.keys(plan.missing).length > 0) {
                return { ok: false, missing: plan.missing, message: null };   // 交给调用方组织话术
            }
        }

        onProgress(`开工做${craftLabel(item)}`);
        const res = await runPlan(agent, plan.plan, {
            craftOne: (name, times) => craftOne(agent, name, times),
            smeltOne: (raw, times) => smeltOne(agent, raw, times),
            onProgress,
        });
        if (!res.ok) {
            return { ok: false, message: res.message || `${craftLabel(item)}没做成。`, interrupted: res.interrupted };
        }
        const okNow = have(bot, item) > 0;
        return {
            ok: okNow,
            message: okNow ? '' : `${craftLabel(item)}合成完了，但背包里没数到 —— 可能被服务端吞了。`,
        };
    }

    /**
     * 保证手上有挖 `block` 所需的镐子，**没有就现场造一把**。
     *
     * 三级链：挖铁矿要石镐 → 石镐要 3 块圆石 → 木镐要 3 根木头。
     * 这是真正的"陪伴"：不是告诉玩家"你去给我做把镐"，而是自己想办法。
     */
    async function ensurePickaxe(agent, block, { say = () => {}, onProgress = () => {}, depth = 0 } = {}) {
        const need = PICKAXE_FOR[block];
        // 不需要镐子的方块（木头、泥土、沙子……）：空手也能采，直接放行
        if (!need) return { ok: true, tool: null };
        if (depth > 2) return { ok: false, message: '这条链太长了，我先歇会儿。' };

        const mine = bestTool(agent.bot, 'pickaxe');
        if (mine && tierRank(mine) >= tierRank(need)) return { ok: true, tool: mine };

        if (!canCraft(need)) {
            return {
                ok: false,
                message: `挖${blockLabelOf(block)}得有把${craftLabel(need)}，这个我暂时做不出来。`,
            };
        }

        const r = await craftTool(agent, need, { say, onProgress, depth });
        if (!r.ok) {
            const need2 = r.missing ? describeNeeds(r.missing) : '';
            return {
                ok: false,
                message: need2
                    ? `挖${blockLabelOf(block)}得有把${craftLabel(need)}，做它要 ${need2}，我手上还没有。你先给我，或者让我先去砍点木头。`
                    : (r.message || `我没能把${craftLabel(need)}做出来。`),
            };
        }
        await equipTool(agent, need);
        return { ok: true, tool: need, freshly: !r.already };
    }

    /**
     * "做把木镐" / "做个工作台"。
     * @returns {boolean} true = 已经处理并回过话；false = 没认出来，让调用方落下去走大模型
     */
    async function runCraftTask(agent, username, text) {
        const want = parseCraftIntent(text);
        if (!want) return false;
        const say = makeSayer(agent, username);

        if (want.item === 'planks') {
            say('木板要拿原木现削，你说"砍点木头"我就去。');
            return true;
        }
        if (!canCraft(want.item)) {
            say(`这个我暂时做不出来 —— 得先有铁锭和熔炉。`);
            return true;
        }
        if (have(agent.bot, want.item) > 0 && want.count <= have(agent.bot, want.item)) {
            say(`我手里已经有${craftLabel(want.item)}了，先用着吧。`);
            return true;
        }

        emit('log', { level: 'info', line: `开始做 ${craftLabel(want.item)} ×${want.count}` });
        let made = 0;
        for (let i = 0; i < want.count; i++) {
            const r = await craftTool(agent, want.item, {
                say,
                onProgress: (line) => emit('log', { level: 'info', line }),
            });
            if (!r.ok) {
                // craftTool 已经自己尽力去弄过料了，还差就是真的弄不到
                const lack = r.missing ? describeNeeds(r.missing) : '';
                say(lack
                    ? `我尽力了 —— 做${craftLabel(want.item)}还差 ${lack}，附近我没找到。你方便的话给我带点，我马上接着做。`
                    : (r.message || `${craftLabel(want.item)}没做成。`));
                return true;
            }
            if (r.already) break;
            made++;
        }
        if (made > 0) {
            await equipTool(agent, want.item);
            say(`${craftLabel(want.item)}做好了${made > 1 ? ` ×${made}` : ''}，给你。`);
        }
        return true;
    }

    let pfMod = null;
    /**
     * mineflayer-pathfinder。它不是一个 ES 模块（CJS），而且装在引擎自己的
     * node_modules 里，所以要从引擎的 package.json 出发 require —— 和 mcdata.js
     * 拿 minecraft-data 是同一条路子。
     */
    async function loadPathfinder() {
        if (!pfMod) {
            const req = createRequire(new URL('../vendor/mindcraft-develop/package.json', import.meta.url));
            pfMod = req('mineflayer-pathfinder');
        }
        return pfMod;
    }

    /**
     * "四处走走 / 往东走 60 格" —— 出去转一圈，回来汇报看见了什么。
     *
     * 和 `!moveAway` 的区别：moveAway 是"朝任意方向走开 N 格"，走完什么都不说。
     * 这里我们会①挑方向（不往水里跳）②记下出发前后的见闻 ③用中文说清楚
     * "走了多远、到了哪、看见了什么"，走不动/超时/被叫停都如实说，不假装成功。
     */
    async function runExploreTask(agent, username, text) {
        const say = makeSayer(agent, username);
        const { distance, heading, label } = parseExploreIntent(text);
        const before = scanAround(agent.bot, SCAN_R, SCAN_DY);
        const target = pickTarget(agent.bot, distance, heading);
        if (target.distance === 0) {
            emit('log', { level: 'warn', line: '探险：四周不是水就是岩浆，没地方好去' });
            say('我四下看了看，不是水就是岩浆，没地方好去。你带我走一段吧。');
            return;
        }
        emit('log', { level: 'info', line: `出发探险：往${target.heading} ${target.distance} 格 → (${target.x}, ${target.z})` });
        // ★ 报"实选中的方向"而不是用户输入的 label —— 没指定方向时 label 是
        //   "随便挑个方向"，说出来就是「我往随便挑个方向走走看」，不像人话。
        say(`好，我往${heading ? label : target.heading}走走看，最多 ${target.distance} 格，回来告诉你看见什么。`);

        agent.bot.interrupt_code = false;
        let lastPos = null;
        let skills, pf;
        try {
            skills = await loadSkills();
            pf = await loadPathfinder();
        } catch (err) {
            emit('log', { level: 'warn', line: `探险：加载寻路库失败 ${err?.message || err}` });
            say('我这边寻路的东西没装上，走不了。');
            return;
        }

        const trip = await exploreTo(agent, target, {
            skills, pf, timeoutMs: EXPLORE_TIMEOUT_MS,
            onProgress: (p) => {
                if (lastPos && Math.hypot(p.x - lastPos.x, p.z - lastPos.z) >= 16) {
                    lastPos = p;
                    emit('log', { level: 'info', line: `探险途中：走到 (${p.x}, ${p.y}, ${p.z})` });
                } else if (!lastPos) lastPos = p;
            },
        });

        const after = scanAround(agent.bot, SCAN_R, SCAN_DY);
        const line = describeTrip({ ...trip, headingLabel: target.heading }, before, after);
        emit('log', { level: trip.ok ? 'info' : 'warn', line: `探险结束：${line}` });
        say(line);

        // 走过的路也值得记 —— "上次你往西走看见了什么"。
        if (trip.ok) {
            const p = after || {};
            const what = (after?.counts && before?.counts)
                ? Object.keys(after.counts).filter((k) => !before.counts[k]).slice(0, 4).join('、')
                : '';
            recordEvent(`${new Date().toLocaleDateString('zh-CN')} 和 ${username} 往${target.heading}走了 ${Math.round(trip.moved)} 格到 (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})${what ? '，看见 ' + what : ''}`);
        }

        // ── 回来说话 ────────────────────────────────────────────────────
        // "陪"字的落点：报告完要回到玩家身边，不能把玩家一个人扔在原地。
        if (!trip.ok && trip.reason === 'interrupted') return;   // 人家叫停的，别自作主张往回跑
        const owner = agent.bot?.players?.[username]?.entity;
        const me = agent.bot?.entity?.position;
        if (!owner || !me) return;
        const back = Math.hypot(owner.position.x - me.x, owner.position.z - me.z);
        if (back < 12 || back > RETURN_MAX) return;              // 就在旁边，或者实在太远（超过这个数就别硬走了）
        emit('log', { level: 'info', line: `探险归来：距离你 ${Math.round(back)} 格，往回走` });
        const home = await exploreTo(agent, { x: Math.floor(owner.position.x), z: Math.floor(owner.position.z), distance: back }, {
            skills, pf, timeoutMs: RETURN_TIMEOUT_MS,
        });
        if (home.ok) {
            emit('log', { level: 'info', line: `已回到你身边（走了 ${home.moved} 格）` });
            say('我回来了。');
        } else {
            emit('log', { level: 'warn', line: `往回走没走到（${home.reason}），我在 (${home.to.x}, ${home.to.y}, ${home.to.z})` });
            say(`我往回走了一半没走通，现在在 (${home.to.x}, ${home.to.y}, ${home.to.z})，你来找我吧。`);
        }
    }

    async function handle(agent, username, message, requireWake) {
        stats.seen++;

        if (!message || String(message).trim() === '') {
            stats.rejectedEmpty++;
            return;
        }
        if (username === agent.name) {
            reject('rejectedSelf', username, message);
            return;
        }
        if (!owners.some((o) => lower(o) === lower(username))) {
            reject('rejectedNotOwner', username, message);
            // 名单还没配过时，别让对方对着一个哑巴 bot 发呆 —— 说清楚怎么办。
            maybeHintNotOwner(agent, username, message, requireWake ? 'chat' : 'whisper');
            return;
        }

        const channel = requireWake ? 'chat' : 'whisper';
        if (requireWake && !hasWakeName(message)) {
            // ★ 这就是"限定称谓"规则：公屏不带称谓 -> 一次模型调用都不发生。
            reject('rejectedNoWakeName', username, message);
            return;
        }

        const cleaned = (stripWakeName(message) || message).trim();

        // ── 主人直接敲引擎命令（"小豆 !inventory"）──
        // 引擎原本对**任何人**都执行 !命令（agent.js 里那个 containsCommand 分支没有 owner 检查）。
        // 我们收紧成"只有主人能敲"，但刻意保留这条通路：它是零 token、零延迟的，
        // 而且 !stop 这类命令必须永远能用 —— 所以它排在限流与预算检查**之前**。
        if (cleaned.startsWith('!')) {
            // ★ 同一个问题，换个问法就得给同一个答案。
            //   玩家说「报一下坐标」我们回中文，但他要是直接敲 `!stats`，
            //   引擎那条路会把 15 行内部转储（含一长串 Agent Modes）刷出来，
            //   实测还会被聊天框拆成两条消息。所以这两个命令**在命令层也接管**，
            //   走和规则通路同一个格式化器（`runner/self-report.mjs`）。
            const localReport = LOCAL_REPORTS[cleaned.split(/[\s(]/)[0]];
            if (localReport) {
                stats.localReports = (stats.localReports || 0) + 1;
                emit('gate', { decision: 'PASS', via: 'command', from: username, msg: cleaned, cmd: `<本地汇报:${localReport}>`, channel });
                console.log(`[MCBOT-GATE] PASS via=direct-command(local) from=${username} cmd=${cleaned}`);
                lastReplyAt.set(username, Date.now());
                try {
                    await runSelfReportTask(agent, username, localReport);
                } catch (err) {
                    console.error('[MCBOT-GATE] local report failed:', err?.message || err);
                    emit('error', { message: `汇报失败（${cleaned}）：${err?.message || err}` });
                }
                return;
            }

            if (!commandsMod) commandsMod = await import(COMMANDS_URL);
            const head = cleaned.split(/[\s(]/)[0];
            if (!commandsMod.commandExists(head)) {
                emit('gate', { decision: 'FALLBACK', reason: 'ruleUnresolved', from: username, msg: cleaned, channel });
                console.log(`[MCBOT-GATE] 不认识的命令 ${head}，退回大模型`);
            } else {
                stats.directCommands = (stats.directCommands || 0) + 1;
                emit('gate', { decision: 'PASS', via: 'command', from: username, msg: cleaned, cmd: cleaned, channel });
                console.log(`[MCBOT-GATE] PASS via=direct-command from=${username} cmd=${cleaned}`);
                lastReplyAt.set(username, Date.now());
                try {
                    if (!executeCommandFn) executeCommandFn = (await import(COMMANDS_URL)).executeCommand;
                    await runEngineCommand(agent, username, cleaned);
                } catch (err) {
                    console.error('[MCBOT-GATE] direct command failed:', err?.message || err);
                    emit('error', { message: `命令执行失败（${cleaned}）：${err?.message || err}` });
                }
                return;
            }
        }

        const now = Date.now();
        const last = lastReplyAt.get(username) ?? 0;
        if (now - last < rateLimitMs) {
            reject('rejectedRateLimited', username, message);
            return;
        }

        if (overBudget()) {
            reject('rejectedBudget', username, message, { used: budget.used, limit: dailyTokenBudget });
            return;
        }

        lastReplyAt.set(username, now);

        // ── 先试固定意图规则 ──────────────────────────────────────────────
        const rule = matchRule(cleaned);
        if (rule) {
            // 盖房子不是一条引擎命令，而是我们这层的一段流程（引擎根本没有建造命令），
            // 所以它单独走一条路，不经过 ruleToCommand。
            if (rule.action === 'buildHouse') {
                stats.rulesMatched++;
                emit('gate', { decision: 'PASS', via: 'rule', rule: rule.id, action: rule.action, from: username, msg: cleaned, cmd: '<本地建造流程>', channel });
                console.log(`[MCBOT-GATE] PASS via=rule rule=${rule.id} action=buildHouse from=${username}`);
                await runBuildTask(agent, username, cleaned);
                return;
            }

            // 汇报自己的状态 / 背包：引擎那两个命令吐的是给模型看的内部转储
            // （`!stats` 15 行，实测被拆成两条聊天消息发出去），我们自己的中文一句话更像个伴。
            if (rule.action === 'stats' || rule.action === 'inventory') {
                stats.rulesMatched++;
                emit('gate', { decision: 'PASS', via: 'rule', rule: rule.id, action: rule.action, from: username, msg: cleaned, cmd: '<本地汇报>', channel });
                console.log(`[MCBOT-GATE] PASS via=rule rule=${rule.id} action=${rule.action} from=${username}`);
                await runSelfReportTask(agent, username, rule.action);
                return;
            }

            // 探险同理：引擎的 !moveAway 只是"朝任意方向走开 N 格"，
            // bot 走完什么都不知道也说不出来 —— 那不是探险。走我们自己的流程。
            if (rule.action === 'explore') {
                stats.rulesMatched++;
                emit('gate', { decision: 'PASS', via: 'rule', rule: rule.id, action: rule.action, from: username, msg: cleaned, cmd: '<本地探险流程>', channel });
                console.log(`[MCBOT-GATE] PASS via=rule rule=${rule.id} action=explore from=${username}`);
                await runExploreTask(agent, username, cleaned);
                return;
            }

            // 做工具：引擎的 `!craftRecipe` 只会做一步，而"做把石镐"要先做木镐、
            // 去挖圆石、再回来 —— 这条链长在我们这层。
            if (rule.action === 'craft') {
                const ok = await runCraftTask(agent, username, cleaned);
                if (ok) {
                    stats.rulesMatched++;
                    emit('gate', { decision: 'PASS', via: 'rule', rule: rule.id, action: rule.action, from: username, msg: cleaned, cmd: '<本地合成流程>', channel });
                    console.log(`[MCBOT-GATE] PASS via=rule rule=${rule.id} action=craft from=${username}`);
                    return;
                }
                // 没认出来就落下去走大模型
            }

            // 记忆这两条也是零 token 的规则通路，而且必须排在 ruleToCommand 之前
            // （它们没有对应的引擎命令）。
            if (rule.action === 'remember' || rule.action === 'recall') {
                const ok = rule.action === 'remember'
                    ? await runRememberTask(agent, username, cleaned)
                    : await runRecallTask(agent, username, cleaned);
                if (ok) {
                    stats.rulesMatched++;
                    emit('gate', { decision: 'PASS', via: 'rule', rule: rule.id, action: rule.action, from: username, msg: cleaned, cmd: '<本地记忆读写>', channel });
                    console.log(`[MCBOT-GATE] PASS via=rule rule=${rule.id} action=${rule.action} from=${username}`);
                    return;
                }
                // 没认出来就落下去走大模型（上面已经发过 FALLBACK 事件了）
            }

            const cmd = ruleToCommand(rule, username, cleaned);
            if (cmd) {
                stats.rulesMatched++;

                // 采集前先看手里有没有家伙。★ 这里**不只是拦下来**：
                // 缺镐子就去造一把（缺木头才如实说缺什么）。玩家说"挖点石头"，
                // 期待的是一会儿石头到手，而不是被告知"你去给我做把镐"。
                if (rule.action === 'collectBlocks') {
                    const want = /!collectBlocks\("([^"]+)"/.exec(cmd)?.[1];
                    const say = makeSayer(agent, username);
                    const guard = await ensurePickaxe(agent, want, {
                        say,
                        onProgress: (line) => emit('log', { level: 'info', line }),
                    });
                    if (!guard.ok) {
                        emit('gate', { decision: 'PASS', via: 'rule-guard', rule: rule.id, action: rule.action, from: username, msg: cleaned, cmd, channel });
                        console.log(`[MCBOT-GATE] 采集预检拦下：${want}（${guard.message}）`);
                        say(guard.message || preflightCollect(agent, want) || '我这边缺点东西，去不了。');
                        return;
                    }
                    if (guard.freshly) {
                        emit('log', { level: 'info', line: `现做了把${craftLabel(guard.tool)}，这就去挖${blockLabelOf(want)}` });
                    }
                }

                const detail = rule._resolved ? ` resolved=${rule._resolved}` : '';
                emit('gate', { decision: 'PASS', via: 'rule', rule: rule.id, action: rule.action, from: username, msg: cleaned, cmd, channel });
                console.log(`[MCBOT-GATE] PASS via=rule rule=${rule.id} action=${rule.action} from=${username}${detail} cmd=${cmd}`);
                try {
                    if (!executeCommandFn) executeCommandFn = (await import(COMMANDS_URL)).executeCommand;
                    await runEngineCommand(agent, username, cmd);
                } catch (err) {
                    console.error('[MCBOT-GATE] rule command failed:', err?.message || err);
                    emit('error', { message: `固定意图执行失败（${rule.action}）：${err?.message || err}` });
                }
                return;
            }
            // 规则的话头对上了，但参数认不出（"帮我弄点那个"）—— 退回大模型。
            // 这是刻意的降级路径：宁可多花一次调用，也不猜错。
            console.log(`[MCBOT-GATE] 规则 ${rule.id} 命中但认不出参数，退回大模型：${JSON.stringify(cleaned)}`);
            emit('gate', { decision: 'FALLBACK', reason: 'ruleUnresolved', rule: rule.id, action: rule.action, from: username, msg: cleaned, channel });
        }

        // ── 走大模型 ──────────────────────────────────────────────────────
        stats.dispatched++;
        emit('gate', { decision: 'PASS', via: 'llm', from: username, msg: cleaned, raw: message, channel });
        console.log(
            `[MCBOT-GATE] PASS channel=${channel} from=${username} ` +
            `raw=${JSON.stringify(message)} -> cleaned=${JSON.stringify(cleaned)}`
        );

        try {
            // 记得的事要在这之前塞进上下文，否则模型根本不知道有这回事。
            await injectMemory(agent, username, cleaned);
            agent.respondFunc(username, cleaned);
        } catch (err) {
            console.error('[MCBOT-GATE] respondFunc threw:', err?.message || err);
            emit('error', { message: `调用大模型失败：${err?.message || err}` });
        }
    }

    const { Agent } = await import(AGENT_URL);

    const originalSetup = Agent.prototype._setupEventHandlers;
    if (typeof originalSetup !== 'function') {
        console.error('[MCBOT-GATE] FATAL: Agent.prototype._setupEventHandlers not found — engine layout changed.');
        emit('error', { message: '引擎结构变了：找不到 Agent.prototype._setupEventHandlers' });
        process.exit(1);
    }

    Agent.prototype._setupEventHandlers = async function (save_data, init_message) {
        const bot = this.bot;
        const before = {
            chat: bot.listeners('chat').slice(),
            whisper: bot.listeners('whisper').slice(),
        };

        await originalSetup.call(this, save_data, init_message);

        // 只摘掉引擎刚刚新增的那两条 —— 不动别人（或后续插件）挂的监听器。
        let removed = 0;
        for (const listener of bot.listeners('chat')) {
            if (!before.chat.includes(listener)) { bot.removeListener('chat', listener); removed++; }
        }
        for (const listener of bot.listeners('whisper')) {
            if (!before.whisper.includes(listener)) { bot.removeListener('whisper', listener); removed++; }
        }

        // 公屏必须带称谓；私聊 /msg 免称谓（用户 m00331 的决定）。
        // ⚠️ 这里的 catch 必须把错误写出来：早先写成 `.catch(() => {})`，结果一次建造任务
        // 抛异常后整个流程静默消失 —— 日志里既没有"开始盖房"也没有任何报错，白查了半小时。
        const onFailure = (err) => {
            console.error('[MCBOT-GATE] 处理消息时出错：', err);
            emit('error', { where: 'handle', message: String(err?.message || err), stack: String(err?.stack || '').split('\n').slice(0, 4).join(' | ') });
        };
        bot.on('chat', (username, message) => { handle(this, username, message, true).catch(onFailure); });
        bot.on('whisper', (username, message) => { handle(this, username, message, false).catch(onFailure); });

        // ── 生命周期事件上报（界面上的"在线/血量/坐标"就靠这些）──
        bot.on('login', () => emit('mc', { kind: 'login', name: bot.username }));
        bot.on('spawn', () => emit('mc', { kind: 'spawn', position: fmtPos(bot) }));
        bot.on('end', (reason) => emit('mc', { kind: 'end', reason: String(reason || '') }));
        bot.on('kicked', (reason) => emit('mc', { kind: 'kicked', reason: typeof reason === 'string' ? reason : JSON.stringify(reason) }));
        bot.on('death', () => emit('mc', { kind: 'death', position: fmtPos(bot) }));
        bot.on('error', (err) => emit('error', { message: `Minecraft 连接错误：${err?.message || err}` }));

        // 补发：mineflayer 的 login/spawn 可能在上面这行之前就已经发过了。
        // 实测顺序是 "Xiaodou logged in!" → "Xiaodou spawned." → 本模块装上监听器，
        // 于是那两条事件被整个错过，界面永远显示"未连接"（血量/坐标却照常刷新）。
        // 装好之后立刻按当前真实状态补一次，谁先谁后都能自愈。
        if (bot.username) emit('mc', { kind: 'login', name: bot.username, replay: true });
        if (bot.entity) emit('mc', { kind: 'spawn', position: fmtPos(bot), replay: true });

        // 定期上报状态。unref 掉，绝不阻止进程退出。
        const emitStats = () => {
            try {
                if (!bot.entity) return;
                emit('mc', {
                    kind: 'stats',
                    health: bot.health,
                    food: bot.food,
                    position: fmtPos(bot),
                    dimension: bot.game?.dimension,
                    gamemode: bot.game?.gameMode,
                });
            } catch { /* bot 正在重连 */ }
        };
        // ★ 立刻先来一条：否则界面上的血量/坐标会空白最多 10 秒（多 bot 自检里
        //   实测到 connected=true 但 health/position 还是 null 的那一瞬）。
        emitStats();
        const statsTimer = setInterval(emitStats, 10000);
        statsTimer.unref?.();

        emit('status', { status: 'running', detail: `已上线，守卫 ${owners.length} 位主人` });
        console.log(
            `[MCBOT-GATE] installed on agent=${this.name} ` +
            `removedEngineListeners=${removed} wakeNames=${JSON.stringify(wakeNames)} owners=${JSON.stringify(owners)} rateLimitMs=${rateLimitMs}`
        );
    };

    function fmtPos(bot) {
        const p = bot?.entity?.position;
        if (!p) return null;
        return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 };
    }

    // ★ 引擎在"没有 init_message、也没有 last_sender"时会**硬编码**说一句
    //   `Hello world! I am <name>`（agent.js:217）。它是英文的，且与"没被叫到就
    //   不出声"的产品承诺直接冲突，所以在这里精确吞掉这一条 —— 只吞这一条，
    //   其它 openChat（真正给玩家的回复）原样放行。
    const originalOpenChat = Agent.prototype.openChat;
    if (typeof originalOpenChat === 'function') {
        Agent.prototype.openChat = function (message) {
            const greeting = 'Hello world! I am ' + this.name;
            if (typeof message === 'string' && message.trim() === greeting) {
                console.log('[MCBOT-GATE] 已静默引擎的英文开机问候（agent.js:217）');
                return Promise.resolve();
            }
            return originalOpenChat.call(this, message);
        };
    }

    // ★ 引擎自己会在 agent 子进程崩掉后重启它，并且**带一句 init_message**
    //   （agent_process.js:49/77/81 `'Agent process restarted.'`）。那句会走
    //   agent.js:214 的 handleMessage('system', …) → 一次真实的大模型调用 →
    //   而且 bot 会在没人叫它的情况下自己开口说话。实测抓到过一次：
    //   `.spike/fake-llm.log` 里 2026-10-05T10:43:01Z 那条 chat 请求的
    //   content 就带着 "Agent process restarted."。
    //   这里精确掐掉这一句（以及引擎可能加的同类内部口令），
    //   **其它 system 消息一律放行** —— 那些是"动作被打断""你死了"之类的
    //   反应式通知，掐了会让 bot 变成聋子。
    const ENGINE_BOOT_NOISE = [
        'Agent process restarted.',
        'You have restarted and this message is auto-generated. Continue the conversation with me.',
    ];
    const originalHandleMessage = Agent.prototype.handleMessage;
    if (typeof originalHandleMessage === 'function') {
        Agent.prototype.handleMessage = function (source, message, max_responses = null) {
            if (source === 'system' && typeof message === 'string'
                && ENGINE_BOOT_NOISE.some((s) => message.trim() === s)) {
                console.log('[MCBOT-GATE] 已拦下引擎的内部重启口令（省一次大模型调用）');
                emit('log', { level: 'info', line: '引擎内部重启了一次 agent，已静默它的重启口令（没让它自己开口）' });
                return Promise.resolve(false);
            }
            return originalHandleMessage.call(this, source, message, max_responses);
        };
    }

    // 供 Electron 主进程通过 stdout 抓取成本数据用。
    process.on('SIGUSR2', () => {
        console.log('[MCBOT-GATE-STATS] ' + JSON.stringify({ ...stats, budgetUsed: budget.used }));
    });

    emit('status', { status: 'starting', detail: '引擎进程已启动' });
    console.log('[MCBOT-GATE] injection module loaded (pid ' + process.pid + ')');
}
