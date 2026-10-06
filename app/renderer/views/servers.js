// ============================================================================
// views/servers.js —— 服务器页
//
// 服务器列表的增删改（名称 / 地址 / 端口 / 版本 / 认证方式），每条右边有
// 「测试连接」按钮调 probeServer，把返回的版本 / MOTD / 在线人数或错误显示出来。
// 删除前会挡住"还有 bot 在用"的情况，避免保存时报校验错才后悔。
// ============================================================================

import { h, clear, mount, button, select, input, errText, uid } from '../ui.js';

export const id = 'servers';
export const label = '服务器';
export const icon = '▤';

const AUTH_ITEMS = [
  { value: 'offline', label: '离线模式（offline）' },
  { value: 'microsoft', label: '微软正版（microsoft）' },
];

export function render(container, ctx) {
  // 测试结果：serverId → { ok, text, detail }
  const probeResults = new Map();

  const head = h('div', { class: 'view-head' },
    h('span', { class: 'view-title' }, '服务器'),
    h('span', { class: 'view-sub' }, 'M1 用第一条即可，但布局按多服设计'),
    h('span', { class: 'spacer' }),
    button('新增服务器', { level: 'primary', onClick: () => addServer() }),
    button('重新加载', { level: 'ghost', onClick: () => ctx.reload() })
  );

  const listBox = h('div', { class: 'sunken-box', style: { padding: '0' } });

  mount(container, head,
    h('div', { class: 'notice info' },
      '地址支持域名或 IP；端口默认 25565。版本填具体版本号（如 1.21.1），或填 auto 让引擎自动探测。',
      h('br'),
      '离线模式用于本机测试服；正版服务器需要微软账号登录，M1 界面里暂不收账号密码。'
    ),
    listBox
  );

  // -------------------------------------------------------------------------
  // 增删
  // -------------------------------------------------------------------------

  function addServer() {
    ctx.config.servers.push({
      id: uid('srv'),
      label: `新服务器 ${(ctx.config.servers || []).length + 1}`,
      host: '127.0.0.1',
      port: 25565,
      version: 'auto',
      auth: 'offline',
    });
    ctx.markDirty();
    renderList();
    ctx.toast('已新增一条服务器（填好地址后记得保存）', 'info');
  }

  function removeServer(srv) {
    const usedBy = (ctx.config.bots || []).filter((b) => b.serverId === srv.id);
    if (usedBy.length) {
      ctx.toast(
        `还有 ${usedBy.length} 个 bot（${usedBy.map((b) => b.displayName || b.name).join('、')}）在用这台服务器，先改掉它们的服务器再删`,
        'warn'
      );
      return;
    }
    ctx.config.servers = ctx.config.servers.filter((s) => s.id !== srv.id);
    probeResults.delete(srv.id);
    ctx.markDirty();
    renderList();
    ctx.toast(`已删除服务器「${srv.label}」`, 'info');
  }

  // -------------------------------------------------------------------------
  // 测试连接
  // -------------------------------------------------------------------------

  async function probe(srv) {
    if (!String(srv.host || '').trim()) {
      probeResults.set(srv.id, { ok: false, text: '地址是空的，先填地址' });
      renderList();
      return;
    }
    probeResults.set(srv.id, { ok: null, text: '正在连接…' });
    renderList();

    const res = await ctx.call('测试连接', () => window.mcbot.probeServer({
      host: String(srv.host).trim(),
      port: Number(srv.port),
      version: srv.version,
    }), { silent: true });

    if (!res) {
      probeResults.set(srv.id, { ok: false, text: '调用失败：主进程没有响应' });
    } else if (!res.ok) {
      // 主进程会把原始 errno 原文放在 `original` 里，单独显示一行 ——
      // 用户看到"对方拒绝了连接"的同时，也该能对着 `ECONNREFUSED` 去搜。
      probeResults.set(srv.id, {
        ok: false,
        text: res.error || '连接失败（未返回原因）',
        original: res.error === res.original ? '' : (res.original || ''),
      });
    } else {
      probeResults.set(srv.id, {
        ok: true,
        text: `连接成功：${res.version || '未知版本'}（协议 ${res.protocol ?? '?'}）`,
        detail: res,
      });
    }
    renderList();
  }

  // -------------------------------------------------------------------------
  // 列表
  // -------------------------------------------------------------------------

  function renderList() {
    clear(listBox);
    const servers = ctx.config.servers || [];
    if (!servers.length) {
      listBox.appendChild(h('div', { class: 'empty-hint' }, '还没有服务器。点右上角「新增服务器」加一条。'));
      return;
    }

    const tbody = h('tbody');

    servers.forEach((srv, index) => {
      tbody.appendChild(h('tr', {},
        h('td', {}, input({
          value: srv.label, placeholder: '例如：本地测试服', style: { width: '100%' },
          onInput: (v) => { srv.label = v; ctx.markDirty(); },
        })),
        h('td', {}, input({
          value: srv.host, placeholder: '127.0.0.1 / mc.example.com', style: { width: '100%' },
          onInput: (v) => { srv.host = v; ctx.markDirty(); },
        })),
        h('td', {}, input({
          type: 'number', value: srv.port, min: 1, max: 65535, style: { width: '84px' },
          onInput: (v) => { srv.port = Number(v); ctx.markDirty(); },
        })),
        h('td', {}, input({
          value: srv.version, placeholder: 'auto / 1.21.1', style: { width: '104px' },
          onInput: (v) => { srv.version = v; ctx.markDirty(); },
        })),
        h('td', {}, select(AUTH_ITEMS, {
          value: srv.auth,
          onChange: (v) => { srv.auth = v; ctx.markDirty(); },
        })),
        h('td', {}, h('div', { class: 'td-actions' },
          button('测试连接', { small: true, onClick: () => probe(srv) }),
          button('复制', {
            small: true, level: 'ghost', title: '复制一条同样的服务器配置',
            onClick: () => {
              const copy = JSON.parse(JSON.stringify(srv));
              copy.id = uid('srv');
              copy.label = `${srv.label} 副本`;
              ctx.config.servers.splice(index + 1, 0, copy);
              ctx.markDirty();
              renderList();
            },
          }),
          button('删除', { small: true, level: 'danger', onClick: () => removeServer(srv) })
        ))
      ));

      const result = probeResults.get(srv.id);
      if (result) {
        const detail = result.detail;
        tbody.appendChild(h('tr', {},
          h('td', { colspan: '6', style: { background: '#2b2b2b' } },
            h('div', { class: `test-result${result.ok ? '' : ' bad'}`, style: { margin: '4px 0' } },
              h('span', null, result.text),
              result.original ? h('div', { class: 'test-hint' }, `原始报错：${result.original}`) : null,
              detail && detail.motd ? h('div', null, `MOTD：${detail.motd}`) : null,
              detail && detail.players
                ? h('div', { class: 'mono' }, `在线人数：${detail.players.online} / ${detail.players.max}`)
                : null
            )
          )
        ));
      }
    });

    listBox.appendChild(h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {},
        h('th', { style: { width: '20%' } }, '名称'),
        h('th', { style: { width: '24%' } }, '地址'),
        h('th', { style: { width: '9%' } }, '端口'),
        h('th', { style: { width: '13%' } }, '版本'),
        h('th', { style: { width: '15%' } }, '认证方式'),
        h('th', null, '操作')
      )),
      tbody
    ));
  }

  function update() { /* 本页只看配置，runtime 事件不需要重绘 */ }

  renderList();
  return { update };
}
