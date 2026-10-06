// ============================================================================
// MCBOT 本地假大模型（OpenAI 兼容）—— 零成本、确定性地端到端验证整条链路。
//
// 它让我们在没有 API key、不花一分钱的前提下验证：
//   1. 引擎能否真的把一次唤醒消息走完 promptConvo -> HTTP -> 回复 -> 游戏内说话；
//   2. 引擎实际发给模型的人格提示词长什么样（原样落盘，T4 中文人格调参全靠它）；
//   3. 带称谓 / 不带称谓两条路径的 token 差异。
//
// 用法：
//   node tools/mcbot-fake-llm.mjs [--port 8799] [--reply "你好呀"] [--log <file>]
// 端点：POST /v1/chat/completions、POST /v1/embeddings（任何路径后缀都接受）
// ============================================================================

import http from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', '8799'));
const REPLY = arg('reply', '你好呀，我是小豆，我在这儿呢。');
const LOG_FILE = arg('log', 'D:/mc_company_bot/.spike/fake-llm.log');

mkdirSync(path.dirname(LOG_FILE), { recursive: true });

let requestCount = 0;
let crashSimulation = false;

function record(entry) {
    appendFileSync(LOG_FILE, JSON.stringify(entry, null, 2) + '\n' + '-'.repeat(78) + '\n', 'utf-8');
}

function sendJson(res, code, body) {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'access-control-allow-origin': '*',
    });
    res.end(payload);
}

const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
        requestCount++;

        if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
            return res.end();
        }

        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* 非 JSON，忽略 */ }

        if (req.url.includes('/embeddings')) {
            const input = Array.isArray(parsed?.input) ? parsed.input : [parsed?.input ?? ''];
            record({ kind: 'embeddings', model: parsed?.model, inputs: input });
            return sendJson(res, 200, {
                object: 'list',
                data: input.map((_, i) => ({ object: 'embedding', index: i, embedding: fakeVector(String(input[i])) })),
                model: parsed?.model ?? 'fake-embed',
                usage: { prompt_tokens: 1, total_tokens: 1 },
            });
        }

        if (req.url.includes('/chat/completions')) {
            const messages = parsed?.messages ?? [];
            record({
                kind: 'chat',
                at: new Date().toISOString(),
                model: parsed?.model,
                stop: parsed?.stop,
                systemPrompt: messages.find((m) => m.role === 'system')?.content ?? null,
                messages,
            });

            if (crashSimulation) {
                return sendJson(res, 500, { error: { message: 'simulated upstream failure', type: 'server_error' } });
            }

            // ★ 故意返回**非零**的 usage。全部填 0 会让"token 计数"整条链路
            //   （mcbot.js 读 completion.usage → 事件 → supervisor 累加 → IPC → 面板）
            //   永远显示 0，等于没测。这里按字符数粗估，中文约 2 字符/ token。
            const promptChars = messages.reduce((n, m) => n + String(m?.content ?? '').length, 0);
            const prompt_tokens = Math.max(1, Math.round(promptChars / 2));
            const completion_tokens = Math.max(1, Math.round(String(REPLY).length / 2));
            const usage = {
                prompt_tokens,
                completion_tokens,
                total_tokens: prompt_tokens + completion_tokens,
            };
            record({ kind: 'usage', at: new Date().toISOString(), promptChars, ...usage });

            return sendJson(res, 200, {
                id: `chatcmpl-fake-${requestCount}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: parsed?.model ?? 'fake-model',
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content: REPLY },
                    finish_reason: 'stop',
                }],
                usage,
            });
        }

        sendJson(res, 404, { error: { message: `unknown path: ${req.url}`, type: 'invalid_request_error' } });
    });
});

// 确定性伪向量：同样的文本永远得到同样的向量，便于复现。
function fakeVector(text) {
    const dim = 16;
    const v = new Array(dim).fill(0);
    for (let i = 0; i < text.length; i++) {
        v[i % dim] += text.charCodeAt(i) % 97;
    }
    const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return v.map((x) => x / norm);
}

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[MCBOT-FAKE-LLM] listening on http://127.0.0.1:${PORT}/v1`);
    console.log(`[MCBOT-FAKE-LLM] reply = ${JSON.stringify(REPLY)}`);
    console.log(`[MCBOT-FAKE-LLM] prompt log -> ${LOG_FILE}`);
    console.log('[MCBOT-FAKE-LLM] 输入 "fail" 让下一次 chat 请求返回 500，"ok" 恢复正常。');
});

// 交互式开关：模拟上游故障，用来验证引擎的容错路径。
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (data) => {
    const cmd = String(data).trim();
    if (cmd === 'fail') { crashSimulation = true; console.log('[MCBOT-FAKE-LLM] 模拟故障：开'); }
    if (cmd === 'ok') { crashSimulation = false; console.log('[MCBOT-FAKE-LLM] 模拟故障：关'); }
    if (cmd === 'count') { console.log(`[MCBOT-FAKE-LLM] 已处理 ${requestCount} 个请求`); }
});
