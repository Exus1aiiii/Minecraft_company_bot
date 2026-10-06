/**
 * devtools/test-firstrun.mjs —— "主人名单配没配过"这条链路的单元测试（快，不起引擎）。
 *
 * ★ 为什么要有这一套：
 *   出厂配置的 `owners` 是 `['Steve']` —— 一个**看起来像真配置**的占位符。
 *   它是非空的，所以 `store.validateConfig` 的"必须指定主人"不报错，
 *   `views/bots.js` 的"没有配 owner"警告也不显示。用户用自己的游戏 ID 在游戏里
 *   喊它，门禁走到 `rejectedNotOwner` 就 `return` —— **一句话都不回**。
 *   用户唯一能得出的结论是"这软件坏了"。
 *
 *   修法是在配置里显式记一个 `ownersConfigured`，但这条链路跨了四个文件
 *   （store 归一化 → launcher 生成 spec → engine-launcher 透传 → mcbot-gate 决策），
 *   任何一段丢字段，现象都是"回到永久沉默"，而且**不会报错**。
 *   所以这里逐段钉死。端到端那条（真的对陌生人说话）在 headless-multibot.mjs 第 4.5 节。
 *
 * 跑法：node --import ./devtools/register-electron-stub.mjs devtools\test-firstrun.mjs
 * 退出码：0 = 全过；1 = 有断言失败。
 */

import './sandbox-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../app/electron/store.mjs';
import { buildLaunchSpec } from '../app/electron/launcher.mjs';
import { SANDBOX_DIR } from './sandbox-env.mjs';

let pass = 0;
let fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
    const good = JSON.stringify(actual) === JSON.stringify(expected);
    if (good) { pass++; console.log(`  ✓ ${label}`); } else {
        fail++; console.log(`  ✗ ${label}\n      期望 ${JSON.stringify(expected)}\n      实得 ${JSON.stringify(actual)}`);
    }
}
function section(title) { console.log(`\n${title}`); }

// ════════════════════════════════════════════════════════════════════════════
section('1. isFactoryOwners：出厂占位符的判定');

ok(store.isFactoryOwners(['Steve']) === true, "出厂原样 ['Steve'] → true");
ok(store.isFactoryOwners(['steve']) === true, '大小写不敏感');
ok(store.isFactoryOwners(['  Steve  ']) === true, '两头空格不算区别（手改过 config 的人会留空格）');
ok(store.isFactoryOwners(['Steve', 'Alex']) === false, "['Steve','Alex'] → false（用户把自己的 ID 加上去了）");
ok(store.isFactoryOwners(['Notch']) === false, "换成别的名字 → false");
ok(store.isFactoryOwners([]) === false, '空名单 → false（那不是"出厂"，是"没配"）');
ok(store.isFactoryOwners(null) === false, 'null 不崩，返回 false');
ok(store.isFactoryOwners(undefined) === false, 'undefined 不崩，返回 false');
eq(store.FACTORY_OWNERS, ['Steve'], 'FACTORY_OWNERS 就是 [\'Steve\'] —— 别处不许再手写这个字面量');

// ════════════════════════════════════════════════════════════════════════════
section('2. 出厂配置 / makeBot 都必须是"未认领"');

const factory = store.defaultConfig();
const fb = (factory.bots || [])[0];
ok(Boolean(fb), '出厂配置里有一台机器人');
eq(fb?.ownersConfigured, false, '★ 出厂 bot 的 ownersConfigured=false（这就是首跑提示的触发条件）');
eq(fb?.owners, ['Steve'], '出厂 owners 仍然是 Steve 占位（保持向后兼容，不改用户的既有行为）');

const mb = store.makeBot('Newbie', '新伙伴', 'srv-x', 'prof-x');
eq(mb.ownersConfigured, false, 'makeBot() 新建的也是 false');
eq(mb.owners, [], 'makeBot() 的名单是空的');

// ════════════════════════════════════════════════════════════════════════════
section('3. normalizeConfig：显式标记 + 老配置的升级路径');

const n1 = store.normalizeConfig({ bots: [{ id: 'b1', name: 'Aaa', owners: ['Steve'] }] });
eq(n1.bots[0].ownersConfigured, false, '老配置里 owners 正好是出厂值 → 推断为"没配过"');

const n2 = store.normalizeConfig({ bots: [{ id: 'b1', name: 'Aaa', owners: ['Notch'] }] });
eq(n2.bots[0].ownersConfigured, true, '★ 老配置（没有这个字段的年代写的）里 owners 是别的名字 → 推断为"配过了"');

const n3 = store.normalizeConfig({ bots: [{ id: 'b1', name: 'Aaa', owners: ['Steve'], ownersConfigured: true }] });
eq(n3.bots[0].ownersConfigured, true, '★ 显式 true 优先：用户就是把名字填成了 Steve，也不许再骚扰他');

const n4 = store.normalizeConfig({ bots: [{ id: 'b1', name: 'Aaa', owners: ['Notch'], ownersConfigured: false }] });
eq(n4.bots[0].ownersConfigured, false, '显式 false 也优先（用户手动改回去的意图要尊重）');

const n5 = store.normalizeConfig({ bots: [{ id: 'b1', name: 'Aaa', owners: [] }] });
eq(n5.bots[0].ownersConfigured, false, '空名单 → 没配过');

const n6 = store.normalizeConfig({ bots: [{ id: 'b1', name: 'Aaa' }] });
eq(n6.bots[0].owners, [], 'owners 字段缺失 → 归一化成空数组而不是崩');
eq(n6.bots[0].ownersConfigured, false, '字段整个缺失 → 没配过');

// ════════════════════════════════════════════════════════════════════════════
section('4. 落盘往返：这个标记必须活得下来');

const cfgFile = path.join(SANDBOX_DIR, 'config.json');
const round = store.normalizeConfig({
    ...store.defaultConfig(),
    bots: [{ id: 'bot-round', name: 'Round', displayName: '往返', owners: ['Notch'], ownersConfigured: true }],
});
store.saveConfigRaw(round);
const back = store.loadConfigRaw();
const rb = (back.bots || []).find((b) => b.id === 'bot-round');
eq(rb?.ownersConfigured, true, '★ 存盘再读回来，ownersConfigured 还在（不然重启一次提示就回来了）');
ok(fs.existsSync(cfgFile), '沙箱里确实写了配置文件（确认测的是沙箱不是用户真配置）');

// ════════════════════════════════════════════════════════════════════════════
section('5. validateConfig：安全默认值没被这次改动放松');

const bad = store.normalizeConfig({ ...store.defaultConfig(), bots: [{ id: 'b1', name: 'Aaa', owners: [] }] });
const errs = store.validateConfig(bad);
ok(errs.some((e) => e.includes('主人')), '空主人名单仍然报错（fail closed 没被放松）');

// ════════════════════════════════════════════════════════════════════════════
section('6. buildLaunchSpec：标记与 ownerName 一起进 spec');

const srv = { id: 'srv-x', host: '127.0.0.1', port: 25565, version: '1.21.1', auth: 'offline' };
const prof = { id: 'p1', baseUrl: 'http://127.0.0.1:8799/v1', model: 'fake', temperature: 0.5, maxTokens: 100, timeoutMs: 1000 };

const unclaimed = { ...store.makeBot('Xiaodou', '小豆', 'srv-x', 'p1'), owners: ['Steve'], ownersConfigured: false };
const sA = buildLaunchSpec(unclaimed, srv, prof).spec;
eq(sA.ownersConfigured, false, '未认领 → spec.ownersConfigured=false');
eq(sA.ownerName, '', '★ 未认领 → spec.ownerName 留空（不把 Steve 喂进人格提示词）');
eq(sA.owners, ['Steve'], 'owners 名单本身照旧传下去（门禁还是要按它放行）');

const claimed = { ...store.makeBot('Xiaodou', '小豆', 'srv-x', 'p1'), owners: ['Notch'], ownersConfigured: true };
const sB = buildLaunchSpec(claimed, srv, prof).spec;
eq(sB.ownersConfigured, true, '已认领 → spec.ownersConfigured=true');
eq(sB.ownerName, 'Notch', '已认领 → ownerName 正常喂进去');

// ★ spec 里的字段必须**永远是布尔**，不能漏出 undefined。
//   下游两处（engine-launcher 透传、mcbot-gate `config.ownersConfigured === true`）
//   都是拿它做判断的：漏出 undefined 会静默变成"没配置"，
//   于是对着一屋子陌生人喊"来改我配置"—— 那比沉默更糟。
const legacy = { ...store.makeBot('Xiaodou', '小豆', 'srv-x', 'p1'), owners: ['Notch'] };
delete legacy.ownersConfigured;
const sC = buildLaunchSpec(legacy, srv, prof).spec;
ok(sC.ownersConfigured === true || sC.ownersConfigured === false,
    '★ spec.ownersConfigured 永远是布尔，不会漏出 undefined');
eq(sC.ownersConfigured, false, '字段缺失 → 当"没配过"（我们自己的 spec 一定带这个字段，缺失只可能是拼装漏了）');
eq(sC.ownerName, '', '字段缺失时 ownerName 也留空（宁可叫「主人」，也不叫错名字）');

// ════════════════════════════════════════════════════════════════════════════
section('7. 密钥：分得清"没填"和"填了个假的"');

// ★ 为什么这也是首跑坑：早期自检把 `sk-multibot-fake` 写进了**用户的**
//   runtime\secrets.json。界面上它显示成「已保存（sk-…fake）」，和真密钥一模一样 ——
//   用户会以为"密钥我填过了"，然后对着一个永远 401 的 bot 找半天原因。

ok(store.looksLikePlaceholderKey('sk-multibot-fake') === true, 'sk-multibot-fake → 假（就是真发生过的那一条）');
ok(store.looksLikePlaceholderKey('sk-test-fake') === true, 'sk-test-fake → 假');
ok(store.looksLikePlaceholderKey('sk-headless-abcdefghijklmnop') === true, 'sk-headless-… → 假');
ok(store.looksLikePlaceholderKey('sk-headless-test-1234567890') === true, '中间夹着 test 的 → 假');
ok(store.looksLikePlaceholderKey('your-api-key-here') === true, 'your-api-key-here → 假');
ok(store.looksLikePlaceholderKey('changeme') === true, 'changeme → 假');

// 真密钥不许被误伤 —— 这是这套判定唯一真正危险的方向：
// 把真密钥说成假的，用户会去反复重填一把本来好好的 Key。
const REAL = 'sk-3f9a2c7e15b84d60af13c9e7204b5d8e'; // publish-audit:ignore —— 随机编的夹具，不是任何人的真密钥
ok(store.looksLikePlaceholderKey(REAL) === false, '★ 真密钥（sk- + 32 位随机）→ 不判假');
ok(store.looksLikePlaceholderKey('sk-abcdefghijklmnopqrstuvwxyz012345') === false, '★ 全字母的真密钥 → 不判假'); // publish-audit:ignore —— 同上，夹具
ok(store.looksLikePlaceholderKey('') === false, '空串 → false（"没填"和"填了假的"是两回事）');
ok(store.looksLikePlaceholderKey(null) === false, 'null 不崩');
ok(store.looksLikePlaceholderKey(undefined) === false, 'undefined 不崩');

// 掩码规则本身：短密钥不许把内容漏出来
eq(store.maskKey('sk-short'), '****', '短密钥只显示 ****（不泄漏长度和内容）');
eq(store.maskKey(''), '', '空密钥 → 空串');
eq(store.maskKey(REAL), 'sk-…5d8e', '长密钥显示 前3…后4');

// 状态要真的透到 UI 那一层（store → ipc → 渲染进程走的就是 secretStates/loadConfigForUi）
const pid = (store.loadConfigRaw().llm?.profiles || [])[0]?.id;
ok(Boolean(pid), '沙箱配置里至少有一个模型（下面拿它的 id 做密钥落盘往返）');
store.setSecret(pid, 'sk-multibot-fake');
const ui = store.loadConfigForUi();
const fakeProf = (ui.llm.profiles || []).find((p) => p.id === pid);
eq(fakeProf?.hasKey, true, '假密钥也算"有密钥"（不能骗自己说没填）');
eq(fakeProf?.keyIsPlaceholder, true, '★ 但必须额外标出来"这是占位符" —— 界面靠这个字段显示警告');
ok(!JSON.stringify(ui).includes('sk-multibot-fake'), '★ 明文密钥不许出现在回传给渲染进程的配置里（安全不变量）');

store.clearSecret(pid);
const ui2 = store.loadConfigForUi();
const goneProf = (ui2.llm.profiles || []).find((p) => p.id === pid);
ok(!goneProf || goneProf.hasKey === false, '清掉之后就回到"还没保存密钥"');

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✓' : '✗'} firstrun：${pass} 项通过，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
