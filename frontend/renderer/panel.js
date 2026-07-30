'use strict';

const $ = (id) => document.getElementById(id);
const i18n = window.OctoI18n;
const t = (key, vars) => i18n ? i18n.t(key, vars) : key;
const LOCALES = { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP' };
let config = { lang: 'zh', mode: 'pet', skin: 'mascot', budget5h: 0, currency: 'USD', fxRate: 7.2 };

function applyLanguage(next) {
  const lang = i18n ? i18n.setLang(next) : 'zh';
  config.lang = lang;
  document.documentElement.lang = LOCALES[lang] || 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((node) => {
    node.title = t(node.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  });
  document.title = t('panel.title');
  if (latestProviderDiagnostic) renderProviderDiagnostic(latestProviderDiagnostic);
  const picker = $('language');
  if (picker && picker.value !== lang) picker.value = lang;
}


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
// R16 (2026-07-30): metric switching state — 'tokens' or 'cost'. Default
// 'tokens' matches the upstream Electron panel (Token tab is active by
// default). lastStats is kept so a metric switch or language switch can
// re-render without waiting for a new stats push.
let usageMetric = 'tokens';
let lastStats = null;
let latestSessions = [];
let sessionProviderFilter = '';
let sessionQuery = '';
// R19 (2026-07-30): session list pin/archive state. Mirrored from config
// on every config push; toggled by clicking the pin/archive buttons on
// each session row. Persisted via window.pet.setSessionPrefs.
let sessionPinned = [];
let sessionArchived = [];
let sessionAttentionOnly = false;
let sessionShowArchived = false;
let latestPriceInfo = null;
let latestProviderDiagnostic = null;
let providerDiagnosticBusy = '';
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
  return d.toLocaleTimeString(LOCALES[config.lang] || 'zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
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
  // AUDIT-FIX (2026-07-30): was hardcoded ' 轮' / ' 重置'; now uses the
  // existing panel.rounds / panel.reset i18n keys (already in zh/en/ja).
  $('today-cost').textContent = aggregateCostText(s.today);
  $('today-tokens').textContent = fmt(s.today.tokens) + ' tokens · ' + s.today.messages + t('panel.rounds');
  $('win-cost').textContent = aggregateCostText(s.window5h);
  if (s.window5h.tokens > 0 && s.window5h.resetTs) {
    $('win-reset').textContent = fmt(s.window5h.tokens) + ' tok · ' + timeStr(s.window5h.resetTs) + t('panel.reset');
  } else {
    $('win-reset').textContent = t('panel.windowIdle');
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

  // R15 (2026-07-30): Codex 5h quota bar (rollout rate_limits).
  // Hidden when s.codexLimits is absent — matches upstream "no Codex
  // activity → hide the whole block" behavior. The actual codexLimits
  // data producer (codex-watch equivalent) is a separate task; this
  // rendering code is ready for when it lands.
  const cl = s.codexLimits;
  if (cl && cl.usedPercent != null) {
    $('codex-wrap').classList.remove('hidden');
    const pct = Math.max(0, Math.min(100, cl.usedPercent));
    $('codex-pct').textContent = pct.toFixed(0) + '%';
    const cfill = $('codex-fill');
    cfill.style.width = pct + '%';
    cfill.classList.toggle('warn', pct >= 80);
    const bits = [];
    if (cl.resetsAt) bits.push(timeStr(cl.resetsAt) + t('panel.reset'));
    if (cl.secondaryUsedPercent != null) bits.push(t('panel.weekWindow') + Math.round(cl.secondaryUsedPercent) + '%');
    if (cl.planType) bits.push(cl.planType + t('panel.plan'));
    $('codex-foot').textContent = bits.join(' · ');
  } else {
    $('codex-wrap').classList.add('hidden');
  }

  // R15: Codex today + lifetime tokens. Hidden when s.codexUsage is absent.
  renderCodexUsage(s.codexUsage);

  // token 明细
  // R18: cache write split into 5m + 1h rows, matching upstream panel.
  $('t-in').textContent = fmt(s.today.input);
  $('t-out').textContent = fmt(s.today.output);
  $('t-cw5').textContent = fmt(s.today.cacheWrite5m || s.today.cacheCreate || 0);
  $('t-cw1').textContent = fmt(s.today.cacheWrite1h || 0);
  $('t-cr').textContent = fmt(s.today.cacheRead);
  $('t-msg').textContent = s.today.messages;

  // 按 provider 花费（今日）
  renderProviderCost(s.providerCost);

  // 按模型（有总有分：每模型 cost + 占比条 + in/out/cache 四元组明细，末行合计）
  renderByModel(s.byModel || {});

  // 待办清单
  renderTodos(s.todos || [], s.todosProject || '');

  // 用量趋势：24h + 日历
  // R16: pass both hourly cost and hourly token arrays so renderChart can
  // pick based on usageMetric. Also store lastStats so a metric tab click
  // can re-render without waiting for a new stats push.
  lastStats = s;
  renderChart(s.hourly || [], s.hourlyTok || []);
  renderCal(s.daily || {});
  renderDiagnostics(s.transcriptDiagnostics);

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
  codex: { icon: '💻', label: 'Codex CLI' },
  opencode: { icon: '🧩', label: 'OpenCode' },
  aider: { icon: '🛠️', label: 'Aider' },
};
// R15 (2026-07-30): Codex today + lifetime tokens rendering.
// Mirrors the upstream Electron panel.js renderCodexUsage. Hidden when
// codexUsage is absent (no Codex activity). The data producer (codex-watch
// equivalent in Rust) is a separate task; this renderer is ready for it.
function renderCodexUsage(codexUsage) {
  const wrap = $('codex-usage');
  if (!wrap) return;
  if (!codexUsage || !codexUsage.today || !codexUsage.lifetime) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  const today = codexUsage.today;
  const lifetime = codexUsage.lifetime;
  $('codex-today').textContent = fmt(today.tokens);
  $('codex-lifetime').textContent = fmt(lifetime.tokens);
  $('codex-today-detail').textContent = t('panel.codexBreakdown', {
    in: fmt(today.input),
    out: fmt(today.output),
    cached: fmt(today.cached || 0),
    reasoning: fmt(today.reasoning || 0),
  });
  $('codex-lifetime-detail').textContent = t('panel.codexLocalHistory', {
    sessions: lifetime.sessions || 0,
    events: lifetime.events || 0,
  });
}

// R16 (2026-07-30): usage diagnostics line — shows transcript scan info,
// streaming corrections, estimated model count, and pricing staleness.
// Mirrors the upstream Electron panel.js renderDiagnostics. Reads
// s.transcriptDiagnostics (already produced by metering.rs snapshot()).
function renderDiagnostics(diag) {
  const el = $('usage-diagnostics');
  if (!el) return;
  if (!diag) { el.textContent = ''; return; }
  const last = diag.lastScanTs
    ? new Date(diag.lastScanTs).toLocaleTimeString(LOCALES[config.lang] || 'zh-CN', { hour: '2-digit', minute: '2-digit' })
    : t('panel.diagNever');
  const bits = [
    t('panel.diagScan', { when: last, files: diag.scannedFiles || 0, records: diag.records || 0 }),
    t('panel.diagCorrections', { n: diag.streamingCorrections || 0 }),
  ];
  if (diag.estimatedModelCount) bits.push(t('panel.diagEstimated', { n: diag.estimatedModelCount }));
  if (diag.pricing && diag.pricing.stale) bits.push(t('panel.diagStale'));
  el.textContent = bits.join(' · ');
}

function renderProviderCost(providerCost) {
  const el = $('provider-cost');
  const block = $('provider-cost-block');
  if (!el) return;
  const entries = Object.entries(providerCost || {});
  // Hide the whole block if no provider has any cost data.
  const hasData = entries.some(([, v]) => (v.cost || 0) > 0 || (v.tokens || 0) > 0 || (v.unknownPrice || 0) > 0);
  if (block) block.style.display = hasData ? '' : 'none';
  if (!hasData) { el.innerHTML = '<div class="empty">' + t('panel.noData') + '</div>'; return; }
  const totalCost = entries.reduce((s, [, v]) => s + (v.cost || 0), 0);
  const base = totalCost || 1;
  let html = '';
  for (const [id, v] of entries) {
    const m = PCOST_META[id] || { icon: '❓', label: id };
    const pct = Math.round(((v.cost || 0) / base) * 100);
    const unknown = Number(v.unknownPrice) || 0;
    const costText = aggregateCostText(v);
    const estimated = Number(v.estimatedPrice) || 0;
    // AUDIT-FIX (2026-07-30): was hardcoded Chinese; now uses i18n keys.
    const unknownText = `${estimated > 0 ? escapeHtml(t('panel.estimatedRounds', { n: estimated })) : ''}${estimated > 0 && unknown > 0 ? ' · ' : ''}${unknown > 0 ? escapeHtml(t('panel.unknownRounds', { n: unknown })) : ''}`;
    html += `<div class="row pcost-row">`
      + `<span class="pcost-name">${escapeHtml(m.icon)} ${escapeHtml(m.label)}</span>`
      + `<span class="pcost-bar-wrap"><span class="pcost-bar" style="width:${pct}%"></span></span>`
       + `<b>${escapeHtml(costText)}</b>`
      + `<span class="pcost-sub">${fmt(v.tokens)} tok · ${v.messages || 0}${escapeHtml(t('panel.rounds'))}${unknownText ? ' · ' + unknownText : ''}</span>`
      + `</div>`;
  }
  el.innerHTML = html;
}

function renderByModel(byModel) {
  const bm = $('by-model');
  const entries = Object.entries(byModel).sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0));
  if (!entries.length) { bm.innerHTML = '<div class="empty">' + t('panel.noData') + '</div>'; return; }
  const totCost = entries.reduce((s, [, v]) => s + (v.cost || 0), 0);
  const totTok = entries.reduce((s, [, v]) => s + (v.tokens || 0), 0);
  const base = totCost || 1;
  let html = '';
  for (const [model, v] of entries) {
    const pct = Math.round(((v.cost || 0) / base) * 100);
    const hasDetail = (v.input || v.output || v.cacheCreate || v.cacheRead);
    const unknown = Number(v.unknownPrice) || 0;
    // AUDIT-FIX (2026-07-30): was hardcoded Chinese; now uses the existing
    // panel.modelDetail + panel.modelRounds + panel.estimatedRounds +
    // panel.unknownRounds i18n keys. R18 (2026-07-30): upgraded modelDetail
    // to use {cw5}/{cw1} split when available, falling back to {cw} (the
    // aggregate cacheCreate) for older ledger rows that lack the split.
    const cw5 = v.cacheWrite5m || v.cacheCreate || 0;
    const cw1 = v.cacheWrite1h || 0;
    const detail = hasDetail
      ? `<div class="m-detail">${escapeHtml(t('panel.modelDetail', { in: fmt(v.input), out: fmt(v.output), cw: fmt(v.cacheCreate || 0), cw5: fmt(cw5), cw1: fmt(cw1), cr: fmt(v.cacheRead) }))}${v.msgs ? escapeHtml(t('panel.modelRounds', { n: v.msgs })) : ''}${v.estimatedPrice ? escapeHtml(t('panel.estimatedRounds', { n: v.estimatedPrice })) : ''}${unknown ? escapeHtml(t('panel.unknownRounds', { n: unknown })) : ''}</div>`
      : ((v.estimatedPrice || unknown) ? `<div class="m-detail">${v.estimatedPrice ? escapeHtml(t('panel.estimatedRounds', { n: v.estimatedPrice })) : ''}${v.estimatedPrice && unknown ? ' · ' : ''}${unknown ? escapeHtml(t('panel.unknownRounds', { n: unknown })) : ''}</div>` : '');
    const costText = aggregateCostText(v);
    html += `<div class="m-item">`
      + `<div class="m-head"><span class="mc">${escapeHtml(shortModel(model))}</span>`
      + `<span class="m-bar"><i style="width:${pct}%"></i></span>`
       + `<b class="m-cost">${escapeHtml(costText)}</b>`
       + `<span class="m-tok">${fmt(v.tokens)} · ${pct}%</span></div>`
       + detail + `</div>`;
   }
   html += `<div class="m-item m-total"><div class="m-head"><span class="mc">${escapeHtml(t('panel.total'))}</span>`
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
// R16 (2026-07-30): renderChart now accepts both hourly cost and hourly
// token arrays and picks which to display based on usageMetric. Mirrors
// the upstream Electron panel.js contract so the Token/Cost tabs work.
function renderChart(hourlyCost, hourlyTokens) {
  const el = $('chart');
  if (!el) return;
  const hourly = usageMetric === 'cost' ? hourlyCost : (hourlyTokens || hourlyCost);
  const values = hourly && hourly.length ? hourly : new Array(24).fill(0);
  const max = Math.max(0.000001, ...values);
  const nowH = new Date().getHours();
  let total = 0, peakH = 0, peakV = 0;
  el.innerHTML = values
    .map((value, h) => {
      total += value;
      if (value > peakV) { peakV = value; peakH = h; }
      const pct = Math.max(3, Math.round((value / max) * 100));
      const cls = value <= 0 ? 'bar empty' : h === nowH ? 'bar now' : 'bar';
      const display = usageMetric === 'cost' ? fmtCost(value) : fmt(value) + ' tok';
      return `<div class="${cls}" data-h="${h}" data-v="${escapeHtml(display)}" style="height:${value <= 0 ? 4 : pct}%" title="${h}:00 · ${escapeHtml(display)}"></div>`;
    })
    .join('');
  hoursSummary = usageMetric === 'cost'
    ? t('panel.hoursSummaryCost', { total: total.toFixed(2), peakH, peakV: peakV.toFixed(2) })
    : t('panel.hoursSummaryTokens', { total: fmt(total), peakH, peakV: fmt(peakV) });
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
    // R16: pick metric value based on usageMetric
    const metricValue = usageMetric === 'cost' ? v.cost : (v.tokens || 0);
    if (metricValue > max) max = metricValue;
    total += metricValue;
    list.push({ k, cost: v.cost, tokens: v.tokens || 0, msgs: v.msgs || 0 });
  }
  let html = '';
  for (let i = 0; i < list.length; i += 7) {
    html += '<div class="cal-col">';
    for (let j = 0; j < 7 && i + j < list.length; j++) {
      const c = list[i + j];
      const metricValue = usageMetric === 'cost' ? c.cost : (c.tokens || 0);
      const lvl = metricValue <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((metricValue / max) * 4)));
      const isToday = c.k === todayK ? ' today' : '';
      const display = usageMetric === 'cost' ? fmtCost(c.cost) : fmt(c.tokens) + ' tok';
      html += `<div class="cal-cell lv${lvl}${isToday}" data-k="${c.k}" data-c="${c.cost.toFixed(2)}" data-t="${fmt(c.tokens)}" data-m="${c.msgs}" title="${c.k} · ${escapeHtml(display)}"></div>`;
    }
    html += '</div>';
  }
  el.innerHTML = html;
  calSummary = usageMetric === 'cost'
    ? t('panel.calSummaryCost', { n: list.length, total: fmtCost(total) })
    : t('panel.calSummaryTokens', { n: list.length, total: fmt(total) });
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
  // R19: filter by provider + query + attention + archive.
  const pinnedSet = new Set(sessionPinned);
  const archivedSet = new Set(sessionArchived);
  const filtered = latestSessions.filter((s) => {
    const provider = sessionProviderId(s);
    if (sessionProviderFilter && provider !== sessionProviderFilter) return false;
    if (!query) return true;
    return [s.project, s.sessionId, s.op, provider].some((value) => String(value || '').toLowerCase().includes(query));
  }).filter((s) => {
    // Attention filter: only waiting/needsinput sessions.
    if (sessionAttentionOnly && s.state !== 'waiting' && s.state !== 'needsinput') return false;
    // Archive filter: hide archived unless toggled.
    const sid = String(s.sessionId || '');
    if (archivedSet.has(sid) && !sessionShowArchived) return false;
    return true;
  }).sort((a, b) => {
    // Pinned sessions float to top; stable order otherwise.
    const pa = pinnedSet.has(String(a.sessionId || '')) ? 0 : 1;
    const pb = pinnedSet.has(String(b.sessionId || '')) ? 0 : 1;
    return pa - pb;
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
      const sid = String(s.sessionId || '');
      const sidShort = sid.slice(0, 8);
      // R19: pin/archive buttons. Clicking toggles membership and persists.
      const isPinned = pinnedSet.has(sid);
      const isArchived = archivedSet.has(sid);
      const pinBtn = `<button class="sess-pin" data-sid="${escapeHtml(sid)}" data-action="pin" title="${isPinned ? t('sess.unpin') : t('sess.pin')}">${isPinned ? '📌' : '📍'}</button>`;
      const archiveBtn = `<button class="sess-archive" data-sid="${escapeHtml(sid)}" data-action="archive" title="${isArchived ? t('sess.unarchive') : t('sess.archive')}">${isArchived ? '📤' : '📥'}</button>`;
      return `<div class="row sess${isPinned ? ' pinned' : ''}${isArchived ? ' archived' : ''}" data-provider="${escapeHtml(provider)}" title="${escapeHtml(sid)}">`
        + `<span class="badge ${m.cls}">${m.label}</span>`
        + `<span class="sess-provider" title="${escapeHtml(meta.label)}">${escapeHtml(meta.icon)}</span>`
        + `<span class="sess-proj">${escapeHtml(s.project)}</span>`
        + `<span class="sess-id">${escapeHtml(sidShort)}</span>`
        + `<span class="sess-op">${detail}</span>`
        + `<span class="sess-actions">${pinBtn}${archiveBtn}</span></div>`;
    })
    .join('');
  // R19: wire pin/archive button clicks.
  el.querySelectorAll('.sess-pin, .sess-archive').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sid = btn.dataset.sid;
      const action = btn.dataset.action;
      if (!sid) return;
      if (action === 'pin') {
        sessionPinned = sessionPinned.includes(sid)
          ? sessionPinned.filter((x) => x !== sid)
          : [...sessionPinned, sid];
        // Pin wins: remove from archived if pinning.
        sessionArchived = sessionArchived.filter((x) => x !== sid);
      } else if (action === 'archive') {
        sessionArchived = sessionArchived.includes(sid)
          ? sessionArchived.filter((x) => x !== sid)
          : [...sessionArchived, sid];
        // Archived can't be pinned.
        sessionPinned = sessionPinned.filter((x) => x !== sid);
      }
      window.pet.setSessionPrefs(sessionPinned, sessionArchived);
      renderSessList(latestSessions);
    });
  });
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

function probeText(probe) {
  if (!probe || typeof probe !== 'object') return '';
  return String(probe.stderr || probe.stdout || probe.error || '').trim().slice(0, 2400);
}

function probeVersion(probe) {
  const text = probeText(probe);
  return text ? text.split(/\r?\n/).find((line) => line.trim()) || '' : '';
}

function probeStatus(probe) {
  if (!probe || typeof probe !== 'object' || !probe.started) return t('diag.notRun');
  if (probe.timedOut) return t('diag.timedOut');
  return probe.success ? t('diag.confirmed') : t('diag.unconfirmed');
}

function diagnosticRow(label, value, mono) {
  if (value == null || value === '') return '';
  return `<div class="diag-row"><span>${escapeHtml(label)}</span><b class="${mono ? 'mono' : ''}">${escapeHtml(String(value))}</b></div>`;
}

function renderProviderDiagnostic(result) {
  latestProviderDiagnostic = result;
  const el = $('provider-diagnostic');
  const summary = $('provider-diag-summary');
  if (!el || !result) return;
  const id = String(result.provider || '');
  const meta = PROVIDER_META[id] || { icon: '•', label: id || 'Provider' };
  const issues = Array.isArray(result.issues) ? result.issues : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const ready = Boolean(result.ready);
  const version = probeVersion(result.versionProbe);
  const companionVersion = probeVersion(result.companionVersionProbe);
  const doctor = probeText(result.doctorProbe);
  const auth = probeText(result.authProbe);
  const doctorSummary = result.doctorSummary && typeof result.doctorSummary === 'object'
    ? result.doctorSummary : null;
  const configInfo = result.config && typeof result.config === 'object' ? result.config : null;
  const terminal = result.terminal && typeof result.terminal === 'object' ? result.terminal : null;
  const aiderSummary = result.aiderSummary && typeof result.aiderSummary === 'object'
    ? result.aiderSummary : null;
  const statusLabel = ready ? t('diag.ready') : t('diag.problem');
  const issueHtml = issues.length
    ? `<ul class="diag-issues">${issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>`
    : `<div class="diag-ok">${escapeHtml(t('diag.noIssues'))}</div>`;
  const warningHtml = warnings.length
    ? `<div class="diag-warning-title">${escapeHtml(t('diag.warnings'))}</div><ul class="diag-warnings">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>`
    : '';
  const compatibility = configInfo && configInfo.compatibility && typeof configInfo.compatibility === 'object'
    ? configInfo.compatibility : null;
  const legacyModels = compatibility && Array.isArray(compatibility.legacyModelIds)
    ? compatibility.legacyModelIds.join(', ') : '';
  const projectOverlays = configInfo && Array.isArray(configInfo.projectOverlays)
    ? configInfo.projectOverlays.filter((item) => item && item.present).map((item) => item.path).join(' · ')
    : '';
  const configRows = configInfo ? [
    diagnosticRow(t('diag.config'), configInfo.selected || configInfo.path, true),
    diagnosticRow(t('diag.configSource'), configInfo.selectedSource, false),
    diagnosticRow(t('diag.projectConfig'), projectOverlays, true),
    diagnosticRow(t('diag.hooks'), configInfo.octopusHookBlock ? t('diag.present') : t('diag.absent'), false),
    diagnosticRow(t('diag.legacyModels'), legacyModels, true),
  ].join('') : '';
  const aiderConfigs = aiderSummary && Array.isArray(aiderSummary.configCandidates)
    ? aiderSummary.configCandidates.filter((item) => item && item.present).map((item) => item.path).join(' · ')
    : '';
  const aiderCredentials = aiderSummary && Array.isArray(aiderSummary.credentialEnvironment)
    ? aiderSummary.credentialEnvironment.join(', ')
    : '';
  const aiderRows = aiderSummary ? [
    diagnosticRow(t('diag.configCandidates'), aiderConfigs || t('diag.absent'), true),
    diagnosticRow(t('diag.credentialHints'), aiderCredentials || t('diag.absent'), true),
    diagnosticRow(t('diag.modelEnvironment'), aiderSummary.modelEnvironment ? t('diag.present') : t('diag.absent'), false),
  ].join('') : '';
  const terminalRows = terminal ? [
    diagnosticRow('Windows Terminal', terminal.windowsTerminal || t('diag.absent'), true),
    diagnosticRow('cmd.exe', terminal.cmdFallback || t('diag.absent'), true),
  ].join('') : '';
  const doctorRows = doctorSummary ? [
    diagnosticRow(t('diag.doctorStatus'), doctorSummary.status, false),
    diagnosticRow(t('diag.providerRoute'), doctorSummary.provider, false),
    diagnosticRow(t('diag.modelRoute'), doctorSummary.model, true),
    diagnosticRow(t('diag.apiKeySource'), doctorSummary.apiKeySource, false),
    diagnosticRow(t('diag.payloadMode'), doctorSummary.requestPayloadMode, false),
    diagnosticRow(t('diag.sessionRecovery'), doctorSummary.sessionRecovery, false),
  ].join('') : '';
  el.innerHTML = `
    <div class="diag-head">
      <span class="diag-provider">${escapeHtml(meta.icon)} ${escapeHtml(meta.label)}</span>
      <span class="diag-state ${ready ? 'ok' : 'warn'}">${escapeHtml(statusLabel)}</span>
      <button type="button" class="diag-close" data-diag-action="close" title="${escapeHtml(t('diag.close'))}">✕</button>
    </div>
    ${issueHtml}
    ${warningHtml}
    <div class="diag-grid">
      ${diagnosticRow(t('diag.executable'), result.executable || t('diag.absent'), true)}
      ${diagnosticRow(t('diag.installKind'), result.executableKind, false)}
      ${diagnosticRow(t('diag.version'), version || t('diag.notRun'), true)}
      ${diagnosticRow(t('diag.companion'), result.companion, true)}
      ${diagnosticRow(t('diag.companionVersion'), companionVersion, true)}
      ${diagnosticRow(t('diag.cwd'), result.workingDirectory, true)}
      ${diagnosticRow(t('diag.doctorTarget'), result.doctorTarget, true)}
      ${diagnosticRow(t('diag.doctorSurface'), result.doctorSurface, false)}
      ${diagnosticRow(t('diag.doctorAttempts'), Array.isArray(result.doctorAttempts) ? result.doctorAttempts.length : '', false)}
      ${diagnosticRow(t('diag.authStatus'), probeStatus(result.authProbe), false)}
      ${diagnosticRow('PATH', `${Number(result.pathEntryCount) || 0} ${t('diag.entries')}`, false)}
      ${doctorRows}
      ${configRows}
      ${terminalRows}
      ${aiderRows}
    </div>
    ${auth ? `<details class="diag-details"><summary>${escapeHtml(t('diag.authOutput'))}</summary><pre>${escapeHtml(auth)}</pre></details>` : ''}
    ${doctor ? `<details class="diag-details"><summary>${escapeHtml(t('diag.doctor'))}</summary><pre>${escapeHtml(doctor)}</pre></details>` : ''}
    <div class="diag-actions">
      <button type="button" data-diag-action="rerun" data-provider="${escapeHtml(id)}">${escapeHtml(t('diag.rerun'))}</button>
      <button type="button" data-diag-action="launch" data-provider="${escapeHtml(id)}">${escapeHtml(t('diag.launch'))}</button>
    </div>`;
  el.classList.remove('hidden');
  if (summary) {
    summary.textContent = `${meta.icon} ${statusLabel}`;
    summary.className = `provider-diag-summary ${ready ? 'ok' : 'warn'}`;
  }
}

function renderProviderDiagnosticError(provider, error) {
  renderProviderDiagnostic({
    provider,
    ready: false,
    issues: [String(error && (error.message || error) || t('diag.failed'))],
  });
}

async function diagnoseProvider(provider) {
  if (!provider || providerDiagnosticBusy) return;
  providerDiagnosticBusy = provider;
  renderProviders();
  const el = $('provider-diagnostic');
  if (el) {
    el.classList.remove('hidden');
    el.innerHTML = `<div class="diag-loading">${escapeHtml(t('diag.running'))}</div>`;
  }
  try {
    renderProviderDiagnostic(await window.pet.diagnoseAgent(provider));
  } catch (error) {
    renderProviderDiagnosticError(provider, error);
  } finally {
    providerDiagnosticBusy = '';
    renderProviders();
  }
}

function renderProviders() {
  const el = $('provider-list');
  if (!el || !config.providers) return;
  const { active = [], all = [], statuses = {}, cwHooksInstalled = false } = config.providers;
  const activeSet = new Set(active);
  const activeCount = activeSet.size;
  el.innerHTML = all.map((id) => {
    const m = PROVIDER_META[id] || { icon: '❓', label: id };
    const on = activeSet.has(id);
    // R22 (2026-07-30): removed locked logic — users can now uncheck all
    // providers (empty selection is valid; no provider hooks installed).
    const locked = false;
    const runtime = statuses[id] || {};
    const installed = runtime.installed != null ? !!runtime.installed : (id === 'codewhale' && cwHooksInstalled);
    const failed = runtime.state === 'error';
    const cls = failed ? 'warn' : installed ? 'ok' : 'off';
    const label = failed ? t('provider.installFailed') : installed ? t('provider.registered') : on ? t('provider.pending') : t('provider.disabled');
    const detail = runtime.message || (on ? t('provider.waitingSync') : t('provider.notEnabled'));
    const mode = runtime.permissionMode ? ` · ${t('provider.permission')}: ${runtime.permissionMode}` : '';
    const warning = runtime.capabilities && runtime.capabilities.bypassWarning
      ? ` · ⚠ ${runtime.capabilities.bypassWarning}` : '';
    const status = `<span class="prov-status ${cls}" title="${escapeHtml(detail + mode + warning)}">${escapeHtml(label)}${warning ? ' ⚠' : ''}</span>`;
    const busy = providerDiagnosticBusy === id;
    return '<div class="prov-item' + (on ? ' active' : '') + (locked ? ' locked' : '') + '">'
      + '<label class="prov-toggle">'
      + '<input type="checkbox" ' + (on ? 'checked' : '') + ' ' + (locked ? 'disabled' : '') + ' data-id="' + escapeHtml(id) + '">'
      + '<span class="prov-icon">' + escapeHtml(m.icon) + '</span>'
      + '<span class="prov-label">' + escapeHtml(m.label) + '</span>'
      + status
      + '</label>'
      + '<button type="button" class="prov-diagnose" data-provider="' + escapeHtml(id) + '" ' + (busy ? 'disabled' : '') + '>'
      + escapeHtml(busy ? t('diag.runningShort') : t('diag.action')) + '</button>'
      + '</div>';
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
  applyLanguage(config.lang);
  const language = $('language');
  if (language) language.addEventListener('change', (event) => {
    const lang = String(event.target.value || 'zh');
    applyLanguage(lang);
    window.pet.setLanguage(lang);
    // R25 (2026-07-30): re-render ALL sections, not just sessList.
    // The old code only called renderSessList, leaving 8 other sections
    // (providerCost/byModel/todos/chart/cal/diagnostics/ops/bg) showing
    // mixed-language content for ~2s until the next stats push.
    if (lastStats) render(lastStats);
    else if (latestSessions.length) renderSessList(latestSessions);
  });
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
  // R19: attention filter + archive toggle buttons.
  const sessAttention = $('sess-attention');
  if (sessAttention) sessAttention.addEventListener('click', () => {
    sessionAttentionOnly = !sessionAttentionOnly;
    sessAttention.classList.toggle('active', sessionAttentionOnly);
    renderSessList(latestSessions);
  });
  const sessShowArchived = $('sess-show-archived');
  if (sessShowArchived) sessShowArchived.addEventListener('click', () => {
    sessionShowArchived = !sessionShowArchived;
    sessShowArchived.classList.toggle('active', sessionShowArchived);
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
    const { active } = config.providers || { active: [] }; // R22: default empty (was ['claude'])
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
  $('provider-list').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-provider]');
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    diagnoseProvider(button.dataset.provider);
  });
  $('provider-diagnostic').addEventListener('click', async (e) => {
    const button = e.target.closest('button[data-diag-action]');
    if (!button) return;
    const action = button.dataset.diagAction;
    const provider = button.dataset.provider || (latestProviderDiagnostic && latestProviderDiagnostic.provider);
    if (action === 'close') {
      $('provider-diagnostic').classList.add('hidden');
      $('provider-diag-summary').textContent = '';
      latestProviderDiagnostic = null;
    } else if (action === 'rerun') {
      diagnoseProvider(provider);
    } else if (action === 'launch') {
      button.disabled = true;
      try {
        await window.pet.launchAgentChecked(provider);
        button.textContent = t('diag.launched');
      } catch (error) {
        renderProviderDiagnosticError(provider, error);
      }
    }
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
  // R19: sync pinned/archived session prefs from config so a config push
  // from another source (tray, another panel instance) is reflected.
  sessionPinned = Array.isArray(cfg.pinnedSessions) ? cfg.pinnedSessions.slice(0, 200) : [];
  sessionArchived = Array.isArray(cfg.archivedSessions) ? cfg.archivedSessions.slice(0, 200) : [];
  applyLanguage(config.lang);
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

// R16 (2026-07-30): metric tab switching — toggles between Token and Cost
// for the 24h chart + calendar. Re-renders from lastStats so the switch is
// instant without waiting for a new stats push.
document.querySelectorAll('.metric-tabs .mt').forEach((b) =>
  b.addEventListener('click', () => {
    usageMetric = b.dataset.metric === 'cost' ? 'cost' : 'tokens';
    document.querySelectorAll('.metric-tabs .mt').forEach((x) => x.classList.toggle('active', x === b));
    if (lastStats) {
      renderChart(lastStats.hourly || [], lastStats.hourlyTok || []);
      renderCal(lastStats.daily || {});
    }
  })
);

// 悬停看具体数值：24h 柱
// R16: bar now carries data-v (display string) instead of data-c (cost only).
$('chart').addEventListener('mouseover', (e) => {
  const bar = e.target.closest('.bar');
  if (bar && bar.dataset.v) $('hours-readout').innerHTML = `${bar.dataset.h}:00 · <b>${escapeHtml(bar.dataset.v)}</b>`;
});
$('chart').addEventListener('mouseleave', () => { $('hours-readout').innerHTML = hoursSummary; });

// 悬停看具体数值：日历格子
// AUDIT-FIX (2026-07-30): was hardcoded Chinese; now uses the existing
// panel.calReadout i18n template (which already exists in zh/en/ja).
$('cal').addEventListener('mouseover', (e) => {
  const cell = e.target.closest('.cal-cell');
  if (cell) $('cal-readout').innerHTML = t('panel.calReadout', {
    k: cell.dataset.k, c: cell.dataset.c, t: cell.dataset.t, m: cell.dataset.m,
  });
});
$('cal').addEventListener('mouseleave', () => { $('cal-readout').innerHTML = calSummary; });

// 初始化
(async () => {
  const cfg = await window.pet.getConfig();
  if (cfg) { config = { ...config, ...cfg }; applyLanguage(config.lang); applyConfigUI(); }
  const s = await window.pet.getStats();
  if (s) render(s);
})();
