// app/electron/llm.mjs
// 直连大模型 API 做两件事：① "测试"按钮的连通性检查 ② 复用同一套解析去统计 token。
//
// ★ 这里刻意**不经过引擎**：用户点"测试"时 bot 还没启动，_model_map 那套也用不上。
//   /chat/completions 是 OpenAI 兼容端点的事实标准，和引擎里 mcbot.js provider 用的是同一个协议。

import { getSecret } from './store.mjs';

/** 把用户填的 Base URL 补成完整的 chat/completions 端点 */
export function chatEndpoint(baseUrl) {
  const b = normalizeBase(baseUrl);
  if (!b) return '';
  // 用户可能填了 …/v1，也可能直接填了 …/v1/chat/completions
  if (/\/chat\/completions$/i.test(b)) return b;
  return `${b}/chat/completions`;
}

export function modelsEndpoint(baseUrl) {
  const b = normalizeBase(baseUrl);
  if (!b) return '';
  if (/\/models$/i.test(b)) return b;
  return `${b}/models`;
}

/**
 * 归一化用户填的 Base URL。
 *
 * 除了去空格去尾斜杠，还要补一件容易被忽略的事：**只填了域名的情况**。
 * 绝大部分 OpenAI 兼容服务都把接口挂在 `/v1` 下，用户很自然地会只填
 * `https://api.deepseek.com`。如果原样拼成 `…/chat/completions` 就会 404，
 * 而报错信息（"404，请检查 Base URL"）会让人一头雾水。所以路径为空时补 `/v1`。
 *
 * 只在"确实没有路径"时补，绝不覆盖用户自己写的路径 —— 有些服务不是 `/v1`
 * （例如 `…/v1beta/openai`、`…/compatible-mode/v1`）。
 */
function normalizeBase(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  try {
    const u = new URL(b);
    if (u.pathname === '' || u.pathname === '/') {
      u.pathname = '/v1';
      return String(u).replace(/\/+$/, '');
    }
  } catch {
    /* 不是合法 URL 就原样返回，交给 fetch 去报错 */
  }
  return b;
}

async function post(url, body, { apiKey, timeoutMs = 30000, signal } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ac.abort(signal.reason), { once: true });
  try {
    const headers = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 不是 JSON，保留原文 */ }
    return { res, text, json };
  } finally {
    clearTimeout(timer);
  }
}

/** socket 层的错误码 → 人话。认不出就返回 null，绝不硬编一个像模像样的原因。 */
const FETCH_CODES = {
  ENOTFOUND: '域名解析不了 —— 地址可能写错了',
  EAI_AGAIN: '域名解析超时 —— 本机 DNS 或网络不通',
  ECONNREFUSED: '对方拒绝了连接 —— 地址或端口不对；如果是本地服务（Ollama 之类），先确认它启动了',
  ECONNRESET: '连接被重置 —— 可能被代理或防火墙中断了',
  ETIMEDOUT: '连接超时 —— 网络不通或被墙',
  EHOSTUNREACH: '主机不可达 —— 网络不通',
  ENETUNREACH: '网络不可达 —— 检查本机网络和代理设置',
  CERT_HAS_EXPIRED: '对方的 HTTPS 证书过期了',
  DEPTH_ZERO_SELF_SIGNED_CERT: '对方用的是自签名证书 —— 本地服务常见，需要在系统里信任它',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'HTTPS 证书验不过 —— 常见于公司网络的中间代理',
  UND_ERR_CONNECT_TIMEOUT: '连接超时 —— 网络不通或被墙',
  UND_ERR_SOCKET: '连接中途断开 —— 服务端提前关了 socket',
  UND_ERR_HEADERS_TIMEOUT: '服务端迟迟不返回响应头',
};

/**
 * ★ 这一条是踩出来的：`fetch` 失败时抛出的 `TypeError` 的 `message` **只有四个字
 * `fetch failed`** —— 真正的原因（是域名解析不了？还是端口拒绝？还是证书不对？）
 * 全在 `err.cause` 这条链上。直接把 `e.message` 显示给用户，等于什么都没说。
 * 所以这里把整条 cause 链都翻出来，并尽力识别一个错误码给一句对应的人话。
 */
export function describeFetchError(e) {
  const chain = [];
  const codes = [];
  let cur = e;
  for (let i = 0; i < 6 && cur; i++) {
    const m = String(cur.message || cur.code || '').trim();
    if (m && !chain.includes(m)) chain.push(m);
    if (cur.code && !codes.includes(cur.code)) codes.push(String(cur.code));
    cur = cur.cause;
  }
  const raw = chain.join(' ← ') || '未知错误';
  if (/abort/i.test(String(e?.name || '')) || /timeout/i.test(raw)) {
    return { timeout: true, message: raw, hint: '', code: codes[0] || '' };
  }
  const known = codes.map((c) => FETCH_CODES[c]).find(Boolean);
  return { timeout: false, message: raw, hint: known || '', code: codes[0] || '' };
}

/** 从一次响应里尽力抽取 token 用量。缺失就返回 null，不要瞎猜。 */
export function extractUsage(json) {
  const u = json?.usage;
  if (!u || typeof u !== 'object') return null;
  const p = Number(u.prompt_tokens ?? u.input_tokens);
  const c = Number(u.completion_tokens ?? u.output_tokens);
  const t = Number(u.total_tokens);
  if (!Number.isFinite(p) && !Number.isFinite(c) && !Number.isFinite(t)) return null;
  return {
    promptTokens: Number.isFinite(p) ? p : 0,
    completionTokens: Number.isFinite(c) ? c : 0,
    totalTokens: Number.isFinite(t) ? t : (Number.isFinite(p) ? p : 0) + (Number.isFinite(c) ? c : 0),
  };
}

/**
 * 思维链的结束标记。至少见过这三种写法：
 *   · `…`                                —— 最常见
 *   · `◁think▷…<｜end▁of▁thinking｜>`   —— DeepSeek 的特殊 token（全角竖线 + ▁）
 *   · `<|end_of_thinking|>`                  —— ASCII 变体（部分本地推理模型）
 * ★ 这是被测试逼出来的：原来只写死了 `</think>`，真遇到后两种就会把整段
 *   思维链当成正文回显给用户 —— 用户点"测试连接"看到的是模型的内心独白。
 */
const THINK_CLOSE = /<\/think>|<｜end▁of▁thinking｜>|<\|end_of_thinking\|>/i;

/** 剥掉正文里的思维链。找不到结束标记就**原样返回**（宁可多显示，不要吃掉正文）。 */
export function stripThinking(s) {
  const m = THINK_CLOSE.exec(String(s));
  return m ? String(s).slice(m.index + m[0].length) : String(s);
}

/** 从响应体里取出第一段文本内容 */
export function extractText(json) {
  const msg = json?.choices?.[0]?.message;
  let content = msg?.content;
  if (Array.isArray(content)) content = content.map(c => (typeof c === 'string' ? c : c?.text ?? '')).join('');
  if (typeof content !== 'string') content = json?.choices?.[0]?.text;
  if (typeof content !== 'string') return null;
  return stripThinking(content).trim();
}

/**
 * "测试"按钮。**两种失败要分清**：
 *   - 连不上 / 401 / 404 → 配置或密钥问题，用户要改
 *   - 能连上但响应不合预期 → 端点可能不是 OpenAI 兼容的
 * @param {{id:string, baseUrl:string, model:string, maxTokens?:number, timeoutMs?:number}} profile
 * @param {string|null} apiKeyOverride 用户在界面上刚输入但还没保存的密钥
 */
export async function testLLM(profile, apiKeyOverride = null) {
  const baseUrl = String(profile?.baseUrl || '').trim();
  if (!baseUrl) return { ok: false, error: '请先填写 Base URL' };
  if (!profile.model) return { ok: false, error: '请先填写模型名' };

  const apiKey = apiKeyOverride || getSecret(profile.id) || '';
  const url = chatEndpoint(baseUrl);
  const started = Date.now();

  let out;
  try {
    out = await post(url, {
      model: profile.model,
      messages: [
        { role: 'system', content: '你是一个测试探针。' },
        { role: 'user', content: '只回复两个字：收到' },
      ],
      max_tokens: 16,
      temperature: 0,
      stream: false,
    }, { apiKey, timeoutMs: Math.min(Number(profile.timeoutMs) || 30000, 30000) });
  } catch (e) {
    const info = describeFetchError(e);
    const secs = Math.round((Date.now() - started) / 1000);
    // 超时和"连不上"是两种病：超时说明地址对但对面不理你，连不上说明根本到不了。
    const msg = info.timeout ? `请求超时（${secs} 秒没有响应）` : `连不上：${info.message}`;
    return {
      ok: false, ms: Date.now() - started, error: msg, code: info.code,
      hint: info.hint
        || '检查 Base URL 是否可达、本机能否访问外网；若用的是本地 Ollama，确认它已经在跑。',
    };
  }

  const ms = Date.now() - started;

  if (!out.res.ok) {
    let detail = '';
    try {
      detail = out.json?.error?.message || out.json?.message || out.text.slice(0, 200);
    } catch { detail = out.text.slice(0, 200); }
    const hint = out.res.status === 401 || out.res.status === 403
      ? '密钥无效或没有权限 —— 重新填写 API Key 试试。'
      : out.res.status === 404
        ? `端点不存在。当前请求的是 ${url} —— 多数服务需要 /v1 结尾，试试把 Base URL 改成以 /v1 结尾。`
        : out.res.status === 429
          ? '被限流或余额不足。等一会儿再试；如果一直这样，去服务商后台看看余额。'
          : out.res.status >= 500
            ? '这是对面服务端的问题，不是你这边配错了。过一会儿再试一次。'
            : '看下面的服务端原文。';
    return { ok: false, ms, status: out.res.status, error: `HTTP ${out.res.status}${detail ? '：' + detail : ''}`, hint, url };
  }

  const reply = extractText(out.json);
  if (reply === null) {
    return {
      ok: false, ms, url,
      error: '服务端返回了 200，但响应里找不到 choices[0].message.content —— 这个端点可能不是 OpenAI 兼容格式。',
      hint: '本应用只支持 OpenAI 兼容的 /chat/completions 端点。',
    };
  }

  return {
    ok: true, ms, url,
    model: out.json?.model || profile.model,
    reply: reply.slice(0, 80),
    usage: extractUsage(out.json),
  };
}

/** 给引擎子进程用的：把 profile + 解密后的密钥翻译成环境变量（只在本进程内流动） */
export function llmEnvFor(profile) {
  const key = getSecret(profile.id) || '';
  const base = String(profile.baseUrl || '').trim().replace(/\/+$/, '');
  return {
    MCBOT_LLM_BASE_URL: base,
    MCBOT_LLM_API_KEY: key,
    MCBOT_LLM_MODEL: profile.model,
    MCBOT_LLM_TEMPERATURE: String(Number(profile.temperature) || 0.7),
    MCBOT_LLM_MAX_TOKENS: String(Number(profile.maxTokens) || 800),
  };
}
