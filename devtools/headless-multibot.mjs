// ============================================================================
// MCBOT 多 bot 并行自检
//
// 为什么需要它：用户的核心需求之一是"可多服务器并行"。单 bot 那条线已经
// 端到端验过了，但"两个 bot 同时在线"从来没验过 —— 而它恰好踩在三个已知
// 风险上：
//
//   1. MindServer 端口冲突。引擎每个 bot 起一个进程、每个进程自带一个
//      MindServer。上游默认写死 8080，我们改成按 botId 散列（8180+）。
//      两个 bot 撞端口 = 后起的那个起不来。这条只能靠真起两个进程来验。
//   2. 唤醒串台。同一个服务器上两个 bot，叫 A 的时候 B 会不会也应答？
//      B 的门外加了自己的称谓表，理论上是隔离的 —— 但"理论"不算证据。
//   3. 事件串台。两个 bot 各写一条 jsonl，界面靠文件名区分。如果文件名
//      撞了或者写串了，面板上就会出现"A 的血量显示在 B 的卡片上"。
//
// 还有一个上游地雷必须在这里验：docs/03 §9.2 记录过，引擎在
//   bot.on('chat', (…) => { if (serverProxy.getNumOtherAgents() > 0) return; … })
// 里，一旦发现有别的 agent 就把公屏监听整体关掉。我们的门替换了那两条
// 监听器，所以理论上不受影响 —— 这个脚本就是来证伪这句话的。
//
// 安全阀与 headless-main.mjs 第 9 节一致：只打本地假大模型，命中真 API
// 域名直接拒跑；跑完无条件还原用户的配置与密钥。
//
// 用法：
//   node --import ./devtools/register-electron-stub.mjs devtools/headless-multibot.mjs
//   MCBOT_MULTI_KEEP=1 时跑完不还原配置（调试用）
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

// ★ 必须是第一个 import：它把 runtime 重定向到沙箱目录，让这个脚本
//   物理上碰不到用户的 runtime\config.json（见 sandbox-env.mjs 的说明）。
import { SANDBOX_DIR, REAL_CONFIG_FILE, pickLoopbackServer, isLoopbackHost } from './sandbox-env.mjs';

import * as paths from '../app/electron/paths.mjs';
import * as store from '../app/electron/store.mjs';
import { buildLaunchSpec } from '../app/electron/launcher.mjs';
import { supervisor as sup } from '../app/electron/supervisor.mjs';
import * as events from '../app/electron/events.mjs';

const require = createRequire(paths.ENGINE_DIR + '/package.json');
const mineflayer = require('mineflayer');

// ---------------------------------------------------------------------------
let checks = 0;
let problems = 0;
function section(t) { console.log(`\n=== ${t} ===`); }
function ok(t) { checks++; console.log(`  ✓ ${t}`); }
function fail(t) { checks++; problems++; console.log(`  ✗ ${t}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ★ 为什么不能一路 `await sleep(4000)` 然后断言：
//   引擎冷启动在本机实测是 **5 秒**，但机器一忙（比如刚跑完 17 套自检、两个 Java 服
//   都在跑）就会变成 **42 秒** —— 而"等 4 秒再看事件流"在那种时候必然误报成
//   "bot 没连上 / 没记下 rejectedNoWakeName"。2026-02 就是这么红了两轮（错误信息还
//   指向完全无关的地方）。所以规则改成：
//     · 凡是"等某个事件出现"的断言 → 用 waitFor 轮询到出现为止（默认 25 秒上限）；
//     · 只有"某个事件**不该**出现"的否定断言，才继续用固定等待，
//       而且必须在**期望的那个事件已经出现之后**再数，否则数的是"还没到时候"。
async function waitFor(cond, { timeoutMs = 25000, everyMs = 250 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let hit = false;
    try { hit = !!(await cond()); } catch { hit = false; }
    const ms = Date.now() - t0;
    if (hit) return { ok: true, ms };
    if (ms >= timeoutMs) return { ok: false, ms };
    await sleep(everyMs);
  }
}
const secs = (ms) => (ms / 1000).toFixed(1) + 's';

// ★ 每句话之间必须留够间隔：门禁对**同一个人**有 `rateLimitMs=3000` 的防刷屏节流，
//   消息挨得太近会被记成 `rejectedRateLimited`（这是设计如此，不是故障）。
//   2026-02 那次"私聊 A 却没放行"就是这么误报出来的 —— 断言改成事件驱动之后，
//   上一句和这一句之间只剩 1.5 秒，正好撞在节流窗口上。测试要按产品的规矩说话。
let lastSayAt = 0;
async function say(client, text, { gapMs = 3600, reconnectMs = 20000 } = {}) {
  const wait = lastSayAt + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  const st = SPEAKERS.get(client);
  if (st) {
    // 被踢过还没有重连上的时候不能发话 —— `chat()` 在没 spawn 的客户端上等于石沉大海，
    // 而那会被后面的断言读成"产品没反应"（这正是 2026-02 那轮误报的一半原因）。
    const up = await waitFor(() => st.spawned, { timeoutMs: reconnectMs, everyMs: 250 });
    if (!up.ok) {
      st.sendFailed = true;
      console.log(`  ! 测试玩家 ${st.username} 没能重新连上服务器（等 ${secs(up.ms)}），这句话没发出去`);
      return false;
    }
    client = st.bot;
  }
  lastSayAt = Date.now();
  client.chat(text);
  return true;
}

// ★★ 服务器会**随机踢人**：vanilla 服务端收到"对不上号"的移动包时会以
//    `Invalid move player packet received` 断开客户端。实测这套本地测试服
//    （vanilla Fabric 1.21.1，和客户端版本一致，不是版本错配）在 2026-02 那天踢了 11 次，
//    **测试玩家 Steve/Alex 和我们自己的 bot 都会被踢**。
//    被踢的人之后**收不到任何聊天**，于是"少收到一句提示"这类断言就会误报成产品问题：
//    2026-02 那次 `A 的提示句数不对：期望 2 实得 1` 查到最后就是 Steve 在两句之间被踢了
//    （服务器日志 `[22:41:54] Steve lost connection: Invalid move player packet received`）。
//    所以测试自己的客户端必须：①自动重连 ②把"被踢过"记下来，并在相关断言失败时**打印出来**，
//    让读日志的人第一眼就分清"产品没反应"和"我的测试玩家掉线了"。
const SPEAKERS = new WeakMap();
function makeTestPlayer(username) {
  const st = { username, bot: null, saw: [], kicks: [], spawned: false, closing: false, sendFailed: false };
  const connect = () => {
    const bot = mineflayer.createBot({
      host: MC_HOST, port: MC_PORT, username, auth: 'offline',
      version: MC_VERSION, checkTimeoutInterval: 60000,
    });
    st.bot = bot;
    st.spawned = false;
    SPEAKERS.set(bot, st);
    bot.on('message', (jsonMsg, position) => {
      if (position === 'game_info') return;
      st.saw.push(jsonMsg.toString());
    });
    bot.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
      st.kicks.push(text.slice(0, 120));
      console.log(`  ! 测试玩家 ${username} 被服务器踢了：${text.slice(0, 120)}`);
    });
    bot.on('end', () => {
      st.spawned = false;
      if (st.closing) return;
      setTimeout(connect, 800);   // 被踢/掉线就自己回来，别让后面的断言读一个死客户端
    });
    bot.once('spawn', () => { st.spawned = true; });
    return bot;
  };
  st.bot = connect();
  st.close = () => { st.closing = true; try { st.bot.end(); } catch { /* 已经断了 */ } };
  return st;
}
/** 断言失败时贴在后面的一句话：这个客户端期间被踢过吗？ */
function kickNote(st) {
  if (!st || st.kicks.length === 0) return '';
  return `（注意：测试玩家 ${st.username} 期间被服务器踢过 ${st.kicks.length} 次：${st.kicks[st.kicks.length - 1]}）`;
}
const waitSpawn = (st, timeoutMs = 30000) => new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => {
    if (st.spawned) return resolve(true);
    if (Date.now() - t0 > timeoutMs) return resolve(false);
    setTimeout(tick, 200);
  };
  tick();
});

const LLM_URL = process.env.MCBOT_HEADLESS_LLM_URL || 'http://127.0.0.1:8799/v1';
const LLM_MODEL = process.env.MCBOT_HEADLESS_LLM_MODEL || 'mcbot-spike-model';
const MC_HOST = process.env.MCBOT_HEADLESS_MC_HOST || '127.0.0.1';
const MC_PORT = Number(process.env.MCBOT_HEADLESS_MC_PORT || 25565);
const MC_VERSION = process.env.MCBOT_HEADLESS_MC_VERSION || '1.21.1';

if (/api\.deepseek\.com|dashscope|openai\.com/i.test(LLM_URL)) {
  console.log(`拒绝用真实 API 跑自动测试（${LLM_URL}）`);
  process.exit(2);
}

// ★ 假大模型（`tools/mcbot-fake-llm.mjs`，默认 8799）在不在跑。
//   第 ⑥ 节要断言"每次放行都对应一次大模型调用"，可如果没人应答，两个计数会一起是 0
//   —— 那条断言就变成"0 == 0"的空过（假绿）。所以先探一次，没跑时把它标成"没跑"，
//   而不是让它冒充通过。
const llmUp = await new Promise((resolve) => {
  const s = net.createConnection({ port: Number(new URL(LLM_URL).port || 80), host: new URL(LLM_URL).hostname });
  const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
  s.setTimeout(1500);
  s.once('connect', () => done(true));
  s.once('timeout', () => done(false));
  s.once('error', () => done(false));
});
if (!llmUp) console.log(`  · ${LLM_URL} 没在跑 —— 第 ⑥ 节"放行 == 大模型调用"会标成没跑（不是失败）`);

// ---------------------------------------------------------------------------
// 备份用户配置 —— 这个脚本必须能在跑完之后让用户毫无察觉
// ---------------------------------------------------------------------------
const userCfgHash0 = fs.existsSync(REAL_CONFIG_FILE)
  ? crypto.createHash('sha256').update(fs.readFileSync(REAL_CONFIG_FILE)).digest('hex')
  : null;
const userSecHash0 = fs.existsSync(path.join(path.dirname(REAL_CONFIG_FILE), 'secrets.json'))
  ? crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(REAL_CONFIG_FILE), 'secrets.json'))).digest('hex')
  : null;

// 这个脚本不再"改完再还原"——它整个跑在沙箱里（sandbox-env.mjs 把 runtime 重定向了），
// 用户的 config.json / secrets.json 从头到尾没有被打开写过。
function userDataUntouched() {
  try {
    const nowCfg = fs.existsSync(REAL_CONFIG_FILE)
      ? crypto.createHash('sha256').update(fs.readFileSync(REAL_CONFIG_FILE)).digest('hex') : null;
    const secFile = path.join(path.dirname(REAL_CONFIG_FILE), 'secrets.json');
    const nowSec = fs.existsSync(secFile)
      ? crypto.createHash('sha256').update(fs.readFileSync(secFile)).digest('hex') : null;
    return nowCfg === userCfgHash0 && nowSec === userSecHash0;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// 读某个 bot 的事件日志（只读尾部，且只统计本次运行之后写的行）
// ---------------------------------------------------------------------------
function readEvents(botId, sinceMs = 0) {
  const file = paths.logFileFor(botId);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const ev = JSON.parse(s);
      // ★ ts 是数字（epoch 毫秒），不是 ISO 字符串 —— 一开始写成 Date.parse(ev.ts)
      //   拿到 NaN，NaN >= x 恒为 false，于是"一条门禁事件都没有"的假象把
      //   五个其实完全正常的断言全判成了失败。别再用 Date.parse 猜类型。
      const t = typeof ev.ts === 'number' ? ev.ts : Date.parse(ev.ts);
      if (!sinceMs || (Number.isFinite(t) && t >= sinceMs)) out.push(ev);
    } catch { /* 半行，跳过 */ }
  }
  return out;
}
function gates(evs) { return evs.filter((e) => e.type === 'gate'); }
function passes(evs) { return gates(evs).filter((e) => e.decision === 'PASS'); }
function llmCalls(evs) { return evs.filter((e) => e.type === 'llm' && e.phase === 'response'); }

// ===========================================================================
// 1. 准备两个 bot 的配置
// ===========================================================================
section('1. 准备双 bot 配置');

const cfg = store.loadConfigRaw();

// 两个 bot 都指向本地假模型
for (const p of cfg.llm.profiles) { p.baseUrl = LLM_URL; p.model = LLM_MODEL; }
// ★ 按意图挑"本机那台"，不是按位置挑 servers[0] —— 见 sandbox-env.mjs 里
//   `isLoopbackHost` 的注释：用户把自己的服务器加进配置并排在前面之后，
//   `servers[0]` 就不再是本机服了，这行会把 bot A 指到线上，测试静默失效。
const srv = pickLoopbackServer(cfg.servers);
if (!srv) {
    fail(`配置里找不到本机服务器（127.0.0.1 / localhost）—— 自检必须连本机，绝不连用户的线上服。`
        + `现有：${cfg.servers.map((s) => `${s.id}=${s.host}:${s.port}`).join('、')}`);
    console.log('\n结果：✗ 没有可用的本机服务器，后面的检查没法做');
    process.exit(1);
}
srv.host = MC_HOST; srv.port = MC_PORT; srv.version = MC_VERSION;

const botA = cfg.bots.find((b) => (b.wakeNames || []).includes('小豆')) || cfg.bots[0];
botA.llmProfileId = cfg.llm.profiles[0].id;
botA.enabled = true;
// ★ 必须**显式**把 A 绑到本机服。supervisor 起进程时是按 bot.serverId 去配置里
//   反查服务器的，光把 srv 变量改成 127.0.0.1 没用 —— 那正是上一轮真机上发生的事：
//   沙箱里 `srv-local` 被改成了 127.0.0.1，可 bot A 还挂着 `srv-main`，
//   于是它老老实实登录了用户的线上服务器（公开版里地址已脱敏），而测试玩家在本地服里喊话。
botA.serverId = srv.id;

// 第二个 bot：换个名字、换个人格 —— 尽量贴近用户真实会怎么配
const B_ID = 'bot-axiao';
let botB = cfg.bots.find((b) => b.id === B_ID);
if (!botB) {
  botB = store.makeBot('Axiao', '阿霄', srv.id, cfg.llm.profiles[0].id);
  Object.assign(botB, {
    id: B_ID,
    enabled: true,
    wakeNames: ['阿霄', 'axiao', '霄霄'],
    owners: ['Steve'],
    rateLimitMs: 3000,
    dailyTokenBudget: 200000,
    personaId: 'builder',
    skin: { model: 'classic', path: '', enabled: false },
  });
  cfg.bots.push(botB);
}
// B 的规则表清空 —— 这样 B 的每一次放行都必然经过大模型，便于计数
botB.rules = [];

// ★★ B 的服务器绑定和唤醒称谓也必须**无条件钉死**，不能只写在上面那个 `if (!botB)` 里。
//    这个脚本是从**用户的真配置**（沙箱副本）里找 `bot-axiao` 的：只要它存在，
//    上面那段就整个被跳过，于是测试偷偷依赖"用户那台 bot 恰好也叫阿霄、恰好也挂在本机服"。
//    实测踩到过两次：
//      ① 用户给出自己的游戏 ID、`bot-axiao.owners` 一改 → 门禁按新名单把测试玩家
//         判成陌生人（`rejectedNotOwner`），报出来却是"B 收不到公屏"；
//      ② 把 `bot-axiao` 指到用户的线上服之后 → **B 真的登进了用户的线上服务器**，
//         而测试玩家在本地服喊话。
//    第 ② 条尤其要紧：当时第 194 行那道"必须连本机"的闸**没拦住**，因为
//    `buildLaunchSpec(botB, srv, …)` 是**显式把 srv 传进去**的，算出来的 spec 当然
//    是本机地址 —— 而 supervisor 起进程时是拿 `bot.serverId` 去**已保存的配置**里
//    反查服务器的，压根不看这个 srv 变量。闸门建错了地方，就等于没有闸门。
botB.serverId = srv.id;
botB.enabled = true;
botB.wakeNames = ['阿霄', 'axiao', '霄霄'];

// ★ 闸门的**反向验证**开关：`MCBOT_VERIFY_GATE=1` 时故意把 B 指到一个不可达的保留地址
//   （192.0.2.1 是 TEST-NET-1，永远不会路由到任何真实主机），用来证明下面那道
//   "已保存的配置必须指向本机"的闸真的会拦下来、而不是形同虚设。
//   为什么必须能自证：上一版那道闸就是**建错了地方**，于是 51 项断言里有 4 项变红，
//   而真正发生的事是 bot 登进了用户的线上服 —— 闸门不响比没有闸门更危险。
if (process.env.MCBOT_VERIFY_GATE === '1') {
    cfg.servers.push({ ...srv, id: 'srv-badgate', host: '192.0.2.1', label: '闸门反验专用（保留地址，不可达）' });
    botB.serverId = 'srv-badgate';
}

// ★ 把两个 bot 的"配没配过"钉死，测试才不受真实配置影响（必须在 buildLaunchSpec
//   和起进程之前设好 —— 运行中的引擎读的是启动那一刻的 spec，事后改内存里的 cfg 没用）：
//   A = 出厂状态（owners 还是 Steve 占位、没配过）→ 该对陌生人提示
//   B = 已配置（用户填过自己的 ID）             → 不该提示
botA.owners = ['Steve'];
botA.ownersConfigured = false;
botB.owners = ['Steve'];
botB.ownersConfigured = true;

const errors = store.validateConfig(cfg);
if (errors.length === 0) ok('配置校验通过');
else fail('配置校验不通过：' + errors.join('；'));

store.saveConfigRaw(cfg);
store.setSecret(cfg.llm.profiles[0].id, 'sk-multibot-fake');

// ★★ 这才是真正该建闸的地方：读回**刚存下的配置**，逐个 bot 走一遍
//    `serverId → servers[] → host` —— supervisor 起进程时走的就是这条链。
//    （上面那个用 `buildLaunchSpec(botB, srv, …)` 算出来的 spec 是本机地址，
//      但它证明不了 supervisor 会连本机：srv 是我们显式传进去的，属于自问自答。）
{
    const saved = store.loadConfigRaw();
    const srvById = new Map(saved.servers.map((s) => [s.id, s]));
    let bad = null;
    for (const id of [botA.id, botB.id]) {
        const sb = saved.bots.find((b) => b.id === id);
        const s = sb ? srvById.get(sb.serverId) : null;
        if (s && isLoopbackHost(s.host)) {
            ok(`${id} 在已保存的配置里挂的是本机：${s.host}:${s.port}`);
        } else {
            bad = `${id} → ${s ? `${s.host}:${s.port}` : `找不到服务器 ${sb ? sb.serverId : '(配置里没有这个 bot)'}`}`;
            fail(`★ 自检会连到 ${bad} —— 不是本机，拒绝继续（这套自检只连本机）`);
        }
    }
    if (bad) {
        console.log('\n结果：✗ 已保存的配置指向的不是本机，立刻停下（绝不许连用户的线上服）');
        process.exit(1);
    }
}

ok(`bot A = ${botA.name}(${botA.displayName}) 称谓 ${JSON.stringify(botA.wakeNames)}`);
ok(`bot B = ${botB.name}(${botB.displayName}) 称谓 ${JSON.stringify(botB.wakeNames)}，规则表为空`);

// ===========================================================================
// 2. 端口与文件必须互不冲突（纯静态检查，先把明显错误挡在起进程之前）
// ===========================================================================
section('2. 端口与日志文件隔离');

const specA = buildLaunchSpec(botA, srv, cfg.llm.profiles[0]).spec;
const specB = buildLaunchSpec(botB, srv, cfg.llm.profiles[0]).spec;

// ★★ 最后一道闸：自检**绝不许**连到局域网/互联网上去。
//    上面那两处修复（按意图挑服务器 + 显式绑 serverId）解释的是"为什么会错"，
//    这一条保证的是"错了也出不去" —— 以后配置再怎么排、字段再怎么加，
//    只要 spec 里的地址不是本机，这里就当场拦下，而不是默默跑一遍线上。
for (const [tag, spec] of [['A', specA], ['B', specB]]) {
    if (isLoopbackHost(spec?.server?.host)) {
        ok(`${tag} 的目标服务器是本机：${spec.server.host}:${spec.server.port}`);
    } else {
        fail(`★ 自检要连到 ${spec?.server?.host}:${spec?.server?.port} —— 不是本机，拒绝继续（这套自检只连本机）`);
        console.log('\n结果：✗ 自检的目标服务器不是本机，立刻停下');
        process.exit(1);
    }
}

if (specA.mindserverPort !== specB.mindserverPort) ok(`MindServer 端口不同：A=${specA.mindserverPort} B=${specB.mindserverPort}`);
else fail(`MindServer 端口撞车：都是 ${specA.mindserverPort}，后起的 bot 会起不来`);

const evFileA = paths.logFileFor(botA.id);
const evFileB = paths.logFileFor(botB.id);
if (evFileA !== evFileB) ok(`事件文件不同：${path.basename(evFileA)} / ${path.basename(evFileB)}`);
else fail(`两个 bot 写同一个事件文件：${evFileA} —— 面板上会互相串数据`);

if (specA.profileFile !== specB.profileFile) ok(`生成的引擎 profile 不同：${path.basename(specA.profileFile || '')} / ${path.basename(specB.profileFile || '')}`);
else ok('（profile 路径由引擎侧生成，跳过）');

// "配没配过"必须一路传到 spec —— 门禁就是靠这个字段决定要不要对陌生人开口的
if (specA.ownersConfigured === false) ok('A 的 spec 带上了 ownersConfigured=false（出厂未认领状态）');
else fail(`A 的 spec 里 ownersConfigured=${JSON.stringify(specA.ownersConfigured)}，期望 false —— 传丢了的话首跑提示永远不会出现`);
if (specB.ownersConfigured === true) ok('B 的 spec 带上了 ownersConfigured=true（用户已填过自己的 ID）');
else fail(`B 的 spec 里 ownersConfigured=${JSON.stringify(specB.ownersConfigured)}，期望 true`);
// ★ 未认领时绝不能把出厂占位名喂进人格提示词，否则它会管陌生人叫 Steve
if (!specA.ownerName) ok('A 未认领 → ownerName 留空（人格提示词会退化成「主人」，而不是叫用户 Steve）');
else fail(`A 未认领却把 ownerName 喂成了「${specA.ownerName}」`);
if (specB.ownerName === 'Steve') ok('B 已认领 → ownerName=Steve 正常喂进去');
else fail(`B 已认领但 ownerName=${JSON.stringify(specB.ownerName)}，期望 'Steve'`);
// ===========================================================================
// 3. 同时拉起两个 bot
// ===========================================================================
section('3. 同时拉起两个 bot');

// 清掉两条日志，让统计从零开始
for (const id of [botA.id, botB.id]) { try { fs.rmSync(paths.logFileFor(id), { force: true }); } catch {} }
// ★ 必须先把事件总线接上 —— 平时这两行是 registerIpc() 做的（ipc.mjs:209-210）。
//   忘了接就得到一个"进程起得来、日志有内容、但面板永远显示启动中"的假象：
//   supervisor 收不到任何事件，它的状态只停留在自己乐观置上的 starting。
events.hub.start();
sup.wire();
// hub 的续读 offset 会缓存 —— 清掉，否则读不到新内容
events.hub.tails.clear(); events.hub.ring = [];

const startedAt = Date.now();

const rA = await sup.start(botA.id);
if (rA.ok) ok(`start(${botA.id}) 成功`); else fail(`start(${botA.id}) 失败：${rA.error}`);
const rB = await sup.start(botB.id);
if (rB.ok) ok(`start(${botB.id}) 成功`); else fail(`start(${botB.id}) 失败：${rB.error}`);

// 等两个都连上（★ 别写死"最多等 40 秒"：机器忙的时候实测要 42 秒才 spawn 完，
//   于是每一条后续断言都跟着错位。这里等 150 秒，并把真实耗时打出来。）
const up = await waitFor(() => {
  const a = sup.snapshot(botA.id), b = sup.snapshot(botB.id);
  return a?.mc?.connected && b?.mc?.connected;
}, { timeoutMs: 150000, everyMs: 500 });
const bothUp = up.ok;
if (bothUp && up.ms > 20000) {
  console.log(`  · 两个 bot 冷启动用了 ${secs(up.ms)}（本机通常 5s 左右；慢说明这台机器当时很忙，不是故障）`);
}
const snapA = sup.snapshot(botA.id);
const snapB = sup.snapshot(botB.id);
if (snapA?.mc?.connected) ok(`${botA.displayName} 已上线（等了 ${secs(up.ms)}），血量=${snapA.mc.health} 位置=${JSON.stringify(snapA.mc.position)}`);
else fail(`${botA.displayName} 没连上（等了 ${secs(up.ms)}）：status=${snapA?.status} lastError=${snapA?.lastError}`);
if (snapB?.mc?.connected) ok(`${botB.displayName} 已上线，血量=${snapB.mc.health} 位置=${JSON.stringify(snapB.mc.position)}`);
else fail(`${botB.displayName} 没连上（等了 ${secs(up.ms)}）：status=${snapB?.status} lastError=${snapB?.lastError}`);
if (bothUp) ok('两个 bot 同时在线 —— 多 bot 并行成立');

// 界面上的血量/坐标不该有空白期：拦到 connected 的那一刻就该有数
const haveStats = [snapA, snapB].every((s) => s?.mc?.health != null && s?.mc?.position != null);
if (haveStats) ok(`连上的同时血量坐标就已就绪（A ${snapA.mc.health}/${JSON.stringify(snapA.mc.position)}、B ${snapB.mc.health}/${JSON.stringify(snapB.mc.position)}）`);
else fail(`连上瞬间血量/坐标还是空的：A=${snapA?.mc?.health}/${JSON.stringify(snapA?.mc?.position)} B=${snapB?.mc?.health}/${JSON.stringify(snapB?.mc?.position)}`);

if (snapA?.pid && snapB?.pid && snapA.pid !== snapB.pid) ok(`两个独立进程：A pid=${snapA.pid} B pid=${snapB.pid}`);
else fail(`进程 pid 异常：A=${snapA?.pid} B=${snapB?.pid}`);

const eA0 = readEvents(botA.id);
const eB0 = readEvents(botB.id);
if (eA0.some((e) => e.type === 'mc' && e.kind === 'spawn')) ok('A 的日志里有 spawn 事件（生命周期上报正常）');
else fail('A 的日志里没有 spawn 事件');
if (eB0.some((e) => e.type === 'mc' && e.kind === 'spawn')) ok('B 的日志里有 spawn 事件');
else fail('B 的日志里没有 spawn 事件');

// ===========================================================================
// 4. 让一个真人玩家说话，验证唤醒不串台
// ===========================================================================
section('4. 唤醒隔离：叫 A 只有 A 应，叫 B 只有 B 应');

// Steve 是"主人"视角的测试玩家：他既是被回话的人，也是**唯一能看到公屏**的证人，
// 所以他的客户端必须能自动重连（服务器会随机踢人，见 makeTestPlayer 上面那段注释）。
const steve = makeTestPlayer('Steve');
const player = steve.bot;
const spoken = steve.saw;   // 同一个数组对象：重连之后收到的消息也照样进这个列表

const spawned = await waitSpawn(steve, 30000);
if (spawned) ok('测试玩家 Steve 已进入服务器');
else fail('测试玩家没能进入服务器');

await sleep(2000);
const t0 = Date.now();

// ① 不带称谓：两个 bot 都必须零 token
let mark = Date.now(); await say(player, '大家晚上好，今天天气不错');
// 先等"两个 bot 都听见了"，再数"有没有人放行"（顺序反了就是拿"还没到时候"当结论）
const w1 = await waitFor(() => {
  const a = gates(readEvents(botA.id, mark)), b = gates(readEvents(botB.id, mark));
  return a.some((g) => g.reason === 'rejectedNoWakeName') && b.some((g) => g.reason === 'rejectedNoWakeName');
});
await sleep(1200);
let evA = readEvents(botA.id, mark), evB = readEvents(botB.id, mark);
if (passes(evA).length === 0 && passes(evB).length === 0) ok('不带称谓：两个 bot 都没放行（零 token）');
else fail(`不带称谓却有人放行：A=${passes(evA).length} B=${passes(evB).length}`);
if (w1.ok)
  ok(`两个 bot 都给出了 rejectedNoWakeName（都听见了，都按规则拦下；${secs(w1.ms)} 内到齐）`);
else fail(`没看到两个 bot 各自记下 rejectedNoWakeName（等了 ${secs(w1.ms)}：A 门禁 ${gates(evA).length} 条、B 门禁 ${gates(evB).length} 条）${kickNote(steve)}`);

// ② 叫 A 的名字：只有 A 放行，B 必须拦下
mark = Date.now(); await say(player, '小豆 你好呀');
const w2 = await waitFor(() => passes(readEvents(botA.id, mark)).length >= 1);
const w2b = await waitFor(() => gates(readEvents(botB.id, mark)).some((g) => g.reason === 'rejectedNoWakeName'));
await sleep(1200);
evA = readEvents(botA.id, mark); evB = readEvents(botB.id, mark);
const passA = passes(evA), passB = passes(evB);
if (passA.length >= 1) ok(`叫"小豆"：A 放行 ${passA.length} 次（via=${passA.map((p) => p.via).join(',')}；${secs(w2.ms)}）`);
else fail(`叫"小豆"但 A 没放行（等了 ${secs(w2.ms)}：门禁 ${gates(evA).length} 条）${kickNote(steve)}`);
if (passB.length === 0) ok('叫"小豆"：B 没有放行 —— 唤醒不串台');
else fail(`叫"小豆"时 B 也放行了 ${passB.length} 次 —— 唤醒串台！`);
if (w2b.ok) ok('B 记下了 rejectedNoWakeName（它听见了但没被叫到）');
else fail(`B 没有记下 rejectedNoWakeName（等了 ${secs(w2b.ms)}），说明它可能压根没收到公屏${kickNote(steve)}`);

// ③ 叫 B 的名字：反过来
mark = Date.now(); await say(player, '阿霄 你好呀');
const w3 = await waitFor(() => passes(readEvents(botB.id, mark)).length >= 1);
await sleep(1200);
evA = readEvents(botA.id, mark); evB = readEvents(botB.id, mark);
if (passes(evB).length >= 1) ok(`叫"阿霄"：B 放行 ${passes(evB).length} 次（${secs(w3.ms)}）`);
else fail(`叫"阿霄"但 B 没放行（等了 ${secs(w3.ms)}）${kickNote(steve)}`);
if (passes(evA).length === 0) ok('叫"阿霄"：A 没有放行');
else fail(`叫"阿霄"时 A 也放行了 ${passes(evA).length} 次 —— 唤醒串台！`);

// ④ 私聊免称谓：只发给 A
mark = Date.now(); await say(player, '/msg Xiaodou 在忙吗');
const w4 = await waitFor(() => passes(readEvents(botA.id, mark)).some((p) => p.channel === 'whisper'));
await sleep(1200);
evA = readEvents(botA.id, mark); evB = readEvents(botB.id, mark);
const wA = passes(evA).filter((p) => p.channel === 'whisper');
if (wA.length >= 1) ok(`私聊 A（不带称谓）：A 放行了 —— 私聊免称谓生效（${secs(w4.ms)}）`);
else fail(`私聊 A 却没放行（等了 ${secs(w4.ms)}），私聊免称谓规则可能失效${kickNote(steve)}`);
if (passes(evB).length === 0) ok('私聊 A：B 完全没被唤醒');
else fail(`私聊 A 时 B 也放行了 ${passes(evB).length} 次`);

// ⑤ 防刷屏：同一个人紧接着再说一句，必须被节流拦掉。
//    ★ 这条断言是那次误报换来的：断言全改成事件驱动之后，两句之间只剩 1.5 秒，
//      于是"私聊没放行"被记成失败 —— 其实那是 `rateLimitMs=3000` 在正常工作。
//      既然它是产品行为，就该有一条断言明着盯着它，而不是藏在"测试碰巧隔了 5 秒"里。
mark = Date.now();
player.chat('小豆 你在吗');   // 故意不等：紧贴着上一句发
lastSayAt = Date.now();
const w4r = await waitFor(() => gates(readEvents(botA.id, mark)).some((g) => g.reason === 'rejectedRateLimited'), { timeoutMs: 8000 });
await sleep(800);
evA = readEvents(botA.id, mark);
const sentTooSoon = passes(evA).length;
if (w4r.ok) ok(`挨得太近的第二句被节流拦下（rejectedRateLimited，${secs(w4r.ms)}）—— 防刷屏真的在工作`);
else fail(`紧贴着发的第二句没有被节流（等了 ${secs(w4r.ms)}）—— 防刷屏可能失效，或 rateLimitMs 被改小了${kickNote(steve)}`);
if (sentTooSoon === 0) ok('被节流的那句没有放行（更不会烧 token）');
else fail(`被节流的句子仍然放行了 ${sentTooSoon} 次`);

// ===========================================================================
// 4.5 首跑坑：主人名单里没有的玩家喊话，bot 必须"回一句"而不是永久沉默
// ===========================================================================
//
// 这是这一轮要修的真正问题：出厂配置的 owners 是 ['Steve']，用户用自己的游戏 ID
// 在游戏里喊它，它会**一句话都不回**（`rejectedNotOwner` 之后直接 return）。
// 用户看到的现象是"这软件坏了"，而应用里没有任何提示。
//
// 修法：当且仅当 ownersConfigured === false 时，对名单外的人回一句"我还没被认领"，
// 每玩家每会话只说一次，且公屏必须带唤醒称谓才说（免得对满服陌生人广播）。
//
// 这里用一个**全新名字的玩家 Alex** 来走这条路径（Steve 是 owner，走不到）。
section('4.5 未认领的 bot 对陌生人不该沉默（首跑坑）');

const HINT_MARK = '还没被认领';
const countHints = () => spoken.filter((s) => s.includes(HINT_MARK)).length;

const alex = makeTestPlayer('Alex');
const stranger = alex.bot;
const strangerSaw = alex.saw;   // 同上：重连之后收到的也照样进这个列表

const strangerIn = await waitSpawn(alex, 30000);
if (strangerIn) ok('测试玩家 Alex（不在任一 bot 的主人名单里）已进入服务器');
else fail('测试玩家 Alex 没能进入服务器');

await sleep(2000);

// ① 陌生人公屏喊 A：必须被拦下，但必须回一句话
mark = Date.now();
const before = countHints(); await say(stranger, '小豆 你好呀');
// 既要等到"A 记下了 rejectedNotOwner"，也要等到"那句提示真的发出去了"（两者都是正向期望）
const w5 = await waitFor(() =>
  gates(readEvents(botA.id, mark)).some((g) => g.reason === 'rejectedNotOwner') && countHints() >= before + 1);
await sleep(1200);
evA = readEvents(botA.id, mark);
if (gates(evA).some((g) => g.reason === 'rejectedNotOwner')) ok(`陌生人对 A 喊话：记下了 rejectedNotOwner（没有放行，安全默认值没被破坏；${secs(w5.ms)}）`);
else fail(`陌生人对 A 喊话没记下 rejectedNotOwner（等了 ${secs(w5.ms)}）—— 要么放行了，要么压根没收到`);
if (passes(evA).length === 0) ok('陌生人没有被放行（零 token）');
else fail(`陌生人被放行了 ${passes(evA).length} 次 —— 门禁漏了！`);
if (countHints() === before + 1) ok(`A 回了一句"${HINT_MARK}"—— 用户不会再看到永久沉默`);
else fail([
  `A 的提示句数不对：期望 ${before + 1} 实得 ${countHints()}（原句：${HINT_MARK}）`,
  `      Steve 最近看到的 6 条：${spoken.slice(-6).map((s) => JSON.stringify(s)).join(' | ') || '（一条都没有）'}`,
  `      Alex 最近看到的 6 条：${strangerSaw.slice(-6).map((s) => JSON.stringify(s)).join(' | ') || '（一条都没有）'}`,
  `      gate 最近 6 条：${gates(evA).slice(-6).map((g) => `${g.reason}(${g.from}): ${JSON.stringify(g.msg)}`).join(' | ') || '（一条都没有）'}`,
  `      Steve 被踢过 ${steve.kicks.length} 次、Alex 被踢过 ${alex.kicks.length} 次${steve.kicks.length + alex.kicks.length ? `（最近：${[...steve.kicks, ...alex.kicks].slice(-1)[0]}）` : ''}`,
].join('\n'));
if (strangerSaw.some((s) => s.includes(HINT_MARK))) ok('Alex 本人确实收到了那句提示（不是只写进了日志）');
else fail('Alex 没收到提示 —— 只写进了我们自己的事件流，用户还是看不见');

// ② 同一玩家再说一次：不许重复刷屏
mark = Date.now();
const afterFirst = countHints(); await say(stranger, '小豆 在吗');
// 这里等的是"第二轮的话确实被处理了"，然后才敢数"有没有重复提示"
const w6 = await waitFor(() => gates(readEvents(botA.id, mark)).length >= 1);
await sleep(1500);
evA = readEvents(botA.id, mark);
if (gates(evA).some((g) => g.reason === 'rejectedNotOwner')) ok('陌生人的第二句话仍然被拦下');
else fail(`陌生人的第二句话没被拦下（等了 ${secs(w6.ms)}）`);
if (countHints() === afterFirst) ok('第二句没有再提示 —— 每玩家每会话只说一次，不会刷屏');
else fail(`重复提示了：${afterFirst} → ${countHints()}`);

// ③ 陌生人私聊 A：也已经被提示过，同样不该再说
mark = Date.now(); await say(stranger, '/msg Xiaodou 在吗');
const w7 = await waitFor(() => gates(readEvents(botA.id, mark)).length >= 1);
await sleep(1500);
if (countHints() === afterFirst) ok(`陌生人私聊也不再重复提示（提示过就是提示过，不分公屏私聊；${secs(w7.ms)}）`);
else fail(`私聊又提示了：${afterFirst} → ${countHints()}`);

// ④ ★ 已配置的 B：陌生人喊它，一个字都不该多说
mark = Date.now();
const beforeB = countHints(); await say(stranger, '阿霄 你好呀');
const w8 = await waitFor(() => gates(readEvents(botB.id, mark)).some((g) => g.reason === 'rejectedNotOwner'));
await sleep(1500);
evB = readEvents(botB.id, mark);
if (gates(evB).some((g) => g.reason === 'rejectedNotOwner')) ok(`陌生人喊已配置的 B：记下了 rejectedNotOwner（${secs(w8.ms)}）`);
else fail(`陌生人喊 B 没记下 rejectedNotOwner（等了 ${secs(w8.ms)}）${kickNote(alex)}`);
if (countHints() === beforeB) ok('已配置的 B 保持沉默 —— 提示只在"没被认领"时出现，不会对陌生人自曝');
else fail(`已配置的 B 也提示了陌生人：${beforeB} → ${countHints()}`);

// ⑤ ★ 公屏不带称谓的陌生人：不提示（否则等于对满服广播）
mark = Date.now();
const beforeC = countHints(); await say(stranger, '今天天气不错');
const w9 = await waitFor(() => gates(readEvents(botB.id, mark)).length >= 1);
await sleep(1500);
if (countHints() === beforeC) ok(`陌生人公屏闲聊（不带称谓）没被打扰 —— 提示不广播给全服（${secs(w9.ms)}）`);
else fail(`没带称谓也提示了：${beforeC} → ${countHints()}`);

// ★ 用 close() 而不是 quit()：quit() 会触发 'end'，而 makeTestPlayer 里注册了
// "断了就 800ms 后重连" —— 收尾时反而会多连一次，日志里看着像测试自己抽风。
alex.close();

// ⑥ 总量与 token 计数
const totalA = readEvents(botA.id, t0);
const totalB = readEvents(botB.id, t0);
ok(`A 本次：门禁 ${gates(totalA).length} 条（放行 ${passes(totalA).length}）、大模型 ${llmCalls(totalA).length} 次`);
ok(`B 本次：门禁 ${gates(totalB).length} 条（放行 ${passes(totalB).length}）、大模型 ${llmCalls(totalB).length} 次`);
const tokA = totalA.filter((e) => e.type === 'llm' && e.phase === 'response').reduce((s, e) => s + (e.usage?.totalTokens || 0), 0);
ok(`A 累计 ${tokA} tokens（面板上的数字就是从这条链路来的）`);
if (passes(totalA).length === llmCalls(totalA).length && llmCalls(totalA).length > 0) ok('A：每次放行都对应一次大模型调用（没有偷跑的调用）');
else if (!llmUp) console.log(`  · 假大模型没在跑，本轮大模型调用 ${llmCalls(totalA).length} 次 —— 这条没跑（不是失败）`);
else fail(`A：放行 ${passes(totalA).length} 次但大模型调了 ${llmCalls(totalA).length} 次 —— 有调用绕过了门，或压根没调`);

steve.close();

// ===========================================================================
// 5. 关掉一个，另一个必须不受影响
// ===========================================================================
section('5. 单独关掉 B，A 必须继续在线');

const stopB = await sup.stop(botB.id);
if (stopB.ok) ok('stop(B) 成功');
const stopped = await waitFor(() => sup.snapshot(botB.id)?.status === 'stopped', { timeoutMs: 20000 });
await sleep(1500);
const aAfter = sup.snapshot(botA.id);
const bAfter = sup.snapshot(botB.id);
if (aAfter?.mc?.connected) ok(`关掉 B 之后 A 仍在线（血量=${aAfter.mc.health}）`);
else fail(`关掉 B 把 A 也带下线了：A.status=${aAfter?.status}`);
if (bAfter?.status === 'stopped') ok(`B 已干净停止，没有触发退避重连（${secs(stopped.ms)} 内）`);
else fail(`B 停止后 status=${bAfter?.status}（等了 ${secs(stopped.ms)}）`);

// ===========================================================================
// 收尾
// ===========================================================================
section('收尾');
events.hub.stop();
await sup.stopAll().catch(() => {});
await sleep(1000);

if (userDataUntouched()) ok('用户的 runtime\\config.json 与 secrets.json 全程未被触碰（沙箱隔离，不靠"记得还原"）');
else fail('用户真实配置被改动了！跑 `node tools/fix-config.mjs --apply` 修回来');
ok(`本次全部产物在沙箱里：${path.relative(paths.PROJECT_ROOT, SANDBOX_DIR)}`);

console.log(`\n结果：${problems === 0 ? '✓ 全部通过' : '✗ ' + problems + ' 个问题'}（共 ${checks} 项检查）`);
process.exit(problems === 0 ? 0 : 1);
