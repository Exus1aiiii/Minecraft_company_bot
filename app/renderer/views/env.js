// ============================================================================
// views/env.js —— 环境视图
//
// 只做一件事：把主进程 getEnv() / getVersions() 的结果如实摊开给你看，
// 并在有问题时给出"下一句该敲什么命令"的建议文案。
//
// 这里刻意不做任何自动修复：本程序不会替你跑 npm install，
// 也不会偷偷改 PATH —— 环境问题一律交回给人处理（契约 §七 的取舍）。
// ============================================================================

import { h, clear, mount, button, kv, panel, table, tag, errText } from '../ui.js';

export const id = 'env';
export const label = '环境';
export const icon = '⚙';

// ---------------------------------------------------------------------------
// 建议文案：按 problems[] 里的关键词匹配，命中多条会全部列出来
// ---------------------------------------------------------------------------
const SUGGESTIONS = [
  {
    // 引擎依赖没装齐
    match: /mineflayer|minecraft-protocol|minecraft-data|引擎依赖|node_modules/i,
    text: '引擎依赖缺失：在项目根目录执行 `cd runner && npm install`，装完回到本页点「重新检测」。本程序不会替你执行安装命令。',
  },
  {
    match: /引擎目录|engineDir|引擎.*(不存在|找不到|缺失)/i,
    text: '引擎目录不存在或路径不对：确认 runner/ 目录还在项目里，且没有被杀毒软件隔离。',
  },
  {
    match: /node/i,
    text: 'Node 可执行文件有问题：检查 runtime/ 下的 Node 是否完整，或用系统 Node 重装依赖。',
  },
  {
    match: /java|jre|jdk/i,
    text: '没找到 Java：离线模式连别人的服务器**不需要** Java，可以忽略；只有需要本地开服时才装 JRE 21。',
  },
  {
    match: /版本|version|不匹配|mismatch/i,
    text: '版本对不上：到「服务器」页把版本改成 `auto`（让引擎自己协商），或改成本机服务端实际版本（如 1.21.1）。',
  },
  {
    match: /密钥|secret|safeStorage|DPAPI/i,
    text: '密钥存取有问题：确认当前是 Windows 用户登录状态（safeStorage 依赖 DPAPI），重启程序后再试一次保存密钥。',
  },
];

const IGNORE_JAVA = {
  match: /java/i,
  text: '提示：离线模式只用 mcbot-gate + mineflayer 直连别人的服务器，不需要本机 Java。',
};

/** 把 problems[] 映射成可读建议（去重、保序） */
function buildSuggestions(problems) {
  const out = [];
  const seen = new Set();
  const push = (t) => {
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const p of problems) {
    for (const s of SUGGESTIONS) {
      if (s.match.test(String(p))) push(s.text);
    }
  }
  // 一条都没命中，但确实有问题 —— 给一条通用的
  if (problems.length && !out.length) {
    push('上面这些问题会影响机器人启动。可以先到「日志」页看引擎的报错原文，再对照项目根目录的 `docs/` 排查。');
  }
  return out;
}

export function render(container, ctx) {
  // 本页自己缓存一份，避免每次切页都重新问主进程
  const state = {
    env: ctx.env || null,
    versions: ctx.versions || null,
    loading: false,
    error: null,
  };

  const body = h('div');

  const head = h(
    'div',
    { class: 'view-head' },
    h('span', { class: 'view-title' }, '环境'),
    h('span', { class: 'view-sub' }, '这里只报告事实，不会自动改你的系统'),
    h('span', { class: 'spacer' }),
    button('打开项目目录', {
      level: 'default',
      onClick: () => openProject(),
    }),
    button('重新检测', { level: 'primary', onClick: () => reload() })
  );

  mount(container, head, body);
  refresh();

  // -------------------------------------------------------------------------
  // 数据
  // -------------------------------------------------------------------------
  async function refresh() {
    state.loading = true;
    state.error = null;
    renderBody();

    const env = await ctx.call('读取环境信息', () => window.mcbot.getEnv(), { silent: true });
    const versions = await ctx.call('读取程序版本', () => window.mcbot.getVersions(), { silent: true });

    if (!env || typeof env !== 'object') {
      state.loading = false;
      state.error = '主进程没有返回环境信息（getEnv 返回空）。引擎可能还没启动完成，或者 preload 没接上。';
      renderBody();
      return;
    }

    // 顺手同步到 ctx，让其它地方（如 app.js 的顶部栏）也能用
    ctx.env = env;
    if (versions) ctx.versions = versions;

    state.env = env;
    state.versions = versions || null;
    state.loading = false;
    renderBody();
  }

  async function reload() {
    await refresh();
    const problems = (state.env && state.env.problems) || [];
    if (problems.length) ctx.toast(`检测完成：发现 ${problems.length} 个问题`, 'warn');
    else ctx.toast('检测完成：环境正常', 'ok');
  }

  async function openProject() {
    const root = state.env && state.env.projectRoot;
    if (!root) {
      ctx.toast('还不知道项目目录，先点「重新检测」', 'warn');
      return;
    }
    // openExternal 只接受 URL；本地目录用 openExternal 打开会被主进程拒绝，
    // 所以这里退化成"把路径复制到剪贴板"，比弹一个打不开的窗口诚实。
    try {
      await navigator.clipboard.writeText(root);
      ctx.toast(`项目目录已复制到剪贴板：${root}`, 'ok');
    } catch (err) {
      ctx.toast(`项目目录：${root}（复制失败：${errText(err)}）`, 'info');
    }
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------
  function renderBody() {
    clear(body);

    if (state.error) {
      body.appendChild(h('div', { class: 'notice error' }, h('span', { class: 'notice-title' }, '读不到环境信息'), state.error));
    }

    const env = state.env || {};
    const versions = state.versions || {};
    const problems = Array.isArray(env.problems) ? env.problems : [];
    const engineOk = env.engineOk !== false;
    const healthy = engineOk && !problems.length;

    // ── 结论条 ──
    body.appendChild(
      h(
        'div',
        { class: ['notice', healthy ? 'ok' : engineOk ? 'warn' : 'error'] },
        h('span', { class: 'notice-title' }, healthy ? '结论：可以开工' : '结论：先处理下面的问题'),
        healthy
          ? 'Node、引擎目录、mineflayer 都没问题。可以到「服务器」页测试连接，然后去「机器人」页打开开关。'
          : engineOk
            ? `引擎本身能用，但有 ${problems.length} 项需要注意（多数不影响离线模式连别人的服务器）。`
            : '引擎不可用：机器人启动一定会失败，先按下面的建议处理。'
      )
    );

    // ── 等待中 ──
    if (state.loading && !state.env) {
      body.appendChild(h('div', { class: 'loading' }, '正在检测环境…'));
      return;
    }

    // ── 程序版本 ──
    body.appendChild(
      panel(
        '程序与运行时',
        h(
          'div',
          {},
          kv('应用版本', versions.app || '—'),
          kv('Electron', versions.electron || '—'),
          kv('Chromium', versions.chrome || '—'),
          kv('内置 Node', versions.node || '—'),
          kv('Node 版本（引擎运行用）', env.nodeVersion || '—')
        ),
        h('div', { class: 'field-hint' }, '引擎进程用的是本程序自带的 Node，不是你系统里装的那个 —— 所以不用为了它去配环境变量。')
      )
    );

    // ── 路径 ──
    body.appendChild(
      panel(
        '路径',
        kv('项目根目录', env.projectRoot || '—'),
        kv('Node 可执行文件', env.nodePath || '—', { valueCls: env.nodePath ? '' : 'bad' }),
        kv('引擎目录', env.engineDir || '—', { valueCls: env.engineDir ? '' : 'bad' }),
        kv('Java 可执行文件', env.javaPath || '（未找到）', { valueCls: env.javaPath ? '' : 'warn' }),
        h(
          'div',
          { class: 'field-hint' },
          '上面的路径都可以直接选中复制。Java 那一行是黄字不代表出错：离线模式连别人的服务器用不到 Java。'
        )
      )
    );

    // ── 引擎依赖版本 ──
    const verRows = [
      { key: 'mineflayer', name: 'mineflayer', desc: 'MC 协议客户端（bot 的本体）' },
      { key: 'minecraftProtocol', name: 'minecraft-protocol', desc: '底层协议实现' },
      { key: 'minecraftData', name: 'minecraft-data', desc: '方块/实体/版本数据' },
    ];
    const v = env.versions || {};
    const { el: verTable } = table(
      [
        { key: 'name', label: '依赖', width: '200px' },
        { key: 'ver', label: '版本', width: '120px', render: (r) => (v[r.key] ? h('span', { class: 'mono' }, v[r.key]) : h('span', { class: 'kv-v bad' }, '未安装')) },
        { key: 'desc', label: '用途' },
      ],
      verRows,
      { empty: '没有读到引擎依赖信息' }
    );
    body.appendChild(
      panel(
        '引擎依赖',
        h(
          'div',
          { class: 'kv' },
          h('span', { class: 'kv-k' }, '引擎就绪'),
          h('span', { class: 'kv-v' }, env.engineOk ? tag('就绪', 'tag-green') : tag('不可用', 'tag-red'))
        ),
        verTable,
        h(
          'div',
          { class: 'field-hint' },
          '三个依赖都由 runner/ 自己的 node_modules 提供。只要显示"未安装"，启动机器人就会立刻失败。'
        )
      )
    );

    // ── 问题清单 ──
    if (problems.length) {
      const list = h('ul', { class: 'problem-list' }, problems.map((p) => h('li', {}, String(p))));
      body.appendChild(
        panel(
          `发现的问题（${problems.length}）`,
          list,
          h('div', { class: 'detail-title' }, '建议怎么处理'),
          h('ul', { class: 'suggest-list' }, buildSuggestions(problems).map((s) => h('li', {}, s)))
        )
      );
    } else {
      body.appendChild(
        panel('发现的问题', h('div', { class: 'empty-hint' }, 'problems[] 是空的 —— 没检测到问题。'))
      );
    }

    // ── 离线模式小抄 ──
    body.appendChild(
      panel(
        '关于离线模式',
        h(
          'ul',
          { class: 'suggest-list' },
          h('li', {}, '离线模式（auth=offline）只用于局域网/自建服务器：服务端要开 online-mode=false。'),
          h('li', {}, '正版验证（microsoft）需要能访问微软的登录服务，国内网络下可能要挂代理。'),
          h('li', {}, IGNORE_JAVA.text)
        )
      )
    );
  }

  return {
    update() {
      // runtime 事件不影响本页；环境信息只在手动点「重新检测」时更新
    },
  };
}
