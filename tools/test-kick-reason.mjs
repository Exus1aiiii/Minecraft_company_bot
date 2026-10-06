/**
 * tools/test-kick-reason.mjs —— `runner/kick-reason.mjs` 的单元测试。
 *
 * ★ 为什么必须单测：这个模块的输出会**直接出现在界面和日志里**，而它存在的理由就是
 *   把一句 `Disconnected: [object Object]` 变成人话。用户看到的失败长这样：
 *     · 输出里又出现了 `[object Object]`      → 等于没修
 *     · 认不出的原因被"编"成某个已知原因       → 比不修更坏（会把排查引到错的方向）
 *     · 输入是空/怪结构时返回空串             → 界面上一片空白
 *   所以下面除了正常结构，还专门喂空值、怪结构、以及真实观测到的那串 protodef 结构。
 *
 * 跑法：node tools\test-kick-reason.mjs
 * 退出码：0 = 全过；1 = 有断言失败。
 */

import { KICK_REASONS, flattenChat, rawOf, decodeKick, describeKick } from '../runner/kick-reason.mjs';

let pass = 0;
let fail = 0;

function ok(cond, label) {
    if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
    const good = actual === expected;
    if (good) { pass++; console.log(`  ✓ ${label}`); } else {
        fail++;
        console.log(`  ✗ ${label}\n      期望：${JSON.stringify(expected)}\n      实际：${JSON.stringify(actual)}`);
    }
}
function has(actual, needle, label) {
    const good = typeof actual === 'string' && actual.includes(needle);
    if (good) { pass++; console.log(`  ✓ ${label}`); } else {
        fail++;
        console.log(`  ✗ ${label}\n      期望包含：${JSON.stringify(needle)}\n      实际：${JSON.stringify(actual)}`);
    }
}
function section(title) { console.log(`\n── ${title} ──`); }

// ─────────────────────────────────────────────────────────────
section('真实观测到的结构（用户 m11391 那次断线的形状）');

// 引擎日志里那句 `[LoginGuard] Disconnected: [object Object]` 背后的东西，
// 就是下面这个嵌套结构（1.21.1 的 kick reason 由 protodef 解出来）。
const REAL = { type: 'compound', value: { translate: { type: 'string', value: 'multiplayer.disconnect.invalid_player_movement' } } };

has(describeKick(REAL), '位置数据', '官方那个"移动数据不对"的原因翻成了中文');
ok(!describeKick(REAL).includes('[object Object]'), '不再出现 [object Object]');
eq(decodeKick(REAL).key, 'multiplayer.disconnect.invalid_player_movement', 'decodeKick 取到了 translate key');
eq(decodeKick(REAL).known, true, '这个 key 是认识的');
eq(decodeKick(REAL).args.length, 0, '没有占位参数');

const REAL_JSON = JSON.stringify(REAL);
eq(describeKick(REAL_JSON), describeKick(REAL), '同一结构以 JSON 字符串形式传进来，结果一致');

// .out.log 里另一次（早先那轮）观测到的是 duplicate_login，同样是这个形状。
const DUP = { type: 'compound', value: { translate: { type: 'string', value: 'multiplayer.disconnect.duplicate_login' } } };
has(describeKick(DUP), '已经在服务器上', 'duplicate_login 翻成"这个名字已经在服务器上了"');
ok(!describeKick(DUP).includes('multiplayer.disconnect'), '认识的原因不再把英文 key 甩给玩家');

// ─────────────────────────────────────────────────────────────
section('别的输入形状');

has(describeKick('Kicked by an operator'), 'Kicked by an operator', '纯字符串原因原样转述（加了"服务器说："前缀）');
has(describeKick('Kicked by an operator'), '服务器说：', '纯字符串走的是"转述"这条路，不是"编原因"');
eq(describeKick({ type: 'string', value: '服务器要重启了' }), '服务器说：服务器要重启了', '{type:string,value} 节点按原文处理');
eq(describeKick([{ text: '服务器' }, { text: '要重启' }]), '服务器说：服务器要重启', '数组里多段文字拼起来');
eq(describeKick({ text: '线路维护', extra: [{ text: '（10 分钟）' }] }), '服务器说：线路维护（10 分钟）', 'extra 里的补充文字也接上');
has(describeKick({ translate: 'multiplayer.disconnect.kicked', with: ['Exus1aiiii'] }), 'Exus1aiiii', '带占位参数的原因把参数也说出来');
has(describeKick({ translate: 'multiplayer.disconnect.kicked', with: ['Exus1aiiii'] }), '管理员', 'kicked 翻成"被服务器管理员踢出去了"');
has(describeKick({ translate: 'multiplayer.disconnect.banned' }), '封', 'banned 翻成封禁');

// ─────────────────────────────────────────────────────────────
section('认不出的原因：只许如实说，不许编');

const UNKNOWN = { type: 'compound', value: { translate: { type: 'string', value: 'multiplayer.disconnect.a_brand_new_reason' } } };
has(describeKick(UNKNOWN), 'multiplayer.disconnect.a_brand_new_reason', '认不出的 key 原样摆出来，方便去查');
has(describeKick(UNKNOWN), '服务器给的原始原因', '并明确说这是"原始原因"，不是我们的解释');
ok(!describeKick(UNKNOWN).includes('位置数据'), '★ 认不出时不许套用别的已知原因（那会把排查引偏）');
eq(decodeKick(UNKNOWN).known, false, 'known=false');
eq(decodeKick(UNKNOWN).cn, null, 'cn=null');

const PLAIN_EN = 'You are not whitelisted on this server!';
has(describeKick(PLAIN_EN), PLAIN_EN, '不认识的英文原文照转，不硬翻');

// ─────────────────────────────────────────────────────────────
section('空值 / 怪结构：永远不返回空、永远不返回 [object Object]');

const WEIRD = [
    null, undefined, '', '   ', 0, 'null', {}, [], [{}, {}],
    { value: {} }, { type: 'compound', value: {} },
    { type: 'compound', value: { translate: {} } },
    { type: 'translate', value: '' },
    { text: '' },
    { translate: null },
];
let emptyCount = 0;
let objectCount = 0;
for (const w of WEIRD) {
    const out = describeKick(w);
    if (typeof out !== 'string' || !out.trim()) emptyCount++;
    if (out.includes('[object Object]')) objectCount++;
}
eq(emptyCount, 0, `★ 每种怪输入都有一句话（喂了 ${WEIRD.length} 种）`);
eq(objectCount, 0, '★ 每种怪输入都不会冒出 [object Object]');
ok(describeKick(null).includes('没有说原因') || describeKick(null).includes('断开'), '什么都没有时如实说"没说原因/断开了"');
has(describeKick(''), '没有说原因', '空字符串也走"没说原因"这条路');

// ─────────────────────────────────────────────────────────────
section('flattenChat / rawOf 这些零件');

const f = flattenChat(REAL);
eq(f.translate, 'multiplayer.disconnect.invalid_player_movement', 'flattenChat 直接给出 translate');
eq(f.literal, '', '这种结构里没有 literal');
eq(flattenChat({ type: 'compound', value: { text: 'hi' } }).literal, 'hi', 'compound 里的 text 被拆出来');
eq(flattenChat('{"a":1}').literal, '', '不像聊天结构的 JSON 不会被硬拆（走兜底）');
eq(flattenChat(42).literal, '42', '数字变字符串');
eq(flattenChat({ translate: { type: 'string', value: 'multiplayer.disconnect.flying' } }).translate, 'multiplayer.disconnect.flying', 'translate 是嵌套节点时也能取到 key');
ok(flattenChat(REAL, 7).translate === null, '★ 深度超限就停手（防环/防深层嵌套卡住）');
eq(rawOf(REAL), JSON.stringify(REAL), 'rawOf 给的是稳定原文');
eq(rawOf('abc'), 'abc', 'rawOf 对字符串原样返回');

const tableCount = Object.keys(KICK_REASONS).length;
ok(tableCount >= 12, `原因表里有 ${tableCount} 条官方 key`);

// ─────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '✓' : '✗'} kick-reason：${pass} 项通过，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
