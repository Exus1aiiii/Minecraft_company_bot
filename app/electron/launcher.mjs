// app/electron/launcher.mjs
// 把 AppConfig 里的一个 bot 翻译成"可以 spawn 的东西"。
//
// 分层：supervisor 管生命周期，launcher 管**参数翻译**。翻译结果有两个产物：
//   ① runtime\tmp\<botId>.launch.json —— 给 runner\engine-launcher.mjs 读的启动规格（不含密钥）
//   ② env                             —— 密钥只留在这里，绝不落盘

import fs from 'node:fs';
import path from 'node:path';
import { TMP_DIR, LOG_DIR, MEMORY_DIR, ENGINE_DIR, PERSONAS_DIR, PROFILES_DIR, findNodeRuntime, ensureDirs, logFileFor } from './paths.mjs';
import { getSecret } from './store.mjs';

/** 引擎能识别的 base_profile；用户的人格面具是叠在它上面的，不替换 */
const BASE_PROFILE = 'assistant';

export function launchSpecFileFor(botId) {
  return path.join(TMP_DIR, `${String(botId).replace(/[^a-zA-Z0-9._-]/g, '_')}.launch.json`);
}

/** MindServer 端口基数；8080 留给用户自己开的别的东西，我们从 8180 起 */
const MINDSERVER_PORT_BASE = 8180;
const MINDSERVER_PORT_SPAN = 100;

/**
 * 由 botId 推出一个稳定的 MindServer 端口（同 id 恒定，不同 id 通常不同）。
 * 真的撞上了也不要紧：runner\engine-launcher.mjs 会从这里开始向上找空闲端口。
 */
export function mindserverPortFor(botId) {
  const s = String(botId);
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return MINDSERVER_PORT_BASE + (Math.abs(h) % MINDSERVER_PORT_SPAN);
}

/**
 * @param {object} bot       归一化后的 bot 配置
 * @param {object} server    它绑定的服务器
 * @param {object} profile   它绑定的大模型 profile
 * @returns {{file:string, env:Record<string,string>, nodeExe:string, spec:object}}
 */
export function buildLaunchSpec(bot, server, profile) {
  ensureDirs();
  const node = findNodeRuntime();
  const file = launchSpecFileFor(bot.id);

  const spec = {
    // —— 身份 ——
    botId: bot.id,
    agentName: bot.name,                     // MC 账号名（引擎硬性要求 [a-zA-Z0-9_]{3,16}）
    displayName: bot.displayName || bot.name,
    // ★ 主人名单还是出厂占位符（['Steve']）时，**不要**把这个名字喂进人格提示词 ——
    //   否则 bot 会管用户叫「Steve」。留空时 personas/index.mjs 的默认值是「主人」。
    ownerName: (bot.ownersConfigured === true ? bot.owners[0] : '') || '',

    // —— 聊天门规则 ——
    wakeNames: bot.wakeNames,
    owners: bot.owners,
    // ★ 主人名单"配没配过"。门禁用它决定：非主人喊话时是静默（正确，公屏上有陌生人）
    //   还是回一句"我还没被认领"（首跑兜底）。只有在明确是 false 时才提示。
    //   写 `=== true` 是为了让 spec 里**永远是布尔**，不会漏出 undefined ——
    //   下游两处（engine-launcher 透传、mcbot-gate）都靠它做判断，
    //   漏出 undefined 会静默变成"没配置"，于是对着一屋子陌生人喊"来改我配置"。
    ownersConfigured: bot.ownersConfigured === true,
    rateLimitMs: bot.rateLimitMs,
    dailyTokenBudget: bot.dailyTokenBudget,

    // —— 服务器 ——
    server: {
      host: server.host,
      port: server.port,
      version: server.version,
      auth: server.auth,
    },

    // —— 大模型（密钥不在这里）——
    llm: {
      baseUrl: profile.baseUrl,
      model: profile.model,
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
      timeoutMs: profile.timeoutMs,
    },

    // —— 人格 ——
    persona: {
      id: bot.personaId,
      overrides: bot.personaOverrides || {},
      dir: PERSONAS_DIR,
    },

    // —— 皮肤 ——
    skin: bot.skin?.enabled ? { model: bot.skin.model, path: bot.skin.path } : null,

    // —— 固定意图规则（不走大模型的那些）——
    rules: (bot.rules || []).filter(r => r.enabled),

    // —— 引擎与事件 ——
    baseProfile: BASE_PROFILE,
    engineDir: ENGINE_DIR,
    profileDir: PROFILES_DIR,
    eventsFile: logFileFor(bot.id),
    logDir: LOG_DIR,
    // 长期记忆放哪。门禁会在这个目录下按 botId 存一份 JSON ——
    // 用户数据区，重启不丢，也方便界面上直接看和清。
    memoryDir: MEMORY_DIR,

    // —— MindServer 端口 ——
    // 引擎是「一个进程一个 MindServer」，所以多开时必须错开端口，否则第二个 bot
    // 会因端口占用起不来（或更糟：连到别人的 MindServer 上去）。
    // 用 botId 的稳定散列，保证同一个 bot 每次启动拿到同一个端口。
    mindserverPort: mindserverPortFor(bot.id),
  };

  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(spec, null, 2), 'utf8');
  fs.renameSync(tmp, file);

  const apiKey = getSecret(profile.id) || '';
  const env = {
    MCBOT_LLM_BASE_URL: profile.baseUrl,
    MCBOT_LLM_MODEL: profile.model,
    MCBOT_LLM_TEMPERATURE: String(profile.temperature),
    MCBOT_LLM_MAX_TOKENS: String(profile.maxTokens),
    MCBOT_LLM_TIMEOUT_MS: String(profile.timeoutMs),
    MCBOT_EVENTS_FILE: logFileFor(bot.id),
    MCBOT_MC_VERSION: server.version,
  };
  if (apiKey) env.MCBOT_LLM_API_KEY = apiKey;

  return { file, env, nodeExe: node.exe, spec };
}
