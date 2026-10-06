// ============================================================================
// 多**服务器**并行自检 —— 用户的原始需求原话是"可多服务器并行的服务器地址设置部分"。
//
// 和 headless-multibot.mjs 的区别：
//   multibot    两个 bot 在**同一台**服务器上  → 验证"多 bot"
//   multiserver 两个 bot 在**两台**服务器上    → 验证"多服务器并行"
// 两者是不同的代码路径：前者共用 host/port，后者每个 bot 走自己的 serverId。
//
// 前置条件：两台测试服都在跑
//   25565  testserver\   （原版 server.jar）
//   25566  testserver2\  （原版 server.jar）
// 缺第二台时本脚本会**跳过**而不是失败（不让别人的环境跑不动）。
//
// 用法：
//   node --import ./devtools/register-electron-stub.mjs devtools\headless-multiserver.mjs
//
// 安全阀：模型一律指向本地假大模型，命中真 API 域名直接退出。
// 隔离：全程跑在 runtime\tmp\sandbox-selftest\，不碰用户的 config.json。
// ============================================================================

import './sandbox-env.mjs';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { createRequire } from 'node:module';

import * as paths from '../app/electron/paths.mjs';
import * as store from '../app/electron/store.mjs';
import { buildLaunchSpec } from '../app/electron/launcher.mjs';
import { supervisor as sup } from '../app/electron/supervisor.mjs';
import * as events from '../app/electron/events.mjs';
import { applyEnginePatches } from '../runner/engine-patches.mjs';
import { REAL_CONFIG_FILE, pickLoopbackServer, isLoopbackHost } from './sandbox-env.mjs';

const require = createRequire(path.join(paths.ENGINE_DIR, 'package.json'));
const mineflayer = require('mineflayer');

const HOST_A = process.env.MCBOT_TEST_HOST_A || '127.0.0.1';
const PORT_A = Number(process.env.MCBOT_TEST_PORT_A || 25565);
const HOST_B = process.env.MCBOT_TEST_HOST_B || '127.0.0.1';
const PORT_B = Number(process.env.MCBOT_TEST_PORT_B || 25566);
const MC_VERSION = process.env.MCBOT_TEST_VERSION || '1.21.1';

const LLM_URL = process.env.MCBOT_HEADLESS_LLM_URL || 'http://127.0.0.1:8799/v1';
const LLM_MODEL = process.env.MCBOT_HEADLESS_LLM_MODEL || 'mcbot-spike-model';
if (/api\.deepseek\.com|dashscope|openai\.com/i.test(LLM_URL)) {
  console.error(`拒绝用真实 API 跑自动测试（${LLM_URL}）`);
  process.exit(2);
}

let problems = 0;
let checks = 0;
const ok = (m) => { checks++; console.log('  ✓ ' + m); };
const fail = (m) => { checks++; problems++; console.log('  ✗ ' + m); };
const skip = (m) => { console.log('  · ' + m); };
const section = (t) => console.log(`\n=== ${t} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on('unhandledRejection', (e) => fail('未处理的 Promise 拒绝：' + (e?.stack || e)));
process.on('uncaughtException', (e) => fail('未捕获异常：' + (e?.stack || e)));

const userCfgHash0 = fs.existsSync(REAL_CONFIG_FILE)
  ? crypto.createHash('sha256').update(fs.readFileSync(REAL_CONFIG_FILE)).digest('hex') : null;

function portOpen(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

/** 在进程内 ping 一台服务器，拿在线人数 */
function pingServer(host, port) {
  applyEnginePatches(() => {});
  const ping = require('minecraft-protocol').ping;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: '超时' }), 10000);
    try {
      ping({ host, port }, (err, res) => {
        clearTimeout(timer);
        if (err) return resolve({ ok: false, error: err.message });
        resolve({ ok: true, version: res?.version?.name, online: res?.players?.online, max: res?.players?.max });
      });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    }
  });
}

// ===========================================================================
section('0. 前置检查：两台服务器都得在跑');

if (!(await portOpen(PORT_A, HOST_A))) {
  fail(`${HOST_A}:${PORT_A} 没在监听 —— 先起第一台测试服`);
  console.log(`\n结果：✗ 前置条件不满足（共 ${checks} 项检查）`);
  process.exit(1);
}
ok(`${HOST_A}:${PORT_A} 在监听`);

if (!(await portOpen(PORT_B, HOST_B))) {
  skip(`${HOST_B}:${PORT_B} 没在监听 —— 跳过整个多服务器自检`);
  console.log(`\n结果：· 已跳过（共 ${checks} 项检查）`);
  process.exit(0);
}
ok(`${HOST_B}:${PORT_B} 在监听`);

// ===========================================================================
section('1. 准备"两台服务器 + 两个 bot"的配置');

events.hub.start();
sup.wire();

const cfg = store.loadConfigRaw();
for (const p of cfg.llm.profiles) { p.baseUrl = LLM_URL; p.model = LLM_MODEL; }

// 服务器 A 沿用用户的第一个 server；服务器 B 新建
// ★ 按意图挑"本机那台"，不是按位置挑 servers[0] —— 见 sandbox-env.mjs 里
//   `isLoopbackHost` 的注释。用户把自己的服务器加进配置并排在前面之后，
//   `servers[0]` 就不再是本机服了。
const srvA = pickLoopbackServer(cfg.servers) || cfg.servers[0];
Object.assign(srvA, { host: HOST_A, port: PORT_A, version: MC_VERSION, auth: 'offline' });

const SRV_B_ID = 'srv-test2';
let srvB = cfg.servers.find((s) => s.id === SRV_B_ID);
if (!srvB) { srvB = store.makeServer('第二台测试服（25566）', HOST_B, PORT_B, MC_VERSION, 'offline'); srvB.id = SRV_B_ID; cfg.servers.push(srvB); }
else Object.assign(srvB, { host: HOST_B, port: PORT_B, version: MC_VERSION, auth: 'offline' });

const botA = cfg.bots.find((b) => b.id === 'bot-xiaodou') || cfg.bots[0];
botA.serverId = srvA.id;
botA.llmProfileId = cfg.llm.profiles[0].id;
botA.enabled = true;

const B_ID = 'bot-axiao';
let botB = cfg.bots.find((b) => b.id === B_ID);
if (!botB) {
  botB = store.makeBot('Axiao', '阿霄', srvB.id, cfg.llm.profiles[0].id);
  Object.assign(botB, {
    id: B_ID, enabled: true,
    wakeNames: ['阿霄', 'axiao', '霄霄'], owners: ['Steve'],
    rateLimitMs: 3000, dailyTokenBudget: 200000, personaId: 'builder',
    skin: { model: 'classic', path: '', enabled: false },
  });
  cfg.bots.push(botB);
}
// ★ 关键：B 绑到**另一台服务器**
botB.serverId = srvB.id;
botB.llmProfileId = cfg.llm.profiles[0].id;
botB.enabled = true;
botB.rules = [];   // 清空规则，便于"放行次数 == 大模型调用次数"的计数断言

// ★★ 唤醒称谓和主人名单必须**无条件钉死**，不能只写在上面那个 `if (!botB)` 里。
//    这个脚本是从**用户的真配置**（沙箱副本）里找 `bot-axiao` 的：只要它存在，
//    上面那段就整个被跳过，测试于是偷偷依赖"用户那台 bot 的主人正好叫 Steve"。
//    用户给出自己的游戏 ID、我们把 `bot-axiao.owners` 改成他那一个 ID
//    之后，这个自检立刻变红，报的是「B 收不到自己服务器上的公屏？」—— 而真相是
//    门禁按新名单把 Steve 判成了陌生人（`rejectedNotOwner`），跟服务器隔离毫无关系。
//    凡是被断言的性质，都要由测试自己摆好，不能指望用户的数据凑巧符合。
botB.wakeNames = ['阿霄', 'axiao', '霄霄'];
botB.owners = ['Steve'];
botB.ownersConfigured = true;
// A 也一样：这里的两条断言（"A 没被唤醒"）同样不该受用户名单影响
botA.owners = ['Steve'];
botA.ownersConfigured = true;

const errors = store.validateConfig(cfg);
if (errors.length === 0) ok('配置校验通过');
else fail('配置校验不通过：' + errors.join('；'));

store.saveConfigRaw(cfg);
store.setSecret(cfg.llm.profiles[0].id, 'sk-multiserver-fake');

ok(`服务器 A = ${srvA.label} @ ${srvA.host}:${srvA.port}`);
ok(`服务器 B = ${srvB.label} @ ${srvB.host}:${srvB.port}`);
ok(`bot A ${botA.displayName} → 服务器 A（${botA.serverId}）`);
ok(`bot B ${botB.displayName} → 服务器 B（${botB.serverId}）`);

if (botA.serverId !== botB.serverId) ok('两个 bot 绑在不同的服务器上 —— 这正是本脚本要验的东西');
else fail('两个 bot 还绑在同一台服务器上，这个自检就没有意义了');

// ===========================================================================
section('2. 静态隔离：端口与事件文件');

const specA = buildLaunchSpec(botA, srvA, cfg.llm.profiles[0]).spec;
const specB = buildLaunchSpec(botB, srvB, cfg.llm.profiles[0]).spec;

// ★★ 最后一道闸：自检绝不许连到本机以外（见 headless-multibot.mjs 里同一条的说明）。
for (const [tag, spec] of [['A', specA], ['B', specB]]) {
    if (isLoopbackHost(spec?.server?.host)) ok(`${tag} 的目标服务器是本机：${spec.server.host}:${spec.server.port}`);
    else {
        fail(`★ 自检要连到 ${spec?.server?.host}:${spec?.server?.port} —— 不是本机，拒绝继续`);
        console.log('\n结果：✗ 自检的目标服务器不是本机，立刻停下');
        process.exit(1);
    }
}

if (specA.mindserverPort !== specB.mindserverPort) ok(`MindServer 端口不同：A=${specA.mindserverPort} B=${specB.mindserverPort}`);
else fail(`MindServer 端口撞车：都是 ${specA.mindserverPort}`);

if (paths.logFileFor(botA.id) !== paths.logFileFor(botB.id)) ok(`事件文件不同：${path.basename(paths.logFileFor(botA.id))} / ${path.basename(paths.logFileFor(botB.id))}`);
else fail('两个 bot 共用一个事件文件，日志会串台');

if (specA.server.port === PORT_A && specB.server.port === PORT_B) ok(`启动参数里的服务器地址分别正确：A=${specA.server.port} B=${specB.server.port}`);
else fail(`启动参数里的服务器地址不对：A=${specA.server.port}（应为 ${PORT_A}）B=${specB.server.port}（应为 ${PORT_B}）`);

// 清掉上一次的日志，避免旧事件干扰
for (const id of [botA.id, botB.id]) {
  fs.rmSync(paths.logFileFor(id), { force: true });
  fs.rmSync(sup.rawLogFileFor(id), { force: true });
  events.hub.tails.clear();
  events.hub.ring = events.hub.ring.filter((e) => e.botId !== id);
}

// ===========================================================================
section('3. 同时拉起两个 bot（各连各的服务器）');

const rA = await sup.start(botA.id);
if (rA.ok) ok(`start(${botA.id}) 成功`);
else fail(`start(${botA.id}) 失败：${rA.error || JSON.stringify(rA.errors)}`);

const rB = await sup.start(botB.id);
if (rB.ok) ok(`start(${botB.id}) 成功`);
else fail(`start(${botB.id}) 失败：${rB.error || JSON.stringify(rB.errors)}`);

let upA = false; let upB = false;
for (let i = 0; i < 70; i++) {
  await sleep(500);
  upA = !!sup.snapshot(botA.id)?.mc?.connected;
  upB = !!sup.snapshot(botB.id)?.mc?.connected;
  if (upA && upB) break;
}
const snapA = sup.snapshot(botA.id);
const snapB = sup.snapshot(botB.id);
if (upA) ok(`${botA.displayName} 已上线（血量 ${snapA.mc.health}，位置 ${JSON.stringify(snapA.mc.position)}）`);
else fail(`${botA.displayName} 没连上：status=${snapA?.status} lastError=${snapA?.lastError}`);
if (upB) ok(`${botB.displayName} 已上线（血量 ${snapB.mc.health}，位置 ${JSON.stringify(snapB.mc.position)}）`);
else fail(`${botB.displayName} 没连上：status=${snapB?.status} lastError=${snapB?.lastError}`);
if (upA && upB) ok('两个 bot 分别连在两台服务器上，同时在线');

// ★ 最硬的证据：从引擎自己的输出日志里读它到底连了哪个端口
await sleep(1200);
for (const [bot, wantPort, wantName] of [[botA, PORT_A, 'A'], [botB, PORT_B, 'B']]) {
  const f = sup.rawLogFileFor(bot.id);
  let txt = '';
  try { txt = fs.readFileSync(f, 'utf8'); } catch {}
  const m = /MC server found\.\s*\(Host:\s*([^,]+),\s*Port:\s*(\d+)/.exec(txt);
  if (!m) fail(`${wantName} 的引擎日志里找不到 "MC server found"（连上了吗？）`);
  else if (Number(m[2]) === wantPort) ok(`${wantName} 的引擎实际连的是 ${m[1]}:${m[2]} —— 与配置一致`);
  else fail(`${wantName} 的引擎连的是 ${m[1]}:${m[2]}，配置里写的是 ${wantPort} —— 连错服务器了！`);
}

// 独立确认：两台服务器各自的在线人数
const pA = await pingServer(HOST_A, PORT_A);
const pB = await pingServer(HOST_B, PORT_B);
if (pA.ok) ok(`服务器 A 自报：${pA.online}/${pA.max} 人在线（版本 ${pA.version}）`);
else fail(`服务器 A ping 失败：${pA.error}`);
if (pB.ok) ok(`服务器 B 自报：${pB.online}/${pB.max} 人在线（版本 ${pB.version}）`);
else fail(`服务器 B ping 失败：${pB.error}`);
if (pA.ok && pB.ok && pA.online === pB.online) {
  skip(`两边在线人数相同（各 ${pA.online}）—— 说明确实各连了一台，没有都挤到同一台`);
} else if (pA.ok && pB.ok) {
  ok(`两台在线人数不同（A=${pA.online} B=${pB.online}）—— 更直接地说明是分开的`);
}

// ===========================================================================
section('4. 跨服务器唤醒隔离');

// 假玩家只进服务器 B
const player = mineflayer.createBot({
  host: HOST_B, port: PORT_B, username: 'Steve', auth: 'offline', version: MC_VERSION,
  checkTimeoutInterval: 60_000,
});
let playerUp = false;
await new Promise((resolve) => {
  const t = setTimeout(resolve, 30_000);
  player.once('spawn', () => { clearTimeout(t); playerUp = true; resolve(); });
  player.once('error', () => { clearTimeout(t); resolve(); });
  player.once('kicked', () => { clearTimeout(t); resolve(); });
});
if (playerUp) ok(`测试玩家 Steve 已进入服务器 B（${PORT_B}）`);
else fail('测试玩家没能进入服务器 B');

const say = async (text, waitMs = 9000) => { player.chat(text); await sleep(waitMs); };

const gatesFor = (botId) => events.hub.recent(botId, 500).filter((e) => e.type === 'gate');
const passesFor = (botId) => gatesFor(botId).filter((e) => e.decision === 'PASS');
const llmFor = (botId) => events.hub.recent(botId, 500).filter((e) => e.type === 'llm' && e.phase === 'response');

if (playerUp) {
  // ① 在服务器 B 上叫 A 的名字 —— A 在另一台服务器上，根本收不到
  const beforeA = passesFor(botA.id).length;
  await say(`小豆 你好呀`);
  const afterA = passesFor(botA.id).length;
  if (afterA === beforeA) ok(`在服务器 B 上叫"小豆"：A 完全没被唤醒（它在服务器 A 上，收不到 B 的公屏）`);
  else fail(`在服务器 B 上叫"小豆"，A 竟然放行了 ${afterA - beforeA} 次 —— 两台服务器串台了！`);

  // ② 在服务器 B 上叫 B 的名字 —— 应该正常响应
  const beforeB = passesFor(botB.id).length;
  await say(`阿霄 你好呀`);
  const afterB = passesFor(botB.id).length;
  if (afterB > beforeB) ok(`在服务器 B 上叫"阿霄"：B 正常放行（+${afterB - beforeB} 次）`);
  else fail('在服务器 B 上叫"阿霄"却没有放行 —— B 收不到自己服务器上的公屏？');

  // ③ B 每次放行都该对应一次大模型调用，A 一次都不该有
  const llmB = llmFor(botB.id).length;
  const llmA = llmFor(botA.id).length;
  if (llmB > 0) ok(`B 产生了 ${llmB} 次大模型调用（面板上的 token 就是从这条链路来的）`);
  else fail('B 放行了却没有任何大模型调用 —— 链路断了');
  if (llmA === 0) ok('A 全程 0 次大模型调用 —— 跨服务器零串台');
  else fail(`A 产生了 ${llmA} 次大模型调用，它不该被服务器 B 上的话唤醒`);
} else {
  skip('测试玩家没上线，跳过第 4 节');
}

// ===========================================================================
section('5. 关掉 B，A 必须不受影响');

const stopB = await sup.stop(botB.id);
if (stopB.ok) ok('stop(B) 成功');
else fail('stop(B) 失败：' + stopB.error);
await sleep(2500);
const afterStopA = sup.snapshot(botA.id);
if (afterStopA?.status === 'running' && afterStopA?.mc?.connected) {
  ok(`关掉 B 之后 A 仍在线（血量 ${afterStopA.mc.health}）—— 关一台不影响另一台`);
} else {
  fail(`关掉 B 把 A 也带下线了：A.status=${afterStopA?.status}`);
}
if (sup.snapshot(botB.id)?.status === 'stopped') ok('B 已干净停止，没有触发退避重连');
else fail(`B 停止后状态是 ${sup.snapshot(botB.id)?.status}，说明它又被自动拉起来了`);

// ===========================================================================
section('收尾');
try { player.quit(); } catch {}
events.hub.stop();
await sup.stopAll().catch(() => {});
await sleep(1000);

const nowHash = fs.existsSync(REAL_CONFIG_FILE)
  ? crypto.createHash('sha256').update(fs.readFileSync(REAL_CONFIG_FILE)).digest('hex') : null;
if (nowHash === userCfgHash0) ok('用户的 runtime\\config.json 全程未被触碰（沙箱隔离）');
else fail('用户真实配置被改动了！跑 `node tools/fix-config.mjs --apply` 修回来');

console.log(`\n结果：${problems === 0 ? '✓ 全部通过' : '✗ ' + problems + ' 个问题'}（共 ${checks} 项检查）`);
process.exit(problems === 0 ? 0 : 1);
