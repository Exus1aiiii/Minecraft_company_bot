// ============================================================================
// views/models.js —— 模型（大模型 API）页
//
// 每个 profile 一张卡：名称 / Base URL / 模型名 / temperature / maxTokens / 超时，
// 加一块独立的密钥区（占位符显示 keyHint，留空 = 不修改，明文只在点「保存密钥」
// 的那一刻交给主进程，界面永不回显），以及「测试」按钮调 testLLM。
// 顶部四个预设按钮：DeepSeek / 通义千问 / Ollama 本地 / 自定义。
// ============================================================================

import { h, clear, mount, button, field, input, fmtMs, tag } from '../ui.js';

export const id = 'models';
export const label = '模型';
export const icon = '✦';

/** 预设：点了就把 Base URL 与模型名（以及超时）填成默认值 */
const PRESETS = [
  {
    key: 'deepseek',
    label: 'DeepSeek',
    profileLabel: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    temperature: 0.7,
    maxTokens: 800,
    timeoutMs: 60000,
    note: '国内直连最省事的选项，默认推荐。',
  },
  {
    key: 'qwen',
    label: '通义千问',
    profileLabel: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    temperature: 0.7,
    maxTokens: 800,
    timeoutMs: 60000,
    note: '阿里云 DashScope 的 OpenAI 兼容端点，模型名可换 qwen-turbo / qwen-max。',
  },
  {
    key: 'ollama',
    label: 'Ollama 本地',
    profileLabel: 'Ollama 本地',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    temperature: 0.8,
    maxTokens: 512,
    timeoutMs: 120000,
    note: '完全离线、不花钱，但本地小模型的陪伴效果和指令遵循都明显更弱。',
  },
  {
    key: 'custom',
    label: '自定义',
    profileLabel: '自定义 API',
    baseUrl: '',
    model: '',
    temperature: 0.7,
    maxTokens: 800,
    timeoutMs: 60000,
    note: '任何 OpenAI 兼容端点：填 Base URL（到 /v1 为止）与模型名即可。',
  },
];

export function render(container, ctx) {
  // profileId → { ok, text } 的测试结果
  const testResults = new Map();

  const head = h('div', { class: 'view-head' },
    h('span', { class: 'view-title' }, '模型'),
    h('span', { class: 'view-sub' }, '密钥只在保存那一刻进主进程，界面只显示尾号提示'),
    h('span', { class: 'spacer' }),
    button('新增模型', {
      level: 'primary',
      onClick: () => addProfile(PRESETS[3]),
    }),
    button('重新加载', { level: 'ghost', onClick: () => ctx.reload() })
  );

  const presetRow = h('div', { class: 'preset-row' },
    h('span', { class: 'field-label', style: { alignSelf: 'center' } }, '快速预设：'),
    PRESETS.map((p) =>
      button(p.label, {
        level: p.key === 'deepseek' ? 'primary' : 'default',
        small: true,
        title: p.note,
        onClick: () => addProfile(p),
      })
    )
  );

  const listBox = h('div');

  mount(container, head,
    h('div', { class: 'notice info' },
      '机器人只用 OpenAI 兼容接口（/chat/completions）。填完 Base URL / 模型名 / 密钥后，记得点这一页的「测试」确认能通，再去「机器人」页开开关。'
    ),
    presetRow,
    listBox
  );

  function profiles() {
    ctx.config.llm = ctx.config.llm || { profiles: [] };
    ctx.config.llm.profiles = ctx.config.llm.profiles || [];
    return ctx.config.llm.profiles;
  }

  function addProfile(preset) {
    const list = profiles();
    let pid = preset.key;
    let n = 2;
    while (list.some((p) => p.id === pid)) pid = `${preset.key}-${n++}`;
    list.push({
      id: pid,
      label: preset.profileLabel,
      baseUrl: preset.baseUrl,
      model: preset.model,
      temperature: preset.temperature,
      maxTokens: preset.maxTokens,
      timeoutMs: preset.timeoutMs,
      hasKey: false,   // 只读字段，由主进程回填
      keyHint: '',
    });
    ctx.markDirty();
    renderList();
    ctx.toast(`已新增模型「${preset.profileLabel}」（${preset.note}）`, 'info');
  }

  function removeProfile(profile) {
    const usedBy = (ctx.config.bots || []).filter((b) => b.llmProfileId === profile.id);
    if (usedBy.length) {
      ctx.toast(
        `还有 ${usedBy.length} 个 bot（${usedBy.map((b) => b.displayName || b.name).join('、')}）在用这个模型，先改掉它们的模型再删`,
        'warn'
      );
      return;
    }
    ctx.config.llm.profiles = profiles().filter((p) => p.id !== profile.id);
    testResults.delete(profile.id);
    ctx.markDirty();
    renderList();
    ctx.toast(`已删除模型「${profile.label}」`, 'info');
  }

  // -------------------------------------------------------------------------
  // 密钥与测试
  // -------------------------------------------------------------------------

  async function saveKey(profile, keyInput, statusEl) {
    const key = String(keyInput.value || '').trim();
    if (!key) {
      ctx.toast('密钥是空的，没做任何修改', 'warn');
      return;
    }
    const res = await ctx.call('保存密钥', () => window.mcbot.setSecret(profile.id, key), { silent: true });
    if (res && res.ok) {
      keyInput.value = '';
      await ctx.reload({ silent: true });
      ctx.toast(`已保存「${profile.label}」的密钥（界面只显示尾号）`, 'ok');
    } else {
      const msg = (res && res.error) || '保存失败';
      ctx.toast(msg, 'error');
      if (statusEl) statusEl.textContent = msg;
    }
  }

  async function clearKey(profile) {
    const res = await ctx.call('清除密钥', () => window.mcbot.clearSecret(profile.id), { silent: true });
    if (res && res.ok) {
      await ctx.reload({ silent: true });
      ctx.toast(`已清除「${profile.label}」的密钥`, 'info');
    } else {
      ctx.toast('清除失败', 'error');
    }
  }

  async function testProfile(profile, keyInput) {
    // ★ 把"刚粘贴进来还没保存"的密钥一起送过去测。
    //   否则用户贴完 Key 直接点「测试」，测的还是**上一次保存的旧密钥**（或者压根没有），
    //   于是明明 Key 是对的却报"密钥无效" —— 这种"说反了"的提示最劝退。
    const typed = String(keyInput?.value || '').trim();
    testResults.set(profile.id, { ok: null, text: '正在测试…' });
    renderList();
    const res = await ctx.call('测试模型', () => window.mcbot.testLLM(profile.id, typed || null), { silent: true });
    if (!res) {
      testResults.set(profile.id, { ok: false, text: '调用失败：主进程没有响应' });
    } else if (!res.ok) {
      // ★ `hint` 一定要显示出来 —— 主进程为每种失败都写了对应的中文提示
      //   （密钥无效 / 端点不存在 / 被限流 / 对面服务端出问题），只显示 error 就把它们全丢了。
      testResults.set(profile.id, { ok: false, text: res.error || '测试失败（未返回原因）', hint: res.hint || '' });
    } else {
      testResults.set(profile.id, {
        ok: true,
        text: `耗时 ${fmtMs(res.ms)} · 模型 ${res.model || profile.model}`
          + (typed ? '（用的是刚输入还没保存的密钥，记得点「保存密钥」）' : ''),
        reply: res.reply,
      });
    }
    renderList();
  }

  // -------------------------------------------------------------------------
  // 列表
  // -------------------------------------------------------------------------

  function renderList() {
    clear(listBox);
    const list = profiles();
    if (!list.length) {
      listBox.appendChild(
        h('div', { class: 'empty-hint' },
          '还没有任何大模型 API。点上面的「DeepSeek」预设最快 —— 只需要再贴一个密钥。')
      );
      return;
    }

    for (const profile of list) {
      listBox.appendChild(buildCard(profile));
    }
  }

  function buildCard(profile) {
    const usedBy = (ctx.config.bots || []).filter((b) => b.llmProfileId === profile.id);

    // ── 头部 ──
    const elLabelInput = input({
      value: profile.label,
      placeholder: '给这个 API 起个名（随便写）',
      style: { width: '190px' },
      mono: false,
      onInput: (v) => { profile.label = v; ctx.markDirty(); },
    });

    const headRow = h('div', { class: 'model-head' },
      elLabelInput,
      tag(profile.id, 'tag-dim'),
      usedBy.length
        ? tag(`被 ${usedBy.map((b) => b.displayName || b.name).join('、')} 使用`, 'tag-green')
        : tag('没有 bot 使用', 'tag-dim'),
      h('span', { class: 'spacer' }),
      button('测试', { small: true, level: 'primary', onClick: () => testProfile(profile, keyInput) }),
      button('删除', { small: true, level: 'danger', onClick: () => removeProfile(profile) })
    );

    // ── 参数 ──
    const fBase = field('Base URL', {
      value: profile.baseUrl,
      placeholder: 'https://api.deepseek.com/v1',
      width: '100%',
      onInput: (v) => { profile.baseUrl = v.trim(); ctx.markDirty(); },
    });
    const fModel = field('模型名', {
      value: profile.model,
      placeholder: 'deepseek-chat',
      width: '100%',
      onInput: (v) => { profile.model = v.trim(); ctx.markDirty(); },
    });
    const fTemp = field('temperature', {
      type: 'number', step: '0.1', min: 0, max: 2,
      value: profile.temperature,
      width: '84px',
      onInput: (v) => { profile.temperature = Number(v); ctx.markDirty(); },
    });
    const fMax = field('maxTokens', {
      type: 'number', min: 1, max: 32000,
      value: profile.maxTokens,
      width: '96px',
      onInput: (v) => { profile.maxTokens = Number(v); ctx.markDirty(); },
    });
    const fTimeout = field('超时 (ms)', {
      type: 'number', min: 1000, max: 600000, step: 1000,
      value: profile.timeoutMs,
      width: '104px',
      onInput: (v) => { profile.timeoutMs = Number(v); ctx.markDirty(); },
    });

    const grid = h('div', { class: 'field-row' },
      h('div', { style: { flex: '2 1 320px' } }, fBase.el),
      h('div', { style: { flex: '1 1 180px' } }, fModel.el),
      fTemp.el, fMax.el, fTimeout.el
    );

    // ── 密钥 ──
    // ★ 三种状态要分清楚：没填 / 填了但像假的 / 填了且像真的。
    //   中间那种最坑：界面上和真密钥长得一样，但一测就报"密钥无效"。
    //   （真发生过：早期自检把 sk-multibot-fake 写进了 runtime\secrets.json。）
    const keyStatus = h('span', { class: 'field-hint' },
      !profile.hasKey ? '还没保存密钥'
        : profile.keyIsPlaceholder ? `已保存（${profile.keyHint || 'sk-…'}）—— 但这看着像测试用的假密钥`
          : `已保存（${profile.keyHint || 'sk-…'}）`
    );
    keyStatus.className = `key-state ${profile.hasKey ? (profile.keyIsPlaceholder ? 'warn' : 'ok') : 'none'}`;

    const keyInput = input({
      type: 'password',
      value: '',
      placeholder: profile.hasKey ? `${profile.keyHint || 'sk-…'}（留空表示不修改）` : '粘贴你的 API Key',
      style: { width: '300px' },
      onInput: () => { keyStatus.textContent = '输入了新密钥，点右边「保存密钥」生效'; keyStatus.className = 'key-state'; },
    });

    const keyRow = h('div', { class: 'key-row' },
      h('span', { class: 'field-label', style: { alignSelf: 'center' } }, 'API Key'),
      keyInput,
      button('保存密钥', { small: true, onClick: () => saveKey(profile, keyInput, keyStatus) }),
      button('清除', { small: true, level: 'default', onClick: () => clearKey(profile) }),
      keyStatus
    );

    // ── 提示与测试结果 ──
    const tip = h('div', { class: 'field-hint', style: { marginTop: '6px' } },
      '密钥由 Windows DPAPI 加密后存在 runtime\\secrets.json，渲染进程与引擎进程都拿不到明文。'
    );
    const fakeWarn = profile.keyIsPlaceholder
      ? h('div', { class: 'notice warn', style: { marginTop: '6px' } },
          h('div', { class: 'notice-title' }, '现在存着的这把密钥是测试用的假密钥'),
          h('div', null, '它跑不通真实的大模型接口。请把你的 API Key 粘到上面的输入框里，点「保存密钥」覆盖掉它。'),
          h('div', { class: 'field-hint' }, '（这条记录是早期自检留下的。看到这句提示，说明它还没被真密钥替换。）')
        )
      : null;

    const result = testResults.get(profile.id);
    const resultBox = result
      ? h('div', { class: `test-result${result.ok ? '' : ' bad'}` },
          h('span', null, result.text),
          result.hint ? h('div', { class: 'test-hint' }, `建议：${result.hint}`) : null,
          result.reply ? h('div', null, `模型回话：「${result.reply}」`) : null
        )
      : null;

    return h('div', { class: 'model-card' },
      headRow,
      grid,
      keyRow,
      fakeWarn,
      tip,
      resultBox
    );
  }

  function update() { /* runtime 事件不影响本页 */ }

  renderList();
  return { update };
}
