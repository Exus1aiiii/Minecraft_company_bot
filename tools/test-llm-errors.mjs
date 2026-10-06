// tools/test-llm-errors.mjs
//
// 为什么要有这个文件：
//   用户拿到应用后做的**第一件事**就是「模型」页填 Key、点「测试连接」。
//   而在此之前，`testLLM()` 的网络分支**从来没有被真正打过** —— 所有自检用的都是
//   8799 上那个永远正常的假大模型。也就是说，"Key 填错了会看到什么"这件事，
//   一直只有代码里几行 `if (status === 401)` 撑着，没人验过。
//
//   这个文件起一堆**故意不正常的**小服务端（401 / 429 / 500 / 不返回 JSON /
//   干脆不回话 / 端口没人听 / 域名不存在），把 `testLLM()` 对着它们全打一遍，
//   逐条断言"用户看到的那句话"是有用的。
//
// 跑法（必须带假 electron，因为 llm.mjs → store.mjs → electron 的 safeStorage）：
//   node --import ./devtools/register-electron-stub.mjs tools/test-llm-errors.mjs

import './../devtools/sandbox-env.mjs';   // ★ 必须在 llm.mjs 之前求值：重定向 runtime 到沙箱

import http from 'node:http';

const { testLLM, describeFetchError, chatEndpoint, modelsEndpoint, extractUsage, extractText, stripThinking } =
  await import('../app/electron/llm.mjs');

// ---------------------------------------------------------------------------
let pass = 0, failN = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failN++; console.log(`  ✗ ${name}${extra ? '  ← ' + extra : ''}`); }
}
function eq(got, want, name) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(g === w, name, `得到 ${g}，期望 ${w}`);
}
const has = (s, sub) => String(s || '').includes(sub);
function section(t) { console.log(`\n=== ${t} ===`); }

// ---------------------------------------------------------------------------
// 一堆"故意的坏服务端"。每个返回 { port, close, seen }，seen 记录收到的请求头。
const servers = [];
const sockets = new Set();

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        srv.seen.push({ url: req.url, headers: req.headers, body });
        handler(req, res, body);
      });
    });
    srv.seen = [];
    srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    srv.listen(0, '127.0.0.1', () => {
      servers.push(srv);
      resolve({ port: srv.address().port, srv, seen: srv.seen, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

const json = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const GOOD = {
  id: 'chatcmpl-test', object: 'chat.completion', model: 'mcbot-spike-model',
  choices: [{ index: 0, message: { role: 'assistant', content: '收到' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 31, completion_tokens: 2, total_tokens: 33 },
};

const sGood = await serve((req, res) => json(res, 200, GOOD));
const s401 = await serve((req, res) => json(res, 401, { error: { message: 'Authentication Fails, Your api key is invalid', type: 'authentication_error' } }));
const s403 = await serve((req, res) => json(res, 403, { error: { message: 'permission denied' } }));
const s404 = await serve((req, res) => json(res, 404, { error: { message: 'Not Found' } }));
const s429 = await serve((req, res) => json(res, 429, { error: { message: 'Rate limit reached; insufficient balance' } }));
const s500 = await serve((req, res) => res.writeHead(502, { 'content-type': 'text/html' }).end('<html><body>502 Bad Gateway</body></html>'));
const sHtml = await serve((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>这是某个网页，不是 API</body></html>'));
const sNoChoices = await serve((req, res) => json(res, 200, { id: 'x', object: 'chat.completion', model: 'm' }));
const sHang = await serve(() => { /* 永远不回话 */ });
const sArr = await serve((req, res) => json(res, 200, {
  model: 'claude-ish',
  choices: [{ message: { content: [{ type: 'text', text: '前半' }, { type: 'text', text: '后半' }] } }],
}));
const sThink = await serve((req, res) => json(res, 200, {
  model: 'reasoner', choices: [{ message: { content: ' thinking让我想想<｜end▁of▁thinking｜>真的收到' } }],
}));

// 一个"本来有人听、现在没人听"的端口
const deadPort = await new Promise((resolve) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const P = (port, extra = {}) => ({ id: 'prof-test', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mcbot-spike-model', ...extra });

// ---------------------------------------------------------------------------
section('1. Base URL 归一化（用户很自然会只填域名）');

eq(chatEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions', '只填域名 → 自动补 /v1');
eq(chatEndpoint('https://api.deepseek.com/'), 'https://api.deepseek.com/v1/chat/completions', '结尾多余斜杠也认');
eq(chatEndpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions', '填了 /v1 → 只补后半截');
eq(chatEndpoint('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1/chat/completions', '已经填全了不会补成两遍');
eq(chatEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1'), 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', '★ 有自定义路径时**绝不覆盖**');
eq(chatEndpoint('https://open.bigmodel.cn/api/paas/v4'), 'https://open.bigmodel.cn/api/paas/v4/chat/completions', '★ 不是 /v1 的路径照样尊重');
eq(chatEndpoint('  http://127.0.0.1:11434/v1/  '), 'http://127.0.0.1:11434/v1/chat/completions', '前后空格 + 尾斜杠');
eq(chatEndpoint(''), '', '空串 → 空串（调用方会先拦住）');
eq(modelsEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/v1/models', 'models 端点同样补 /v1');

// ---------------------------------------------------------------------------
section('2. 一切正常的时候（对照组）');

{
  const r = await testLLM(P(sGood.port), 'sk-good-key');
  ok(r.ok === true, '正常服务端 → ok:true', JSON.stringify(r));
  eq(r.reply, '收到', '取回了模型回复');
  eq(r.model, 'mcbot-spike-model', '回显了服务端返回的模型名');
  eq(r.usage, { promptTokens: 31, completionTokens: 2, totalTokens: 33 }, '★ token 用量被解析出来了（成本统计靠它）');
  eq(r.url, `http://127.0.0.1:${sGood.port}/v1/chat/completions`, '请求打到了正确端点');
  const sent = sGood.seen.at(-1);
  eq(sent.headers.authorization, 'Bearer sk-good-key', '★ 密钥放进了 Authorization 头');
  ok(!JSON.stringify(sent.body).includes('sk-good-key'), '★ 密钥**没有**混进请求体里');
  const parsed = JSON.parse(sent.body);
  eq(parsed.stream, false, '测试请求是非流式的');
  eq(parsed.temperature, 0, '测试请求 temperature=0（要可复现）');
}

// ---------------------------------------------------------------------------
section('3. 密钥不对 / 没权限 / 地址写错 / 限流 / 对面炸了');

{
  const r = await testLLM(P(s401.port), 'sk-wrong');
  ok(r.ok === false && r.status === 401, '401 → ok:false 且带回状态码');
  ok(has(r.error, 'HTTP 401'), '错误里写明是 HTTP 401', r.error);
  ok(has(r.error, 'api key is invalid'), '★ 把服务端原文带给用户（不是只说"失败了"）', r.error);
  ok(has(r.hint, '密钥无效'), '401 的提示指向"密钥"', r.hint);
}
{
  const r = await testLLM(P(s403.port), 'sk-x');
  ok(has(r.hint, '密钥无效'), '403 也按密钥问题提示');
}
{
  const r = await testLLM(P(s404.port), 'sk-x');
  ok(has(r.hint, '/v1'), '404 的提示指向"要不要加 /v1"', r.hint);
  ok(has(r.hint, `127.0.0.1:${s404.port}/v1/chat/completions`), '★ 提示里带上**实际请求的那个 URL**（否则用户无从对照）', r.hint);
}
{
  const r = await testLLM(P(s429.port), 'sk-x');
  ok(has(r.hint, '限流') || has(r.hint, '余额'), '429 的提示指向限流/余额', r.hint);
}
{
  const r = await testLLM(P(s500.port), 'sk-x');
  ok(r.status === 502, '502 被如实报出来');
  ok(has(r.hint, '对面服务端的问题') && has(r.hint, '不是你这边配错了'), '★ 5xx 明说"不是你配错了"（否则用户会去反复改自己的配置）', r.hint);
}

// ---------------------------------------------------------------------------
section('4. 连得上但不是 OpenAI 兼容端点');

{
  const r = await testLLM(P(sHtml.port), 'sk-x');
  ok(r.ok === false, '返回 HTML 网页 → 判失败');
  ok(has(r.error, '找不到 choices'), '说清楚"200 了但格式不对"', r.error);
  ok(!has(r.error, 'Unexpected token'), '★ 不把 JSON.parse 的原始报错甩给用户', r.error);
}
{
  const r = await testLLM(P(sNoChoices.port), 'sk-x');
  ok(has(r.error, '不是 OpenAI 兼容格式'), '合法 JSON 但没有 choices → 点名"不是 OpenAI 兼容格式"', r.error);
}

// ---------------------------------------------------------------------------
section('5. 超时 / 端口没人听 / 域名不存在 —— 三种"连不上"要分得开');

{
  const r = await testLLM(P(sHang.port, { timeoutMs: 900 }), 'sk-x');
  ok(r.ok === false, '服务端不回话 → 判失败');
  ok(has(r.error, '请求超时'), '★ 说"请求超时"而不是"连不上"', r.error);
  ok(/（\d+ 秒没有响应）/.test(r.error), '超时信息里带秒数', r.error);
  ok(has(r.hint, 'Ollama') || has(r.hint, '可达'), '超时的提示仍然有用', r.hint);
}
{
  const r = await testLLM({ ...P(deadPort), id: 'prof-dead' }, 'sk-x');
  ok(r.ok === false, '端口没人听 → 判失败');
  ok(has(r.error, 'ECONNREFUSED'), '★ 原始错误码被保留下来（排错要靠它）', r.error);
  ok(has(r.hint, '拒绝了连接'), '★ 翻译成"对方拒绝了连接"并提示本地服务没起', r.hint);
}
{
  const r = await testLLM({ id: 'prof-dns', baseUrl: 'https://no-such-host-mcbot-test.invalid/v1', model: 'm' }, 'sk-x');
  ok(r.ok === false, '域名不存在 → 判失败');
  ok(has(r.error, 'ENOTFOUND'), '★ 原始错误码保留', r.error);
  ok(has(r.hint, '域名解析不了'), '★ 翻译成"域名解析不了 —— 地址可能写错了"', r.hint);
}

// ---------------------------------------------------------------------------
section('6. 还没发请求就该拦住的情况');

{
  const r = await testLLM({ id: 'p', baseUrl: '', model: 'm' }, 'sk-x');
  ok(has(r.error, '请先填写 Base URL'), '空 Base URL → 明确提示', r.error);
}
{
  const r = await testLLM({ id: 'p', baseUrl: 'http://127.0.0.1:1/v1', model: '' }, 'sk-x');
  ok(has(r.error, '请先填写模型名'), '空模型名 → 明确提示', r.error);
}
{
  // 没有密钥时不该编一个 Authorization 头出来
  const r = await testLLM({ id: 'prof-nokey-在沙箱里查不到', baseUrl: `http://127.0.0.1:${sGood.port}/v1`, model: 'm' }, '');
  ok(r.ok === true, '没填 Key 也能测试（有些本地服务不需要 Key）');
  const sent = sGood.seen.at(-1);
  ok(sent.headers.authorization === undefined, '★ 没 Key 时**不发** Authorization 头（而不是发一个空的 Bearer）',
    JSON.stringify(sent.headers.authorization));
}

// ---------------------------------------------------------------------------
section('7. describeFetchError：把 fetch 那句没用的 "fetch failed" 拆开');

{
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), { code: 'ENOTFOUND' });
  const d = describeFetchError(e);
  eq(d.timeout, false, '不是超时');
  ok(has(d.message, 'fetch failed') && has(d.message, 'ENOTFOUND'), '★ 整条 cause 链都展开（不再只有"fetch failed"四个字）', d.message);
  ok(has(d.hint, '域名解析不了'), '认出了 ENOTFOUND', d.hint);
  eq(d.code, 'ENOTFOUND', '带回了错误码');
}
{
  const d = describeFetchError(new Error('unknown weirdness'));
  eq(d.hint, '', '★ 认不出的错误**不编提示**（宁可没有，也不要瞎猜一个原因）');
  eq(d.code, '', '认不出就没有错误码');
}
{
  const e = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  eq(describeFetchError(e).timeout, true, 'AbortError → 归为超时');
}
{
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
  ok(has(describeFetchError(e).hint, '拒绝了连接'), '嵌套一层的 ECONNREFUSED 也认得出');
}
{
  // 循环引用不能把函数转死
  const a = new Error('a'); const b = new Error('b');
  a.cause = b; b.cause = a;
  const d = describeFetchError(a);
  ok(typeof d.message === 'string' && d.message.length > 0, '★ cause 成环也不会死循环');
}

// ---------------------------------------------------------------------------
section('8. 响应解析的两个纯函数');

eq(extractUsage({ usage: { input_tokens: 10, output_tokens: 4 } }),
  { promptTokens: 10, completionTokens: 4, totalTokens: 14 }, '★ 只有 input/output（另一种命名）也要认');
eq(extractUsage({ usage: { total_tokens: 99 } }),
  { promptTokens: 0, completionTokens: 0, totalTokens: 99 }, '只有 total 也行');
eq(extractUsage({ usage: null }), null, '没有 usage → null（宁可没有，也不瞎猜成 0）');
eq(extractUsage({}), null, '连 usage 字段都没有 → null');

eq(extractText({ choices: [{ message: { content: [{ type: 'text', text: '前半' }, { type: 'text', text: '后半' }] } }] }),
  '前半后半', 'content 是数组（多模态格式）时拼起来');
eq(extractText({ choices: [{ message: { content: '  空白要 trim  ' } }] }), '空白要 trim', '首尾空白去掉');
eq(extractText({ choices: [{ message: { content: ' thinking让我想想<｜end▁of▁thinking｜>真的收到' } }] }), '真的收到', '★ 标准的  思维链要剥掉');
eq(extractText({ choices: [{ message: { content: '◁think▷让我想想<｜end▁of▁thinking｜>真的收到' } }] }), '真的收到',
  '★ DeepSeek 那种全角特殊 token 的思维链也要剥掉');
eq(extractText({ choices: [{ message: { content: '<|think|>让我想想<|end_of_thinking|>真的收到' } }] }), '真的收到',
  '★ ASCII 变体的思维链也要剥掉');
eq(extractText({ choices: [{ message: { content: '我在想 </think> 这个标签是干嘛的' } }] }), '这个标签是干嘛的',
  '思维链标记出现在正文里也按"之前的都是思考"处理');
eq(stripThinking('没有结束标记的思考过程'), '没有结束标记的思考过程', '★ 找不到结束标记就原样返回（不吃掉正文）');
eq(extractText({ choices: [{ message: { content: '   ' } }] }), '', '※ 只有空白时返回空串而不是 null（结构本身是对的）');
eq(extractText({ choices: [{ text: '老式 completions 格式' }] }), '老式 completions 格式', '兼容 choices[0].text');
eq(extractText({ choices: [] }), null, '空 choices → null');

// ---------------------------------------------------------------------------
section('9. 数组格式 / 思维链要能真的走通 testLLM 这一整条路');

{
  const r = await testLLM(P(sArr.port), 'sk-x');
  ok(r.ok === true && r.reply === '前半后半', 'content 为数组的端点也能测通', JSON.stringify(r));
}
{
  const r = await testLLM(P(sThink.port), 'sk-x');
  ok(r.ok === true && r.reply === '真的收到', '★ 推理模型的思维链不会出现在"测试成功"的回复里', JSON.stringify(r));
}

// ---------------------------------------------------------------------------
section('收尾');

// ★ 顺序不能反：挂在"永远不回话"那个服务端上的连接还在，`server.close()` 会一直
//   等它自己断开 —— 先 close 后 destroy 会把这个脚本挂死在这里（第一次跑就是这样）。
for (const s of sockets) s.destroy();
sockets.clear();
await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));
await new Promise((r) => setTimeout(r, 100));

console.log(`\n结果：${failN === 0 ? '✓ 全部通过' : '✗ 有失败'}（共 ${pass + failN} 项检查，失败 ${failN} 项）`);
process.exit(failN === 0 ? 0 : 1);
