// ============================================================================
// views/memory.js —— 长期记忆页
//
// 这是"陪伴"与"工具"的分界线。一个记不住上次一起干过什么的 bot，无论指令
// 执行得多准，都不是陪伴。
//
// 这一层跟引擎自己那份记忆不是一回事：引擎的 history.memory 是"为了省 token
// 压缩上下文"用的摘要（硬上限 500 字符，每次重写都要花一次模型调用，而且我们
// 启动时是 load_memory:false，重启就归零）。这份由我们自己在 runtime\memory\
// 下管，重启不丢，读写在主进程里做，不走大模型 —— **零 token**。
//
// 界面上要能看、能加、能删：记忆里如果有过时或写错的一条（"家"搬了），
// 用户得能自己清掉，而不是只能干看着。
// ============================================================================

import {
  h, clear, mount, button, field, tag, fmtAgo,
} from '../ui.js';

export const id = 'memory';
export const label = '记忆';
export const icon = '♥';

/** 与 runner/memory.mjs 的 KIND_LABEL 对应。改那边记得同步这里。 */
const KIND_INFO = {
  fact: { label: '印象', cls: 'tag-dim' },
  promise: { label: '约定', cls: 'tag-gold' },
  place: { label: '地点', cls: 'tag-blue' },
  event: { label: '经历', cls: 'tag-green' },
};

export function render(container, ctx) {
  const bots = ctx.config?.bots || [];
  let botId = ctx.params?.botId || bots[0]?.id || null;
  let entries = [];
  let loading = false;

  const head = h('div', { class: 'view-head' },
    h('span', { class: 'view-title' }, '记忆'),
    h('span', { class: 'view-sub' }, 'bot 记住的事 —— 重启不丢，而且不花 token'),
    h('span', { class: 'spacer' })
  );

  const botBar = h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', alignItems: 'center' } });
  const listBox = h('div', { class: 'panel' });
  const addBox = h('div', { class: 'panel' });
  const fileLine = h('div', { class: 'hint mono' });

  mount(container, head,
    h('div', { class: 'notice info' },
      '在游戏里直接说「小豆 记住我家在 (-12, 64, 30)」它就会记下来；问「小豆 你还记得我家在哪吗」它直接答。',
      h('br'),
      '聊天里提到「我家在…」「我喜欢…」「明天…」这类明确的长期信息，它也会顺手记一笔 —— 闲聊不会。'
    ),
    h('div', { class: 'section-title' }, '哪个 bot'),
    botBar,
    listBox,
    h('div', { class: 'section-title' }, '手动加一条'),
    addBox,
    fileLine
  );

  // -------------------------------------------------------------------------
  // bot 切换
  // -------------------------------------------------------------------------
  function renderBotBar() {
    clear(botBar);
    if (bots.length === 0) {
      botBar.appendChild(h('span', { class: 'hint' }, '还没有 bot，先去「机器人」页建一个。'));
      return;
    }
    for (const b of bots) {
      const btn = button(b.displayName || b.name, {
        small: true,
        level: b.id === botId ? 'primary' : 'default',
        onClick: () => { botId = b.id; renderBotBar(); load(); },
      });
      botBar.appendChild(btn);
    }
  }

  // -------------------------------------------------------------------------
  // 记忆列表
  // -------------------------------------------------------------------------
  async function load() {
    if (!botId) { renderList(); return; }
    loading = true;
    renderList();
    const res = await ctx.call('读取记忆', () => window.mcbot.getMemory(botId), { silent: true });
    loading = false;
    entries = res && res.ok !== false && Array.isArray(res.entries) ? res.entries : [];
    if (res && res.ok === false) ctx.toast(`读取记忆失败：${res.error || '未知原因'}`, 'error');
    fileLine.textContent = res?.file ? `存在：${res.file}` : '';
    renderList();
  }

  function renderList() {
    clear(listBox);
    if (loading) {
      listBox.appendChild(h('div', { class: 'hint' }, '读取中…'));
      return;
    }
    if (entries.length === 0) {
      listBox.appendChild(h('div', { class: 'notice' },
        '这个 bot 还没记住什么。在游戏里跟它说一句「记住……」就行，也可以在下面手动加一条。'
      ));
      return;
    }

    listBox.appendChild(h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center' } },
      h('span', { class: 'section-title', style: { margin: '0' } }, `记住了 ${entries.length} 条`),
      button('清空全部', {
        small: true, level: 'danger',
        onClick: async () => {
          if (!window.confirm('确定把这个 bot 的记忆全部清掉吗？这一步无法撤销。')) return;
          const r = await ctx.run('清空记忆', () => window.mcbot.clearMemory(botId));
          if (r) { ctx.toast(`清掉了 ${r.removed} 条`, 'ok'); load(); }
        },
      })
    ));

    for (const e of entries) {
      const info = KIND_INFO[e.kind] || KIND_INFO.fact;
      const row = h('div', { class: 'row', style: { gap: '8px', alignItems: 'flex-start', padding: '6px 0', borderTop: '1px solid rgba(255,255,255,.06)' } },
        tag(info.label, info.cls),
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div', {}, e.text),
          h('div', { class: 'hint' }, `${fmtAgo(e.ts)}${e.from ? ` · 来自 ${e.from}` : ''}`)
        ),
        button('忘掉', {
          small: true, level: 'default',
          title: '只删这一条',
          onClick: async () => {
            const r = await ctx.run('删掉记忆', () => window.mcbot.forgetMemory(botId, e.id));
            if (r) { ctx.toast('忘掉了', 'ok'); load(); }
          },
        })
      );
      listBox.appendChild(row);
    }
  }

  // -------------------------------------------------------------------------
  // 手动添加
  // -------------------------------------------------------------------------
  function renderAdd() {
    clear(addBox);
    const f = field('要记住的事', {
      placeholder: '例如：家在建在山顶的橡木屋里 / 主人怕苦力怕',
      width: '100%',
    });
    const submit = async () => {
      const text = String(f.value || '').trim();
      if (text.length < 2) { ctx.toast('至少写两个字', 'warn'); return; }
      const r = await ctx.run('记住这条', () => window.mcbot.addMemory(botId, text));
      if (r) {
        ctx.toast(r.dup ? '这条已经记过了，我更新了时间' : '记下了', 'ok');
        f.input.value = '';
        load();
      }
    };
    f.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
    });

    mount(addBox,
      h('div', { class: 'row', style: { gap: '8px', alignItems: 'flex-end' } },
        h('div', { style: { flex: '1' } }, f.el),
        button('记住', { level: 'primary', onClick: submit, disabled: !botId })
      ),
      h('div', { class: 'hint' }, '手动加的和游戏里说的存在同一个地方，bot 下次被叫到时就能想起来。')
    );
  }

  renderBotBar();
  renderAdd();
  load();

  return {
    // 记忆是 bot 进程写的文件，界面不订阅实时事件 —— 切回这一页时刷一次就够。
    update() { /* 由用户手动点 bot 切换或重新进入页面时刷新 */ },
    dispose() { /* 没有订阅，无需清理 */ },
  };
}
