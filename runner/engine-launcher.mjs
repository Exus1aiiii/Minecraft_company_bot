// ============================================================================
// MCBOT 引擎启动器 —— 一个 bot 一个进程
//
// 它做五件事，全部由一份"启动规格" JSON 驱动（由 app/electron/launcher.mjs 生成）：
//   1. 生成引擎 profile（含人格提示词），写进 runner/profiles/<botId>.json；
//   2. 组出 SETTINGS_JSON，覆盖端口/版本/语言等引擎默认值；
//   3. 设 MCBOT_GATE，把唤醒称谓与 owner 规则交给聊天门；
//   4. 启动前做协议栈自检（V-3 相关），把"连不上"的原因讲在崩溃之前；
//   5. spawn `node main.js`。
//
// NODE_OPTIONS=--import <gate> 由**上层**（Electron 主进程 / 手工调用者）设置，
// 这里原样透传 —— agent_process.js 的 spawn 会继承环境变量，所以一次注入覆盖两层。
//
// 用法：
//   node runner/engine-launcher.mjs --bot-json runtime/tmp/<botId>.launch.json
//   node runner/engine-launcher.mjs --config runner/bots/spike.bot.json   （T0 时期的旧格式）
// ============================================================================

import { spawn } from 'node:child_process';
import net from 'node:net';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeProtocolStack } from './engine-patches.mjs';
import { createEventLog } from './event-log.mjs';
import { getPersona, buildSystemPrompt } from './personas/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const ENGINE_DIR = path.join(PROJECT_ROOT, 'vendor', 'mindcraft-develop');
const PROFILES_DIR = path.join(PROJECT_ROOT, 'runner', 'profiles');
const NAME_RE = /^[a-zA-Z0-9_]{3,16}$/;

/**
 * 从 want 开始向上找一个空闲端口。
 * 引擎是「一个进程一个 MindServer」，多开时端口撞上会直接起不来；
 * 上层（app/electron/launcher.mjs）已经按 botId 散列错开了，这里再兜一层。
 */
function findFreePort(want, tries = 25) {
    return new Promise((resolve) => {
        let port = Number(want) || 8080;
        let n = 0;
        const attempt = () => {
            if (n >= tries) { resolve(Number(want) || 8080); return; }
            const srv = net.createServer();
            srv.unref();
            srv.on('error', () => { port += 1; n += 1; attempt(); });
            srv.listen(port, '127.0.0.1', () => {
                srv.close(() => resolve(port));
            });
        };
        attempt();
    });
}

/** runtime\ 下挑一个 Node 22（引擎依赖要求 >=22，且 24 会踩原生依赖） */
function findNodeExe() {
    const runtimeDir = path.join(PROJECT_ROOT, 'runtime');
    const found = [];
    try {
        for (const name of readdirSync(runtimeDir)) {
            const m = /^node-v(\d+)\./.exec(name);
            if (!m) continue;
            const exe = path.join(runtimeDir, name, 'node.exe');
            if (existsSync(exe)) found.push({ exe, major: Number(m[1]) });
        }
    } catch { /* runtime 不存在 */ }
    const preferred = found.filter(f => f.major >= 22 && f.major < 24).sort((a, b) => b.major - a.major);
    if (preferred.length) return preferred[0].exe;
    if (found.length) return found.sort((a, b) => b.major - a.major)[0].exe;
    return process.execPath;
}

function parseArgs() {
    const args = process.argv.slice(2);
    const out = {};
    for (let i = 0; i < args.length; i += 2) {
        if (args[i].startsWith('--')) out[args[i].slice(2)] = args[i + 1];
    }
    return out;
}

function pathToFileUrl(p) {
    return 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '');
}

// ── 读取启动规格 ─────────────────────────────────────────────────────────────

const args = parseArgs();
const specPath = args['bot-json'] || args.config;
if (!specPath) {
    console.error('用法: node runner/engine-launcher.mjs --bot-json <launch.json>');
    process.exit(2);
}
const resolved = path.resolve(PROJECT_ROOT, specPath);
if (!existsSync(resolved)) {
    console.error(`找不到启动规格: ${resolved}`);
    process.exit(2);
}
const raw = JSON.parse(readFileSync(resolved, 'utf8'));

// 把 T0 时期的 spike 格式也归一化到新格式，这样老配置文件还能直接用。
const spec = raw.botId ? raw : {
    botId: 'spike',
    agentName: raw.agentName,
    displayName: raw.displayName || raw.agentName,
    ownerName: (raw.owners || [])[0] || '',
    wakeNames: raw.wakeNames,
    owners: raw.owners,
    rateLimitMs: raw.rateLimitMs,
    dailyTokenBudget: raw.dailyTokenBudget,
    server: raw.server,
    llm: { baseUrl: raw.llm?.baseUrl, model: raw.llm?.model, timeoutMs: 60000 },
    persona: null,
    skin: null,
    rules: [],
    baseProfile: raw.baseProfile || 'assistant',
    profileDir: PROFILES_DIR,
    eventsFile: process.env.MCBOT_EVENTS_FILE || '',
    mindserverPort: raw.mindserverPort ?? 8080,
    logAllPrompts: raw.logAllPrompts,
    legacyProfile: raw.profile,
};

const botId = spec.botId || 'unknown';
const eventsFile = process.env.MCBOT_EVENTS_FILE || spec.eventsFile || '';
const log = eventsFile ? createEventLog({ botId, file: eventsFile, echo: true }) : { emit: () => {} };
const emit = log.emit;

const settings_for_gate = null; // 占位，防止误用

// ── 自检：把明显的配置错误挡在启动之前 ───────────────────────────────────────

const problems = [];
if (!NAME_RE.test(spec.agentName || '')) {
    // 引擎 connection_handler.js:88 的 validateNameFormat 就是这个正则，
    // 不满足会直接 process.exit(1)。中文只能当"称谓"，不能当账号名。
    problems.push(`agentName "${spec.agentName}" 不合法：Minecraft 账号名必须是 3-16 位 [a-zA-Z0-9_]（中文只能用作唤醒称谓）`);
}
if (!Array.isArray(spec.wakeNames) || spec.wakeNames.length === 0) {
    problems.push('wakeNames 为空：公屏上将永远无法唤醒 bot');
}
if (!Array.isArray(spec.owners) || spec.owners.length === 0) {
    problems.push('owners 为空：聊天门会拒绝一切消息（fail closed）');
}
if (!spec.llm?.baseUrl) problems.push('llm.baseUrl 缺失');
if (!process.env.MCBOT_LLM_API_KEY && !spec.llm?.apiKey) problems.push('llm API Key 缺失（应由主进程通过环境变量注入）');
if (!spec.server?.host || !spec.server?.port) problems.push('server.host / server.port 缺失');
if (problems.length) {
    console.error('[MCBOT-LAUNCHER] 配置有误，拒绝启动：');
    for (const p of problems) console.error('  - ' + p);
    emit('error', { message: '启动配置有误：' + problems.join('；') });
    process.exit(2);
}

// ── 生成引擎 profile ─────────────────────────────────────────────────────────

const baseProfileName = spec.baseProfile || 'assistant';
const engineDefaults = JSON.parse(readFileSync(path.join(ENGINE_DIR, 'profiles', 'defaults', '_default.json'), 'utf8'));

let personaPrompt = '';
if (spec.persona?.id) {
    const persona = getPersona(spec.persona.id);
    if (!persona) {
        problems.push(`找不到人格面具 "${spec.persona.id}"`);
    } else {
        try {
            personaPrompt = buildSystemPrompt(persona, {
                botDisplayName: spec.displayName || spec.agentName,
                ownerName: spec.ownerName || '',
                language: 'zh',
            });
        } catch (e) {
            console.warn(`[MCBOT-LAUNCHER] 人格提示词生成失败，退回到引擎默认人格：${e.message}`);
        }
    }
}

// ★ 关键：人格提示词是**叠在**引擎默认 conversing 之前的，不能替换它。
//   引擎默认提示词里带着 $STATS / $INVENTORY / $COMMAND_DOCS / $EXAMPLES 这些
//   占位符，替换掉就等于把 bot"会使用命令"的能力一起删了 —— 它会变得只会聊天。
//   实测 vendor/mindcraft-develop/profiles/defaults/_default.json 的 conversing 为 817 字符。
const profile = {
    name: spec.agentName,
    // selectAPI 按前缀推断厂商；"mcbot/" 会路由到我们自己的 provider，
    // 真正的模型名与端点由 MCBOT_LLM_* 环境变量决定（见 src/models/mcbot.js）。
    model: `mcbot/${spec.llm.model || 'default'}`,
    embedding: 'mcbot/embed',
    conversing: personaPrompt
        ? `${personaPrompt}\n\n${engineDefaults.conversing}`
        : engineDefaults.conversing,
};

if (spec.skin?.model && spec.skin?.path) {
    // 引擎 agent.js:98 登录后会执行 `/skin set URL <model> <path>`，依赖 Fabric Tailor 模组。
    profile.skin = { model: spec.skin.model, path: spec.skin.path };
}

const profileDir = spec.profileDir || PROFILES_DIR;
mkdirSync(profileDir, { recursive: true });
const profilePath = path.join(profileDir, `${botId}.json`);
const profileTmp = profilePath + '.tmp';
writeFileSync(profileTmp, JSON.stringify(profile, null, 2), 'utf8');
renameSync(profileTmp, profilePath);

// ── SETTINGS_JSON ───────────────────────────────────────────────────────────

// blocked_actions 的默认值。前 4 条是引擎自己的默认（蓝图建造系统上游属实验状态），
// 后 3 条是我们加的：
//   !newAction —— 让大模型写代码并在沙箱里执行。哪怕 allow_insecure_coding=false
//                 挡得住，也不该让这条命令留在提示词里诱惑模型（R-2 / R-14）。
//   !attackPlayer —— 玩家之间的 PvP。陪伴型 bot 不该被一句话挑唆去打人。
//   !restart —— 引擎的 !restart 会直接退出进程。启停是界面的职责，不该由聊天触发。
const DEFAULT_BLOCKED_ACTIONS = [
    '!checkBlueprint',
    '!checkBlueprintLevel',
    '!getBlueprint',
    '!getBlueprintLevel',
    '!newAction',
    '!attackPlayer',
    '!restart',
];

const settings = {
    host: spec.server.host,
    port: String(spec.server.port),
    auth: spec.server.auth || 'offline',
    // 锁死版本：mineflayer 自动探测会多一次 ping，且目标版本是本项目的既定选择。
    minecraft_version: spec.server.version || '1.21.1',
    // 每个 bot 一个进程 = 一个 MindServer，端口必须错开，否则第二个 bot 起不来。
    mindserver_port: await findFreePort(spec.mindserverPort ?? 8080),
    auto_open_ui: false,
    base_profile: baseProfileName,
    profiles: [profilePath],
    load_memory: false,
    // ★ 空字符串 = 不触发开场白。引擎默认会给一句 init_message 并烧掉一次调用，
    //   与"没被叫到就不烧 token"直接冲突（T0 遗留问题 R-9）。
    init_message: '',
    only_chat_with: [],
    speak: false,
    chat_ingame: true,
    // ★ 必须保持 en。translator.js:7,20 见到 en 直接原样返回，
    //   这样三次 Google 翻译往返（大陆通常不可达）全部消失，中文由人格提示词负责。
    language: 'en',
    render_bot_view: false,
    allow_insecure_coding: false,
    allow_vision: false,
    spawn_timeout: 60,
    log_all_prompts: spec.logAllPrompts === true,
    // ★ blocked_actions 是**一石二鸟**的开关：getCommandDocs()
    //   （commands/index.js:247 `if (agent.blocked_actions.includes(command.name)) continue;`）
    //   会把被禁的命令从提示词里整条删掉，而 blacklistCommands() 又让它们真的不可执行。
    //   所以这一份清单同时是"安全闸门"和"token 闸门"。
    //   实测每条命令在提示词里平均约 145 字符（51 条共 7434 字符 ≈ 3717 token）：
    //     !getCraftingPlan 396 / !craftRecipe 282 / !tradeWithVillager 265 / !useOn 248 …
    //   这里只封"越权/自毁"类，不封正常玩法 —— 挖矿、建造、跟随、合成一律保留。
    blocked_actions: spec.blockedActions || DEFAULT_BLOCKED_ACTIONS,
};

process.env.MCBOT_MC_VERSION = settings.minecraft_version;

const gateConfig = {
    botId,
    wakeNames: spec.wakeNames,
    owners: spec.owners,
    // 只在明确 false 时才让门禁对非主人开口提示（见 store.mjs 的 FACTORY_OWNERS）。
    ownersConfigured: spec.ownersConfigured === true,
    rateLimitMs: spec.rateLimitMs ?? 5000,
    dailyTokenBudget: spec.dailyTokenBudget ?? 0,
    rules: spec.rules || [],
    eventsFile,
};

const env = {
    ...process.env,
    SETTINGS_JSON: JSON.stringify(settings),
    MCBOT_GATE: JSON.stringify(gateConfig),
    MCBOT_BOT_ID: botId,
    MCBOT_EVENTS_FILE: eventsFile,
    MCBOT_LLM_BASE_URL: spec.llm.baseUrl,
    MCBOT_LLM_MODEL: spec.llm.model || '',
    MCBOT_LLM_API_KEY: process.env.MCBOT_LLM_API_KEY || spec.llm.apiKey || '',
    MCBOT_MC_VERSION: settings.minecraft_version,
};

const nodeExe = findNodeExe();

// ── 日志 ────────────────────────────────────────────────────────────────────

const summary = [
    `engine     : ${ENGINE_DIR}`,
    `node       : ${nodeExe}`,
    `agentName  : ${spec.agentName}${spec.displayName !== spec.agentName ? `（${spec.displayName}）` : ''}`,
    `wakeNames  : ${JSON.stringify(spec.wakeNames)}`,
    `owners     : ${JSON.stringify(spec.owners)}`,
    `server     : ${spec.server.host}:${spec.server.port} (${settings.minecraft_version}, ${settings.auth})`,
    `llm        : ${spec.llm.baseUrl} model=${spec.llm.model}`,
    `persona    : ${spec.persona?.id || '(引擎默认)'}`,
    `mindserver : ${settings.mindserver_port}`,
    `profile    : ${profilePath}`,
];
console.log('[MCBOT-LAUNCHER] ================= 启动配置 =================');
for (const line of summary) console.log('[MCBOT-LAUNCHER] ' + line);
console.log('[MCBOT-LAUNCHER] ================================================');
emit('log', { level: 'info', line: `启动配置：${spec.server.host}:${spec.server.port} · ${spec.llm.model} · 人格 ${spec.persona?.id || '默认'}` });
emit('status', { status: 'starting', detail: '正在启动引擎' });

// ── 启动前协议栈自检 ────────────────────────────────────────────────────────
// 在启动器进程里跑，只读；真正的修正在子进程里由 V-3 守卫做（见 engine-patches.mjs）。
// 目的是把"连不上服务器"的原因在引擎崩溃【之前】就讲清楚。
const stack = describeProtocolStack();
if (stack.error) {
    console.error('[MCBOT-LAUNCHER] 协议栈解析失败：', stack.error);
    emit('log', { level: 'warn', line: `协议栈解析失败：${stack.error}` });
} else {
    console.log('[MCBOT-LAUNCHER] 协议栈   :', JSON.stringify(stack.versions));
    const willPatch = stack.chosen && stack.chosen !== stack.defaultVersion;
    console.log(
        `[MCBOT-LAUNCHER] 版本兜底 : defaultVersion=${stack.defaultVersion}` +
        (willPatch ? ` -> ${stack.chosen}（将由子进程内的 V-3 修正）` : '（无需修正）')
    );
    if (!stack.chosen) {
        const msg = 'minecraft-protocol 与 minecraft-data 没有任何交集版本，连接必然失败。请运行 node tools/probe-protocol-stack.mjs 查看详情。';
        console.error('[MCBOT-LAUNCHER] 致命：' + msg);
        emit('error', { message: msg });
        process.exit(3);
    }
    if (stack.target && stack.target !== 'auto' && !stack.known.includes(stack.target)) {
        const msg = `目标版本 ${stack.target} 在 minecraft-data@${stack.versions['minecraft-data']} 里没有数据。可用版本：${stack.known.join(', ')}`;
        console.error('[MCBOT-LAUNCHER] 致命：' + msg);
        emit('error', { message: msg });
        process.exit(3);
    }
}

// ── 拉起引擎 ────────────────────────────────────────────────────────────────

const child = spawn(nodeExe, ['main.js'], {
    cwd: ENGINE_DIR,
    env,
    // inherit 而不是 pipe：引擎和 agent 子进程的日志直接进上层给的 stdout
    //（主进程把它接到了 runtime\logs\<botId>.out.log 的文件描述符上），
    // 同时这也是在受限沙箱下唯一可用的 spawn 形式。
    stdio: 'inherit',
});

child.on('exit', (code, signal) => {
    console.log(`[MCBOT-LAUNCHER] engine exited code=${code} signal=${signal}`);
    emit('status', { status: 'stopped', detail: `引擎退出（code=${code}）` });
    process.exit(code ?? 0);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        console.log(`[MCBOT-LAUNCHER] 收到 ${sig}，转发给引擎进程`);
        try { child.kill(sig); } catch { /* 已经没了 */ }
    });
}
