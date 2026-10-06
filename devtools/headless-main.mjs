// devtools/headless-main.mjs
// 无头主进程自检：在纯 Node 里把 app/electron 的主进程逻辑跑一遍。
//
// 为什么需要它：这个执行环境起不来 Chromium（Electron 启动即 0xC0000005），
// 所以「窗口」无法自动验证；但主进程里除开窗口之外的一切——配置读写、密钥托管、
// 进程守护、事件翻译、IPC 契约——都能跑。这个脚本就是那部分的回归测试。
//
// 用法（必须带 --import，钩子要在被测模块之前就位）：
//   node --import ./devtools/register-electron-stub.mjs devtools/headless-main.mjs
//
// 环境变量：
//   MCBOT_HEADLESS_REAL_ENGINE=1   真的起一个引擎进程（需要假大模型在 8799 上）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// ★ 必须是第一个"有副作用"的 import：它把用户数据目录重定向到沙箱。
//   第 9 节要起真引擎，就得把配置落盘成"指向本地假模型"；从前进沙箱之前
//   靠的是"先备份、跑完还原"，而管道被截断时进程会被硬杀、还原根本跑不到
//   （用户配置因此被污染过一次）。现在物理上碰不到用户的文件。
import { SANDBOX_DIR, REAL_CONFIG_FILE, pickLoopbackServer } from './sandbox-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

let problems = 0;
let checks = 0;
const ok = (m) => {
  checks += 1;
  console.log('  ✓ ' + m);
};
const fail = (m) => {
  checks += 1;
  problems += 1;
  console.log('  ✗ ' + m);
};
const section = (t) => console.log(`\n=== ${t} ===`);

process.on('unhandledRejection', (e) => {
  fail('未处理的 Promise 拒绝：' + (e?.stack || e));
});
process.on('uncaughtException', (e) => {
  fail('未捕获异常：' + (e?.stack || e));
});

// ---------------------------------------------------------------------------
section('1. 模块加载（electron 已被假模块顶替）');

const stub = await import('./electron.mjs');
const paths = await import('../app/electron/paths.mjs');
const store = await import('../app/electron/store.mjs');
const envMod = await import('../app/electron/env.mjs');
const llm = await import('../app/electron/llm.mjs');
const events = await import('../app/electron/events.mjs');
const launcher = await import('../app/electron/launcher.mjs');
const supervisorMod = await import('../app/electron/supervisor.mjs');
const ipcMod = await import('../app/electron/ipc.mjs');

ok('7 个主进程模块全部加载成功');
ok(`PROJECT_ROOT = ${paths.PROJECT_ROOT}`);
ok(`CONFIG_FILE  = ${paths.CONFIG_FILE}`);

// ---------------------------------------------------------------------------
section('2. 配置读写与校验');

const cfg = store.defaultConfig();
ok(`defaultConfig() 产出 ${cfg.bots.length} 个 bot / ${cfg.servers.length} 个服务器 / ${cfg.llm.profiles.length} 个模型`);

const errs = store.validateConfig(cfg);
if (errs.length === 0) ok('默认配置校验通过');
else fail('默认配置没通过校验：\n      - ' + errs.join('\n      - '));

// 故意造几处非法，确认校验器真的会拦
const bad = JSON.parse(JSON.stringify(cfg));
bad.bots[0].name = 'bad name!';
const badErrs = store.validateConfig(bad);
if (badErrs.length > 0) ok(`非法 bot 名被拦下：${badErrs[0]}`);
else fail('非法 bot 名没被拦下 —— 校验器有漏洞');

const normalized = store.normalizeConfig({ bots: 'not-an-array', servers: null });
if (Array.isArray(normalized.bots) && Array.isArray(normalized.servers))
  ok('normalizeConfig 能容忍类型错误的配置（界面永远能打开）');
else fail('normalizeConfig 没有修复畸形配置');

// ---------------------------------------------------------------------------
section('3. 密钥托管（假 safeStorage 默认模拟"系统加密不可用"）');

const pid = cfg.llm.profiles[0].id;
store.setSecret(pid, 'sk-headless-test-1234567890');
const got = store.getSecret(pid);
if (got === 'sk-headless-test-1234567890') ok('密钥能存能取');
else fail(`密钥往返不一致：拿到 ${JSON.stringify(got)}`);

const states = store.secretStates();
const st = states[pid];
if (st && st.present) ok(`secretStates() 报告已配置，掩码 = ${st.hint}（加密可用=${states.__encryptionAvailable} 明文降级=${states.__plaintextFallback}）`);
else fail('secretStates() 没报告出来：' + JSON.stringify(states));

const raw = JSON.parse(fs.readFileSync(paths.SECRETS_FILE, 'utf8'));
const encFlag = raw?.[pid]?.enc;
if (encFlag === false) ok('加密不可用时如实标记 enc=false（降级分支生效）');
else ok(`加密可用标记 enc=${encFlag}`);

store.clearSecret(pid);
if (store.getSecret(pid) == null) ok('clearSecret 能清掉');
else fail('clearSecret 没清干净');

// ---------------------------------------------------------------------------
section('4. 环境探测');

const env = envMod.getEnv();
ok(`Node    : ${env.nodeVersion || '(未找到)'}  supported=${env.nodeSupported}`);
ok(`引擎    : ok=${env.engineOk}   gate=${env.gateOk}   launcher=${env.launcherOk}`);
ok(`版本    : mineflayer=${env.versions.mineflayer} protocol=${env.versions.minecraftProtocol} data=${env.versions.minecraftData}`);
ok(`协议兜底: defaultVersion=${env.protocol.defaultVersion} 有数据=${env.protocol.fallbackHasData}`);
ok(`人格    : ${env.personas.length} 个 -> ${env.personas.join(', ')}`);
if (env.problems.length) console.log('    problems: ' + env.problems.join(' / '));

if (env.nodePath && env.engineOk && env.launcherOk && env.gateOk) ok('四项硬门禁全部就绪，可以真的起 bot');
else fail('有硬门禁没过：' + env.problems.join(' / '));

// ---------------------------------------------------------------------------
section('5. LLM 客户端纯函数');

const cs = [
  ['https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/chat/completions'],
  ['https://api.deepseek.com', 'https://api.deepseek.com/v1/chat/completions'],
  ['http://127.0.0.1:11434/v1/', 'http://127.0.0.1:11434/v1/chat/completions'],
  ['https://x.com/v1/chat/completions', 'https://x.com/v1/chat/completions'],
];
let csOk = true;
for (const [inp, want] of cs) {
  const got2 = llm.chatEndpoint(inp);
  if (got2 !== want) {
    csOk = false;
    fail(`chatEndpoint(${inp}) = ${got2}，期望 ${want}`);
  }
}
if (csOk) ok('chatEndpoint 四种输入的归一化都对');

const u1 = llm.extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
const u2 = llm.extractUsage({ usage: { input_tokens: 7, output_tokens: 2 } });
const u3 = llm.extractUsage({});
if (u1.promptTokens === 10 && u1.completionTokens === 3) ok('extractUsage 认 prompt_tokens/completion_tokens');
else fail('extractUsage 解析 OpenAI 格式失败');
if (u2.promptTokens === 7 && u2.completionTokens === 2) ok('extractUsage 认 input_tokens/output_tokens');
else fail('extractUsage 解析 Anthropic 风格失败');
if (u3 === null) ok('没有 usage 时如实返回 null（不瞎猜 token 数）');
else fail('没有 usage 却编了一个：' + JSON.stringify(u3));

const t = llm.extractText({ choices: [{ message: { content: '你好' } }] });
if (t === '你好') ok('extractText 解析字符串 content');
else fail('extractText 失败：' + JSON.stringify(t));

// ---------------------------------------------------------------------------
section('6. IPC 注册与契约');

const { ipcMain } = stub;
ipcMod.registerIpc();
const channels = ipcMain.channels();
ok(`注册了 ${channels.length} 个 IPC channel`);
const required = [
  'env:get', 'config:get', 'config:save', 'secret:set', 'secret:clear', 'llm:test',
  'server:probe', 'bots:list', 'bot:start', 'bot:stop', 'bot:restart', 'bot:stopAll',
  'log:read', 'stats:clear', 'skin:pick', 'skin:read', 'personas:list',
  'memory:get', 'memory:add', 'memory:forget', 'memory:clear',
  'app:openExternal', 'app:pickDirectory', 'app:versions', 'app:defaults',
];
const missing = required.filter((c) => !channels.includes(c));
if (missing.length === 0) ok(`renderer 需要的 ${required.length} 个 channel 一个不缺`);
else fail('缺 channel：' + missing.join(', '));

// preload 白名单里的方法名 → channel 名，逐个对着调，确认返回的是 {ok:...} 形状
const r1 = await ipcMain.invoke('env:get');
if (r1 && typeof r1.ok === 'boolean') ok('env:get 返回 {ok,...}');
else fail('env:get 返回形状不对：' + JSON.stringify(r1)?.slice(0, 120));

const r2 = await ipcMain.invoke('config:get');
const uiCfg = r2?.config ?? r2;
if (uiCfg && Array.isArray(uiCfg.bots)) ok(`config:get 返回了 ${uiCfg.bots.length} 个 bot`);
else fail('config:get 返回形状不对');

const r3 = await ipcMain.invoke('bot:start', 'no-such-bot');
if (r3 && r3.ok === false && typeof r3.error === 'string') ok(`给不存在的 bot 发启动 → 中文人话拒绝："${r3.error}"`);
else fail('给不存在的 bot 发启动，返回形状不对：' + JSON.stringify(r3));

const r4 = await ipcMain.invoke('personas:list');
const plist = r4?.personas ?? r4;
if (Array.isArray(plist) && plist.length === 6) ok(`personas:list 返回 6 个面具：${plist.map((p) => p.label).join(' / ')}`);
else fail('personas:list 返回不对：' + JSON.stringify(r4)?.slice(0, 160));

const r5 = await ipcMain.invoke('log:read', 'no-such-bot', {});
if (Array.isArray(r5)) ok('log:read 对不存在的 bot 返回空数组而不是抛异常');
else fail('log:read 对不存在的 bot 返回形状不对：' + JSON.stringify(r5)?.slice(0, 120));

const r6 = await ipcMain.invoke('app:openExternal', 'file:///etc/passwd');
if (r6 && r6.ok === false) ok(`openExternal 只放行 http(s)："${r6.error}"`);
else fail('openExternal 没有拦住非 http(s) 的 URL：' + JSON.stringify(r6));

// —— 「点测试连接」这条链，走完整的 IPC ——
// 为什么要专门测：这是**用户拿到应用后做的第一件事**。这条链有三个环节
// （渲染进程 → IPC → testLLM → 回到界面），任何一环把信息丢掉，用户看到的
// 就是一句没有下文的"失败"。最典型的丢法就是渲染层只读 res.error、
// 把主进程精心写的 res.hint 扔掉（这个 bug 真的存在过，已经修了）。
{
  const badSrv = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Authentication Fails, Your api key is invalid' } }));
  });
  await new Promise((r) => badSrv.listen(0, '127.0.0.1', r));
  const badPort = badSrv.address().port;

  const cfg0 = store.loadConfigRaw();
  const prof = cfg0.llm.profiles[0];
  const savedBase = prof.baseUrl;
  prof.baseUrl = `http://127.0.0.1:${badPort}/v1`;
  prof.model = 'headless-probe';
  store.saveConfigRaw(cfg0);

  const rr = await ipcMain.invoke('llm:test', prof.id, 'sk-deliberately-wrong');
  if (rr?.ok === false && rr.status === 401) ok('llm:test 打到一个 401 的服务端 → 如实返回 ok:false + status=401');
  else fail('llm:test 对 401 的返回不对：' + JSON.stringify(rr)?.slice(0, 160));
  if (typeof rr?.hint === 'string' && rr.hint.includes('密钥')) ok(`★ 失败时**带着中文建议**回到界面："${rr.hint}"`);
  else fail('llm:test 没把 hint 带回来，界面就只能显示一句干巴巴的错误');
  if (String(rr?.error || '').includes('api key is invalid')) ok('★ 服务端原文也带回来了（排错要用）');
  else fail('llm:test 丢了服务端原文：' + String(rr?.error || '')?.slice(0, 120));

  // 收尾：配置改回原样，并关掉这个临时服务端
  const cfg1 = store.loadConfigRaw();
  const prof1 = cfg1.llm.profiles.find((p) => p.id === prof.id);
  if (prof1) { prof1.baseUrl = savedBase; prof1.model = prof.model; store.saveConfigRaw(cfg1); }
  await new Promise((r) => badSrv.close(r));
}

// —— 「服务器 → 测试连接」这条链，也走完整的 IPC ——
// 这是用户要做的第 3 步。探测是真的 spawn 一个子进程去 ping 服务器，
// 所以这里验的是"整条链路真的能跑通、失败时说的话有用"。
{
  // ① 端口上没人听
  const deadPort = await new Promise((r) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
  });
  const p1 = await ipcMain.invoke('server:probe', { host: '127.0.0.1', port: deadPort, version: '' });
  if (p1?.ok === false) ok('探测一个没人听的端口 → ok:false（不是抛异常，也不是假装成功）');
  else fail('探测死端口的返回不对：' + JSON.stringify(p1)?.slice(0, 160));
  if (/拒绝了连接/.test(String(p1?.error))) ok(`★ 翻译成人话："${p1.error}"`);
  else fail('死端口的报错没翻成人话：' + String(p1?.error));
  if (/ECONNREFUSED/i.test(String(p1?.original))) ok('★ 原始 errno 也带回来了（用户能拿去搜）');
  else fail('丢了原始 errno：' + String(p1?.original));

  // ② 域名不存在
  const p2 = await ipcMain.invoke('server:probe', { host: 'no-such-host-mcbot.invalid', port: 25565, version: '' });
  if (/域名解析不了/.test(String(p2?.error))) ok(`★ 域名不存在 → 提示"地址可能写错了"："${p2.error}"`);
  else fail('域名解析失败的报错没翻成人话：' + String(p2?.error));

  // ③ 参数校验：端口越界不该去 spawn 子进程
  const p3 = await ipcMain.invoke('server:probe', { host: '127.0.0.1', port: 99999, version: '' });
  if (p3?.ok === false && /1-65535/.test(String(p3.error))) ok(`端口越界被当场拦住："${p3.error}"`);
  else fail('端口越界没拦住：' + JSON.stringify(p3));

  // ④ 真服务器（优先挑本机那台）。没在跑就跳过，不判失败 ——
  //    这套自检不该因为"本机服务器没开"或"网线拔了"而整体变红。
  //    ★ 以前写的是 servers[0]：用户后来把自己的线上服加进配置并排在前面，
  //      这行就去探测他的真服务器了 —— 探到了固然好，但他一断网，
  //      域名解析失败的文案不在下面的匹配里，整套自检会莫名其妙变红。
  const cfgNow = store.loadConfigRaw();
  const realSrv = pickLoopbackServer(cfgNow.servers) || cfgNow.servers[0];
  const p4 = await ipcMain.invoke('server:probe', { host: realSrv.host, port: realSrv.port, version: realSrv.version });
  if (p4?.ok === true && p4.version) {
    ok(`★ 探测真服务器 ${realSrv.host}:${realSrv.port} → ${p4.version}（协议 ${p4.protocol}，在线 ${p4.players?.online}/${p4.players?.max}）`);
  } else if (p4?.ok === false && /拒绝了连接|连接超时|域名解析|找不到|没找到/.test(String(p4.error))) {
    ok(`真服务器 ${realSrv.host}:${realSrv.port} 连不上，跳过这条（不算失败）`);
  } else {
    fail('探测真服务器的返回不对：' + JSON.stringify(p4)?.slice(0, 200));
  }
}

// —— 长期记忆的四个通道，跑一遍真实的读写删 ——
// 注意：这条链落在**沙箱**里（devtools/sandbox-env.mjs 已把 MCBOT_RUNTIME_DIR
// 指到 runtime\tmp\sandbox-selftest），所以怎么折腾都碰不到用户的记忆文件。
const memBot = 'bot-headless-mem';
const m0 = await ipcMain.invoke('memory:get', memBot);
if (m0?.ok && Array.isArray(m0.entries)) ok('memory:get 读一个从没记过事的 bot → 空列表而不是报错');
else fail('memory:get 返回形状不对：' + JSON.stringify(m0)?.slice(0, 140));

const m1 = await ipcMain.invoke('memory:add', memBot, '主人叫 Steve，喜欢下矿洞');
if (m1?.ok && m1.count === 1) ok('memory:add 记下一条');
else fail('memory:add 失败：' + JSON.stringify(m1));

const m2 = await ipcMain.invoke('memory:add', memBot, '主人叫 Steve，喜欢下矿洞');
if (m2?.ok && m2.dup === true) ok('同一句再说一遍 → 认得出是重复，不新增');
else fail('重复检测失效：' + JSON.stringify(m2));

const m3 = await ipcMain.invoke('memory:add', memBot, '嗯');
if (m3?.ok === false) ok(`太短的内容被拒："${m3.error}"`);
else fail('太短的内容竟然记下了：' + JSON.stringify(m3));

const m4 = await ipcMain.invoke('memory:get', memBot);
if (m4?.ok && m4.entries.length === 1 && m4.entries[0].text.includes('Steve')) ok('memory:get 读回来的是刚写的那条');
else fail('memory:get 读回来的不对：' + JSON.stringify(m4)?.slice(0, 160));

const m5 = await ipcMain.invoke('memory:forget', memBot, m4.entries[0].id);
if (m5?.ok && m5.removed === 1 && m5.count === 0) ok('memory:forget 按 id 删掉一条');
else fail('memory:forget 失败：' + JSON.stringify(m5));

await ipcMain.invoke('memory:add', memBot, '第二条用来测清空');
const m6 = await ipcMain.invoke('memory:clear', memBot);
if (m6?.ok && m6.removed === 1) ok('memory:clear 清空全部');
else fail('memory:clear 失败：' + JSON.stringify(m6));

// ---------------------------------------------------------------------------
section('7. 事件通道（子进程 jsonl → EventHub → IPC 广播）');

const sent = [];
// 第 6 节已经 registerIpc() 过了（它的 hub 监听器就是在这里要验证的那条链路），
// 这里只补一个"看起来像真窗口"的广播目标。
const fakeWin = new stub.BrowserWindow({});
fakeWin.webContents.send = (_ch, payload) => sent.push(payload);
ok(`广播目标窗口 ${stub.BrowserWindow.getAllWindows().length} 个`);

// 直接构造一个 bot 日志文件，模拟子进程已经写过的内容。
// 注意要先清掉 EventHub 的续读位置：上一次跑这个脚本留下的 offset 会让它以为
// "文件没变"而跳过整段内容（writeFileSync 截断重写长度相同时无法被察觉）。
events.hub.tails.clear();
events.hub.ring = [];
const testBotId = 'bot-headless';
const logFile = paths.logFileFor(testBotId);
fs.mkdirSync(path.dirname(logFile), { recursive: true });
fs.writeFileSync(
  logFile,
  [
    JSON.stringify({ ts: Date.now(), botId: testBotId, type: 'status', status: 'running', detail: '无头自检' }),
    JSON.stringify({ ts: Date.now(), botId: testBotId, type: 'gate', decision: 'BLOCK', reason: 'rejectedNoWakeName', from: 'Steve', msg: '随便聊聊' }),
    JSON.stringify({ ts: Date.now(), botId: testBotId, type: 'gate', decision: 'PASS', via: 'llm', from: 'Steve', msg: '你好', channel: 'chat' }),
    JSON.stringify({ ts: Date.now(), botId: testBotId, type: 'llm', phase: 'response', model: 'm', latencyMs: 12, usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } }),
    '{ 这一行是坏的 JSON',
    '',
  ].join('\n'),
  'utf8'
);

const absorbed = [];
events.hub.on('event', (ev) => absorbed.push(ev));
events.hub.poll();
const types = absorbed.map((e) => e.type);
if (types.includes('status') && types.includes('gate') && types.includes('llm'))
  ok(`EventHub 解析出 ${absorbed.length} 条事件：${types.join(',')}`);
else fail('EventHub 没解析出预期事件：' + types.join(','));
if (types.includes('log')) ok('坏 JSON 那一行被降级成 log 而不是抛异常');
else fail('坏 JSON 没有降级处理');

// 全链路：jsonl 文件 -> EventHub -> ipc.relayEvent -> 窗口 webContents.send
const gotTypes = new Set(sent.map((p) => p.type));
if (sent.length > 0 && gotTypes.has('log') && gotTypes.has('gate'))
  ok(`主进程往渲染进程广播了 ${sent.length} 条消息：${[...gotTypes].join(',')}`);
else fail('渲染进程一条广播都没收到：' + [...gotTypes].join(','));
const gateMsg = sent.find((p) => p.type === 'gate');
if (gateMsg && typeof gateMsg.text === 'string' && gateMsg.text === '随便聊聊')
  ok(`gate 广播字段对齐契约：decision=${gateMsg.decision} reason=${gateMsg.reason} from=${gateMsg.from}`);
else fail('gate 广播字段不对：' + JSON.stringify(gateMsg));
const logMsg = sent.find((p) => p.type === 'log' && typeof p.line === 'string' && p.line.includes(']'));
if (logMsg) ok(`log 广播的是格式化好的整行文本："${logMsg.line.slice(0, 60)}"`);
else fail('log 广播的 line 不是格式化文本：' + JSON.stringify(sent.find((p) => p.type === 'log')));

const sup = supervisorMod.supervisor;
sup.sync();
const rtList = sup.list();
const rt = rtList.find((r) => r.id === testBotId) || rtList[0];
if (rt && rt.gate && typeof rt.gate.passed === 'number') ok(`Supervisor 折进了运行态：status=${rt.status} gate.passed=${rt.gate.passed} gate.blocked=${rt.gate.blocked} llm.calls=${rt.llm?.calls}`);
else fail('Supervisor 没有把事件折进运行态');

// ---------------------------------------------------------------------------
section('8. 启动参数翻译（不真的起进程）');

const realBot = cfg.bots[0];
const realServer = cfg.servers.find((s) => s.id === realBot.serverId);
const realProfile = cfg.llm.profiles.find((p) => p.id === realBot.llmProfileId);
// 先塞一个密钥，才能验证它真的只走环境变量、不落进 launch.json
store.setSecret(realProfile.id, 'sk-headless-abcdefghijklmnop');
const spec = launcher.buildLaunchSpec(realBot, realServer, realProfile);
const s = spec.spec;
ok(`生成 launch spec: ${path.basename(spec.file)}`);
ok(`  agentName=${s.agentName} wakeNames=${JSON.stringify(s.wakeNames)} owners=${JSON.stringify(s.owners)}`);
ok(`  server=${s.server.host}:${s.server.port} v${s.server.version} auth=${s.server.auth}`);
ok(`  llm=${s.llm.baseUrl} model=${s.llm.model} temp=${s.llm.temperature} maxTokens=${s.llm.maxTokens}`);
ok(`  persona=${s.persona.id}  rules=${s.rules.map((r) => r.id).join(',')}`);
ok(`  事件文件=${path.basename(s.eventsFile)}  mindserverPort=${s.mindserverPort}`);

const specRaw = fs.readFileSync(spec.file, 'utf8');
if (!/sk-|API_KEY|apiKey/i.test(specRaw)) ok('✅ API Key 没有落进 launch.json（只走环境变量）');
else fail('🔴 launch.json 里出现了疑似密钥内容！');

const envKeys = Object.keys(spec.env);
if (envKeys.includes('MCBOT_LLM_API_KEY')) ok('密钥确实放在 env.MCBOT_LLM_API_KEY 里');
else fail('env 里没有 MCBOT_LLM_API_KEY');

if (s.mindserverPort >= 8180) ok(`MindServer 端口已按 botId 分配：${s.mindserverPort}`);
else fail(`MindServer 端口没分配（${s.mindserverPort}）—— 多开必撞车`);

const msPorts = new Set(cfg.bots.map((b) => launcher.buildLaunchSpec(b, cfg.servers[0], realProfile).spec.mindserverPort));
if (msPorts.size === cfg.bots.length) ok(`每个 bot 的 MindServer 端口都不重复：${[...msPorts].join(',')}`);
else fail('有 bot 共用了 MindServer 端口，多开会互相踢：' + [...msPorts].join(','));

// ---------------------------------------------------------------------------
section('9. 起停一个真实引擎进程' + (process.env.MCBOT_HEADLESS_REAL_ENGINE === '1' ? '' : '（已跳过，设 MCBOT_HEADLESS_REAL_ENGINE=1 打开）'));

if (process.env.MCBOT_HEADLESS_REAL_ENGINE === '1') {
  // ★ 安全阀：这个脚本会真的起一个引擎进程。默认把模型指向本地假大模型，
  //   绝不去打用户的真 API —— 一次误跑就是真金白银。
  const llmUrl = process.env.MCBOT_HEADLESS_LLM_URL || 'http://127.0.0.1:8799/v1';
  const llmModel = process.env.MCBOT_HEADLESS_LLM_MODEL || 'mcbot-spike-model';
  if (/api\.deepseek\.com|dashscope|openai\.com/i.test(llmUrl)) {
    fail(`拒绝用真实 API 跑自动测试（${llmUrl}），请改 MCBOT_HEADLESS_LLM_URL`);
  } else {
    // 把配置改成"指向本地假模型"，并存盘 —— supervisor 是从磁盘读配置的。
    // ★ 这里改的是**沙箱里的配置**（sandbox-env.mjs 已经把 MCBOT_RUNTIME_DIR
    //   指到 runtime\tmp\sandbox-selftest），用户的 runtime\config.json 全程
    //   没有被打开写过。从前的做法是"整份备份、跑完还原"，但管道被截断
    //   （`... | Select-Object -First 20`）时 PowerShell 会把 node 硬杀掉，
    //   finally 和 process.on('exit') 都跑不到，用户配置因此被污染过一次。
    const userCfgHash0 = fs.existsSync(REAL_CONFIG_FILE)
      ? crypto.createHash('sha256').update(fs.readFileSync(REAL_CONFIG_FILE)).digest('hex') : null;

    const runCfg = store.loadConfigRaw();
    const rb = runCfg.bots.find((b) => b.id === realBot.id) || runCfg.bots[0];
    const rp = runCfg.llm.profiles.find((p) => p.id === rb.llmProfileId) || runCfg.llm.profiles[0];
    rp.baseUrl = llmUrl;
    rp.model = llmModel;
    const rs = runCfg.servers.find((s) => s.id === rb.serverId) || runCfg.servers[0];
    rs.host = process.env.MCBOT_HEADLESS_MC_HOST || rs.host;
    rs.port = Number(process.env.MCBOT_HEADLESS_MC_PORT || rs.port);
    store.saveConfigRaw(runCfg);
    store.setSecret(rp.id, process.env.MCBOT_HEADLESS_LLM_KEY || 'sk-headless-fake');
    ok(`用配置：${rs.host}:${rs.port} v${rs.version} -> ${rp.baseUrl} (${rp.model})`);

    try {
      const botId = rb.id;
      const r = await sup.start(botId);
      if (r.ok) ok(`start(${botId}) 成功，pid=${sup.snapshot(botId)?.pid}`);
      else fail(`start(${botId}) 失败：${r.error}`);

      // 等它连上
      for (let i = 0; i < 60; i++) {
        await new Promise((r2) => setTimeout(r2, 500));
        const s2 = sup.snapshot(botId);
        if (s2?.mc?.connected) break;
      }
      const snap = sup.snapshot(botId);
      if (snap?.mc?.connected) ok(`bot 已连上服务器，血量=${snap.mc.health} 位置=${JSON.stringify(snap.mc.position)}`);
      else fail(`30 秒内没连上，当前 status=${snap?.status} lastError=${snap?.lastError}`);

      // 进程真的起来了吗
      const pid = sup.snapshot(botId)?.pid;
      ok(`引擎进程 pid=${pid}，日志文件=${path.basename(paths.logFileFor(botId))}`);

      const stopR = await sup.stop(botId);
      if (stopR.ok) ok('stop() 成功');
      else fail('stop() 失败：' + stopR.error);
      await new Promise((r2) => setTimeout(r2, 1500));
      const after = sup.snapshot(botId);
      if (after?.status === 'stopped') ok(`停止后 status=${after.status}（没有触发退避重连）`);
      else fail(`停止后 status=${after?.status}，说明它又被自动拉起来了（intentional 标志没生效）`);
      if (after?.mc?.connected === false) ok('停止后 mc.connected 已置 false');
    } finally {
      const nowHash = fs.existsSync(REAL_CONFIG_FILE)
        ? crypto.createHash('sha256').update(fs.readFileSync(REAL_CONFIG_FILE)).digest('hex') : null;
      if (nowHash === userCfgHash0) ok('用户的 runtime\\config.json 全程未被触碰（沙箱隔离，不靠"记得还原"）');
      else fail('用户真实配置被改动了！跑 `node tools/fix-config.mjs --apply` 修回来');
      ok(`本次全部产物在沙箱里：${path.relative(paths.PROJECT_ROOT, SANDBOX_DIR)}`);
    }
  }
} else {
  ok('跳过（未设置 MCBOT_HEADLESS_REAL_ENGINE=1）');
}

// ---------------------------------------------------------------------------
section('收尾');
events.hub.stop();
await sup.stopAll().catch(() => {});

console.log(`\n结果：${problems === 0 ? '✓ 全部通过' : '✗ ' + problems + ' 个问题'}（共 ${checks} 项检查）`);
process.exit(problems === 0 ? 0 : 1);
