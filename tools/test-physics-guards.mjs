// mineflayer "非法移动包" 守卫的回归测试（4.33.0 + 我们的 patch）。
//
// 为什么要有这一套：用户真机上 bot 上线约 10~16 秒就被踢，引擎日志里只有
// `[LoginGuard] Disconnected: [object Object]`，服务端日志里是
// `lost connection: Invalid move player packet received` —— 也就是
// multiplayer.disconnect.invalid_player_movement。上游后来在 physics.js 里
// 补了两类守卫（NaN 位置不发、重生后延迟回 position_look），我们把它移植进了
// `vendor\mindcraft-develop\patches\mineflayer+4.33.0.patch`。
//
// ⚠️ 这个 bug 的要害是"补丁没打上时**一切看起来都正常**"：bot 照样上线、照样说话、
//    十几秒后才被踢。所以这套测试既查"补丁装上了没有"（字面量），也**真的把
//    mineflayer 的 physics.js 注入一个假 bot 跑起来**，确认坏值进不了网络包
//    —— 只查字符串是查不出"守卫写错了地方"的。
//
// 跑法：node tools/test-physics-guards.mjs

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const ENGINE_DIR = path.join(PROJECT_ROOT, 'vendor', 'mindcraft-develop');
const PATCH_FILE = path.join(ENGINE_DIR, 'patches', 'mineflayer+4.33.0.patch');
const PHYSICS_FILE = path.join(ENGINE_DIR, 'node_modules', 'mineflayer', 'lib', 'plugins', 'physics.js');
const MC_VERSION = process.env.MCBOT_TEST_VERSION || '1.21.1';

let checks = 0;
let problems = 0;
function ok(msg) { checks++; console.log(`  ✓ ${msg}`); }
function fail(msg) { checks++; problems++; console.log(`  ✗ ${msg}`); }
function must(cond, msg, why) {
  if (cond) ok(msg);
  else fail(`${msg}${why ? `\n      ${why}` : ''}`);
}
function section(t) { console.log(`\n=== ${t} ===`); }

const requireEngine = createRequire(path.join(ENGINE_DIR, 'package.json'));
const { Vec3 } = requireEngine('vec3');
const minecraftData = requireEngine('minecraft-data');
const mcData = minecraftData(MC_VERSION);
if (!mcData) {
  console.error(`✗ minecraft-data 里没有 ${MC_VERSION} 的数据，测试无法进行`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
section('1. 补丁与装完之后的文件里，守卫真的在（查"补丁没打上"这类静默失败）');

const patchText = fs.readFileSync(PATCH_FILE, 'utf8');
const physicsText = fs.readFileSync(PHYSICS_FILE, 'utf8');

must(
  patchText.includes('diff --git a/node_modules/mineflayer/lib/plugins/physics.js'),
  'patch 文件里有 physics.js 这一段',
  '没有它，干净机器上 npm install 出来的 mineflayer 就是没守卫的裸版本',
);
const NEEDLES = [
  ['NaN 位置不发 position', 'if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z))'],
  ['NaN 朝向不发 look', 'if (!Number.isFinite(yaw) || !Number.isFinite(pitch))'],
  ['死后不再算坐标', "// Don't send position with invalid coordinates (NaN after death)"],
  ['重生后延迟回包', 'respawnTimer'],
  ['坏值日志（中文，能顺带抓出编码写坏）', '拦下一个非法移动包'],
];
for (const [what, needle] of NEEDLES) {
  must(physicsText.includes(needle), `已安装的 physics.js 里有「${what}」`, `找不到：${needle}`);
}
must(
  patchText.includes('拦下一个非法移动包'),
  'patch 文件本身是 UTF-8 且中文没写坏',
  '中文串烂掉说明 patch 被当 GBK 重写过，干净机器上打出来的日志会是乱码',
);

// ---------------------------------------------------------------------------
section('2. 把 physics.js 真的注入一个假 bot，验证坏值进不了网络包');

const written = [];
let lore = [];
const realError = console.error;
console.error = (...args) => { lore.push(args.map(String).join(' ')); };

// 总闸：正常跑约 3 秒。★ 万一守卫丢了，`await bot.look(NaN, …)` 会一直等一个永远不会来的
// 'move' 事件（脏值把 yaw 变成 NaN 之后 yawChange 永远不等于 0）—— 卡死比报错难查得多，
// 所以到点自己收尾、报红、退出 1。（故意不 unref：事件循环空掉时 node 会以 0 退出，
// 那就把"卡死"粉饰成"通过"了。）
const watchdog = setTimeout(() => {
  console.error = realError;
  console.log('\n结果：✗ 卡住超过 15 秒（多半是守卫丢了：某个 await 在等一个永远不会发生的事件）');
  process.exit(1);
}, 15000);

const bot = new EventEmitter();
bot.registry = mcData;
bot.version = MC_VERSION;
bot.game = { gameMode: 'survival' };
bot.isAlive = true;
bot.inventory = { slots: [] };
bot.entity = {
  id: 1,
  position: new Vec3(10, 64, 10),
  velocity: new Vec3(0, 0, 0),
  yaw: 0,
  pitch: 0,
  onGround: true,
  eyeHeight: 1.62,
  height: 1.8,
  effects: {},
};
bot.blockAt = () => null;
bot._client = new EventEmitter();
bot._client.state = 'play';
bot._client.write = (name, params) => { written.push({ name, params: { ...(params || {}) } }); };
bot.supportFeature = (f) => f === 'teleportUsesOwnPacket';

const physics = requireEngine('mineflayer/lib/plugins/physics.js');
let injected = true;
try {
  physics(bot, { physicsEnabled: true, maxCatchupTicks: 4 });
} catch (e) {
  injected = false;
  fail(`注入 physics.js 时抛异常：${e.message}`);
}
if (injected) ok('physics.js 注入假 bot 成功（说明补丁没有把文件改坏）');

function badPacketSent () {
  return written.some(({ params }) =>
    [params.x, params.y, params.z, params.yaw, params.pitch]
      .some((v) => typeof v === 'number' && !Number.isFinite(v)));
}
function badLogSeen () { return lore.some((l) => l.includes('拦下一个非法移动包')); }

// --- 2.1 朝向上传坏值 -----------------------------------------------------------------
lore = [];
written.length = 0;
await bot.look(NaN, 0);
await bot.look(0.5, NaN);
await bot.look(undefined, undefined);
must(written.length === 0, 'bot.look(NaN/undefined) 一个包都没发出去',
  `实际发了：${JSON.stringify(written.map((w) => w.name))}`);
must(Number.isFinite(bot.entity.yaw) && Number.isFinite(bot.entity.pitch),
  '坏朝向没有污染 bot.entity.yaw / pitch（否则之后每一帧都会发 NaN）',
  `yaw=${bot.entity.yaw} pitch=${bot.entity.pitch}`);
must(badLogSeen(), '坏值被写进日志（用户真机复现时能一眼看到是谁传进来的）');

// --- 2.2 正常朝向仍然照常工作（守卫不能把好值也拦了）-------------------------------
written.length = 0;
await bot.look(1.0, 0.5, true);
must(Math.abs(bot.entity.yaw - 1.0) < 0.02 && Number.isFinite(bot.entity.pitch),
  `正常的 bot.look(1.0, 0.5, true) 仍然生效（yaw=${bot.entity.yaw.toFixed(3)}）`);

// --- 2.3 服务端传送：好值要回声 ------------------------------------------------------
let forcedMove = 0;
bot.on('forcedMove', () => { forcedMove++; });
written.length = 0;
bot._client.emit('position', { x: 12, y: 70, z: 12, yaw: 1, pitch: 0.2, flags: 0, teleportId: 7 });
must(written.some((w) => w.name === 'teleport_confirm' && w.params.teleportId === 7),
  '正常传送会回 teleport_confirm（没有被守卫误伤）');
const pl = written.find((w) => w.name === 'position_look');
must(!!pl && !badPacketSent(), '正常传送的 position_look 照样发出去，且数值都是有限的');
must(forcedMove === 1, '正常传送仍然发出 forcedMove 事件');

// --- 2.4 服务端传送：坏坐标不许回声 --------------------------------------------------
const badLogCount = () => lore.filter((l) => l.includes('拦下一个非法移动包')).length;
const logsBefore = badLogCount();
written.length = 0;
bot._client.emit('position', { x: NaN, y: 70, z: 12, yaw: 1, pitch: 0.2, flags: 0, teleportId: 8 });
must(!badPacketSent(), '传送包里是 NaN 时，position_look 没有发出去（这正是服务端踢人的那一包）');
must(logsBefore >= 1, '坏值确实被写进了日志（不是默默吞掉）');
must(
  badLogCount() === logsBefore,
  '连着来 5 秒内的同类坏值只记一次日志（真机上不会被刷屏把关键行糊掉）',
  `${logsBefore} → ${badLogCount()} 条`,
);
bot.entity.position.set(10, 64, 10); // 复原，免得后面的用例被污染

// --- 2.5 物理循环里坐标变成 NaN（"死亡瞬间那一帧"）-----------------------------------
lore = [];
written.length = 0;
bot.entity.position.x = NaN;
bot.emit('login');            // 启动 50ms 一次的物理循环
await new Promise((r) => setTimeout(r, 250));
bot.emit('end');              // 停掉定时器
must(!badPacketSent(), '物理循环跑了 5 帧，NaN 坐标一个包都没发出去');
must(!/Invalid|Cannot read|undefined/.test(lore.join('\n')), '物理循环里没有抛异常刷屏',
  `日志：${lore.slice(0, 3).join(' | ')}`);
bot.entity.position.x = 10;

// --- 2.6 死亡/重生后必须延迟回 position_look（旧服务端会踢立刻回的那个）-------------
written.length = 0;
bot.emit('death');
bot._client.emit('position', { x: 10, y: 64, z: 10, yaw: 0, pitch: 0, flags: 0, teleportId: 9 });
const immediately = written.filter((w) => w.name === 'position_look').length;
must(immediately === 0, '刚死亡那一下没有立刻回 position_look（延迟 1.5 秒）',
  `实际立刻回了 ${immediately} 个`);
await new Promise((r) => setTimeout(r, 1700));
const afterWait = written.filter((w) => w.name === 'position_look').length;
must(afterWait === 1, '1.5 秒后补上了那个 position_look（服务端要靠它完成重生）',
  `实际 ${afterWait} 个 —— 少了说明重生会卡住，多了说明延迟没生效`);

console.error = realError;
clearTimeout(watchdog);

// ---------------------------------------------------------------------------
console.log(`\n结果：${problems === 0 ? '✓ 全部通过' : '✗ ' + problems + ' 个问题'}（共 ${checks} 项检查）`);
process.exit(problems === 0 ? 0 : 1);
