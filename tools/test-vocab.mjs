// 中文意图词典的单元测试。
//
// 最有价值的一组断言是第 ① 组：拿**引擎自己那份 minecraft-data** 逐个校验词典里的
// 方块 id。词典是手写的，写错一个字母（`oak_planks` 写成 `oak_plank`）不会报错，
// 只会在用户说"砍点木头"时静默失败 —— 那种 bug 靠肉眼是查不出来的。
//
// 跑法：node tools/test-vocab.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { BLOCK_WORDS, parseCollectIntent, parseCount, cnToNumber, resolveBlock } from '../runner/vocab.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const ENGINE_DIR = path.join(PROJECT_ROOT, 'vendor', 'mindcraft-develop');
const MC_VERSION = process.env.MCBOT_TEST_VERSION || '1.21.1';

let checks = 0;
let problems = 0;
function ok(msg) { checks++; console.log(`  ✓ ${msg}`); }
function fail(msg) { checks++; problems++; console.log(`  ✗ ${msg}`); }
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(`${msg} → ${a}`);
  else fail(`${msg}\n      期望 ${e}\n      实际 ${a}`);
}
function section(t) { console.log(`\n=== ${t} ===`); }

// ---------------------------------------------------------------------------
section(`1. 词典里的方块 id 在 minecraft-data ${MC_VERSION} 里真的存在`);

const requireEngine = createRequire(path.join(ENGINE_DIR, 'package.json'));
const minecraftData = requireEngine('minecraft-data');
const mcData = minecraftData(MC_VERSION);
if (!mcData) {
  fail(`minecraft-data 里没有 ${MC_VERSION} 的数据，测试无法进行`);
  process.exit(1);
}
ok(`载入 minecraft-data ${MC_VERSION}（protocol ${mcData.version.version}）`);

let badBlocks = 0;
for (const entry of BLOCK_WORDS) {
  const block = mcData.blocksByName[entry.block];
  if (!block) { fail(`词条「${entry.label}」的方块 id 不存在：${entry.block}`); badBlocks++; }
  else if (!entry.words || entry.words.length === 0) { fail(`词条「${entry.label}」没有配置任何中文词`); badBlocks++; }
  else if (!(entry.defaultCount >= 1)) { fail(`词条「${entry.label}」的 defaultCount 不是正数：${entry.defaultCount}`); badBlocks++; }
}
if (badBlocks === 0) ok(`全部 ${BLOCK_WORDS.length} 条词条的方块 id、中文词、默认数量都合法`);

// 反向查重：两个词条指向同一个方块会让"最长词优先"的消歧变得没有意义
const byBlock = new Map();
for (const e of BLOCK_WORDS) byBlock.set(e.block, (byBlock.get(e.block) || 0) + 1);
const dupBlocks = [...byBlock.entries()].filter(([, n]) => n > 1);
if (dupBlocks.length === 0) ok('没有两个词条指向同一个方块');
else fail(`有方块被重复定义：${dupBlocks.map(([b]) => b).join(', ')}`);

// ---------------------------------------------------------------------------
section('2. 中文数字');

for (const [input, expected] of [
  ['一', 1], ['两', 2], ['三', 3], ['九', 9],
  ['十', 10], ['十五', 15], ['二十', 20], ['二十三', 23], ['三十', 30], ['九十九', 99],
]) eq(cnToNumber(input), expected, `cnToNumber('${input}')`);

for (const bad of ['', '零', '一百', 'abc', '十十']) {
  const r = cnToNumber(bad);
  if (r === null) ok(`cnToNumber('${bad}') → null（不瞎猜）`);
  else fail(`cnToNumber('${bad}') 应该是 null，实际 ${r}`);
}

// ---------------------------------------------------------------------------
section('3. 数量解析');

for (const [input, expected] of [
  ['挖 20 个石头', 20],
  ['挖二十个石头', 20],
  ['砍三棵树', 3],
  ['帮我弄 5 块木头', 5],
  ['去 100 64 200 挖 8 个石头', 8],   // 坐标不是数量，量词才是判据
  ['去 100 64 200 挖点石头', null],   // ★ 抠掉坐标三元组之后就没有数字了
  ['采一点木头', null],               // ★ 模糊量词的"一"不是数量
  ['收一下小麦', null],               // ★ "一下"的"一"不是数量
  ['等我一会儿', null],               // ★ "一会儿"的"一"不是数量
  ['挖 20 石头', 20],                 // 没量词的阿拉伯数字仍然认
  ['挖二十石头', null],               // ★ 没量词的中文数字不认（太容易误判）
]) eq(parseCount(input), expected, `parseCount('${input}')`);

// ---------------------------------------------------------------------------
section('4. 意图识别（含最关键的消歧）');

for (const [input, block, count] of [
  ['去砍点木头', 'oak_log', 10],
  ['小豆 砍20个木头', 'oak_log', 20],
  ['帮我挖点石头', 'stone', 20],
  ['挖点圆石', 'cobblestone', 20],       // ★ 不能被「石」抢走
  ['挖点钻石', 'diamond_ore', 6],        // ★ 不能被「石」抢走
  ['去挖铁矿', 'iron_ore', 12],
  ['挖点铁矿石', 'iron_ore', 12],        // ★ 不能被「铁矿」的短词逻辑搞乱
  ['收一下小麦', 'wheat', 16],
  ['砍点白桦', 'birch_log', 10],
  ['挖点煤炭', 'coal_ore', 16],
  ['搞点沙子', 'sand', 20],
]) {
  const got = parseCollectIntent(input);
  if (!got) { fail(`parseCollectIntent('${input}') 返回 null，但应该认出 ${block}`); continue; }
  if (got.block === block && got.count === count) ok(`'${input}' → ${got.label} × ${got.count}（${got.block}）`);
  else fail(`'${input}' → 期望 ${block} × ${count}，实际 ${got.block} × ${got.count}`);
}

section('5. 认不出时必须返回 null（宁可退回大模型，也不要猜错）');
for (const input of [
  '你好呀，能听见我说话吗',
  '大家晚上好，今天天气不错',
  '你背包里有什么',
  '跟着我',
  '帮我建个房子吧',     // 建房是另一条路，不能当成采集
  '今天心情不错',
]) {
  eq(parseCollectIntent(input), null, `parseCollectIntent('${input}')`);
}

section('6. resolveBlock 的返回形状');
const r = resolveBlock('去砍点木头');
if (r && r.block === 'oak_log' && r.label === '橡木' && r.word === '木头') ok(`resolveBlock 返回 {block,label,word,defaultCount}：${JSON.stringify(r)}`);
else fail(`resolveBlock 形状不对：${JSON.stringify(r)}`);

// ---------------------------------------------------------------------------
console.log(`\n结果：${problems === 0 ? '✓ 全部通过' : '✗ ' + problems + ' 个问题'}（共 ${checks} 项检查）`);
process.exit(problems === 0 ? 0 : 1);
