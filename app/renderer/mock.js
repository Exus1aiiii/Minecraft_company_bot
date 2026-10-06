// ============================================================================
// mock.js —— 内置假实现（脱离 Electron 主进程也能整页验收）
//
// 触发条件：index.html 里由 app.js 检测 —— 如果 window.mcbot 不存在
// （例如直接用浏览器打开 index.html），就调用 installMock() 装一份。
// 它实现契约第五节 McbotAPI 的【全部】方法，返回中文演示数据：
//   2 个服务器 / 2 个 bot（小豆在线、阿霄已停止）/ 真实感的 token 数字
//   与门禁日志；并每 1 秒推一次 runtime 事件，运行中的 bot 还会持续吐出
//   log / gate / llm 事件，让日志页真的"滚"起来。
//
// 所有假数据都只在本文件的内存里，不写盘、不碰 Node API。
// ============================================================================

import { clone } from './ui.js';
// 演示模式下没有主进程可问，直接复用视图里那份内置预设表（避免出现第三份副本）。
import { BUILTIN_PERSONAS as PERSONA_PRESETS } from './views/persona.js';

const now = Date.now();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// ---------------------------------------------------------------------------
// 一、演示配置（结构与契约第二节 AppConfig 完全一致）
// ---------------------------------------------------------------------------

function demoConfig() {
  return {
    version: 1,
    llm: {
      profiles: [
        {
          id: 'deepseek',
          label: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          temperature: 0.7,
          maxTokens: 800,
          timeoutMs: 60000,
          hasKey: true,
          keyHint: 'sk-…3f2a',
          keyIsPlaceholder: false,
        },
        {
          id: 'ollama-local',
          label: 'Ollama 本地',
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'qwen2.5:7b',
          temperature: 0.8,
          maxTokens: 512,
          timeoutMs: 120000,
          hasKey: false,
          keyHint: '',
          keyIsPlaceholder: false,
        },
        {
          // ★ 这一条是照着"真发生过的事"写的：早期自检把 sk-multibot-fake 写进了
          //   用户的 runtime\secrets.json，界面上它显示成「已保存（sk-…fake）」，
          //   和真密钥长得一模一样。留着这条是为了让"填了个假密钥"这个状态
          //   在离线演示里也能看见、在自检里也有断言（见 render-headless 第 6 节）。
          id: 'deepseek-test',
          label: 'DeepSeek（演示：假密钥）',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          temperature: 0.7,
          maxTokens: 800,
          timeoutMs: 60000,
          hasKey: true,
          keyHint: 'sk-…fake',
          keyIsPlaceholder: true,
        },
      ],
    },
    servers: [
      {
        id: 'srv-local',
        label: '本地测试服',
        host: '127.0.0.1',
        port: 25565,
        version: '1.21.1',
        auth: 'offline',
      },
      {
        id: 'srv-friends',
        label: '朋友的小服',
        host: 'mc.example.com',
        port: 25566,
        version: 'auto',
        auth: 'offline',
      },
    ],
    bots: [
      {
        id: 'bot-xiaodou',
        name: 'Xiaodou',
        displayName: '小豆',
        serverId: 'srv-local',
        llmProfileId: 'deepseek',
        enabled: true,
        wakeNames: ['小豆', 'xiaodou', '豆豆'],
        owners: ['Steve'],
        // ★ 出厂占位符还没被认领 —— 主进程loadConfig() 会把这条推断成 false，
        //   这里手写出来是为了让离线演示模式与真机看到同一张首跑引导卡。
        ownersConfigured: false,
        rateLimitMs: 3000,
        dailyTokenBudget: 200000,
        personaId: 'companion-gentle',
        personaOverrides: { systemPrompt: '' },
        skin: { model: 'slim', path: 'D:\\mc_company_bot\\runtime\\skins\\xiaodou.png', enabled: false },
        rules: [
          { id: 'follow', enabled: true, patterns: ['跟着我', '跟紧我', '跟我来'], action: 'followPlayer' },
          { id: 'stop', enabled: true, patterns: ['停下', '别动', '站住', '停'], action: 'stop' },
          { id: 'come', enabled: true, patterns: ['过来', '来我这', '来我身边'], action: 'goToPlayer' },
        ],
      },
      {
        id: 'bot-axiao',
        name: 'Axiao',
        displayName: '阿霄',
        serverId: 'srv-friends',
        llmProfileId: 'deepseek',
        enabled: false,
        wakeNames: ['阿霄', 'axiao'],
        owners: ['Steve', 'Alex'],
        ownersConfigured: true,   // 这台是真配过的：用户加了自己的 ID
        rateLimitMs: 5000,
        dailyTokenBudget: 100000,
        personaId: 'butler',
        personaOverrides: { systemPrompt: '' },
        skin: { model: 'classic', path: '', enabled: false },
        rules: [
          { id: 'follow', enabled: true, patterns: ['跟着我', '跟我来'], action: 'followPlayer' },
          { id: 'stop', enabled: true, patterns: ['停下', '站住'], action: 'stop' },
        ],
      },
    ],
    app: { autoStartBots: false, language: 'zh' },
  };
}

// ---------------------------------------------------------------------------
// 二、演示运行态（契约第三节 BotRuntime）
// ---------------------------------------------------------------------------

function demoRuntimes() {
  return {
    'bot-xiaodou': {
      id: 'bot-xiaodou',
      name: 'Xiaodou',
      displayName: '小豆',
      status: 'running',
      pid: 28344,
      restarts: 1,
      startedAt: now - 42 * MIN - 18 * 1000,
      uptimeMs: 42 * MIN + 18 * 1000,
      mc: {
        connected: true,
        health: 20,
        food: 17,
        position: { x: 128.5, y: 65, z: -342.2 },
        dimension: 'overworld',
        gamemode: 'survival',
      },
      llm: {
        calls: 37,
        promptTokens: 21_480,
        completionTokens: 3_164,
        lastLatencyMs: 1420,
        todayTokens: 24_644,
        budget: 200000,
      },
      gate: {
        passed: 12,
        blocked: 96,
        byReason: {
          rejectedNoWakeName: 71,
          rejectedNotOwner: 14,
          rejectedSelf: 2,
          rejectedRateLimited: 6,
          rejectedBudget: 0,
          rejectedEmpty: 3,
        },
        lastDecision: {
          ts: now - 96 * 1000,
          decision: 'PASS',
          reason: '',
          from: 'Steve',
          channel: 'chat',
          text: '小豆 跟着我',
        },
      },
      lastError: null,
    },
    'bot-axiao': {
      id: 'bot-axiao',
      name: 'Axiao',
      displayName: '阿霄',
      status: 'stopped',
      pid: null,
      restarts: 0,
      startedAt: null,
      uptimeMs: 0,
      mc: null,
      llm: {
        calls: 4,
        promptTokens: 2_310,
        completionTokens: 402,
        lastLatencyMs: 2210,
        todayTokens: 2_712,
        budget: 100000,
      },
      gate: {
        passed: 1,
        blocked: 9,
        byReason: {
          rejectedNoWakeName: 6,
          rejectedNotOwner: 2,
          rejectedSelf: 0,
          rejectedRateLimited: 1,
          rejectedBudget: 0,
          rejectedEmpty: 0,
        },
        lastDecision: {
          ts: now - 3 * HOUR,
          decision: 'BLOCK',
          reason: 'rejectedNoWakeName',
          from: 'Alex',
          channel: 'chat',
          text: '大家晚上好',
        },
      },
      lastError: '连接被服务器关闭：Server closed connection (testsrv 维护中)',
    },
  };
}

// ---------------------------------------------------------------------------
// 三、演示日志素材
// ---------------------------------------------------------------------------

// 公屏消息池：带称谓的会被 PASS，不带的会被 BLOCK
const CHAT_WITH_WAKE = [
  '小豆 你好呀',
  '小豆 跟着我',
  '小豆 帮我看下这附近有没有牛',
  '豆豆 过来一下',
  '小豆 你饿不饿',
  '小豆 别动',
  '小豆 现在几点了',
];
const CHAT_NO_WAKE = [
  '大家晚上好',
  '有人吗',
  '这服务器卡不卡',
  '谁有多的木头',
  'Steve 你在哪',
  '我到基地方向了',
];
const CHAT_NOT_OWNER = [
  '小豆 帮我挖点矿',
  '小豆 你在干嘛',
  '小豆 跟着我',
  '小豆 别理他',
];
const CHAT_SELF = ['小豆 我先去砍树了', '小豆 这里有矿'];

const ENGINE_LOGS = [
  '[info] Xiaodou spawned.',
  '[info] Connected to 127.0.0.1:25565 (version 1.21.1, protocol 767)',
  '[info] Loaded mineflayer-pathfinder with createHuman(seed=8412)',
  '[warn] 世界加载较慢，等待 chunk 到达（18/49）',
  '[info] 背包：oak_log x12, bread x3, stone_pickaxe x1',
  '[info] 自动跳过夜间挂机（休眠档未开启）',
  '[warn] 路径被阻断，重新寻路（第 2 次）',
  '[info] 已到达 Steve 身边（距离 1.8 格）',
];

const GATE_TEXT_POOL = [
  { decision: 'PASS', reason: '', from: 'Steve', channel: 'chat', text: '小豆 你好呀' },
  { decision: 'BLOCK', reason: 'rejectedNoWakeName', from: 'Alex', channel: 'chat', text: '有人吗' },
  { decision: 'BLOCK', reason: 'rejectedNotOwner', from: 'Herobrine', channel: 'chat', text: '小豆 帮我挖矿' },
  { decision: 'PASS', reason: '', from: 'Steve', channel: 'whisper', text: '在吗' },
  { decision: 'BLOCK', reason: 'rejectedRateLimited', from: 'Steve', channel: 'chat', text: '小豆 快说话' },
  { decision: 'BLOCK', reason: 'rejectedNoWakeName', from: 'Steve', channel: 'chat', text: '这地方真不错' },
  { decision: 'PASS', reason: '', from: 'Steve', channel: 'chat', text: '小豆 跟着我' },
  { decision: 'BLOCK', reason: 'rejectedSelf', from: 'Xiaodou', channel: 'chat', text: '欸，我在呢！' },
];

const LLM_REPLIES = [
  '欸，我在呢！这就跟上你。',
  '好呀，我看看附近有没有牛，稍等一下。',
  '嗯……这边光线有点暗，你要不要插个火把？',
  '我背包里还有 12 个木头，够搭个小棚子啦。',
  '收到，我先站在这儿不动。',
  '这个我不太确定，等我走近点再看。',
];

// ---------------------------------------------------------------------------
// 四、皮肤演示图（用 SVG 画一张 64×64 的假皮肤，浏览器能直接当 <img> 用）
// ---------------------------------------------------------------------------

function demoSkinDataUrl() {
  const px = (x, y, w, h, fill) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;

  let body = px(0, 0, 64, 64, '#2b2b2b');
  // 头部正脸（8,8 起 8×8，每格 1px）
  body += px(8, 8, 8, 8, '#e0b48c'); // 皮肤底色
  body += px(8, 8, 8, 3, '#4a2f1c'); // 头发
  body += px(9, 11, 2, 1, '#1d1d21'); // 左眼
  body += px(13, 11, 2, 1, '#1d1d21'); // 右眼
  body += px(11, 13, 2, 1, '#b06a5a'); // 嘴
  // 身体（20,20 起 8×12）
  body += px(20, 20, 8, 12, '#4a8f3c');
  body += px(20, 20, 8, 2, '#5fae4c');
  body += px(22, 24, 4, 4, '#f5c542'); // 胸前小徽章
  // 双臂
  body += px(44, 20, 4, 12, '#e0b48c');
  body += px(36, 52, 4, 12, '#e0b48c');
  // 双腿
  body += px(4, 20, 4, 12, '#3a3a72');
  body += px(12, 52, 4, 12, '#3a3a72');
  // 淡淡的网格，方便看出这是 64×64
  for (let i = 0; i <= 64; i += 8) {
    body += `<rect x="${i}" y="0" width="0.4" height="64" fill="#00000033"/>`;
    body += `<rect x="0" y="${i}" width="64" height="0.4" fill="#00000033"/>`;
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" ` +
    `shape-rendering="crispEdges">${body}</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// ---------------------------------------------------------------------------
// 五、假实现主体
// ---------------------------------------------------------------------------

export function createMockApi() {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 内存里的"配置"与"运行态"，getConfig 一律返回深拷贝，避免视图误改 */
  const store = {
    config: demoConfig(),
    secrets: {
      deepseek: 'sk-demo-0000000000000000000000003f2a',
      // 假密钥那条：见 demoConfig() 里 deepseek-test 的注释。
      'deepseek-test': 'sk-multibot-fake',
    },
    runtimes: demoRuntimes(),
    logSeq: 0,
  };

  /**
   * 哪些 profile 的密钥是"假的"。
   *
   * ★ 这里刻意**不**重复实现判定规则：真判定在 `app/electron/store.mjs` 的
   *   `looksLikePlaceholderKey()` 里（主进程算完通过 `keyIsPlaceholder` 回填）。
   *   mock 的职责是"造出三种状态给人看"，不是"判断真假"，所以它直接显式点名。
   *   要是这里也写一遍正则，就等于把同一条规则维护两份 —— 迟早对不上。
   */
  const FAKE_KEY_PROFILES = new Set(['deepseek-test']);

  /** 把密钥状态回填进配置 —— 主进程每次 loadConfigForUi 都会做同样的事 */
  function applySecretState() {
    for (const p of store.config.llm.profiles) {
      const raw = store.secrets[p.id];
      p.hasKey = Boolean(raw);
      p.keyHint = p.hasKey ? 'sk-…' + String(raw).slice(-4) : '';
      p.keyIsPlaceholder = Boolean(p.hasKey && FAKE_KEY_PROFILES.has(p.id));
    }
  }
  applySecretState();

  /** 演示用的记忆（按 botId 分开存，getMemory 返回深拷贝） */
  const memStore = {};

  const listeners = new Set();
  const lines = new Map(); // botId → 最近日志行（给 readLog 用）
  for (const id of Object.keys(store.runtimes)) lines.set(id, []);

  function emit(ev) {
    for (const fn of Array.from(listeners)) {
      try {
        fn(ev);
      } catch (err) {
        console.error('[ui][mock] 事件处理器抛错：', err);
      }
    }
  }

  function pushLine(botId, text) {
    const arr = lines.get(botId) || [];
    arr.push(text);
    if (arr.length > 2000) arr.splice(0, arr.length - 2000);
    lines.set(botId, arr);
  }

  // ── 定时器：1 Hz 运行态 + 随机 log/gate/llm ──────────────────────────────
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    for (const rt of Object.values(store.runtimes)) {
      const running = rt.status === 'running' || rt.status === 'reconnecting';

      // 启动中 / 停止中 / 重连中的状态迁移
      if (rt.status === 'starting' && tick % 2 === 0) {
        rt.status = 'running';
        rt.pid = 20000 + Math.floor(Math.random() * 20000);
        rt.startedAt = Date.now();
        rt.uptimeMs = 0;
        rt.lastError = null;
        rt.mc = {
          connected: true,
          health: 20,
          food: 20,
          position: { x: 128.5, y: 65, z: -342.2 },
          dimension: 'overworld',
          gamemode: 'survival',
        };
        emit({ type: 'status', botId: rt.id, status: rt.status, pid: rt.pid });
        emitLog(rt.id, 'info', `${rt.name} spawned.`);
      } else if (rt.status === 'stopping' && tick % 1 === 0) {
        rt.status = 'stopped';
        rt.pid = null;
        rt.startedAt = null;
        rt.uptimeMs = 0;
        rt.mc = null;
        emit({ type: 'status', botId: rt.id, status: rt.status, pid: null });
        emitLog(rt.id, 'info', `${rt.name} disconnected.`);
      } else if (running) {
        rt.uptimeMs = rt.startedAt ? Date.now() - rt.startedAt : rt.uptimeMs + 1000;
        if (rt.mc) {
          rt.mc.position.x = Math.round((rt.mc.position.x + (Math.random() - 0.5) * 2) * 10) / 10;
          rt.mc.position.z = Math.round((rt.mc.position.z + (Math.random() - 0.5) * 2) * 10) / 10;
          rt.mc.food = Math.max(0, rt.mc.food - (Math.random() < 0.05 ? 1 : 0));
        }
      }
    }

    emit({ type: 'runtime', bots: clone(Object.values(store.runtimes)) });

    if (tick < 3) return; // 前两拍先让界面把骨架画出来

    for (const rt of Object.values(store.runtimes)) {
      if (rt.status !== 'running') continue;

      // 引擎日志：约每 6 秒一条
      if (tick % 6 === 0) {
        emitLog(rt.id, pickLevel(), ENGINE_LOGS[Math.floor(Math.random() * ENGINE_LOGS.length)]);
      }

      // 门禁判定：约每 4 秒一条
      if (tick % 4 === 0) {
        const g = GATE_TEXT_POOL[Math.floor(Math.random() * GATE_TEXT_POOL.length)];
        const ts = Date.now();
        rt.gate.lastDecision = { ts, decision: g.decision, reason: g.reason, from: g.from, channel: g.channel, text: g.text };
        if (g.decision === 'PASS') rt.gate.passed++;
        else {
          rt.gate.blocked++;
          if (rt.gate.byReason[g.reason] === undefined) rt.gate.byReason[g.reason] = 0;
          rt.gate.byReason[g.reason]++;
        }
        emit({ type: 'gate', botId: rt.id, ts, ...g });
      }

      // 大模型调用：约每 9 秒一次
      if (tick % 9 === 0) {
        const ts = Date.now();
        const promptTokens = 600 + Math.floor(Math.random() * 500);
        const completionTokens = 20 + Math.floor(Math.random() * 60);
        const ms = 900 + Math.floor(Math.random() * 1400);
        rt.llm.calls++;
        rt.llm.promptTokens += promptTokens;
        rt.llm.completionTokens += completionTokens;
        rt.llm.todayTokens += promptTokens + completionTokens;
        rt.llm.lastLatencyMs = ms;
        emit({
          type: 'llm',
          botId: rt.id,
          ts,
          model: 'deepseek-chat',
          ms,
          promptTokens,
          completionTokens,
          ok: true,
        });
        emitLog(rt.id, 'info', `[LLM] reply in ${ms}ms: ${LLM_REPLIES[Math.floor(Math.random() * LLM_REPLIES.length)]}`);
      }
    }
  }, 1000);

  // 浏览器环境里别让定时器长期挂着（Electron 里不会触发 unload）
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => clearInterval(timer));
  }

  function pickLevel() {
    const r = Math.random();
    if (r < 0.72) return 'info';
    if (r < 0.93) return 'warn';
    return 'error';
  }

  function emitLog(botId, level, text) {
    const ts = Date.now();
    store.logSeq++;
    const line = `[${new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })}] [${level}] ${text}`;
    pushLine(botId, line);
    emit({ type: 'log', botId, ts, level, line });
  }

  // 初始灌一批历史日志，让日志页一打开就有内容
  (function seedHistory() {
    const base = Date.now() - 30 * MIN;
    for (const rt of Object.values(store.runtimes)) {
      for (let i = 0; i < 26; i++) {
        const ts = base + i * 61 * 1000;
        const time = new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
        let line;
        if (i % 3 === 0) {
          const g = GATE_TEXT_POOL[i % GATE_TEXT_POOL.length];
          const reason = g.decision === 'BLOCK' ? ` reason=${g.reason}` : '';
          line = `[${time}] [gate] ${g.decision} channel=${g.channel} from=${g.from}${reason} text=${JSON.stringify(g.text)}`;
        } else if (i % 3 === 1) {
          line = `[${time}] [info] ${ENGINE_LOGS[i % ENGINE_LOGS.length]}`;
        } else {
          const ms = 900 + ((i * 137) % 1500);
          line = `[${time}] [info] [LLM] deepseek-chat ${ms}ms promptTokens=${600 + i * 21} completionTokens=${30 + i}`;
        }
        pushLine(rt.id, line);
      }
    }
  })();

  // -------------------------------------------------------------------------
  // 六、McbotAPI 实现
  // -------------------------------------------------------------------------

  const api = {
    // ── 环境 ──
    async getEnv() {
      await delay(60);
      return {
        ok: true,
        projectRoot: 'D:\\mc_company_bot',
        nodePath: 'D:\\mc_company_bot\\runtime\\node-v22.23.3-win-x64\\node.exe',
        nodeVersion: 'v22.23.3',
        engineDir: 'D:\\mc_company_bot\\vendor\\mindcraft-develop',
        engineOk: true,
        javaPath: 'D:\\mc_company_bot\\runtime\\jdk-21.0.12.1+1-jre\\bin\\java.exe',
        versions: {
          mineflayer: '4.33.0',
          minecraftProtocol: '1.64.0',
          minecraftData: '3.97.0',
        },
        problems: [],
      };
    },

    async getVersions() {
      await delay(30);
      return {
        app: '0.1.0',
        electron: '38.2.0',
        chrome: '140.0.7339.80',
        node: '22.23.3',
      };
    },

    // ── 配置 ──
    async getConfig() {
      await delay(80);
      return clone(store.config);
    },

    async saveConfig(cfg) {
      await delay(220);
      const errors = validateConfig(cfg);
      if (errors.length) return { ok: false, errors };
      store.config = clone(cfg);
      // 主进程会回填 hasKey/keyHint/keyIsPlaceholder，这里同步一下
      applySecretState();
      console.log('[ui][mock] config saved:', store.config.bots.length, 'bots');
      return { ok: true, errors: [] };
    },

    // ── 密钥 ──
    async setSecret(profileId, key) {
      await delay(160);
      if (!key || !String(key).trim()) return { ok: false, error: '密钥不能为空' };
      store.secrets[profileId] = String(key).trim();
      // 用户真的粘了一把新密钥进来 —— 那就不再是"假密钥"了（真主进程同样按内容重新算）
      if (!/fake|placeholder|test/i.test(String(key).trim())) FAKE_KEY_PROFILES.delete(profileId);
      applySecretState();
      return { ok: true };
    },

    async clearSecret(profileId) {
      await delay(120);
      delete store.secrets[profileId];
      FAKE_KEY_PROFILES.delete(profileId);
      applySecretState();
      return { ok: true };
    },

    async testLLM(profileId, keyOverride) {
      const started = Date.now();
      await delay(500 + Math.random() * 900);
      const profile = store.config.llm.profiles.find((p) => p.id === profileId);
      if (!profile) return { ok: false, error: `找不到模型配置：${profileId}`, hint: '' };
      const local = /127\.0\.0\.1|localhost/.test(profile.baseUrl || '');
      if (!local && !store.secrets[profileId] && !keyOverride) {
        return { ok: false, error: 'HTTP 401：Authentication Fails, Your api key is invalid', hint: '密钥无效或没有权限 —— 重新填写 API Key 试试。' };
      }
      const ms = Date.now() - started;
      return {
        ok: true,
        ms,
        model: profile.model,
        reply: LLM_REPLIES[Math.floor(Math.random() * LLM_REPLIES.length)],
      };
    },

    // ── MC 版本（演示模式：下面这份候选表是**假的**）──
    // 真跑起来时这些都由 runner/mc-versions.mjs 回答；渲染进程不能 import 它
    // （那个模块要用 node: 的东西），所以演示模式里只放"长得像"的几个版本。
    // 演示数据也要说人话：`tested`/`realServer`/`note` 三样都得有。
    async mcVersionCatalog() {
      await delay(30);
      return {
        ok: true,
        default: '1.21.1',
        dataVerified: ['1.20.1', '1.21.1'],
        realServer: ['1.21.1'],
        options: [
          { version: '1.21.1', protocol: 767, tested: true, realServer: true, note: '我们真连过' },
          { version: '1.20.1', protocol: 763, tested: true, realServer: false, note: '数据核对过' },
          { version: '1.20.4', protocol: 765, tested: false, realServer: false, note: '没核对过' },
        ],
      };
    },

    async judgeMcVersion(raw) {
      await delay(30);
      const s = String(raw ?? '').trim();
      const cat = await this.mcVersionCatalog();
      if (!s || /^(auto|自动|随便|默认)$/i.test(s)) {
        return {
          ok: true, raw: s, version: '1.21.1', mode: 'auto', protocol: 767,
          tested: true, realServer: true, suggestions: [],
          reason: '自动：用 1.21.1（协议 767）',
          hint: '「自动」不会去猜服务器的版本 —— 引擎在连接时按服务端回包自己纠正。',
        };
      }
      const hit = cat.options.find((o) => o.version === s);
      if (hit) {
        return {
          ok: true, raw: s, version: hit.version, mode: 'explicit', protocol: hit.protocol,
          tested: hit.tested, realServer: hit.realServer, suggestions: [],
          reason: `${hit.version} 可以（协议 ${hit.protocol}）`,
          hint: hit.tested && !hit.realServer
            ? `它的方块/配方我们逐条核对过，但**没有真的连过 ${hit.version} 服务器**。`
            : '',
        };
      }
      return {
        ok: false, raw: s, mode: 'explicit', suggestions: [],
        reason: `「${s}」不是已知的版本号`,
        hint: '可用的版本（有数据的）：1.21.1 / 1.20.1 / 1.20.4；不想挑就填 auto。',
      };
    },

    // ── 服务器 ──
    async probeServer({ host, port, version }) {
      await delay(400 + Math.random() * 700);
      const h = String(host || '').trim();
      const p = Number(port);
      if (!h) return { ok: false, error: '地址不能为空' };
      if (!Number.isFinite(p) || p <= 0 || p > 65535) return { ok: false, error: '端口必须是 1-65535' };
      if (/example\.com|^10\.|^192\.168/.test(h) && !/^(127\.0\.0\.1|localhost)$/.test(h)) {
        return { ok: false, error: `连接超时：${h}:${p} 在 5000ms 内没有响应（服务器未开或防火墙拦截）` };
      }
      // 版本填错时和真主进程一样：**不去连**，直接说人话（这道闸在连接之前）。
      const judge = await this.judgeMcVersion(version);
      if (!judge.ok) return { ok: false, error: judge.reason, hint: judge.hint, suggestions: judge.suggestions, judge };
      return {
        ok: true,
        version: judge.version,
        protocol: judge.protocol || 767,
        motd: '§a一个 Minecraft 服务器 §7| §e1.21.1 · Fabric',
        players: { online: 1, max: 20 },
        judge,
      };
    },

    // ── 人格预设 ──
    // 演示模式下主进程不在，就直接回内置表（与 views/persona.js 共用同一份，
    // 别在这里再抄一遍）。真跑起来时这个调用会去读 runner/personas/*.json。
    async getPersonas() {
      await delay(30);
      return { ok: true, personas: clone(PERSONA_PRESETS) };
    },
    async listPersonas() {
      return this.getPersonas();
    },

    // ── 长期记忆（演示数据）──
    // 演示模式下主进程不在，就给一份像样的样例，让用户能看见"记忆"长什么样。
    async getMemory(botId) {
      await delay(40);
      const list = memStore[botId] || (memStore[botId] = [
        { id: 'demo1', ts: Date.now() - 86400000 * 2, kind: 'fact', text: '主人叫 Steve，喜欢下矿洞', from: 'Steve' },
        { id: 'demo2', ts: Date.now() - 86400000 * 2, kind: 'place', text: '家在 (-12, 64, 30)', from: null },
        { id: 'demo3', ts: Date.now() - 86400000, kind: 'promise', text: '答应 Steve 明天一起去挖铁矿', from: 'Steve' },
        { id: 'demo4', ts: Date.now() - 3600000, kind: 'event', text: `${new Date().toLocaleDateString('zh-CN')} 和 Steve 在 (-16, 112, -4) 盖了一栋 3×3 的小木屋，放了 23 块`, from: null },
      ]);
      return { ok: true, botId, entries: clone(list), file: `（演示）runtime\\memory\\${botId}.json` };
    },
    async addMemory(botId, text) {
      await delay(30);
      const body = String(text || '').trim();
      if (body.length < 2) return { ok: false, error: '内容太短了，至少写两个字' };
      const list = await this.getMemory(botId).then(r => r.entries);
      const dup = list.some(e => e.text === body);
      if (!dup) list.unshift({ id: 'demo' + Date.now(), ts: Date.now(), kind: 'fact', text: body, from: '主人' });
      memStore[botId] = list;
      return { ok: true, dup, count: list.length };
    },
    async forgetMemory(botId, what) {
      await delay(30);
      const list = await this.getMemory(botId).then(r => r.entries);
      const kept = list.filter(e => e.id !== what && e.text !== what);
      memStore[botId] = kept;
      return { ok: true, removed: list.length - kept.length, count: kept.length };
    },
    async clearMemory(botId) {
      await delay(30);
      const list = await this.getMemory(botId).then(r => r.entries);
      memStore[botId] = [];
      return { ok: true, removed: list.length };
    },

    // ── bot 生命周期 ──
    async listBots() {
      await delay(50);
      return clone(Object.values(store.runtimes));
    },

    async startBot(id) {
      const rt = store.runtimes[id];
      if (!rt) return { ok: false, error: `没有这个 bot：${id}` };
      if (rt.status === 'running' || rt.status === 'starting') return { ok: true };
      const cfgBot = store.config.bots.find((b) => b.id === id);
      rt.displayName = cfgBot ? cfgBot.displayName : rt.displayName;
      if (!cfgBot || cfgBot.owners.length === 0) {
        rt.status = 'error';
        rt.lastError = '未配置 owner，门禁会拒绝一切消息，已中止启动';
        return { ok: false, error: rt.lastError };
      }
      rt.status = 'starting';
      rt.lastError = null;
      emitLog(id, 'info', `正在启动 ${rt.name} …（引擎进程 spawn 中）`);
      return { ok: true };
    },

    async stopBot(id) {
      const rt = store.runtimes[id];
      if (!rt) return { ok: false, error: `没有这个 bot：${id}` };
      if (rt.status === 'stopped') return { ok: true };
      rt.status = 'stopping';
      emitLog(id, 'info', `正在停止 ${rt.name} …`);
      return { ok: true };
    },

    async restartBot(id) {
      const rt = store.runtimes[id];
      if (!rt) return { ok: false, error: `没有这个 bot：${id}` };
      rt.restarts++;
      rt.status = 'starting';
      rt.lastError = null;
      emitLog(id, 'warn', `收到重启请求，${rt.name} 即将重新上线（第 ${rt.restarts} 次）`);
      return { ok: true };
    },

    async stopAll() {
      await delay(120);
      for (const rt of Object.values(store.runtimes)) {
        if (rt.status === 'running' || rt.status === 'starting') rt.status = 'stopping';
      }
      return { ok: true };
    },

    // ── 观测 ──
    async readLog(id, opts = {}) {
      await delay(80);
      const n = Number(opts.lines) > 0 ? Number(opts.lines) : 400;
      const arr = lines.get(id) || [];
      return arr.slice(Math.max(0, arr.length - n));
    },

    async clearStats(id) {
      await delay(80);
      const rt = store.runtimes[id];
      if (!rt) return { ok: false };
      rt.llm.calls = 0;
      rt.llm.promptTokens = 0;
      rt.llm.completionTokens = 0;
      rt.llm.todayTokens = 0;
      rt.llm.lastLatencyMs = null;
      rt.gate.passed = 0;
      rt.gate.blocked = 0;
      for (const k of Object.keys(rt.gate.byReason)) rt.gate.byReason[k] = 0;
      return { ok: true };
    },

    // ── 皮肤 ──
    async pickSkinFile() {
      await delay(300);
      return {
        path: 'D:\\mc_company_bot\\runtime\\skins\\xiaodou_64x64.png',
        dataUrl: demoSkinDataUrl(),
      };
    },

    async readSkinFile(path) {
      await delay(120);
      if (!path) return { ok: false, error: '路径为空' };
      if (!/\.png$/i.test(path)) return { ok: false, error: '只支持 PNG 皮肤文件' };
      return { ok: true, dataUrl: demoSkinDataUrl() };
    },

    // ── 事件订阅 ──
    onEvent(handler) {
      listeners.add(handler);
      // 订阅时立刻补一帧运行态，避免界面空着等 1 秒
      setTimeout(() => {
        try {
          handler({ type: 'runtime', bots: clone(Object.values(store.runtimes)) });
        } catch (err) {
          console.error('[ui][mock] 首帧推送失败：', err);
        }
      }, 0);
      return () => listeners.delete(handler);
    },

    // ── 杂项 ──
    async openExternal(url) {
      console.log('[ui][mock] openExternal:', url);
    },

    async pickDirectory() {
      await delay(200);
      return 'D:\\mc_company_bot\\runtime\\skins';
    },
  };

  // 与主进程 saveConfig 的校验规则保持一致（契约第二节）
  function validateConfig(cfg) {
    const errors = [];
    if (!cfg || typeof cfg !== 'object') return ['配置不是有效对象'];

    const serverIds = new Set((cfg.servers || []).map((s) => s.id));
    const profileIds = new Set(((cfg.llm && cfg.llm.profiles) || []).map((p) => p.id));
    const botIds = new Set();

    for (const s of cfg.servers || []) {
      if (!s.label || !String(s.label).trim()) errors.push('服务器名称不能为空');
      const port = Number(s.port);
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        errors.push(`服务器「${s.label || s.id}」的端口必须是 1-65535`);
      }
    }
    for (const p of (cfg.llm && cfg.llm.profiles) || []) {
      if (!p.baseUrl || !/^https?:\/\//.test(p.baseUrl)) {
        errors.push(`模型「${p.label || p.id}」的 Base URL 必须以 http:// 或 https:// 开头`);
      }
      if (!p.model || !String(p.model).trim()) {
        errors.push(`模型「${p.label || p.id}」必须填模型名`);
      }
    }
    for (const b of cfg.bots || []) {
      const label = b.displayName || b.name || b.id;
      if (!/^[a-zA-Z0-9_]{3,16}$/.test(String(b.name || ''))) {
        errors.push(`机器人「${label}」：MC 账号名只能是 3-16 位字母/数字/下划线`);
      }
      if (!Array.isArray(b.wakeNames) || b.wakeNames.length === 0) {
        errors.push(`机器人「${label}」：必须至少有一个唤醒称谓`);
      }
      if (!Array.isArray(b.owners) || b.owners.length === 0) {
        errors.push(`机器人「${label}」：必须至少指定一个 owner，否则 bot 不会响应任何人`);
      }
      if (b.serverId && !serverIds.has(b.serverId)) {
        errors.push(`机器人「${label}」：指向了不存在的服务器 ${b.serverId}`);
      }
      if (b.llmProfileId && !profileIds.has(b.llmProfileId)) {
        errors.push(`机器人「${label}」：指向了不存在的大模型 API ${b.llmProfileId}`);
      }
      if (botIds.has(b.id)) errors.push(`机器人 id 重复：${b.id}`);
      botIds.add(b.id);
    }
    const seenSrv = new Set();
    for (const s of cfg.servers || []) {
      if (seenSrv.has(s.id)) errors.push(`服务器 id 重复：${s.id}`);
      seenSrv.add(s.id);
    }
    return errors;
  }

  return api;
}

/**
 * 装到 window.mcbot 上。已存在则不覆盖，返回 true 表示"这次装了 mock"。
 */
export function installMock(target = typeof window !== 'undefined' ? window : null) {
  if (!target) return false;
  if (target.mcbot) return false;
  target.mcbot = createMockApi();
  target.__MCBOT_MOCK__ = true;
  console.log('[ui] window.mcbot 不存在 —— 已装载内置假实现（mock.js），当前为离线演示模式。');
  return true;
}
