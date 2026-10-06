// ============================================================================
// ui.js —— 极简 DOM 助手 + 格式化函数
//
// 刻意保持"够用"：不做虚拟 DOM、不做组件框架、不做响应式绑定。
// 所有视图都用 h() 造元素、用 clear() 换内容、用 on() 挂事件。
// 约定：本文件不 import 任何其它渲染进程模块，也不碰 window.mcbot。
// ============================================================================

// ---------------------------------------------------------------------------
// 一、元素创建
// ---------------------------------------------------------------------------

/**
 * 建元素。props 支持的键：
 *   class / className   字符串（数组会被展开过滤）
 *   style               对象或字符串
 *   dataset             对象 → data-*
 *   on                  对象，{ click: fn } 等价于 addEventListener
 *   text                等价于 textContent（会覆盖 children）
 *   html                谨慎使用：只用于我们自造的固定字符串
 *   value/checked/disabled/selected/... 其余键：能当属性赋值就赋值，否则 setAttribute
 * children 可为：字符串 / 数字 / 节点 / 数组 / null / false（自动跳过）。
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);

  if (props && typeof props === 'object' && !(props instanceof Node)) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;

      if (key === 'class' || key === 'className') {
        const cls = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
        if (cls) el.setAttribute('class', cls);
        continue;
      }
      if (key === 'style') {
        if (typeof value === 'string') {
          el.setAttribute('style', value);
        } else {
          for (const [sk, sv] of Object.entries(value)) {
            if (sv === null || sv === undefined || sv === '') continue;
            if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
            else el.style[sk] = sv;
          }
        }
        continue;
      }
      if (key === 'dataset') {
        for (const [dk, dv] of Object.entries(value)) {
          if (dv === null || dv === undefined) continue;
          el.dataset[dk] = String(dv);
        }
        continue;
      }
      if (key === 'on') {
        for (const [ev, fn] of Object.entries(value)) {
          if (typeof fn === 'function') el.addEventListener(ev, fn);
        }
        continue;
      }
      if (key === 'text') {
        el.textContent = String(value);
        continue;
      }
      if (key === 'html') {
        el.innerHTML = String(value);
        continue;
      }
      if (key in el) {
        // 有些 DOM 实现（比如 linkedom）给 select.value 这种属性只装了 getter，
        // 直接赋值会抛 TypeError。这里退一步用 setAttribute，语义一样但更保守。
        let assigned = false;
        try {
          el[key] = value;
          assigned = true;
        } catch {
          assigned = false;
        }
        if (!assigned) el.setAttribute(key, String(value));
        continue;
      }
      el.setAttribute(key, String(value));
    }
  } else if (props !== null && props !== undefined && typeof props !== 'object') {
    // 允许 h('div', '纯文本')
    children.unshift(props);
  }

  append(el, children);
  return el;
}

/** 往节点里追加 children（支持数组与嵌套，跳过空值） */
export function append(node, children) {
  for (const child of flatten(children)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function flatten(list) {
  const out = [];
  for (const item of list) {
    if (Array.isArray(item)) out.push(...flatten(item));
    else out.push(item);
  }
  return out;
}

/** 清空节点（比 innerHTML='' 更彻底，且不带解析开销） */
export function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** 用新内容替换节点的全部子节点 */
export function mount(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

/** 绑定事件，返回退订函数 */
export function on(node, ev, fn, opts) {
  node.addEventListener(ev, fn, opts);
  return () => node.removeEventListener(ev, fn, opts);
}

/** 查询助手：qs(root, '.a') —— root 可为选择器字符串或节点 */
export function qs(root, sel) {
  const base = typeof root === 'string' ? document.querySelector(root) : root;
  return base ? base.querySelector(sel) : null;
}

export function qsa(root, sel) {
  const base = typeof root === 'string' ? document.querySelector(root) : root;
  return base ? Array.from(base.querySelectorAll(sel)) : [];
}

/** 设置/移除类名，第二参数为真时添加 */
export function toggleClass(node, cls, enabled) {
  if (!node) return;
  if (enabled) node.classList.add(cls);
  else node.classList.remove(cls);
  return node;
}

// ---------------------------------------------------------------------------
// 二、格式化
// ---------------------------------------------------------------------------

const DIGITS = '0123456789';

/** 数字千分位：1234567 → "1,234,567"；非法输入 → "-" */
export function fmtNum(n) {
  if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return '-';
  const num = Math.trunc(Number(n));
  const neg = num < 0;
  let s = String(Math.abs(num));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const rest = s.length - i;
    out += s[i];
    if (rest > 1 && rest % 3 === 1) out += ',';
  }
  return (neg ? '-' : '') + out;
}

/** token 缩写：999 → "999"，12345 → "12.3k"，2500000 → "2.5M" */
export function fmtTokens(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '-';
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs < 1000) return String(Math.round(v));
  if (abs < 1000 * 1000) return trimZero((v / 1000).toFixed(1)) + 'k';
  if (abs < 1000 * 1000 * 1000) return trimZero((v / 1000000).toFixed(2)) + 'M';
  return trimZero((v / 1000000000).toFixed(2)) + 'B';
}

/** 完整 token 数：12345 → "12,345 tokens" */
export function fmtTokenFull(n) {
  return `${fmtNum(n)} tokens`;
}

function trimZero(s) {
  return String(s).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/** 时长（毫秒）→ "3 分 21 秒" / "1 小时 02 分" / "2 天 3 小时" */
export function fmtDur(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return '-';
  let s = Math.max(0, Math.floor(Number(ms) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const hh = Math.floor(s / 3600);
  s -= hh * 3600;
  const mm = Math.floor(s / 60);
  const ss = s - mm * 60;

  if (d > 0) return `${d} 天 ${hh} 小时`;
  if (hh > 0) return `${hh} 小时 ${pad2(mm)} 分`;
  if (mm > 0) return `${mm} 分 ${pad2(ss)} 秒`;
  return `${ss} 秒`;
}

/** 短时长（延迟用）：1420 → "1.42s"，340 → "340ms" */
export function fmtMs(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return '-';
  const v = Number(ms);
  if (v < 1000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(2)}s`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** epoch ms → "10-05 14:32:07" */
export function fmtTime(ts) {
  const d = toDate(ts);
  if (!d) return '-';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** epoch ms → "14:32:07" */
export function fmtClock(ts) {
  const d = toDate(ts);
  if (!d) return '-';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** epoch ms → "2026-10-05 14:32" */
export function fmtDateTime(ts) {
  const d = toDate(ts);
  if (!d) return '-';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 相对时间："刚刚" / "12 秒前" / "3 分前" */
export function fmtAgo(ts, now = Date.now()) {
  if (!ts) return '从未';
  const diff = Math.max(0, now - Number(ts));
  if (diff < 5000) return '刚刚';
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

/** 坐标："x 12 y 64 z -3" */
export function fmtPos(pos) {
  if (!pos) return '未知';
  return `x ${round1(pos.x)} y ${round1(pos.y)} z ${round1(pos.z)}`;
}

function round1(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '?';
  return String(Math.round(n * 10) / 10);
}

/** 从路径里取文件名（不依赖 Node 的 path） */
export function baseName(p) {
  if (!p) return '';
  const s = String(p).replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function toDate(ts) {
  if (ts === null || ts === undefined || ts === '') return null;
  const d = ts instanceof Date ? ts : new Date(Number(ts));
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// 三、状态与文案映射
// ---------------------------------------------------------------------------

/** BotRuntime.status → { text, cls } —— cls 对应 CSS 的 .st-xxx 状态灯颜色 */
export const BOT_STATUS = {
  stopped: { text: '已停止', cls: 'st-stopped' },
  starting: { text: '启动中', cls: 'st-starting' },
  running: { text: '在线', cls: 'st-running' },
  reconnecting: { text: '重连中', cls: 'st-reconnecting' },
  stopping: { text: '停止中', cls: 'st-stopping' },
  error: { text: '错误', cls: 'st-error' },
};

export function statusInfo(status) {
  return BOT_STATUS[status] || { text: status ? String(status) : '未知', cls: 'st-stopped' };
}

/** 门禁拒绝原因 → 中文解释（logs.js / bots.js 共用） */
export const GATE_REASON_CN = {
  rejectedNoWakeName: '没叫称谓',
  rejectedNotOwner: '不是主人',
  rejectedSelf: '自己的消息',
  rejectedRateLimited: '触发限流',
  rejectedBudget: '超出预算',
  rejectedEmpty: '空消息',
  rejectedNotAllowed: '不在允许名单',
  rejectedInsecureCommand: '危险指令被拦',
  rejectedNoOwner: '未配置主人',
};

export function gateReasonCN(reason) {
  if (!reason) return '';
  return GATE_REASON_CN[reason] || String(reason);
}

// ---------------------------------------------------------------------------
// 四、常用组件（都只返回元素，不带状态）
// ---------------------------------------------------------------------------

/** 像素风按钮。level: 'default' | 'primary' | 'danger' | 'ghost' */
export function button(label, opts = {}) {
  const { level = 'default', onClick, disabled, title, small, cls } = opts;
  const classes = ['btn', `btn-${level}`];
  if (small) classes.push('btn-sm');
  if (cls) classes.push(cls);
  return h(
    'button',
    {
      class: classes,
      type: 'button',
      disabled: Boolean(disabled),
      title: title || undefined,
      on: onClick ? { click: onClick } : undefined,
    },
    label
  );
}

/** 带标签的单行输入；返回 { el: 包裹元素, input: 输入框, value: 当前值 } */
export function field(label, opts = {}) {
  const { width, hint, ...rest } = opts;
  const el = input({ ...rest, style: width ? { width } : undefined });
  const wrap = h(
    'label',
    { class: 'field' },
    h('span', { class: 'field-label' }, label),
    el,
    hint ? h('span', { class: 'field-hint' }, hint) : null
  );
  return {
    el: wrap,
    input: el,
    get value() { return el.value; },
  };
}

/**
 * 裸输入框（不带 label 包裹），用于表格单元格等紧凑位置。
 * 返回的就是 <input> 本身，方便直接塞进 <td>。
 */
export function input(opts = {}) {
  const {
    type = 'text',
    value = '',
    placeholder = '',
    min,
    max,
    step,
    style,
    disabled,
    mono = true,
    title,
    onInput,
    onChange,
  } = opts;
  return h('input', {
    class: ['input', mono ? 'mono' : ''],
    type,
    value: value === null || value === undefined ? '' : String(value),
    placeholder,
    min,
    max,
    step,
    title,
    disabled: Boolean(disabled),
    style,
    on: {
      input: onInput ? (e) => onInput(e.target.value, e) : undefined,
      change: onChange ? (e) => onChange(e.target.value, e) : undefined,
    },
  });
}

/** 下拉框；items 为 [{value,label}] */
export function select(items, opts = {}) {
  const { value, onChange, width, disabled } = opts;
  const el = h(
    'select',
    {
      class: 'input select',
      disabled: Boolean(disabled),
      style: width ? { width } : undefined,
      on: onChange ? { change: (e) => onChange(e.target.value, e) } : undefined,
    },
    items.map((it) =>
      h('option', { value: it.value, selected: String(it.value) === String(value) }, it.label)
    )
  );
  // 注意：选项的 selected 已经按 value 标好了，这里不再碰 el.value ——
  // 某些 DOM 实现把 select.value 做成了只读 getter，赋值会抛错。
  return el;
}

/** 内凹容器（列表/预览区） */
export function sunken(...children) {
  return h('div', { class: 'sunken-box' }, ...children);
}

/** 面板：标题 + 内容 */
export function panel(title, ...children) {
  return h(
    'section',
    { class: 'panel' },
    title ? h('div', { class: 'panel-title' }, title) : null,
    h('div', { class: 'panel-body' }, ...children)
  );
}

/** 键值对行 */
export function kv(k, v, opts = {}) {
  return h(
    'div',
    { class: ['kv', opts.cls] },
    h('span', { class: 'kv-k' }, k),
    h('span', { class: ['kv-v', opts.mono === false ? '' : 'mono', opts.valueCls] },
      typeof v === 'string' || typeof v === 'number' ? v : (v ?? '-'))
  );
}

/** 状态灯 + 文字 */
export function statusLight(status) {
  const info = statusInfo(status);
  return h('span', { class: ['status', info.cls] }, h('i', { class: 'dot' }), info.text);
}

/** 开关滑杆（像素风，不用原生 checkbox 的默认外观） */
export function toggle(checked, onChange, opts = {}) {
  const { disabled, title } = opts;
  const el = h(
    'button',
    {
      class: ['switch', checked ? 'on' : 'off', disabled ? 'disabled' : ''],
      type: 'button',
      role: 'switch',
      'aria-checked': String(Boolean(checked)),
      disabled: Boolean(disabled),
      title,
    },
    h('span', { class: 'switch-knob' })
  );
  if (onChange) el.addEventListener('click', () => onChange(!checked));
  return el;
}

/** 行内小标签 */
export function tag(text, cls = '') {
  return h('span', { class: ['tag', cls] }, text);
}

/**
 * 可重排表格：columns = [{ key, label, width, render(row, index) }]
 * 返回 { el, tbody }
 */
export function table(columns, rows, opts = {}) {
  const { empty = '暂无数据', onRow } = opts;
  const thead = h(
    'thead',
    {},
    h('tr', {}, columns.map((c) => h('th', { style: c.width ? { width: c.width } : undefined }, c.label)))
  );
  const tbody = h('tbody');
  if (!rows.length) {
    tbody.appendChild(
      h('tr', {}, h('td', { class: 'td-empty', colspan: String(columns.length) }, empty))
    );
  } else {
    rows.forEach((row, i) => {
      const tr = h(
        'tr',
        { class: 'data-row', on: onRow ? { click: () => onRow(row, i) } : undefined },
        columns.map((c) =>
          h('td', {}, c.render ? c.render(row, i) : String(row[c.key] ?? ''))
        )
      );
      tbody.appendChild(tr);
    });
  }
  const el = h('table', { class: 'data-table' }, thead, tbody);
  return { el, tbody };
}

/** 自增 id（配置里新增条目用） */
export function uid(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
}

/** 深拷贝（配置副本用；AppConfig 是纯 JSON 结构，够用） */
export function clone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  return JSON.parse(JSON.stringify(obj));
}

/** 把任意值转成可读文本（错误对象也吃） */
export function errText(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  return err.message ? String(err.message) : String(err);
}

/** 简易确认框（不用 window.confirm，避免 Electron 里的模态阻塞体验） */
export function confirmInline(node, question, onYes, onNo) {
  const wrap = h(
    'span',
    { class: 'confirm-inline' },
    h('span', { class: 'confirm-text' }, question),
    h('button', { class: 'btn btn-sm btn-danger', type: 'button', on: { click: () => { restore(); onYes && onYes(); } } }, '确定'),
    h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => { restore(); onNo && onNo(); } } }, '取消')
  );
  const restore = () => {
    if (wrap.parentNode) wrap.parentNode.replaceChild(node, wrap);
  };
  if (node.parentNode) node.parentNode.replaceChild(wrap, node);
  return wrap;
}

/** 触发浏览器下载（导出日志用；不需要 Node 权限） */
export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}
