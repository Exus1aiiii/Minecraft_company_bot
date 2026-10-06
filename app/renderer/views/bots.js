// ============================================================================
// views/bots.js —— 机器人页（本项目最重要的页面）
//
// 每个 bot 一张卡：中文名 + MC 账号名 + 所属服务器 + 状态灯 + pid + 运行时长
// + 开关滑杆（startBot / stopBot）+ 重启按钮 + 实时统计行（大模型调用次数 /
// 今日 token / 门禁拦截次数）。展开后能看到最近的规则开关、门禁判定与最近日志。
//
// 性能约定：卡片骨架只在"bot 数量/身份变化"时重建；1 Hz 的 runtime 事件只
// 走 patchRuntime() 就地改文本，避免滚动位置与展开状态被冲掉。
// ============================================================================

import {
  h, clear, mount, fmtNum, fmtTokens, fmtDur, fmtMs, fmtAgo, fmtClock, fmtPos,
  statusInfo, gateReasonCN, button, toggle, kv, errText, input, select, uid,
} from '../ui.js';
import { BUILTIN_PERSONAS } from './persona.js';

export const id = 'bots';

// ---------------------------------------------------------------------------
// 展开过哪几张卡片 —— 刻意放在模块级，而不是 render() 内部
// ---------------------------------------------------------------------------
//
// ★ 为什么不能放在视图状态里：app.js 的 saveConfig() 成功之后会调 remountView()，
//   也就是把当前页面**整个重挂一遍**（那边的注释写着"避免视图抱着旧对象引用"）。
//   重挂会重建 render() 的局部状态，于是"哪些卡片是展开的"会全部归零。
//   后果很具体：用户点开卡片、改了两个字段、按「保存配置」—— 保存成功的同时
//   编辑区自己合上了，看起来像把他改的东西弄丢了。（这个坑是 render-headless
//   第 5 节先测出来的：点开详情的按钮文字已经是「收起详情 ▴」，里面却是空的，
//   因为重挂发生在点击之后。）
//   放在模块级还能顺手带来一个好处：切到别的页再回来，展开的卡片还开着。
const openCards = new Set();
export const label = '机器人';
export const icon = '◈';

// ---------------------------------------------------------------------------
// 渲染入口
// ---------------------------------------------------------------------------

export function render(container, ctx) {
  const state = {
    cards: new Map(),   // botId → { el, patch, detail }
    blob: null,         // { signature, elements }
    // 人格下拉用。唯一事实来源是主进程读的 runner/personas/*.json，
    // BUILTIN_PERSONAS 只是它读回来之前的兜底 —— 见下面 loadPersonas()。
    personas: BUILTIN_PERSONAS.slice(),
  };
  // 展开状态在模块级的 openCards 里（见文件开头），这里只是给本视图起个短名字。
  const detailOpen = openCards;

  const head = h('div', { class: 'view-head' },
    h('span', { class: 'view-title' }, '机器人'),
    h('span', { class: 'view-sub' }, '开关即启停；改动会自动标脏，点顶部「保存配置」落盘'),
    h('span', { class: 'spacer' }),
    button('新建机器人', {
      level: 'default',
      onClick: () => ctx.run('新建机器人', async () => addBot()),
    }),
    button('启动全部', {
      level: 'default',
      onClick: () => ctx.run('启动全部', async () => {
        for (const b of ctx.config.bots) {
          if (b.enabled) await window.mcbot.startBot(b.id);
        }
      }),
    }),
    button('停止全部', {
      level: 'default',
      onClick: () => ctx.run('停止全部', async () => { await window.mcbot.stopAll(); }),
    }),
    button('刷新', { level: 'ghost', onClick: () => ctx.reload() })
  );

  const firstRun = h('div');   // 首跑引导：主人名单还是出厂默认时，这里是唯一的出路
  const hint = h('div', { class: 'notice info' });
  const list = h('div', { class: 'bot-list' });

  mount(container, head, firstRun, hint, list);

  // -------------------------------------------------------------------------
  // 首跑引导卡：把主人改成你自己的游戏 ID
  // -------------------------------------------------------------------------
  //
  // ★ 为什么这张卡必须存在（这一段是全项目最容易让用户以为"软件坏了"的地方）：
  //   门禁只认主人名单里的人，名单外的玩家说话它**一句话都不回**。而出厂配置
  //   的主人名单是 ['Steve'] —— 它非空，所以校验通得过、警告也不响，界面上一切正常。
  //   用户进游戏喊「小豆 你好」，得到的是永久沉默。他不可能会想到"要去某页改个名字"。
  //   所以这里不只报一句警告，而是**直接给一个输入框和一键修复**。
  //   （服务端也补了一层：名单没配过时 bot 会在游戏里回一句说明 —— 见
  //     runner/mcbot-gate.mjs 的 maybeHintNotOwner。）
  function unclaimedBots() {
    return (ctx.config.bots || []).filter((b) => !b.ownersConfigured || !(b.owners || []).length);
  }

  function renderFirstRun() {
    clear(firstRun);
    const bots = unclaimedBots();
    if (!bots.length) return;

    const names = bots.map((b) => b.displayName || b.name).join('、');
    const box = input({
      placeholder: '你的游戏 ID（进服务器后显示的那个名字）',
      value: '',
      style: { width: '260px' },
    });

    const err = h('span', { class: 'field-hint' });

    const apply = () => {
      const name = String(box.value || '').trim();
      // MC 的账号名规则是 [a-zA-Z0-9_]{3,16}。离线服务器一般也只认这些字符，
      // 中文名多数服务器进不去 —— 所以这里挡住，而不是让他填完再在游戏里失败。
      if (!/^[a-zA-Z0-9_]{3,16}$/.test(name)) {
        err.textContent = '只能是 3~16 位字母、数字或下划线（和你进服务器时用的名字一模一样）';
        err.className = 'field-hint bad';
        return;
      }
      err.textContent = '';
      for (const b of bots) { b.owners = [name]; b.ownersConfigured = true; }
      ctx.markDirty();
      ctx.toast(`已把「${names}」的主人改成 ${name}`);
      renderFirstRun();
      ctx.save();
    };

    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });

    mount(firstRun,
      h('div', { class: 'notice warn firstrun' },
        h('span', { class: 'notice-title' }, '先做这一件事：让它认得出你'),
        h('div', { class: 'firstrun-body' },
          h('p', null,
            '聊天门只认「主人」名单里的人。名单外的玩家跟它说话，它',
            h('b', null, '一句话都不会回'),
            '——看起来就像坏了。'),
          h('p', null,
            `现在「${names}」的主人还是出厂默认的 `,
            h('code', null, (bots[0].owners || []).join('、') || '（空）'),
            '。改成你的游戏 ID：')
        ),
        h('div', { class: 'firstrun-row' }, box, button('就这个，改掉', { level: 'primary', onClick: apply }), err),
        h('p', { class: 'field-hint' },
          '不确定的话：进服务器后看聊天框里你自己的名字，或者按 Tab 看玩家列表。改完点顶部「保存配置」，然后重启这个 bot。')
      )
    );
  }

  // -------------------------------------------------------------------------
  // 提示条：根据配置与运行态给出中文指引
  // -------------------------------------------------------------------------
  function renderHint() {
    const bots = ctx.config.bots || [];
    const problems = [];
    if (!(ctx.config.servers || []).length) problems.push('还没有配任何服务器，先去「服务器」页加一条');
    if (!((ctx.config.llm && ctx.config.llm.profiles) || []).length) problems.push('还没有配大模型 API，先去「模型」页填一个');
    const noKey = ((ctx.config.llm && ctx.config.llm.profiles) || []).filter((p) => !p.hasKey);
    if (noKey.length && noKey.length === ((ctx.config.llm && ctx.config.llm.profiles) || []).length) {
      problems.push('所有模型都还没保存密钥，bot 起来也聊不了天');
    }
    for (const b of bots) {
      if (!b.owners || !b.owners.length) problems.push(`「${b.displayName || b.name}」没有配 owner，门禁会拒绝一切消息`);
      if (!b.wakeNames || !b.wakeNames.length) problems.push(`「${b.displayName || b.name}」没有配唤醒称谓，公屏叫不应它`);
    }

    if (!bots.length) {
      clear(hint);
      hint.className = 'notice warn';
      hint.appendChild(h('span', null, '还没有任何机器人。先在「服务器」页加服务器、在「模型」页填好 API，然后重新加载配置。'));
      return;
    }
    if (problems.length) {
      mount(hint,
        h('span', { class: 'notice-title' }, '开工前还要补：'),
        h('ul', { class: 'suggest-list' }, problems.map((p) => h('li', null, p)))
      );
      hint.className = 'notice warn';
    } else {
      mount(hint,
        h('span', null, '全部就绪：开关一拨就会拉起引擎进程；公屏说话记得带上唤醒称谓（私聊 /msg 免称谓）。')
      );
      hint.className = 'notice ok';
    }
  }

  // -------------------------------------------------------------------------
  // 列表构建 / 就地更新
  // -------------------------------------------------------------------------
  function signature() {
    // ★ 主人名单也算进签名：在卡片里改了主人，首跑引导卡要能立刻消失。
    return (ctx.config.bots || [])
      .map((b) => `${b.id}:${b.name}:${b.serverId}:${b.llmProfileId}:${b.personaId}:${b.ownersConfigured === true ? 1 : 0}:${(b.owners || []).join(',')}`)
      .join('|');
  }

  function buildList() {
    clear(list);
    state.cards.clear();
    const bots = ctx.config.bots || [];
    if (!bots.length) {
      list.appendChild(h('div', { class: 'empty-hint' }, '暂无机器人配置。'));
      return;
    }
    for (const cfgBot of bots) {
      const card = buildCard(cfgBot);
      state.cards.set(cfgBot.id, card);
      list.appendChild(card.el);
    }
    // 详情区（门禁/日志）依赖事件缓冲，展开状态要恢复
    for (const botId of detailOpen) {
      const card = state.cards.get(botId);
      if (card) card.setDetailOpen(true);
    }
  }

  // -------------------------------------------------------------------------
  // 增删机器人
  // -------------------------------------------------------------------------

  function addBot() {
    const servers = ctx.config.servers || [];
    const profiles = (ctx.config.llm && ctx.config.llm.profiles) || [];
    const n = (ctx.config.bots || []).length + 1;
    // 默认规则从已有的 bot 抄一份（store 在归一化时会把空 rules 填成出厂规则，
    // 但那是"下次读配置"才发生的事 —— 界面不该在这一刻显示成"没有规则"）。
    const rules = ((ctx.config.bots || [])[0]?.rules || []).map((r) => ({
      ...r, patterns: [...(r.patterns || [])],
    }));
    const bot = {
      id: uid('bot'),
      name: `Bot${n}`,
      displayName: `新伙伴${n}`,
      serverId: servers[0]?.id || '',
      llmProfileId: profiles[0]?.id || '',
      enabled: false,
      wakeNames: [`新伙伴${n}`, `Bot${n}`],
      owners: [],
      ownersConfigured: false,
      rateLimitMs: 3000,
      dailyTokenBudget: 200000,
      personaId: state.personas[0]?.id || 'companion-gentle',
      personaOverrides: {},
      skin: { model: 'slim', path: '', enabled: false },
      rules,
    };
    ctx.config.bots.push(bot);
    ctx.markDirty();
    state.blob = null;          // 强制重建列表，新卡片才会出现
    detailOpen.add(bot.id);
    update();
    ctx.toast('已新增一台机器人：展开它的详情，把「主人」改成你的游戏 ID', 'info');
  }

  function removeBot(cfgBot) {
    const rt = ctx.runtimeById(cfgBot.id);
    if (rt && (rt.status === 'running' || rt.status === 'starting')) {
      ctx.toast(`「${cfgBot.displayName || cfgBot.name}」还在运行，先把它关掉再删`, 'warn');
      return;
    }
    ctx.config.bots = (ctx.config.bots || []).filter((b) => b.id !== cfgBot.id);
    state.cards.delete(cfgBot.id);
    detailOpen.delete(cfgBot.id);
    ctx.markDirty();
    state.blob = null;
    update();
    ctx.toast(`已删除「${cfgBot.displayName || cfgBot.name}」（点顶部「保存配置」才真正落盘）`, 'info');
  }

  // -------------------------------------------------------------------------
  // 人格列表：读完只重绘编辑区，不动卡片与滚动位置
  // -------------------------------------------------------------------------
  //
  // 刻意不让 render() 变成 async —— 视图的渲染契约是同步的，慢一步的列表
  // 顶多让下拉里少几个人格，不该把整页卡住。
  function loadPersonas() {
    const p = window.mcbot && window.mcbot.getPersonas;
    if (typeof p !== 'function') return;
    Promise.resolve()
      .then(() => p.call(window.mcbot))
      .then((r) => {
        const list = Array.isArray(r) ? r : (r && r.ok !== false && Array.isArray(r.personas) ? r.personas : null);
        if (!list || !list.length) return;
        state.personas = list.map((x) => ({ id: x.id, label: x.label || x.id }));
        for (const card of state.cards.values()) card.refreshEdit();
      })
      .catch(() => { /* 读不到就用内置表，不值得打扰用户 */ });
  }

  function buildCard(cfgBot) {
    const rt0 = ctx.runtimeById(cfgBot.id);

    // ── 头部 ──
    const elDot = h('i', { class: 'dot' });
    const elStatusText = h('span', null, '—');
    const elStatus = h('span', { class: 'status' }, elDot, elStatusText);

    const elMeta = h('div', { class: 'bot-meta' }, '—');
    const elPid = h('span', { class: 'bot-meta mono' }, '—');
    const elUptime = h('span', { class: 'bot-meta mono' }, '—');

    const elToggle = toggle(Boolean(cfgBot.enabled), async (next) => {
      cfgBot.enabled = next;
      ctx.markDirty();
      // 开关先落盘再动进程：避免重启软件后状态回退（契约里 enabled 是持久化状态）
      const saved = await ctx.save({ silent: true });
      if (!saved) {
        cfgBot.enabled = !next;
        ctx.markDirty();
        refreshEnabled();
        return;
      }
      const res = next
        ? await ctx.call('启动机器人', () => window.mcbot.startBot(cfgBot.id))
        : await ctx.call('停止机器人', () => window.mcbot.stopBot(cfgBot.id));
      if (res && res.ok === false && res.error) ctx.toast(res.error, 'error');
      refreshEnabled();
    }, { title: '上线 / 下线' });

    const elRestart = button('重启', {
      level: 'default',
      small: true,
      onClick: async () => {
        const res = await ctx.call('重启机器人', () => window.mcbot.restartBot(cfgBot.id), { silent: true });
        if (res && res.ok === false && res.error) ctx.toast(res.error, 'error');
        else ctx.toast(`已请求重启「${cfgBot.displayName || cfgBot.name}」`, 'ok');
      },
    });

    const elExpand = button('展开详情 ▾', {
      level: 'ghost',
      small: true,
      onClick: () => setDetailOpen(!detailOpen.has(cfgBot.id)),
    });

    const elAvatar = h('div', { class: 'bot-avatar' }, '☻');
    const elName = h('div', { class: 'bot-name' }, cfgBot.displayName || cfgBot.name);
    const elId = h('div', { class: 'bot-id' }, elName, elMeta);

    const head = h('div', { class: 'bot-head' },
      elAvatar, elId, elStatus,
      h('span', { class: 'spacer' }),
      h('div', { class: 'bot-actions' },
        elPid, elUptime, elToggle, elRestart, elExpand
      )
    );

    // ── 统计行 ──
    const elCalls = h('div', { class: 'stat-value mono' }, '0');
    const elCallsFoot = h('div', { class: 'stat-foot' }, '最近延迟 —');
    const statCalls = h('div', { class: 'stat' },
      h('div', { class: 'stat-label' }, '大模型调用次数'), elCalls, elCallsFoot);

    const elTokens = h('div', { class: 'stat-value mono' }, '0');
    const elBudgetFill = h('div', { class: 'budget-fill' });
    const elBudget = h('div', { class: 'budget-bar' }, elBudgetFill);
    const elTokensFoot = h('div', { class: 'stat-foot' }, '预算 —');
    const statTokens = h('div', { class: 'stat' },
      h('div', { class: 'stat-label' }, '今日 token'), elTokens, elBudget, elTokensFoot);

    const elBlocked = h('div', { class: 'stat-value mono' }, '0');
    const elBlockedFoot = h('div', { class: 'stat-foot' }, '通过 —');
    const statBlocked = h('div', { class: 'stat' },
      h('div', { class: 'stat-label' }, '门禁拦截次数'), elBlocked, elBlockedFoot);

    // ── 事实区（服务器 / 模型 / 人格 / 位置 / 维度）──
    const elFacts = h('div', { class: 'bot-facts' });

    const elError = h('div', { class: 'bot-error', style: { display: 'none' } });

    const body = h('div', { class: 'bot-body' },
      h('div', { class: 'bot-stats' }, statCalls, statTokens, statBlocked),
      elFacts
    );

    // ── 编辑区 ──
    const elEdit = h('div', { class: 'bot-edit' });

    // ── 展开详情 ──
    const elGateList = h('div', { class: 'sunken-box' });
    const elMiniLog = h('div', { class: 'mini-log' });
    const elRules = h('div', { class: 'rules' });
    const elDetail = h('div', { class: 'bot-detail', style: { display: 'none' } },
      elEdit,
      h('div', { class: 'detail-cols' },
        h('div', { class: 'detail-col' },
          h('div', { class: 'detail-title' }, '最近的门禁判定'),
          elGateList,
          h('div', { class: 'detail-title' }, '固定意图规则（命中即执行，零 token）'),
          elRules,
          h('div', { class: 'btn-group' },
            button('清空统计', {
              level: 'ghost', small: true,
              onClick: async () => {
                const res = await ctx.call('清空统计', () => window.mcbot.clearStats(cfgBot.id), { silent: true });
                if (res && res.ok === false) ctx.toast('清空失败', 'error');
                else ctx.toast(`已清空「${cfgBot.displayName || cfgBot.name}」的统计`, 'ok');
              },
            }),
            button('查看完整日志', {
              level: 'ghost', small: true,
              onClick: () => ctx.goto('logs', { botId: cfgBot.id }),
            })
          )
        ),
        h('div', { class: 'detail-col' },
          h('div', { class: 'detail-title' }, '最近的引擎日志'),
          elMiniLog
        )
      )
    );

    // ── 编辑配置（★ 这是全应用唯一能改主人名单的地方 —— 没有它，用户只能去
    //    手改 runtime\config.json，而"名单里没你"的表现是 bot 在游戏里一声不吭）──
    function renderEdit() {
      clear(elEdit);

      const servers = ctx.config.servers || [];
      const profiles = (ctx.config.llm && ctx.config.llm.profiles) || [];
      const personas = (state.personas && state.personas.length) ? state.personas : BUILTIN_PERSONAS;

      const fld = (label, node, hint) => h('div', { class: 'edit-field' },
        h('span', { class: 'field-label' }, label), node,
        hint ? h('span', { class: 'field-hint' }, hint) : null);

      // 逗号 / 顿号 / 空格都当分隔符：用户不会在意中英文标点
      const splitList = (v) => String(v || '').split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean);

      const elNameWarn = h('span', { class: 'field-hint' });
      const elOwnersWarn = h('span', { class: 'field-hint' });

      const elNameInput = input({
        value: cfgBot.name || '',
        placeholder: 'Xiaodou',
        onInput: (v) => {
          cfgBot.name = v.trim();
          // 引擎硬性要求：[a-zA-Z0-9_]{3,16}。中文只能当唤醒称谓，不能当账号名。
          const bad = !/^[a-zA-Z0-9_]{3,16}$/.test(cfgBot.name);
          elNameWarn.textContent = bad
            ? '只能是 3~16 位字母、数字或下划线（这是 MC 账号名，中文不行）'
            : '';
          elNameWarn.className = bad ? 'field-hint bad' : 'field-hint';
          ctx.markDirty();
        },
      });

      const elDisplayInput = input({
        value: cfgBot.displayName || '',
        placeholder: '小豆',
        onInput: (v) => {
          cfgBot.displayName = v;
          setText(elName, v || cfgBot.name);   // 卡片标题跟着走，不用等重载
          ctx.markDirty();
        },
      });

      const elOwnersInput = input({
        value: (cfgBot.owners || []).join('、'),
        placeholder: '你的游戏 ID',
        onInput: (v) => {
          const list = splitList(v);
          cfgBot.owners = list;
          // ★ 只要用户动过这一栏，就永远算"配过了" —— 哪怕他填的正好是 Steve。
          //   否则首跑那张引导卡会一直挂着，怎么填都消不掉。
          if (list.length) cfgBot.ownersConfigured = true;
          const empty = list.length === 0;
          const weird = list.some((n) => !/^[a-zA-Z0-9_]{3,16}$/.test(n));
          elOwnersWarn.textContent = empty
            ? '空名单 = 它会拒绝所有人的话（这是故意的安全默认值）'
            : (weird ? '有名字不是 3~16 位字母数字下划线 —— 多半对不上服务器里的真实 ID' : '');
          elOwnersWarn.className = (empty || weird) ? 'field-hint bad' : 'field-hint';
          ctx.markDirty();
        },
      });

      elEdit.appendChild(h('div', { class: 'detail-title' }, '编辑这台机器人'));
      elEdit.appendChild(h('div', { class: 'edit-grid' },
        fld('MC 账号名', elNameInput, '进服务器时用的名字'),
        fld('中文名', elDisplayInput, '面板与唤醒称谓用'),
        fld('唤醒称谓', input({
          value: (cfgBot.wakeNames || []).join('、'),
          placeholder: '小豆、豆豆',
          onInput: (v) => { cfgBot.wakeNames = splitList(v); ctx.markDirty(); },
        }), '公屏上叫这几个词它才搭话；私聊不用'),
        fld('主人', elOwnersInput, '只有名单里的人能指挥它 —— 填你自己的游戏 ID'),
        fld('服务器', select(
          servers.map((s) => ({ value: s.id, label: `${s.label}（${s.host}:${s.port}）` })),
          { value: cfgBot.serverId, onChange: (v) => { cfgBot.serverId = v; ctx.markDirty(); } }
        )),
        fld('大模型', select(
          profiles.map((p) => ({ value: p.id, label: `${p.label} / ${p.model}` })),
          { value: cfgBot.llmProfileId, onChange: (v) => { cfgBot.llmProfileId = v; ctx.markDirty(); } }
        )),
        fld('人格', select(
          personas.map((p) => ({ value: p.id, label: p.label || p.id })),
          { value: cfgBot.personaId, onChange: (v) => { cfgBot.personaId = v; ctx.markDirty(); } }
        )),
        fld('限流', input({
          type: 'number', value: Math.round((cfgBot.rateLimitMs || 0) / 1000), min: 0, max: 600,
          onInput: (v) => { cfgBot.rateLimitMs = Math.max(0, Number(v) || 0) * 1000; ctx.markDirty(); },
        }), '秒 / 条（只影响大模型通路）'),
        fld('每日 token 预算', input({
          type: 'number', value: cfgBot.dailyTokenBudget || 0, min: 0,
          onInput: (v) => { cfgBot.dailyTokenBudget = Math.max(0, Number(v) || 0); ctx.markDirty(); },
        }), '超出后退回固定规则，不再调模型')
      ));
      elEdit.appendChild(h('div', { class: 'edit-warns' }, elNameWarn, elOwnersWarn));

      elEdit.appendChild(h('div', { class: 'btn-group' },
        button('保存配置', {
          level: 'primary', small: true,
          onClick: async () => {
            const res = await ctx.save();
            if (res) ctx.toast(`已保存「${cfgBot.displayName || cfgBot.name}」的配置`, 'ok');
          },
        }),
        button('删除这台机器人', {
          level: 'danger', small: true,
          onClick: () => removeBot(cfgBot),
        }),
        h('span', { class: 'field-hint' }, '改完记得保存；正在运行的 bot 要重启才会用上新配置')
      ));
    }

    const el = h('div', { class: 'bot-card' }, head, body, elError, elDetail);

    // ── 规则开关（编辑配置副本 → 标脏）──
    function renderRules() {
      clear(elRules);
      const rules = cfgBot.rules || [];
      if (!rules.length) {
        elRules.appendChild(h('span', { class: 'field-hint' }, '这个 bot 没有配置固定意图规则。'));
        return;
      }
      for (const rule of rules) {
        elRules.appendChild(
          h('div', { class: 'rule-item' },
            toggle(Boolean(rule.enabled), (next) => {
              rule.enabled = next;
              ctx.markDirty();
              renderRules();
            }),
            h('span', null, ruleLabel(rule)),
            h('span', { class: 'field-hint' }, rule.patterns && rule.patterns.length ? `「${rule.patterns.join('」「')}」` : '')
          )
        );
      }
    }

    function setDetailOpen(open) {
      if (open) detailOpen.add(cfgBot.id);
      else detailOpen.delete(cfgBot.id);
      elDetail.style.display = open ? '' : 'none';
      elExpand.textContent = open ? '收起详情 ▴' : '展开详情 ▾';
      if (open) {
        renderEdit();
        renderRules();
        renderDetailTexts();
      }
    }

    function renderDetailTexts() {
      // 门禁判定：优先用事件缓冲里属于本 bot 的 gate，兜底用 runtime 的 lastDecision
      const gates = ctx.gateBuffer.filter((g) => g.botId === cfgBot.id).slice(-12).reverse();
      clear(elGateList);
      if (!gates.length) {
        const rt = ctx.runtimeById(cfgBot.id);
        const last = rt && rt.gate ? rt.gate.lastDecision : null;
        if (last) gates.push({ ...last, botId: cfgBot.id });
      }
      if (!gates.length) {
        elGateList.appendChild(h('div', { class: 'log-empty' }, '还没有门禁记录。'));
      } else {
        for (const g of gates) {
          const pass = g.decision === 'PASS';
          elGateList.appendChild(
            h('div', { class: ['gate-line', pass ? 'gate-pass' : 'gate-block'] },
              h('span', { class: 'gate-ts mono' }, fmtClock(g.ts)),
              h('span', null, pass ? 'PASS' : 'BLOCK'),
              h('span', { class: 'gate-reason' }, pass ? '' : gateReasonCN(g.reason)),
              h('span', { class: 'field-hint' }, `${g.from || '?'}·${g.channel === 'whisper' ? '私聊' : '公屏'}`),
              h('span', { class: 'mono', style: { color: '#8a8a8a' } }, g.text ? ` ${truncate(g.text, 26)}` : '')
            )
          );
        }
      }

      // 最近日志（内存缓冲里属于本 bot 的最后 40 条）
      const logs = ctx.logBuffer.filter((l) => l.botId === cfgBot.id).slice(-40);
      clear(elMiniLog);
      if (!logs.length) {
        elMiniLog.appendChild(h('div', { class: 'log-empty' }, '还没有日志。'));
      } else {
        for (const l of logs) {
          elMiniLog.appendChild(
            h('div', { class: lvClass(l.level) }, `${fmtClock(l.ts)} ${l.line || ''}`)
          );
        }
        elMiniLog.scrollTop = elMiniLog.scrollHeight;
      }
    }

    // ── runtime 补丁 ──
    function patchRuntime() {
      const rt = ctx.runtimeById(cfgBot.id);
      const server = (ctx.config.servers || []).find((s) => s.id === cfgBot.serverId);
      const profile = ((ctx.config.llm && ctx.config.llm.profiles) || []).find((p) => p.id === cfgBot.llmProfileId);

      if (!rt) {
        elDot.className = 'dot';
        elStatus.className = 'status st-stopped';
        elStatusText.textContent = '未登记';
        elMeta.textContent = `${cfgBot.name} · ${server ? server.label : '服务器已删除'} · 主进程未上报运行态`;
        elPid.textContent = 'pid —';
        elUptime.textContent = '—';
        elError.style.display = '';
        elError.textContent = '主进程没有返回这个 bot 的运行态（可能是配置里刚新增、还没保存）。';
        return;
      }

      const info = statusInfo(rt.status);
      elStatus.className = `status ${info.cls}`;
      elStatusText.textContent = info.text;
      elDot.className = 'dot';

      elAvatar.textContent = rt.status === 'running' ? '☺' : (rt.status === 'error' ? '☹' : '☻');
      setText(elName, cfgBot.displayName || rt.displayName || rt.name);
      elMeta.textContent = `${cfgBot.name} · ${server ? `${server.label}（${server.host}:${server.port}）` : '服务器已删除'}`;
      elPid.textContent = rt.pid ? `pid ${rt.pid}` : 'pid —';
      elUptime.textContent = rt.status === 'running' || rt.status === 'reconnecting'
        ? `已运行 ${fmtDur(rt.uptimeMs)}`
        : (rt.startedAt ? `上次运行 ${fmtAgo(rt.startedAt)}` : '未运行');

      el.classList.toggle('is-running', rt.status === 'running');
      el.classList.toggle('is-error', rt.status === 'error');

      // 统计
      const llm = rt.llm || {};
      elCalls.textContent = fmtNum(llm.calls || 0);
      elCallsFoot.textContent = `最近延迟 ${llm.lastLatencyMs ? fmtMs(llm.lastLatencyMs) : '—'} · 累计 prompt ${fmtTokens(llm.promptTokens || 0)}`;
      elTokens.textContent = fmtTokens(llm.todayTokens || 0);
      const budget = llm.budget || cfgBot.dailyTokenBudget || 0;
      const ratio = budget > 0 ? Math.min(1, (llm.todayTokens || 0) / budget) : 0;
      elBudgetFill.style.width = `${(ratio * 100).toFixed(1)}%`;
      elBudgetFill.className = `budget-fill${ratio >= 0.9 ? ' bad' : ratio >= 0.7 ? ' warn' : ''}`;
      elTokensFoot.textContent = `预算 ${fmtTokens(budget)}（用掉 ${(ratio * 100).toFixed(0)}%）`;

      const gate = rt.gate || { blocked: 0, passed: 0, byReason: {} };
      setText(elBlocked, fmtNum(gate.blocked || 0));
      elBlockedFoot.textContent = `通过 ${fmtNum(gate.passed || 0)} · ${topReason(gate.byReason)}`;

      // 事实区
      clear(elFacts);
      elFacts.appendChild(kv('模型', profile ? `${profile.label} / ${profile.model}` : '未指定', { valueCls: profile ? '' : 'bad' }));
      elFacts.appendChild(kv('人格', cfgBot.personaId || '未指定'));
      elFacts.appendChild(kv('唤醒称谓', (cfgBot.wakeNames || []).join('、') || '（空，公屏叫不应）', {
        valueCls: (cfgBot.wakeNames || []).length ? '' : 'bad',
      }));
      elFacts.appendChild(kv('主人', (cfgBot.owners || []).join('、') || '（空，拒绝一切）', {
        valueCls: (cfgBot.owners || []).length ? '' : 'bad',
      }));
      elFacts.appendChild(kv('限流', `${Math.round((cfgBot.rateLimitMs || 0) / 1000)} 秒 / 条`));
      if (rt.mc) {
        elFacts.appendChild(kv('位置', fmtPos(rt.mc.position)));
        elFacts.appendChild(kv('维度', `${rt.mc.dimension || '?'} · ${rt.mc.gamemode || '?'}`, { cls: 'mono' }));
        elFacts.appendChild(kv('生命/饱食', `${rt.mc.health ?? '?'} / ${rt.mc.food ?? '?'}`));
      } else {
        elFacts.appendChild(kv('位置', '离线', { valueCls: 'bad' }));
      }
      if (rt.restarts) elFacts.appendChild(kv('自动重启', `${rt.restarts} 次`, { valueCls: 'warn' }));

      // 错误
      if (rt.lastError) {
        elError.style.display = '';
        elError.textContent = `最近错误：${rt.lastError}`;
      } else {
        elError.style.display = 'none';
      }

      if (detailOpen.has(cfgBot.id)) renderDetailTexts();
      elToggle.className = `switch ${cfgBot.enabled ? 'on' : 'off'}`;
      elRestart.disabled = !rt || rt.status === 'starting' || rt.status === 'stopping';
    }

    function refreshEnabled() {
      elToggle.className = `switch ${cfgBot.enabled ? 'on' : 'off'}`;
      elToggle.setAttribute('aria-checked', String(Boolean(cfgBot.enabled)));
    }

    return {
      el,
      patch: patchRuntime,
      setDetailOpen,
      refreshEdit: () => { if (detailOpen.has(cfgBot.id)) renderEdit(); },
      cfgBot,
    };
  }

  // -------------------------------------------------------------------------
  // 对外更新
  // -------------------------------------------------------------------------
  function update() {
    const sig = signature();
    if (state.blob !== sig) {
      state.blob = sig;
      renderFirstRun();
      renderHint();
      buildList();
    }
    for (const card of state.cards.values()) card.patch();
  }

  update();
  loadPersonas();
  return { update };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 只在内容真的变了时才写 DOM（1 Hz 刷新下这个判断能省掉大量重排） */
function setText(node, text) {
  const s = String(text ?? '');
  if (node.textContent !== s) node.textContent = s;
}

const RULE_LABELS = {
  followPlayer: '跟着我',
  stop: '停下',
  goToPlayer: '过来',
  inventory: '看背包',
  stats: '报坐标',
  collectBlocks: '采集原料',
  searchForBlock: '找方块',
  explore: '四处走走',
  buildHouse: '盖房子',
  remember: '记住事情',
  recall: '回忆事情',
  craft: '做工具',
};

function ruleLabel(rule) {
  const base = RULE_LABELS[rule.action] || rule.action || rule.id || '规则';
  return `${base}（${rule.id}）`;
}

function topReason(byReason) {
  if (!byReason) return '无拦截';
  let best = null;
  for (const [k, v] of Object.entries(byReason)) {
    if (!v) continue;
    if (!best || v > best[1]) best = [k, v];
  }
  if (!best) return '无拦截';
  return `最多：${gateReasonCN(best[0])} ${best[1]}`;
}

function lvClass(level) {
  if (level === 'warn' || level === 'warning') return 'lv-warn';
  if (level === 'error') return 'lv-error';
  return '';
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}
