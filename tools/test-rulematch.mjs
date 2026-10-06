/**
 * tools/test-rulematch.mjs —— 话头匹配的单元测试。
 *
 * 为什么单独测它：这是"零 token 通路"的入口。命中 → 直接发引擎命令，
 * 一句话不发给大模型；落空 → **悄悄退回大模型**，白花几千 token 还多等两秒，
 * 而界面上那条规则明明开着。这种 bug 不报错，只是安静地变贵 ——
 * 所以它必须被测到，而且必须用**真机上真实出现过的那句话**来测。
 *
 * 跑法：node tools/test-rulematch.mjs
 */

import { MAX_FILLER, patternHits, matchRule, explainMatch } from '../runner/rulematch.mjs';
import { DEFAULT_RULES, migrateConfig } from '../app/electron/store.mjs';

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); } };
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label}${JSON.stringify(a) === JSON.stringify(b) ? '' : `（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`}`);

const hit = (text, pattern) => patternHits(text, pattern);
const ruleOf = (text) => matchRule(DEFAULT_RULES, text)?.id ?? null;

console.log('\n=== 1. 不带 * 的话头：行为和以前一模一样 ===');
ok(hit('跟着我', '跟着我'), '「跟着我」命中「跟着我」');
ok(!hit('跟着', '跟着我'), '「跟着」不命中「跟着我」（不能只匹配一半）');
ok(!hit('我着跟', '跟着我'), '乱序不算命中');
ok(hit('大家好啊跟着我走', '跟着我'), '包含在长句里也命中');
ok(!hit('随便说点什么', '跟着我'), '不相干的话不命中');
ok(!hit('', ''), '空话头不命中任何东西（防呆）');
ok(!hit('随便说点什么', ''), '空话头不命中（空串被挡住）');
ok(!hit(null, '跟着我'), 'text 不是字符串时返回 false，不抛');

console.log('\n=== 2. 带 * 的话头：中间塞字也命中 ===');
ok(hit('报坐标', '报*坐标'), '「报坐标」——一个字没塞，也命中');
ok(hit('报一下坐标', '报*坐标'), '★「报一下坐标」（真机上就是这么说的，当时落空了）');
ok(hit('报个坐标', '报*坐标'), '「报个坐标」');
ok(hit('报一下我的坐标', '报*坐标'), '「报一下我的坐标」（塞了 3 个字）');
ok(hit('看一下背包', '看*背包'), '「看一下背包」');
ok(hit('看下背包', '看*背包'), '「看下背包」');
ok(hit('盖一座大房子', '盖*房子'), '「盖一座大房子」（塞了 3 个字）');
ok(hit('盖个房子', '盖*房子'), '「盖个房子」');

console.log('\n=== 3. * 的三条边界（不能放宽到"什么都算命中"）===');
ok(!hit('坐标报一下', '报*坐标'), '★ 顺序反了不算 —— 不会退化成"都出现过就算"');
ok(!hit('报' + '啊'.repeat(MAX_FILLER + 1) + '坐标', '报*坐标'), `★ 塞超过 ${MAX_FILLER} 个字不算（塞太多就不是同一句话了）`);
ok(hit('报' + '啊'.repeat(MAX_FILLER) + '坐标', '报*坐标'), `塞满 ${MAX_FILLER} 个字仍然算`);
ok(!hit('今天天气不错', '报*坐标'), '完全不相关的话不命中');
ok(!hit('砍价砍了半天，后来我们去种树了', '砍*树'), '★「砍*树」不会匹配隔了老远的一句话');
// 「砍完这棵树…」中间只隔 3 个字，**算命中是对的** —— 那确实是在说砍树。
// 这条断言是故意留着的：它把"我们到底容忍多宽"钉在测试里，改 MAX_FILLER 时会立刻看见。
ok(hit('砍完这棵树', '砍*树'), '「砍完这棵树」算命中（隔 3 个字，是同一句话）');

console.log('\n=== 4. 正则元字符必须被转义（用户可以自己写话头）===');
ok(hit('价格是 (3) 块', '(3)'), '话头里的括号按字面匹配');
ok(!hit('价格是 3 块', '(3)'), '「(3)」不会因为没转义变成分组而误命中');
ok(hit('a.b', 'a.b'), '话头里的点按字面匹配（不是"任意字符"）');
ok(!hit('axb', 'a.b'), '★「a.b」不会匹配「axb」—— 点没被当成通配');
ok(hit('问他[1]', '[1]'), '方括号按字面匹配');
ok(!hit('问他1', '[1]'), '「[1]」不会因为没转义变成字符组');
ok(hit('算一下 1+2', '1+2'), '加号按字面匹配');
ok(hit('哇(选填)好的', '哇(选填)好'), '带括号的话头中间塞字也能通配');

console.log('\n=== 5. 真机上真实说过的每一句话，都要落在正确的规则上 ===');
// 这些句子全部来自真机实测记录（含"当时落空、白花 token"的那几句）——
// 用真实语料测，比我自己造句可靠得多。
const CASES = [
  ['跟着我', 'follow'],
  ['小豆 你在哪', 'where'],
  ['报一下坐标', 'where'],          // ← 真机上落空，白花了 5109 token
  ['报个坐标', 'where'],
  ['你背包里有什么', 'inventory'],
  ['看一下背包', 'inventory'],
  ['停下', 'stop'],
  ['过来', 'come'],
  ['来我这边', 'come'],
  ['砍点木头', 'collect'],
  ['挖点石头', 'collect'],
  ['挖 10 个石头', 'collect'],
  ['收集一些沙子', 'collect'],
  ['附近有铁矿吗', 'seek'],         // ← 真机上落空过一次
  ['附近有没有钻石', 'seek'],
  ['哪有煤矿', 'seek'],
  ['四处走走', 'explore'],
  ['随便逛逛', 'explore'],
  ['盖个房子', 'build'],
  ['盖一座大房子', 'build'],
  ['帮我盖个小木屋', 'build'],
  ['记住我喜欢钻石', 'remember'],
  ['你还记得我喜欢什么吗', 'recall'],
  ['做把铁镐', 'craft'],
  ['做个熔炉', 'craft'],
  ['烧点铁锭', 'craft'],
];
for (const [text, want] of CASES) {
  const got = ruleOf(text);
  ok(got === want, `「${text}」→ ${want}${got === want ? '' : `（实际 ${got}）`}`);
}

console.log('\n=== 6. 不该被任何规则抢走的话（闲聊要留给大模型）===');
const CHITCHAT = [
  '今天天气不错',
  '你好呀',
  '你叫什么名字',
  '我有点无聊',
  '这个游戏真好玩',
  '你觉得我该干什么',
  '讲个笑话吧',
];
for (const text of CHITCHAT) {
  ok(ruleOf(text) === null, `「${text}」不该命中任何规则（实际 ${ruleOf(text)}）`);
}

console.log('\n=== 7. 规则表的形状（内置规则不能互相抢）===');
ok(DEFAULT_RULES.length >= 12, `内置规则至少 12 条（现在 ${DEFAULT_RULES.length} 条）`);
const ids = DEFAULT_RULES.map((r) => r.id);
ok(new Set(ids).size === ids.length, '规则 id 不重复');
ok(DEFAULT_RULES.every((r) => Array.isArray(r.patterns) && r.patterns.length > 0), '每条规则都有话头');
ok(DEFAULT_RULES.every((r) => r.patterns.every((p) => typeof p === 'string' && p.length > 0)), '没有空话头');
// 先匹配到的赢 —— 所以重复的话头等于后面的那条永远废掉
const all = [];
let dup = null;
for (const r of DEFAULT_RULES) for (const p of r.patterns) { if (all.includes(p)) dup = p; all.push(p); }
ok(dup === null, `话头没有重复（重复的话后面的规则会永远废掉）${dup ? `（重复：${dup}）` : ''}`);

console.log('\n=== 8. explainMatch 能说清"到底哪条抢到了" ===');
{
  const hits = explainMatch(DEFAULT_RULES, '报一下坐标');
  ok(hits.length >= 1 && hits[0].id === 'where', '「报一下坐标」的第一条命中是 where');
  ok(hits.some((h) => h.wildcard), '并且标出了它是靠通配命中的（排错时要知道这个）');
  eq(explainMatch(DEFAULT_RULES, '今天天气不错'), [], '闲聊的命中列表是空的');
}

console.log('\n=== 9. 迁移：老配置里的话头要能刷成新版（但用户改过的不许碰）===');
{
  const mk = (patterns) => ({ bots: [{ id: 'b1', rules: [{ id: 'where', enabled: true, action: 'stats', patterns }] }] });

  // ① 还是最早那版内置话头 → 刷成新版
  const cfgA = mk(['你在哪', '报坐标']);
  migrateConfig(cfgA);
  const whereA = cfgA.bots[0].rules.find((r) => r.id === 'where');
  ok(whereA.patterns.includes('报*坐标'), '★ 旧内置话头 → 刷成带通配的新版');
  ok(ruleOf('报一下坐标') === 'where', '刷完之后「报一下坐标」真的能命中了');

  // ② 用户自己改过 → 一个字都不碰
  const cfgB = mk(['我自己写的话头']);
  migrateConfig(cfgB);
  eq(cfgB.bots[0].rules.find((r) => r.id === 'where').patterns, ['我自己写的话头'],
    '★ 用户改过的话头原样保留（用户的改动比我们的新默认值重要）');

  // ③ 跨版本：还停在 seek 的 v1 话头，也要能一步刷到最新
  const cfgC = { bots: [{ id: 'b1', rules: [{ id: 'seek', enabled: true, action: 'searchForBlock', patterns: ['找找', '找一下', '附近有没有', '哪有', '哪里有', '带我去找'] }] }] };
  migrateConfig(cfgC);
  ok(cfgC.bots[0].rules.find((r) => r.id === 'seek').patterns.includes('附近*有'),
    '★ 停在 v1 的 seek 话头能一步刷到最新（不用逐版升级）');

  // ④ 缺失的规则照常补齐
  const cfgD = { bots: [{ id: 'b1', rules: [{ id: 'where', enabled: true, action: 'stats', patterns: ['你在哪'] }] }] };
  migrateConfig(cfgD);
  ok(cfgD.bots[0].rules.length >= 12, `缺失的内置规则被补齐（补到 ${cfgD.bots[0].rules.length} 条）`);
}

console.log('\n=== 10. 迁移是幂等的（跑两遍不会越改越乱）===');
{
  const mk = () => ({ bots: [{ id: 'b1', rules: null }] });
  const a = mk(); migrateConfig(a); const first = JSON.stringify(a);
  migrateConfig(a); const second = JSON.stringify(a);
  ok(first === second, '第一次迁移后就是稳定态');

  const b = mk(); migrateConfig(b);
  const c = mk(); migrateConfig(c); migrateConfig(c);
  ok(JSON.stringify(b) === JSON.stringify(c), '跑一遍和跑两遍结果一样');
}

console.log(`\n结果：${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}（共 ${pass + fail} 项检查，失败 ${fail} 项）`);
process.exit(fail === 0 ? 0 : 1);
