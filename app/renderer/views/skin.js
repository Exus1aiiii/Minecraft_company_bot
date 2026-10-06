// ============================================================================
// views/skin.js —— 皮肤页
//
// 选 64×64 的 PNG 皮肤（pickSkinFile），用返回的 dataUrl 预览，CSS 放大 +
// image-rendering: pixelated 保持像素质感；可选 slim / classic 模型类型。
// 每个 bot 可以单独启用/停用皮肤（存在 bot.skin.enabled）。
//
// ★ 页面上必须写清：皮肤要生效，服务端得装 Fabric Tailor 这类模组；原版服
//   会直接忽略/清除客户端上传的皮肤 —— M1 只存配置，不做真实换肤（docs/04 §二）。
// ============================================================================

import { h, clear, mount, button, select, field, input, tag, baseName } from '../ui.js';

export const id = 'skin';
export const label = '皮肤';
export const icon = '▦';

const MODEL_ITEMS = [
  { value: 'slim', label: 'slim（Alex 型 · 3 像素手臂）' },
  { value: 'classic', label: 'classic（Steve 型 · 4 像素手臂）' },
];

export function render(container, ctx) {
  // 预览缓存：path → dataUrl（读盘只做一次，避免每次重绘都调主进程）
  const previewCache = new Map();
  let lastError = '';
  let loadingPreview = false;

  const head = h('div', { class: 'view-head' },
    h('span', { class: 'view-title' }, '皮肤'),
    h('span', { class: 'view-sub' }, 'M1 只存配置与预览，不做真实换肤'),
    h('span', { class: 'spacer' }),
    button('选择 PNG 皮肤文件…', { level: 'primary', onClick: () => pick() }),
    button('重新加载', { level: 'ghost', onClick: () => ctx.reload() })
  );

  const warning = h('div', { class: 'skin-warning' },
    h('b', null, '⚠ 皮肤不会自动生效：'),
    '原版服务端不接受客户端上传皮肤，必须由服务端安装 Fabric Tailor（或同类换肤模组）才能看到效果，否则服务器会忽略甚至自动清除它。',
    h('br'),
    '另外请只用自己绘制或获得授权的皮肤 —— 不要用 Minecraft 官方材质或他人作品（版权）。'
  );

  const previewBox = h('div', { class: 'skin-layout' });
  const botBox = h('div', { class: 'panel' });

  mount(container, head, warning,
    h('div', { class: 'section-title' }, '皮肤文件与模型类型'),
    previewBox,
    botBox
  );

  // -------------------------------------------------------------------------
  // 选文件 / 预览
  // -------------------------------------------------------------------------

  async function pick() {
    const res = await ctx.call('选择皮肤文件', () => window.mcbot.pickSkinFile(), { silent: true });
    if (res === null || res === undefined) {
      ctx.toast('没有选择文件（已取消）', 'info');
      return;
    }
    if (res.error) {
      lastError = res.error;
      renderPreview();
      return;
    }
    if (res.dataUrl) previewCache.set(res.path, res.dataUrl);
    // 皮肤是"每个 bot 一份"，选完文件后分配给哪些 bot 由下面的开关决定；
    // 这里把路径记在第一个被选中的 bot 上，如果没有 bot 就先只做预览。
    const target = (ctx.config.bots || [])[0];
    if (target) {
      target.skin = target.skin || { model: 'slim', path: '', enabled: false };
      target.skin.path = res.path;
      ctx.markDirty();
      ctx.toast(`已选择 ${baseName(res.path)}，并记到「${target.displayName || target.name}」上（保存后生效）`, 'ok');
    } else {
      ctx.toast('已选择皮肤文件，但当前没有机器人可以分配', 'warn');
    }
    lastError = '';
    renderPreview();
    renderBots();
  }

  async function loadPreview(path) {
    if (!path || previewCache.has(path)) return;
    loadingPreview = true;
    renderPreview();
    const res = await ctx.call('读取皮肤', () => window.mcbot.readSkinFile(path), { silent: true });
    loadingPreview = false;
    if (res && res.ok && res.dataUrl) previewCache.set(path, res.dataUrl);
    else lastError = (res && res.error) || '读取皮肤文件失败（可能文件已被移动或不是 PNG）';
    renderPreview();
  }

  function currentSkinTarget() {
    // 预览哪一张：优先第一个启用了皮肤的 bot，否则第一个有路径的 bot
    const bots = ctx.config.bots || [];
    const enabled = bots.find((b) => b.skin && b.skin.enabled && b.skin.path);
    const anyPath = bots.find((b) => b.skin && b.skin.path);
    return enabled || anyPath || null;
  }

  function renderPreview() {
    clear(previewBox);
    const target = currentSkinTarget();
    const path = target ? target.skin.path : '';

    const img = h('img', {
      class: 'skin-preview',
      alt: '皮肤预览',
      src: previewCache.get(path) || '',
      title: path,
    });
    if (!path) {
      img.removeAttribute('src');
      img.className = 'skin-preview empty';
      img.textContent = '还没有选择皮肤文件';
    } else if (!previewCache.has(path)) {
      img.className = 'skin-preview empty';
      img.removeAttribute('src');
      img.textContent = loadingPreview ? '正在读取…' : '预览不可用';
      if (!loadingPreview) loadPreview(path);
    }

    const right = h('div', { style: { flex: '1 1 340px', minWidth: '300px' } },
      target
        ? field('皮肤文件路径（属于「' + (target.displayName || target.name) + '」）', {
            value: path,
            width: '100%',
            onInput: (v) => {
              target.skin.path = v.trim();
              ctx.markDirty();
              renderPreview();
            },
          }).el
        : h('div', { class: 'field-hint' }, '还没有机器人配置，先把皮肤路径填到某个 bot 上。'),
      h('div', { class: 'field-row' },
        field('模型类型', {
          value: target ? target.skin.model : 'slim',
          width: '100%',
          hint: '手臂 3 像素选 slim，4 像素选 classic；选错会出现"多出一层手臂"的错位',
          onChange: (v) => {
            if (!target) return;
            target.skin.model = v;
            ctx.markDirty();
          },
        }).el
      ),
      h('div', { class: 'btn-group' },
        button('重新选择文件…', { small: true, onClick: () => pick() }),
        target
          ? button('清除这张皮肤', {
              small: true, level: 'danger',
              onClick: () => {
                target.skin.path = '';
                target.skin.enabled = false;
                ctx.markDirty();
                renderPreview();
                renderBots();
                ctx.toast('已清除皮肤路径（保存后生效）', 'info');
              },
            })
          : null
      ),
      h('div', { class: 'field-hint', style: { marginTop: '8px' } },
        '只支持 64×64 的 PNG。旧版 64×32 皮肤在 1.21 上会显示异常，请先用图片工具把尺寸补齐到 64×64。'
      ),
      lastError ? h('div', { class: 'test-result bad' }, lastError) : null
    );

    mount(previewBox, img, right);
  }

  // -------------------------------------------------------------------------
  // 每个 bot 的启停
  // -------------------------------------------------------------------------

  function renderBots() {
    clear(botBox);
    botBox.appendChild(h('div', { class: 'panel-title' }, '每个机器人的皮肤开关'));
    const body = h('div', { class: 'panel-body' });
    const bots = ctx.config.bots || [];

    if (!bots.length) {
      body.appendChild(h('div', { class: 'field-hint' }, '还没有机器人配置。'));
      botBox.appendChild(body);
      return;
    }

    const tbody = h('tbody', {}, bots.map((bot) => {
      bot.skin = bot.skin || { model: 'slim', path: '', enabled: false };
      const modelSel = select(MODEL_ITEMS, {
        value: bot.skin.model || 'slim',
        onChange: (v) => { bot.skin.model = v; ctx.markDirty(); },
      });
      const pathInput = input({
        value: bot.skin.path || '',
        placeholder: '尚未选择皮肤文件',
        style: { width: '100%' },
        onInput: (v) => { bot.skin.path = v.trim(); ctx.markDirty(); },
      });
      return h('tr', {},
        h('td', { style: { width: '22%' } },
          `${bot.displayName || bot.name}`,
          h('div', { class: 'field-hint mono' }, bot.name)),
        h('td', { style: { width: '28%' } }, pathInput),
        h('td', { style: { width: '24%' } }, modelSel),
        h('td', { style: { width: '12%' } },
          bot.skin.path ? tag('已配置', 'tag-green') : tag('未配置', 'tag-dim')),
        h('td', null,
          button(bot.skin.enabled ? '停用皮肤' : '启用皮肤', {
            small: true,
            level: bot.skin.enabled ? 'default' : 'primary',
            disabled: !bot.skin.path,
            title: bot.skin.path ? '' : '先给这个 bot 选一个皮肤文件',
            onClick: () => {
              if (!bot.skin.path) {
                ctx.toast('这个 bot 还没有皮肤文件，先点「选择 PNG 皮肤文件…」', 'warn');
                return;
              }
              bot.skin.enabled = !bot.skin.enabled;
              ctx.markDirty();
              renderBots();
              renderPreview();
            },
          }))
      );
    }));

    body.appendChild(h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {},
        h('th', null, '机器人'),
        h('th', null, '皮肤文件'),
        h('th', null, '模型类型'),
        h('th', null, '状态'),
        h('th', null, '操作')
      )),
      tbody
    ));
    body.appendChild(h('div', { class: 'field-hint', style: { marginTop: '8px' } },
      '启用只是写进配置；引擎侧真正加载皮肤还需要服务端模组配合（见上方提示）。'
    ));
    botBox.appendChild(body);
  }

  function update() { /* runtime 事件不影响本页 */ }

  const initial = currentSkinTarget();
  if (initial && initial.skin.path) loadPreview(initial.skin.path);
  renderPreview();
  renderBots();
  return { update };
}
