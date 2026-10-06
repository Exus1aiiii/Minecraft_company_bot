// ============================================================================
// views/persona.js —— 人格面具页
//
// getConfig 里只有每个 bot 的 personaId，没有预设列表（预设列表在
// runner/personas/index.mjs，渲染进程读不到、也不该去读），所以这里内置一份
// 与 runner/personas/ 同名的 id 与中文标签。改预设文件时记得同步这张表。
//
// 交互：点卡片选中 → 下方出现「覆盖系统提示词」文本域（留空 = 用预设）；
// 每个 bot 一个下拉框绑定 personaId。
// ============================================================================

import { h, clear, mount, button, select, tag } from '../ui.js';

export const id = 'persona';
export const label = '人格';
export const icon = '☺';

// 内置兜底表：只在拿不到主进程的预设列表时用（例如浏览器直开的演示模式）。
// 正常路径是下面的 loadPersonas() 走 IPC 去读 runner/personas/*.json —— 那份才是
// 唯一事实来源，改预设文件界面就会跟着变，不会再出现"两边对不上"的漂移。
export const BUILTIN_PERSONAS = [
  {
    id: 'companion-gentle',
    label: '温柔的陪伴者',
    description: '耐心、轻声、接得住情绪；不会抢话，也不会说教。',
    tags: ['陪伴', '温和'],
    traits: '语气：温柔耐心口语化 · 话少 · 幽默 2/5 · 主动 2/5',
  },
  {
    id: 'companion-lively',
    label: '活泼损友',
    description: '话多、爱起哄、喜欢开玩笑，但关键时候很靠谱。',
    tags: ['热闹', '嘴贫'],
    traits: '语气：跳脱爱吐槽 · 话中等 · 幽默 5/5 · 主动 4/5',
  },
  {
    id: 'butler',
    label: '稳重管家',
    description: '称呼您、做事有条理、汇报清楚，从不擅自行动。',
    tags: ['靠谱', '正式'],
    traits: '语气：正式克制 · 话中等 · 幽默 1/5 · 主动 2/5',
  },
  {
    id: 'explorer',
    label: '冒险搭档',
    description: '爱跑图爱下矿，会主动报点危险和战利品。',
    tags: ['冒险', '探索'],
    traits: '语气：兴奋直接 · 话中等 · 幽默 3/5 · 主动 5/5',
  },
  {
    id: 'builder',
    label: '建筑师助手',
    description: '聊方块、聊结构、聊配色；递材料比说话更积极。',
    tags: ['建造', '审美'],
    traits: '语气：就事论事 · 话中等 · 幽默 2/5 · 主动 3/5',
  },
  {
    id: 'quiet',
    label: '少话',
    description: '能一个字答完就绝不说两个字，省 token 首选。',
    tags: ['省 token', '安静'],
    traits: '语气：极简 · 话极少 · 幽默 0/5 · 主动 0/5',
  },
];

/** 兼容旧引用 */
export const PERSONAS = BUILTIN_PERSONAS;

/** 当前实际渲染用的列表，先给兜底表，拿到预设后会被替换 */
let personaList = BUILTIN_PERSONAS.slice();

/** 把 {traits:{tone,verbosity,humor,initiative}} 压成一行中文，卡片上好看 */
function traitsLine(tr) {
  if (!tr) return '';
  if (typeof tr === 'string') return tr;
  const tone = { gentle: '温柔耐心口语化', lively: '跳脱爱吐槽', formal: '正式克制', neutral: '就事论事', terse: '极简', excited: '兴奋直接' }[tr.tone] || tr.tone || '';
  const verb = { short: '话少', medium: '话中等', long: '话多', 'very-short': '话极少', very_short: '话极少' }[tr.verbosity] || tr.verbosity || '';
  const parts = [];
  if (tone) parts.push(`语气：${tone}`);
  if (verb) parts.push(verb);
  if (typeof tr.humor === 'number') parts.push(`幽默 ${tr.humor}/5`);
  if (typeof tr.initiative === 'number') parts.push(`主动 ${tr.initiative}/5`);
  return parts.join(' · ');
}

/**
 * 从主进程读预设人格。失败就保留内置兜底表 —— 界面任何情况下都得能看。
 */
async function loadPersonas(ctx) {
  const api = ctx.api || (typeof window !== 'undefined' ? window.mcbot : null);
  if (!api || typeof api.getPersonas !== 'function') return;
  let list = null;
  try {
    const r = await api.getPersonas();
    list = Array.isArray(r) ? r : r && r.ok !== false ? r.personas : null;
  } catch {
    return;
  }
  if (!Array.isArray(list) || list.length === 0) return;
  personaList = list.map((p) => {
    const fallback = BUILTIN_PERSONAS.find((b) => b.id === p.id) || {};
    return {
      id: p.id,
      label: p.label || fallback.label || p.id,
      description: p.description || fallback.description || '',
      tags: Array.isArray(p.tags) ? p.tags : fallback.tags || [],
      traits: traitsLine(p.traits) || fallback.traits || '',
    };
  });
}

export function render(container, ctx) {
  let selectedId = personaList[0]?.id || BUILTIN_PERSONAS[0].id;

  const head = h('div', { class: 'view-head' },
    h('span', { class: 'view-title' }, '人格'),
    h('span', { class: 'view-sub' }, '选一个面具，再给每个 bot 绑定'),
    h('span', { class: 'spacer' })
  );

  const grid = h('div', { class: 'persona-grid' });

  // 选中后的编辑区
  const overrideInput = h('textarea', {
    class: 'input',
    rows: '8',
    placeholder: '留空 = 使用预设的人格提示词。填了内容则整段覆盖预设（{{botDisplayName}} / {{ownerName}} 这类占位符仍会被替换）。',
    style: { width: '100%', fontSize: '13px' },
  });
  const overrideBox = h('div', { class: 'panel', style: { marginTop: '12px' } });
  const bindBox = h('div', { class: 'panel' });

  mount(container, head,
    h('div', { class: 'notice info' },
      '人格决定 bot 怎么说话。预设文件在 runner\\personas\\，改动它会同时影响所有绑定该面具的 bot；只想给某一个 bot 特殊人设，就用下面的「覆盖系统提示词」。'
    ),
    h('div', { class: 'section-title' }, '人格面具'),
    grid,
    overrideBox,
    bindBox
  );

  // -------------------------------------------------------------------------
  // 面具卡片
  // -------------------------------------------------------------------------
  function renderGrid() {
    clear(grid);
    for (const p of personaList) {
      const card = h('div', {
        class: ['persona-card', p.id === selectedId ? 'selected' : ''],
        on: { click: () => { selectedId = p.id; renderGrid(); renderOverride(); } },
      },
        h('div', { class: 'persona-head' },
          h('span', { class: 'persona-label' }, p.label),
          p.id === selectedId ? tag('已选中', 'tag-gold') : null
        ),
        h('div', { class: 'persona-id mono' }, p.id),
        h('div', { class: 'persona-desc' }, p.description),
        h('div', {}, p.tags.map((t) => tag(t, 'tag-dim'))),
        h('div', { class: 'persona-traits' }, p.traits)
      );
      grid.appendChild(card);
    }
  }

  // -------------------------------------------------------------------------
  // 覆盖提示词
  // -------------------------------------------------------------------------
  function renderOverride() {
    clear(overrideBox);
    const current = personaList.find((p) => p.id === selectedId);
    const botsUsing = (ctx.config.bots || []).filter((b) => b.personaId === selectedId);
    // 覆盖文本是按 bot 存的（personaOverrides），所以这里选第一个绑定该面具的 bot 来编辑
    const targetBot = botsUsing[0] || null;

    overrideBox.appendChild(h('div', { class: 'panel-title' },
      `「${current ? current.label : selectedId}」的系统提示词覆盖`
    ));

    const body = h('div', { class: 'panel-body' });

    if (!targetBot) {
      body.appendChild(h('div', { class: 'field-hint' },
        '目前没有 bot 绑定这个面具。覆盖内容是按 bot 存的，先到下面把某个 bot 绑到它，再回来编辑。'
      ));
    } else {
      targetBot.personaOverrides = targetBot.personaOverrides || { systemPrompt: '' };
      overrideInput.value = targetBot.personaOverrides.systemPrompt || '';
      const hint = h('div', { class: 'field-hint' },
        `正在编辑「${targetBot.displayName || targetBot.name}」的覆盖内容（为空则用预设）。` +
        (botsUsing.length > 1
          ? `另有 ${botsUsing.length - 1} 个 bot 也绑了这个面具，它们的覆盖要逐个在下面切换 bot 后编辑。`
          : '')
      );
      body.appendChild(overrideInput);
      body.appendChild(hint);
      body.appendChild(h('div', { class: 'btn-group', style: { marginTop: '6px' } },
        button('清空覆盖（回到预设）', {
          small: true, level: 'default',
          onClick: () => {
            targetBot.personaOverrides.systemPrompt = '';
            overrideInput.value = '';
            ctx.markDirty();
            ctx.toast('已清空覆盖，保存后生效', 'info');
          },
        }),
        button('编辑另一个 bot 的覆盖', {
          small: true, level: 'ghost',
          onClick: () => ctx.goto('bots'),
        })
      ));
      overrideInput.oninput = () => {
        targetBot.personaOverrides.systemPrompt = overrideInput.value;
        ctx.markDirty();
      };    }

    overrideBox.appendChild(body);
  }

  // -------------------------------------------------------------------------
  // bot 绑定
  // -------------------------------------------------------------------------
  function renderBind() {
    clear(bindBox);
    bindBox.appendChild(h('div', { class: 'panel-title' }, '给每个 bot 绑定人格'));
    const body = h('div', { class: 'panel-body' });
    const bots = ctx.config.bots || [];

    if (!bots.length) {
      body.appendChild(h('div', { class: 'field-hint' }, '还没有机器人配置。'));
    } else {
      const items = personaList.map((p) => ({ value: p.id, label: `${p.label}（${p.id}）` }));
      // 允许配置里存在未知 id（比如以后新增了预设），不要把它静默改掉
      const known = new Set(personaList.map((p) => p.id));
      for (const bot of bots) {
        if (bot.personaId && !known.has(bot.personaId)) {
          items.push({ value: bot.personaId, label: `${bot.personaId}（配置里的未知面具）` });
        }
      }
      body.appendChild(h('table', { class: 'data-table' },
        h('thead', {}, h('tr', {},
          h('th', { style: { width: '26%' } }, '机器人'),
          h('th', { style: { width: '38%' } }, '人格面具'),
          h('th', null, '覆盖提示词')
        )),
        h('tbody', {}, bots.map((bot) =>
          h('tr', {},
            h('td', null, `${bot.displayName || bot.name}`,
              h('span', { class: 'field-hint mono' }, ` ${bot.name}`)),
            h('td', null, select(items, {
              value: bot.personaId || personaList[0]?.id || BUILTIN_PERSONAS[0].id,
              onChange: (v) => {
                bot.personaId = v;
                ctx.markDirty();
                selectedId = v;
                renderGrid();
                renderOverride();
              },
            })),
            h('td', null, (bot.personaOverrides && bot.personaOverrides.systemPrompt)
              ? tag('已自定义', 'tag-gold')
              : h('span', { class: 'field-hint' }, '用预设'))
          )
        ))
      ));
    }
    bindBox.appendChild(body);
  }

  function update() { /* runtime 事件不影响本页 */ }

  renderGrid();
  renderOverride();
  renderBind();

  // 先用兜底表把页面画出来，再去主进程拿真正的预设列表；拿到了就重画。
  loadPersonas(ctx).then(() => {
    if (selectedId && !personaList.some((p) => p.id === selectedId)) {
      selectedId = personaList[0]?.id || selectedId;
    }
    renderGrid();
    renderOverride();
    renderBind();
  });

  return { update };
}
