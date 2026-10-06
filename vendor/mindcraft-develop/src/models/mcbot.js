import fs from 'node:fs';
import OpenAIApi from 'openai';
import { strictFormat } from '../utils/text.js';

// ── 事件上报 ────────────────────────────────────────────────────────────────
// 这里直接写 jsonl 而**不** import runner/event-log.mjs：provider 是引擎目录
// 里的文件，跨目录 import 会把两个目录结构焊死。反过来，只依赖一个环境变量
// 就没有这个耦合。用 appendFileSync 是因为它同步、原子到行，且不需要管道
// （本机沙箱禁止管道，见 app/electron/supervisor.mjs 的注释）。
const EV_FILE = process.env.MCBOT_EVENTS_FILE || '';
const EV_BOTID = process.env.MCBOT_BOT_ID || 'unknown';

function emitEv(type, payload) {
    if (!EV_FILE) return;
    try {
        fs.appendFileSync(EV_FILE, JSON.stringify({ ts: Date.now(), botId: EV_BOTID, type, ...payload }) + '\n', 'utf8');
    } catch { /* 上报失败绝不影响对话 */ }
}

// ============================================================================
// MCBOT provider — "接入任意大模型 API" 的唯一落点。
//
// 为什么需要这个文件：
//   prompter.js:59 调用的是 selectAPI(this.profile.model)，传进去的是一个
//   **字符串**（模型名），所以 profile 里的 "url" 永远不会到达模型构造函数
//   —— 每个内置 provider 的 baseURL 都是硬编码的。要做到"任意 OpenAI 兼容
//   端点"，最干净的做法不是改 prompter.js，而是往 src/models/ 里**新增**一个
//   provider：_model_map.js:10-31 会自动发现本目录下所有导出 static prefix
//   的类。零改动复用，且 npm install / patch-package 都不会碰这个文件。
//
// 用法（profile JSON）：
//   { "model": "mcbot/<真实模型名>", "embedding": "mcbot/<嵌入模型名>" }
// selectAPI 会把 "mcbot/" 前缀剥掉，剩下 <真实模型名> 作为 model_name 传进来。
//
// 连接参数走环境变量，这样 Electron 主进程可以用同一份 profile 文件、
// 只靠环境变量驱动不同 bot / 不同服务器 / 不同厂商：
//   MCBOT_LLM_BASE_URL   例 https://api.deepseek.com/v1
//   MCBOT_LLM_API_KEY
//   MCBOT_LLM_MODEL      当 profile 里没写具体模型名时的兜底
// ============================================================================

const DEFAULT_BASE_URL = 'http://127.0.0.1:8799/v1';

function resolveConfig(url) {
    const baseURL = url || process.env.MCBOT_LLM_BASE_URL || DEFAULT_BASE_URL;
    // OpenAI SDK 拒绝空 apiKey；本地/免鉴权端点给一个占位符即可。
    const apiKey = process.env.MCBOT_LLM_API_KEY || 'mcbot-no-key';
    return { baseURL: baseURL.replace(/\/+$/, ''), apiKey };
}

export class MCBOT {
    static prefix = 'mcbot';

    constructor(model_name, url, params) {
        this.model_name = model_name || process.env.MCBOT_LLM_MODEL || null;
        this.params = params;
        this.config = resolveConfig(url);
        this.openai = new OpenAIApi(this.config);
    }

    get chatModelName() {
        return this.model_name || process.env.MCBOT_LLM_MODEL || 'unknown';
    }

    async sendRequest(turns, systemMessage, stop_seq = '***') {
        let messages = [{ role: 'system', content: systemMessage }].concat(turns);
        messages = strictFormat(messages);

        const pack = {
            model: this.chatModelName,
            messages,
            stop: stop_seq,
            ...(this.params || {}),
        };

        let res = null;
        const startedAt = Date.now();
        emitEv('llm', { phase: 'request', model: pack.model, baseUrl: this.config.baseURL });
        try {
            console.log(`[MCBOT-LLM] awaiting ${this.config.baseURL} model=${pack.model}`);
            const completion = await this.openai.chat.completions.create(pack);
            const choice = completion?.choices?.[0];
            if (choice?.finish_reason === 'length') {
                throw new Error('Context length exceeded');
            }
            res = choice?.message?.content ?? '';
            console.log('[MCBOT-LLM] received.');

            // 用量：既上报给界面，也回调给聊天门做"当日预算"闸门。
            const u = completion?.usage;
            const usage = u ? {
                promptTokens: u.prompt_tokens ?? 0,
                completionTokens: u.completion_tokens ?? 0,
                totalTokens: u.total_tokens ?? ((u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
            } : null;
            emitEv('llm', { phase: 'response', model: completion?.model || pack.model, latencyMs: Date.now() - startedAt, usage });
            if (typeof globalThis.__MCBOT_ON_LLM__ === 'function') {
                try { globalThis.__MCBOT_ON_LLM__(usage); } catch { /* 门自己会处理 */ }
            }
        } catch (err) {
            if ((err.message === 'Context length exceeded' || err.code === 'context_length_exceeded') && turns.length > 1) {
                console.log('[MCBOT-LLM] context length exceeded, retrying with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            }
            console.error('[MCBOT-LLM] request failed:', err?.message || err);
            emitEv('error', { message: `大模型请求失败：${err?.message || err}` });
            emitEv('llm', { phase: 'response', model: pack.model, latencyMs: Date.now() - startedAt, usage: null, failed: true });
            res = '我这边信号不太好，你再说一遍好吗？';
        }
        return res;
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        const image = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
        let messages = [
            { role: 'system', content: systemMessage },
            ...turns,
            { role: 'user', content: [{ type: 'text', text: '这里是我看到的画面。' }, { type: 'image_url', image_url: { url: image } }] },
        ];
        messages = strictFormat(messages);
        try {
            const completion = await this.openai.chat.completions.create({
                model: this.chatModelName,
                messages,
                ...(this.params || {}),
            });
            return completion?.choices?.[0]?.message?.content ?? '';
        } catch (err) {
            console.error('[MCBOT-LLM] vision request failed:', err?.message || err);
            return '我现在看不清。';
        }
    }

    // 很多厂商（如 DeepSeek）没有 embeddings 端点。失败时向上抛，让
    // Examples.load 回退到 word-overlap 匹配（examples.js:40-43 已处理）。
    async embed(text) {
        const res = await this.openai.embeddings.create({
            model: this.model_name || 'mcbot-embed',
            input: text,
        });
        return res.data[0].embedding;
    }
}
