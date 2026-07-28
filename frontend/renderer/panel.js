'use strict';

const $ = (id) => document.getElementById(id);
let config = { mode: 'pet', skin: 'mascot', budget5h: 0, currency: 'USD', fxRate: 7.2 };

// Format cost with current currency symbol (supports USD → $, CNY → ¥).
// Cost values in stats are always USD; CNY display applies fxRate conversion.
function fmtCost(cost, currency, fxRate) {
  const n = Number(cost) || 0;
  const cur = (currency || config.currency || 'USD');
  const rate = Number.isFinite(fxRate || config.fxRate) && (fxRate || config.fxRate) > 0
    ? (fxRate || config.fxRate) : 7.2;
  const sym = cur === 'CNY' ? '¥' : '$';
  const display = cur === 'CNY' ? n * rate : n;
  if (Math.abs(display) < 1) return sym + display.toFixed(3);
  if (Math.abs(display) < 100) return sym + display.toFixed(2);
  return sym + display.toFixed(1);
}
let lastOpKey = null;
let hoursSummary = ''; // 24h 视图默认读数（鼠标移开时恢复）
let calSummary = '';   // 日历默认读数
let latestSessions = [];
let sessionProviderFilter = '';
let sessionQuery = '';
let latestPriceInfo = null;
const dKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function fmt(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
function aggregateCostText(value) {
  const cost = Number(value && value.cost) || 0;
  const unknown = Number(value && value.unknownPrice) || 0;
  const estimated = Number(value && value.estimatedPrice) || 0;
  if (unknown > 0 && cost <= 0) return '价格未知';
  let text = fmtCost(cost);
  if (estimated > 0) text = estimated === Number(value && (value.messages || value.msgs) || 0) ? '≈' + text : text + '（含估算）';
  if (unknown > 0) text += ' + 未知';
  return text;
}

function timeStr(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function shortModel(m) {
  if (!m) return '?';
  return String(m).replace(/^claude-/, '').replace(/\[1m\]/, '·1M');
}

function render(s) {
  if (!s) return;
  // 头部
  if (s.active && s.active.project) {
    $('active-sub').textContent = `${s.active.project} · ${shortModel(s.active.model)}`;
  }
  // 大数
  $('today-cost').textContent = aggregateCostText(s.today);
  $('today-tokens').textContent = fmt(s.today.tokens) + ' tokens · ' + s.today.messages + ' 轮';
  $('win-cost').textContent = aggregateCostText(s.window5h);
  if (s.window5h.tokens > 0 && s.window5h.resetTs) {
    $('win-reset').textContent = fmt(s.window5h.tokens) + ' tok · ' + timeStr(s.window5h.resetTs) + ' 重置';
  } else {
    $('win-reset').textContent = '窗口空闲';
  }

  // 预算条
  if (config.budget5h > 0) {
    $('budget-wrap').classList.remove('hidden');
    const pct = Math.min(100, (s.window5h.cost / config.budget5h) * 100);
    $('budget-pct').textContent = (s.window5h.unknownPrice > 0 ? '≥' : '') + pct.toFixed(0) + '%';
    const fill = $('budget-fill');
    fill.style.width = pct + '%';
    fill.classList.toggle('warn', pct >= 80);
  } else {
    $('budget-wrap').classList.add('hidden');
  }

  // token 明细
  $('t-in').textContent = fmt(s.today.input);
  $('t-out').textContent = fmt(s.today.output);
  $('t-cw').textContent = fmt(s.today.cacheCreate);
  $('t-cr').textContent = fmt(s.today.cacheRead);
  $('t-msg').textContent = s.today.messages;

  // 按 provider 花费（今日）
  renderProviderCost(s.providerCost);

  // 按模型（有总有分：每模型 cost + 占比条 + in/out/cache 四元组明细，末行合计）
  renderByModel(s.byModel || {});

  // 待办清单
  renderTodos(s.todos || [], s.todosProject || '');

  // 用量趋势：24h + 日历
  renderChart(s.hourly || []);
  renderCal(s.daily || {});

  // 进行中的任务（各会话状态）
  renderSessList(s.sessions || []);

  // 后台任务对账
  renderBg(s.bg || { items: [] });

  // 操作流
  const ops = s.lastOps || [];
  const list = $('ops');
  if (ops.length === 0) {
    list.innerHTML = '<li class="empty">等待操作…</li>';
  } else {
    const topKey = ops[0].ts + ops[0].detail;
    const isNew = topKey !== lastOpKey;
    lastOpKey = topKey;
    list.innerHTML = ops
      .map(
        (o, i) =>
          `<li class="${i === 0 && isNew ? 'new' : ''}"><span>${escapeHtml(o.icon || '🔧')}</span><span>${escapeHtml(o.detail)}</span><span class="op-proj">${escapeHtml(o.project || '')}</span><span class="op-time">${timeStr(o.ts)}</span></li>`
      )
      .join('');
  }
  fitPanelHeight();
}

// 面板按内容高度自适应：量出内容底边（footer 底）到卡片顶的距离，通知主进程调窗口高，
// 避免固定高窗口在内容变短时露出大片空白。requestAnimationFrame 确保布局已完成。
let fitRaf = 0;
function fitPanelHeight() {
  if (!window.pet || !window.pet.setPanelHeight) return;
  if (fitRaf) cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(() => {
    fitRaf = 0;
    const card = $('card');
    const last = card && card.lastElementChild; // 内容最后一块（footer 已移除）
    if (!card || !last) return;
    const h = Math.ceil(last.getBoundingClientRect().bottom - card.getBoundingClientRect().top + card.scrollTop) + 14; // +底部呼吸留白
    if (h > 0) window.pet.setPanelHeight(h);
  });
}

// 按模型明细：每模型一行 = 名称 + 占比条 + $花费 + token/占比；下方灰字给出
// 入/出/缓写/缓读 四元组与轮次；最后一行合计。数据里没有明细字段（旧数据）时只
// 显示头行，跑一次 `npm run meter:rebuild` 可回填历史明细。
// Round 12-拓展: per-provider cost breakdown (today).
const PCOST_META = {
  claude: { icon: '🐙', label: 'Claude Code' },
  codewhale: { icon: '🐋', label: 'CodeWhale' },
  aider: { icon: '🤖', label: 'Aider' },
};
function renderProviderCost(providerCost) {
  const el = $('provider-cost');
  const block = $('provider-cost-block');
  if (!el) return;
  const entries = Object.entries(providerCost || {});
  // Hide the whole block if no provider has any cost data.
  const hasData = entries.some(([, v]) => (v.cost || 0) > 0 || (v.tokens || 0) > 0 || (v.unknownPrice || 0) > 0);
  if (block) block.style.display = hasData ? '' : 'none';
  if (!hasData) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const totalCost = entries.reduce((s, [, v]) => s + (v.cost || 0), 0);
  const base = totalCost || 1;
  let html = '';
  for (const [id, v] of entries) {
    const m = PCOST_META[id] || { icon: '❓', label: id };
    const pct = Math.round(((v.cost || 0) / base) * 100);
    const unknown = Number(v.unknownPrice) || 0;
    const costText = aggregateCostText(v);
    const estimated = Number(v.estimatedPrice) || 0;
    const unknownText = `${estimated > 0 ? ` · ${estimated} 轮按 API 等价估算` : ''}${unknown > 0 ? ` · ${unknown} 轮价格未知` : ''}`;
    html += `<div class="row pcost-row">`
      + `<span class="pcost-name">${escapeHtml(m.icon)} ${escapeHtml(m.label)}</span>`
      + `<span class="pcost-bar-wrap"><span class="pcost-bar" style="width:${pct}%"></span></span>`
       + `<b>${escapeHtml(costText)}</b>`
      + `<span class="pcost-sub">${fmt(v.tokens)} tok · ${v.messages || 0} 轮${escapeHtml(unknownText)}</span>`
      + `</div>`;
  }
  el.innerHTML = html;
}

function renderByModel(byModel) {
  const bm = $('by-model');
  const entries = Object.entries(byModel).sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0));
  if (!entries.length) { bm.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const totCost = entries.reduce((s, [, v]) => s + (v.cost || 0), 0);
  const totTok = entries.reduce((s, [, v]) => s + (v.tokens || 0), 0);
  const base = totCost || 1;
  let html = '';
  for (const [model, v] of entries) {
    const pct = Math.round(((v.cost || 0) / base) * 100);
    const hasDetail = (v.input || v.output || v.cacheCreate || v.cacheRead);
    const unknown = Number(v.unknownPrice) || 0;
    const detail = hasDetail
      ? `<div class="m-detail">入 ${fmt(v.input)} · 出 ${fmt(v.output)} · 缓写 ${fmt(v.cacheCreate)} · 缓读 ${fmt(v.cacheRead)}${v.msgs ? ' · ' + v.msgs + ' 轮' : ''}${v.estimatedPrice ? ' · ' + v.estimatedPrice + ' 轮按 API 等价估算' : ''}${unknown ? ' · ' + unknown + ' 轮价格未知' : ''}</div>`
      : ((v.estimatedPrice || unknown) ? `<div class="m-detail">${v.estimatedPrice ? v.estimatedPrice + ' 轮按 API 等价估算' : ''}${v.estimatedPrice && unknown ? ' · ' : ''}${unknown ? unknown + ' 轮价格未知' : ''}</div>` : '');
    const costText = aggregateCostText(v);
    html += `<div class="m-item">`
      + `<div class="m-head"><span class="mc">${escapeHtml(shortModel(model))}</span>`
      + `<span class="m-bar"><i style="width:${pct}%"></i></span>`
       + `<b class="m-cost">${escapeHtml(costText)}</b>`
       + `<span class="m-tok">${fmt(v.tokens)} · ${pct}%</span></div>`
       + detail + `</div>`;
   }
   html += `<div class="m-item m-total"><div class="m-head"><span class="mc">合计</span>`
     + `<span class="m-bar"></span><b class="m-cost">${escapeHtml(aggregateCostText({ cost: totCost, messages: entries.reduce((sum, [, value]) => sum + (Number(value.messages || value.msgs) || 0), 0), estimatedPrice: entries.reduce((sum, [, value]) => sum + (Number(value.estimatedPrice) || 0), 0), unknownPrice: entries.reduce((sum, [, value]) => sum + (Number(value.unknownPrice) || 0), 0) }))}</b>`
    + `<span class="m-tok">${fmt(totTok)}</span></div></div>`;
  bm.innerHTML = html;
}

const STATE_META = {
  working: { label: '干活中', cls: 'st-working' },
  juggling: { label: '并行子任务', cls: 'st-working' },
  sweeping: { label: '清理上下文', cls: 'st-working' },
  thinking: { label: '思考中', cls: 'st-thinking' },
  loafing: { label: '摸鱼中', cls: 'st-idle' },
  waiting: { label: '等你处理', cls: 'st-waiting' },
  needsinput: { label: '等你回复', cls: 'st-needsinput' },
  error: { label: '出错了', cls: 'st-error' },
  done: { label: '刚完成', cls: 'st-done' },
  idle: { label: '空闲', cls: 'st-idle' },
  sleeping: { label: '休息中', cls: 'st-sleeping' },
  greet: { label: '新会话', cls: 'st-greet' },
  talking: { label: '回应中', cls: 'st-talking' },
};
function renderChart(hourly) {
  const el = $('chart');
  if (!el) return;
  if (!hourly.length) hourly = new Array(24).fill(0);
  const max = Math.max(0.000001, ...hourly);
  const nowH = new Date().getHours();
  let total = 0, peakH = 0, peakV = 0;
  el.innerHTML = hourly
    .map((c, h) => {
      total += c;
      if (c > peakV) { peakV = c; peakH = h; }
      const pct = Math.max(3, Math.round((c / max) * 100));
      const cls = c <= 0 ? 'bar empty' : h === nowH ? 'bar now' : 'bar';
      return `<div class="${cls}" data-h="${h}" data-c="${c.toFixed(3)}" style="height:${c <= 0 ? 4 : pct}%" title="${h}:00 · ${fmtCost(c)}"></div>`;
    })
    .join('');
  hoursSummary = `今日 <b>${fmtCost(total)}</b> · 峰值 ${peakH}点 <b>${fmtCost(peakV)}</b>`;
  const ro = $('hours-readout');
  if (ro) ro.innerHTML = hoursSummary;
}

function renderCal(daily) {
  const el = $('cal');
  if (!el) return;
  daily = daily || {};
  const WEEKS = 12, DAYS = WEEKS * 7;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (DAYS - 1));
  start.setDate(start.getDate() - start.getDay()); // 回到周日对齐
  const todayK = dKey(today);
  const list = [];
  let max = 1e-6, total = 0;
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const k = dKey(d);
    const v = daily[k] || { cost: 0, tokens: 0, msgs: 0 };
    if (v.cost > max) max = v.cost;
    total += v.cost;
    list.push({ k, cost: v.cost, tokens: v.tokens || 0, msgs: v.msgs || 0 });
  }
  let html = '';
  for (let i = 0; i < list.length; i += 7) {
    html += '<div class="cal-col">';
    for (let j = 0; j < 7 && i + j < list.length; j++) {
      const c = list[i + j];
      const lvl = c.cost <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((c.cost / max) * 4)));
      const isToday = c.k === todayK ? ' today' : '';
      html += `<div class="cal-cell lv${lvl}${isToday}" data-k="${c.k}" data-c="${c.cost.toFixed(2)}" data-t="${fmt(c.tokens)}" data-m="${c.msgs}" title="${c.k} · ${fmtCost(c.cost)}"></div>`;
    }
    html += '</div>';
  }
  el.innerHTML = html;
  calSummary = `近 ${list.length} 天合计 <b>${fmtCost(total)}</b>`;
  const cr = $('cal-readout');
  if (cr) cr.innerHTML = calSummary;
}

function sessionProviderId(s) {
  return String(s.providerId || s.provider || 'claude').toLowerCase();
}
function refreshSessionProviderOptions(sessions) {
  const select = $('sess-provider-filter');
  if (!select) return;
  const providers = [...new Set(sessions.map(sessionProviderId))].sort();
  const previous = sessionProviderFilter;
  select.innerHTML = '<option value="">全部 Provider</option>' + providers
    .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml((PROVIDER_META[id] && PROVIDER_META[id].label) || id)}</option>`)
    .join('');
  if (providers.includes(previous)) select.value = previous;
  else { sessionProviderFilter = ''; select.value = ''; }
}
function renderSessList(sessions) {
  latestSessions = Array.isArray(sessions) ? sessions : [];
  refreshSessionProviderOptions(latestSessions);
  const el = $('sess-list');
  const query = sessionQuery.trim().toLowerCase();
  const filtered = latestSessions.filter((s) => {
    const provider = sessionProviderId(s);
    if (sessionProviderFilter && provider !== sessionProviderFilter) return false;
    if (!query) return true;
    return [s.project, s.sessionId, s.op, provider].some((value) => String(value || '').toLowerCase().includes(query));
  });
  const count = $('sess-count');
  if (count) count.textContent = filtered.length === latestSessions.length
    ? `${latestSessions.length} 个`
    : `${filtered.length}/${latestSessions.length} 个`;
  if (!filtered.length) {
    el.innerHTML = `<div class="empty">${latestSessions.length ? '没有匹配的会话' : '暂无活跃会话'}</div>`;
    return;
  }
  el.innerHTML = filtered
    .map((s) => {
      // 与桌宠 HUD 同源：badge=done/interrupted 时盖掉 idle，对齐头顶小点
      const effState = s.state === 'idle' && s.badge === 'done' ? 'done'
        : s.state === 'idle' && s.badge === 'interrupted' ? 'error'
        : s.state;
      const m = STATE_META[effState] || STATE_META.idle;
      const detail =
        effState === 'waiting' ? escapeHtml(`等你${s.reason || '处理'}`)
        : effState === 'needsinput' ? escapeHtml((s.choice && s.choice.question) || '等你回复')
        : (effState === 'working' || effState === 'juggling' || effState === 'sweeping' || effState === 'thinking') && s.op ? escapeHtml(s.op)
        : escapeHtml(m.label);
      const provider = sessionProviderId(s);
      const meta = PROVIDER_META[provider] || { icon: '•', label: provider };
      const sid = String(s.sessionId || '').slice(0, 8);
      return `<div class="row sess" data-provider="${escapeHtml(provider)}" title="${escapeHtml(String(s.sessionId || ''))}">`
        + `<span class="badge ${m.cls}">${m.label}</span>`
        + `<span class="sess-provider" title="${escapeHtml(meta.label)}">${escapeHtml(meta.icon)}</span>`
        + `<span class="sess-proj">${escapeHtml(s.project)}</span>`
        + `<span class="sess-id">${escapeHtml(sid)}</span>`
        + `<span class="sess-op">${detail}</span></div>`;
    })
    .join('');
}

const TODO_ICON = { completed: '✅', in_progress: '▶️', pending: '⬜️' };
function renderTodos(todos, proj) {
  // 空待办不占版面（待办常年为空）——整块收起
  const block = $('todo-block');
  if (block) block.style.display = todos.length ? '' : 'none';
  const el = $('todo-list');
  if (!el) return;
  const prog = $('todo-prog');
  const pj = $('todo-proj');
  if (!todos.length) {
    el.innerHTML = '<div class="empty">当前没有待办</div>';
    if (prog) prog.textContent = '';
    if (pj) pj.textContent = '';
    return;
  }
  const done = todos.filter((t) => t.status === 'completed').length;
  if (prog) prog.textContent = `${done}/${todos.length}`;
  if (pj) pj.textContent = proj ? '· ' + proj : '';
  el.innerHTML = todos
    .map((t) => {
      const cls = t.status === 'completed' ? 'td done' : t.status === 'in_progress' ? 'td doing' : 'td';
      return `<div class="${cls}"><span class="td-ic">${TODO_ICON[t.status] || '⬜️'}</span><span class="td-txt">${escapeHtml(t.content)}</span></div>`;
    })
    .join('');
}

const BG_META = {
  running: { label: '该跑', cls: 'st-working' },
  suspect: { label: '可疑', cls: 'st-waiting' },
  unregistered: { label: '疑似僵尸', cls: 'st-waiting' },
  ended: { label: '已结束', cls: 'st-idle' },
};
function ageStr(sec) {
  if (sec == null) return '';
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.round(sec / 60) + 'm';
  if (sec < 86400) return (sec / 3600).toFixed(1) + 'h';
  return (sec / 86400).toFixed(1) + 'd';
}
function renderBg(bg) {
  const el = $('bg-list');
  if (!el) return;
  const items = (bg.items || []).filter((x) => x.alive); // 只列还活着的
  // 没有后台进程时整块收起，不占版面
  const block = $('bg-block');
  if (block) block.style.display = items.length ? '' : 'none';
  const head = $('bg-head');
  if (head) head.textContent = `后台任务 ✅${bg.running || 0} · 🧟${bg.zombie || 0}`;
  if (!items.length) {
    el.innerHTML = '<div class="empty">没有长跑的后台进程 — 干净</div>';
    return;
  }
  el.innerHTML = items
    .map((it) => {
      const m = BG_META[it.status] || BG_META.ended;
      const ic = it.status === 'running' ? '✅' : it.status === 'ended' ? '⚪' : '🧟';
      const purpose = it.purpose ? escapeHtml(it.purpose) : escapeHtml(String(it.cmd).slice(0, 48));
      return `<div class="row sess"><span class="badge ${m.cls}">${ic}${m.label}</span><span class="sess-proj">${purpose}</span><span class="sess-op">${ageStr(it.ageSec)} · ${it.stop ? escapeHtml(it.stop) : ''}</span></div>`;
    })
    .join('');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Native provider adapter status. The persisted Rust config keeps a compact
// string array; get_config expands it with installation/runtime metadata.
const PROVIDER_META = {
  claude: { icon: '🐙', label: 'Claude Code' },
  codewhale: { icon: '🐋', label: 'CodeWhale' },
  codex: { icon: '🤖', label: 'Codex CLI' },
  opencode: { icon: '🧩', label: 'OpenCode' },
  aider: { icon: '🛠️', label: 'Aider' },
};

function renderProviders() {
  const el = $('provider-list');
  if (!el || !config.providers) return;
  const { active = [], all = [], statuses = {}, cwHooksInstalled = false } = config.providers;
  const activeSet = new Set(active);
  const activeCount = activeSet.size;
  el.innerHTML = all.map((id) => {
    const m = PROVIDER_META[id] || { icon: '❓', label: id };
    const on = activeSet.has(id);
    const locked = on && activeCount <= 1;
    const runtime = statuses[id] || {};
    const installed = runtime.installed != null ? !!runtime.installed : (id === 'codewhale' && cwHooksInstalled);
    const failed = runtime.state === 'error';
    const cls = failed ? 'warn' : installed ? 'ok' : 'off';
    const label = failed ? '●安装失败' : installed ? '●已注册' : on ? '○待注册' : '○未启用';
    const detail = runtime.message || (on ? '等待原生 Hook 同步' : 'provider 未启用');
    const mode = runtime.permissionMode ? ` · 权限：${runtime.permissionMode}` : '';
    const warning = runtime.capabilities && runtime.capabilities.bypassWarning
      ? ` · ⚠ ${runtime.capabilities.bypassWarning}` : '';
    const status = `<span class="prov-status ${cls}" title="${escapeHtml(detail + mode + warning)}">${label}${warning ? ' ⚠' : ''}</span>`;
    return '<label class="prov-item' + (on ? ' active' : '') + (locked ? ' locked' : '') + '">'
      + '<input type="checkbox" ' + (on ? 'checked' : '') + ' ' + (locked ? 'disabled' : '') + ' data-id="' + escapeHtml(id) + '">'
      + '<span class="prov-icon">' + escapeHtml(m.icon) + '</span>'
      + '<span class="prov-label">' + escapeHtml(m.label) + '</span>'
      + status
      + '</label>';
  }).join('');
}

function formatPriceTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderPriceInfo(message) {
  if (!message) return;
  latestPriceInfo = message;
  const el = $('price-src');
  if (!el) return;
  const updated = message.lastUpdatedAt || message.updatedAt || message.ts;
  const checked = message.lastCheckedAt;
  const next = message.nextCheckAt;
  const count = Number(message.entryCount || message.models || message.count) || 0;
  const source = String(message.source || 'bundled');
  const state = String(message.state || 'idle');
  const live = Boolean(message.live);
  const inProgress = Boolean(message.inProgress);
  const autoUpdate = message.autoUpdate !== false;
  const refreshHours = Math.max(1, Math.min(168, Number(message.refreshHours) || 24));
  const error = String(message.lastError || '').slice(0, 500);
  const consecutiveFailures = Math.max(0, Number(message.consecutiveFailures) || 0);

  let base;
  if (live) {
    const when = formatPriceTime(updated) || '缓存';
    base = `💲 价目：${source === 'user-override' ? '用户覆盖' : 'models.dev 缓存'} ${count} 项 · ${when} 更新`;
  } else {
    base = `💲 价目：内置兜底表 ${count ? '· ' + count + ' 项' : ''}`;
  }

  let tail = '';
  if (inProgress || state === 'refreshing' || state === 'queued') {
    tail = ' · 正在检查最新价格…';
  } else if (state === 'not-modified') {
    tail = ` · ${formatPriceTime(checked) || '刚刚'}检查，无变化`;
  } else if (state === 'updated') {
    tail = ` · ${formatPriceTime(checked) || '刚刚'}已同步`;
  } else if (state === 'error') {
    tail = ` · 价格更新失败${consecutiveFailures ? `（连续 ${consecutiveFailures} 次）` : ''}，${next ? formatPriceTime(next) + '重试' : '保留旧价'}`;
  } else if (state === 'network-disabled') {
    tail = ' · 网络更新已被环境变量关闭';
  } else if (!autoUpdate || state === 'auto-disabled') {
    tail = ' · 自动更新已关闭';
  } else if (next) {
    tail = ` · 下次 ${formatPriceTime(next)} 检查`;
  } else {
    tail = ` · 每 ${refreshHours} 小时自动检查`;
  }

  el.textContent = base + tail;
  el.title = error || `固定来源：${message.sourceUrl || 'https://models.dev/api.json'}；条件请求：${message.conditionalRequests ? '已启用' : '未启用'}；失败退避：${message.failureBackoff ? '已启用' : '未启用'}`;
  el.classList.toggle('price-error', state === 'error');
  el.classList.toggle('price-live', live && state !== 'error');

  const refresh = $('price-refresh');
  const auto = $('price-auto');
  const interval = $('price-interval');
  if (refresh) {
    refresh.disabled = inProgress || state === 'refreshing' || state === 'queued';
    refresh.textContent = refresh.disabled ? '刷新中…' : '立即刷新';
  }
  if (auto) auto.checked = autoUpdate;
  if (interval) {
    const exact = Array.from(interval.options).some((option) => Number(option.value) === refreshHours);
    if (!exact) {
      const option = document.createElement('option');
      option.value = String(refreshHours);
      option.textContent = `每 ${refreshHours} 小时`;
      interval.appendChild(option);
    }
    interval.value = String(refreshHours);
    interval.disabled = !autoUpdate;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const sessionProvider = $('sess-provider-filter');
  const sessionSearch = $('sess-query');
  if (sessionProvider) sessionProvider.addEventListener('change', (e) => {
    sessionProviderFilter = String(e.target.value || '').toLowerCase();
    renderSessList(latestSessions);
  });
  if (sessionSearch) sessionSearch.addEventListener('input', (e) => {
    sessionQuery = String(e.target.value || '').slice(0, 128);
    renderSessList(latestSessions);
  });
  const priceRefresh = $('price-refresh');
  const priceAuto = $('price-auto');
  const priceInterval = $('price-interval');
  if (priceRefresh) priceRefresh.addEventListener('click', () => {
    priceRefresh.disabled = true;
    priceRefresh.textContent = '刷新中…';
    window.pet.refreshModelPrices().then(renderPriceInfo).catch((error) => {
      renderPriceInfo({ ...(latestPriceInfo || {}), state: 'error', inProgress: false, lastError: String(error || '刷新失败') });
    });
  });
  const savePriceAuto = () => {
    const enabled = Boolean(priceAuto && priceAuto.checked);
    const refreshHours = Math.max(1, Math.min(168, Number(priceInterval && priceInterval.value) || 24));
    if (priceInterval) priceInterval.disabled = !enabled;
    window.pet.setPriceAutoUpdate(enabled, refreshHours);
  };
  if (priceAuto) priceAuto.addEventListener('change', savePriceAuto);
  if (priceInterval) priceInterval.addEventListener('change', savePriceAuto);
  window.pet.getPriceInfo().then(renderPriceInfo).catch(() => {});

  $('provider-list').addEventListener('change', (e) => {
    if (!e.target.matches('input[data-id]')) return;
    const id = e.target.dataset.id;
    const { active } = config.providers || { active: ['claude'] };
    const newActive = e.target.checked
      ? [...active, id]
      : active.filter((a) => a !== id);
    // W22: allow disabling claude (to "unlock" it from the pet's hook). Only
    // guard: must keep at least one active provider.
    if (newActive.length === 0) {
      e.target.checked = true; // revert checkbox
      return;
    }
    window.pet.setProviders(newActive);
  });
});

function applyConfigUI() {
  document.querySelectorAll('#mode-seg .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === config.mode)
  );
  document.querySelectorAll('#skin-seg .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.skin === (config.skin || 'mascot'))
  );
  const bi = $('budget'); // 预算输入已移到托盘；面板里不再有该元素
  if (bi && document.activeElement !== bi) bi.value = config.budget5h || '';
  renderProviders();
}

// 事件
window.pet.onPanelStats(render);
window.pet.onPrice(renderPriceInfo);
window.pet.onConfig((cfg) => {
  if (!cfg) return;
  config = { ...config, ...cfg };
  applyConfigUI();
});

$('close').addEventListener('click', () => window.pet.closePanel());
document.querySelectorAll('#mode-seg .seg-btn').forEach((b) =>
  b.addEventListener('click', () => {
    config.mode = b.dataset.mode;
    applyConfigUI();
    window.pet.setMode(b.dataset.mode);
  })
);
document.querySelectorAll('#skin-seg .seg-btn').forEach((b) =>
  b.addEventListener('click', () => {
    config.skin = b.dataset.skin;
    applyConfigUI();
    window.pet.setSkin(b.dataset.skin);
  })
);
{ // 预算输入已移到托盘；面板存在旧元素时才接线（向后兼容）
  const bi = $('budget');
  if (bi) bi.addEventListener('change', (e) => {
    config.budget5h = Number(e.target.value) || 0;
    window.pet.setBudget(config.budget5h);
  });
}

// 视图切换：24h / 日历
document.querySelectorAll('.view-tabs .vt').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.view-tabs .vt').forEach((x) => x.classList.toggle('active', x === b));
    $('view-hours').classList.toggle('hidden', b.dataset.view !== 'hours');
    $('view-cal').classList.toggle('hidden', b.dataset.view !== 'cal');
  })
);

// 悬停看具体数值：24h 柱
$('chart').addEventListener('mouseover', (e) => {
  const bar = e.target.closest('.bar');
  if (bar) $('hours-readout').innerHTML = `${bar.dataset.h}:00 · <b>${fmtCost(Number(bar.dataset.c))}</b>`;
});
$('chart').addEventListener('mouseleave', () => { $('hours-readout').innerHTML = hoursSummary; });

// 悬停看具体数值：日历格子
$('cal').addEventListener('mouseover', (e) => {
  const cell = e.target.closest('.cal-cell');
  if (cell) $('cal-readout').innerHTML = `${cell.dataset.k} · <b>${fmtCost(Number(cell.dataset.c))}</b> · ${cell.dataset.t} tok · ${cell.dataset.m} 轮`;
});
$('cal').addEventListener('mouseleave', () => { $('cal-readout').innerHTML = calSummary; });

// 初始化
(async () => {
  const cfg = await window.pet.getConfig();
  if (cfg) { config = { ...config, ...cfg }; applyConfigUI(); }
  const s = await window.pet.getStats();
  if (s) render(s);
})();
