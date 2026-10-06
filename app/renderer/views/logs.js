// ============================================================================
// views/logs.js —— 日志页
//
// 选一个 bot，看它的滚动日志。工具栏：来源筛选（全部 / 门禁 / 大模型 / 引擎 /
// 状态与通知）、暂停自动滚动、清屏、导出为文本。
//
// 门禁行按决策着色：PASS 绿色、BLOCK 灰色，并在后面用中文写出拦截原因
// （没叫称谓 / 不是主人 / 自己的消息 / 触发限流 / 超出预算 …）。
//
// 数据有两个来源：① 打开页面时调 readLog() 拉一批历史（引擎 stdout 落盘的那部分）；
// ② ctx.logBuffer 里的实时事件（app.js 统一订阅、按 2000 条上限维护）。
// 两者合并进本页自己的缓存，重绘时只做筛选和切片，不重复拼装上万行 DOM。
// ============================================================================

import {
  h, clear, mount, button, select, toggle, fmtClock, gateReasonCN, downloadText, errText,
} from '../ui.js';

export const id = 'logs';
export const label = '日志';
export const icon = '▥';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'gate', label: '门禁' },
  { key: 'llm', label: '大模型' },
  { key: 'engine', label: '引擎' },
  { key: 'status', label: '状态' },
];

/** 一次最多往 DOM 里放多少行（历史可能很长，全放会卡） */
const MAX_DOM_LINES = 1500;

export function render(container, ctx) {
  const state = {
    botId: (ctx.params && ctx.params.botId) || null,
    filter: 'all',
    autoScroll: true,
    history: new Map(),   // botId → 结构化行数组
    loading: false,
    lastError: '',
    cursor: 0,            // logBuffer 已并入缓存的进度
  };
  if (!state.botId) {
    const running = (ctx.runtimes || []).find((r) => r.status === 'running');
    const first = (ctx.config.bots || [])[0];
    state.botId = (running && running.id) || (first && first.id) || null;
  }

  // ── 工具栏 ──────────────────────────────────────────────────────────────
  const botSel = select(
    (ctx.config.bots || []).map((b) => ({ value: b.id, label: `${b.displayName || b.name}（${b.name}）` })),
    {
      value: state.botId,
      onChange: (v) => {
        state.botId = v;
        state.cursor = 0;
        loadHistory();
        update();
        renderStats();
      },
    }
  );

  const chipRow = h('div', { class: 'chip-group' });

  const autoSwitch = toggle(true, (next) => {
    state.autoScroll = next;
    autoSwitch.className = `switch ${next ? 'on' : 'off'}`;
    if (next) scrollToBottom();
  }, { title: '暂停后可以安心往上翻历史；滚回底部会自动恢复' });

  const exportBtn = button('导出为文本', { small: true, onClick: () => exportLogs() });
  const clearBtn = button('清屏', {
    small: true,
    level: 'default',
    title: '只清空界面显示，不删除磁盘上的 jsonl 文件',
    onClick: () => {
      viewport.replaceChildren(h('div', { class: 'log-empty' }, '已清屏。点「重新读取」可以把历史再拉回来。'));
      state.history.set(state.botId, []);
      renderStats();
    },
  });
  const reloadBtn = button('重新读取', { small: true, level: 'ghost', onClick: () => loadHistory(true) });

  const toolbar = h('div', { class: 'log-toolbar' },
    h('label', null, '机器人'),
    botSel,
    h('span', { class: 'spacer' }),
    chipRow,
    h('span', { class: 'spacer' }),
    h('label', null, '自动滚动'),
    autoSwitch,
    clearBtn, exportBtn, reloadBtn
  );

  const statsLine = h('div', { class: 'field-hint', style: { marginBottom: '6px' } });
  const viewport = h('div', { class: 'log-view' });

  mount(container,
    h('div', { class: 'view-head' },
      h('span', { class: 'view-title' }, '日志'),
      h('span', { class: 'view-sub' }, '来自 runtime\\logs\\<botId>.jsonl，主进程 tail 后推给界面'),
      h('span', { class: 'spacer' }),
      button('查看机器人页', { small: true, level: 'ghost', onClick: () => ctx.goto('bots') })
    ),
    toolbar,
    statsLine,
    viewport
  );

  // 用户手动往上滚 → 自动暂停；滚回底部 → 自动恢复
  viewport.addEventListener('scroll', () => {
    const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;
    if (!atBottom && state.autoScroll) {
      state.autoScroll = false;
      autoSwitch.className = 'switch off';
    } else if (atBottom && !state.autoScroll) {
      state.autoScroll = true;
      autoSwitch.className = 'switch on';
    }
  });

  // -------------------------------------------------------------------------
  // 一、历史读取与文本解析
  // -------------------------------------------------------------------------

  async function loadHistory(force = false) {
    const botId = state.botId;
    if (!botId || state.loading) return;
    if (!force && state.history.has(botId) && state.history.get(botId).length) return;

    state.loading = true;
    state.lastError = '';
    renderStats();

    const lines = await ctx.call('读取日志', () => window.mcbot.readLog(botId, { lines: 400 }), { silent: true });
    state.loading = false;

    if (!Array.isArray(lines)) {
      state.lastError = '读取日志失败：主进程没有返回字符串数组';
      renderStats();
      renderLog();
      return;
    }

    // 历史里经常已经包含我们现在缓存的实时行（readLog 读的是同一个 jsonl），
    // 所以用 "时钟 + 正文" 做多重集去重，只保留历史里没有出现过的实时行。
    const live = state.history.get(botId) || [];
    const counts = new Map();
    for (const r of live) {
      const k = `${fmtClock(r.ts)}|${r.text}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const parsed = lines.map((raw, i) => parseLine(raw, botId, i, lines.length));
    const keptLive = live.filter((r) => {
      const k = `${fmtClock(r.ts)}|${r.text}`;
      const n = counts.get(k) || 0;
      if (n > 0) {
        counts.set(k, n - 1);
        return false;
      }
      return true;
    });

    state.history.set(botId, parsed.concat(keptLive));
    state.cursor = (ctx.logBuffer || []).length;
    renderLog();
    renderStats();
  }

  /** 把 readLog 返回的纯文本行解析成结构化行 */
  function parseLine(raw, botId, index, total) {
    const text = String(raw ?? '');
    const tsMatch = text.match(/^\[(\d{2}:\d{2}:\d{2})\]/);
    const ts = tsMatch ? clockToTs(tsMatch[1]) : Date.now() - (total - index) * 1000;

    let source = 'engine';
    let level = 'info';
    let decision = '';
    let reason = '';
    let from = '';
    let channel = '';
    let body = text.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '');

    const lv = body.match(/^\[(info|warn|warning|error)\]\s*/i);
    if (lv) {
      level = lv[1].toLowerCase();
      body = body.slice(lv[0].length);
    }

    if (/^\[gate\]/i.test(body) || /\b(PASS|BLOCK)\b\s+channel=/.test(body)) {
      source = 'gate';
      body = body.replace(/^\[gate\]\s*/i, '');
      decision = /^PASS\b/.test(body) ? 'PASS' : /^BLOCK\b/.test(body) ? 'BLOCK' : '';
      const r = body.match(/reason=([A-Za-z]+)/);
      reason = r ? r[1] : '';
      const fr = body.match(/from=(\S+)/);
      from = fr ? fr[1] : '';
      const ch = body.match(/channel=([a-z]+)/);
      channel = ch ? ch[1] : '';
      const tx = body.match(/text=(".*"|\S*)$/);
      if (tx) body = tx[1].replace(/^"|"$/g, '');
    } else if (/^\[LLM\]/i.test(body) || /promptTokens=/.test(body)) {
      source = 'llm';
      body = body.replace(/^\[LLM\]\s*/i, '');
    } else if (/spawned\.|disconnected\.|Connecting to|kicked|重连|路径被阻断/.test(body)) {
      source = 'status';
    }

    return { ts, source, level, text: body, decision, reason, from, channel, botId };
  }

  function clockToTs(clock) {
    const [hh, mm, ss] = clock.split(':').map(Number);
    const d = new Date();
    d.setHours(hh, mm, ss, 0);
    if (d.getTime() > Date.now() + 60000) d.setDate(d.getDate() - 1); // 跨天日志收敛到过去
    return d.getTime();
  }

  // -------------------------------------------------------------------------
  // 二、实时事件并入缓存
  // -------------------------------------------------------------------------

  function ingest() {
    const botId = state.botId;
    if (!botId) return false;
    const buf = ctx.logBuffer || [];
    if (state.cursor > buf.length) state.cursor = 0; // 缓冲被裁剪过，重新对齐

    let changed = false;
    let list = state.history.get(botId);
    if (!list) {
      list = [];
      state.history.set(botId, list);
    }

    for (; state.cursor < buf.length; state.cursor++) {
      const ev = buf[state.cursor];
      if (!ev || ev.botId !== botId) continue;
      list.push({
        ts: ev.ts || Date.now(),
        source: ev.source || 'engine',
        level: ev.level || 'info',
        text: ev.line || '',
        decision: ev.decision || '',
        reason: ev.reason || '',
        from: ev.from || '',
        channel: ev.channel || '',
        botId,
      });
      changed = true;
    }

    if (list.length > 5000) list.splice(0, list.length - 5000);
    return changed;
  }

  // -------------------------------------------------------------------------
  // 三、渲染
  // -------------------------------------------------------------------------

  function filteredRows() {
    const list = state.history.get(state.botId) || [];
    return state.filter === 'all' ? list : list.filter((r) => r.source === state.filter);
  }

  /** 一行日志的纯文本形式（导出与显示共用同一套文案） */
  function lineText(row, withClock) {
    const clock = withClock ? `[${fmtClock(row.ts)}] ` : '';
    if (row.source === 'gate') {
      const isBlock = row.decision === 'BLOCK';
      const reasonCN = isBlock && row.reason ? `（${gateReasonCN(row.reason)}）` : '';
      const ch = row.channel ? ` [${row.channel === 'whisper' ? '私聊' : '公屏'}]` : '';
      const who = row.from ? ` ${row.from}${ch}` : '';
      return `${clock}[门禁] ${row.decision || '-'}${reasonCN}${who}：${row.text}`;
    }
    if (row.source === 'llm') return `${clock}[大模型] ${row.text}`;
    if (row.source === 'status') return `${clock}[状态] ${row.text}`;
    if (row.level && row.level !== 'info') return `${clock}[${row.level}] ${row.text}`;
    return `${clock}${row.text}`;
  }

  function renderLog() {
    const rows = filteredRows();
    const shown = rows.slice(-MAX_DOM_LINES);
    const frag = document.createDocumentFragment();

    if (!shown.length) {
      frag.appendChild(h('div', { class: 'log-empty' },
        state.loading ? '正在读取日志…'
          : state.lastError ? state.lastError
          : '这个筛选条件下还没有日志。让 bot 上线、在游戏里说句话试试。'));
    } else {
      for (const row of shown) {
        const cls = ['log-line', `src-${row.source}`];
        if (row.source === 'gate' && row.decision === 'BLOCK') cls.push('block');
        if (row.level === 'warn' || row.level === 'warning') cls.push('lv-warn');
        if (row.level === 'error') cls.push('lv-error');
        frag.appendChild(h('div', { class: cls },
          h('span', { class: 'log-ts mono' }, `${fmtClock(row.ts)} `),
          lineText(row, false)
        ));
      }
      if (rows.length > shown.length) {
        frag.appendChild(h('div', { class: 'log-empty' },
          `（只显示最近 ${shown.length} 行，更早的 ${rows.length - shown.length} 行请用「导出为文本」完整查看）`));
      }
    }

    viewport.replaceChildren(frag);
    if (state.autoScroll) scrollToBottom();
  }

  function scrollToBottom() {
    viewport.scrollTop = viewport.scrollHeight;
  }

  function renderChips() {
    clear(chipRow);
    for (const f of FILTERS) {
      chipRow.appendChild(
        h('button', {
          class: ['chip', state.filter === f.key ? 'active' : ''],
          type: 'button',
          on: {
            click: () => {
              state.filter = f.key;
              renderChips();
              renderLog();
              renderStats();
            },
          },
        }, f.label)
      );
    }
  }

  function renderStats() {
    const list = state.history.get(state.botId) || [];
    const gates = list.filter((r) => r.source === 'gate');
    const passed = gates.filter((r) => r.decision === 'PASS').length;
    const blocked = gates.filter((r) => r.decision === 'BLOCK').length;
    const bot = (ctx.config.bots || []).find((b) => b.id === state.botId);
    const rt = (ctx.runtimes || []).find((r) => r.id === state.botId);

    clear(statsLine);
    mount(statsLine,
      `当前 ${bot ? `${bot.displayName || bot.name}（${bot.name}）` : '未选择'}　·　`,
      `本页缓存 ${list.length} 行，当前显示 ${filteredRows().length} 行　·　`,
      `门禁 PASS ${passed} / BLOCK ${blocked}`,
      rt && rt.gate
        ? `　·　主进程计数：通过 ${rt.gate.passed || 0} / 拦截 ${rt.gate.blocked || 0}`
        : '',
      state.loading ? '　·　正在读取…' : '',
      state.lastError ? h('span', { style: { color: '#ff9a9a' } }, `　·　${state.lastError}`) : ''
    );
  }

  function exportLogs() {
    const rows = filteredRows();
    if (!rows.length) {
      ctx.toast('当前筛选下没有可导出的日志', 'warn');
      return;
    }
    const bot = (ctx.config.bots || []).find((b) => b.id === state.botId);
    const name = bot ? bot.name : (state.botId || 'bot');
    const text = rows.map((r) => lineText(r, true)).join('\r\n');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    try {
      downloadText(`mcbot-${name}-${stamp}.txt`, text);
      ctx.toast(`已导出 ${rows.length} 行日志`, 'ok');
    } catch (err) {
      ctx.toast(`导出失败：${errText(err)}`, 'error');
    }
  }

  // -------------------------------------------------------------------------
  // 四、对外更新（runtime 或事件到达时由 app.js 调用）
  // -------------------------------------------------------------------------

  function update() {
    if (!state.botId) {
      const first = (ctx.config.bots || [])[0];
      if (!first) return;
      state.botId = first.id;
    }
    if (ingest()) {
      renderLog();
      renderStats();
    }
  }

  renderChips();
  renderLog();
  renderStats();
  loadHistory();

  return { update };
}
