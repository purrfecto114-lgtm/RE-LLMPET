'use strict';
// panel-export.js — Usage data export feature (ROADMAP 0.6.1)
// Self-contained module: keeps its own stats cache via the tauri-bridge,
// attaches a click handler to #export-csv / #export-json buttons.
// Does NOT depend on panel.js internals; only uses window.pet bridge.
window.OctopusExport = (() => {
  let cachedStats = null;
  let cachedPriceInfo = null;
  let cachedSessions = null;

  // Keep a local copy of the latest stats/price/sessions for export.
  // These are updated by the same events panel.js listens to, but we
  // maintain an independent reference so export works even if panel.js
  // is mid-render or its revision gate rejected a snapshot.
  function init() {
    if (typeof window.pet !== 'object' || !window.pet) return;
    if (typeof window.pet.onPanelStats === 'function') {
      window.pet.onPanelStats((s) => { cachedStats = s; });
    }
    if (typeof window.pet.onPrice === 'function') {
      window.pet.onPrice((p) => { cachedPriceInfo = p; });
    }
    if (typeof window.pet.onStats === 'function') {
      window.pet.onStats((s) => {
        if (s && s.sessions) cachedSessions = s.sessions;
      });
    }

    const btnCsv = document.getElementById('export-csv');
    const btnJson = document.getElementById('export-json');
    if (btnCsv) btnCsv.addEventListener('click', (e) => {
      e.stopPropagation();
      exportData('csv');
    });
    if (btnJson) btnJson.addEventListener('click', (e) => {
      e.stopPropagation();
      exportData('json');
    });
  }

  function buildExportObject() {
    const s = cachedStats || {};
    const today = s.today || {};
    const w5h = s.window5h || {};
    const byModel = s.byModel || {};
    const providerCost = s.providerCost || {};
    const travel = s.travel || {};
    const growth = travel.growth || {};
    const codexUsage = s.codexUsage || {};
    const combinedUsage = s.combinedUsage || {};
    const machineGrowth = s.machineGrowth || {};
    // R16: read version dynamically from package.json via the bridge config
    const config = (typeof window.pet !== 'undefined' && typeof window.pet.getConfig === 'function')
      ? null : null; // config is async; we use a cached version tag instead
    return {
      exportedAt: new Date().toISOString(),
      version: (window.OctopusVersion) || '0.5.51',
      summary: {
        today: {
          cost: today.cost || 0,
          tokens: today.tokens || 0,
          input: today.input || 0,
          output: today.output || 0,
          cacheWrite5m: today.cacheWrite5m || today.cacheCreate || 0,
          cacheWrite1h: today.cacheWrite1h || 0,
          cacheRead: today.cacheRead || 0,
          messages: today.messages || 0,
        },
        window5h: {
          cost: w5h.cost || 0,
          tokens: w5h.tokens || 0,
          resetTs: w5h.resetTs || null,
        },
        combinedUsage: {
          todayCost: combinedUsage.todayCost || 0,
          claudeTodayCost: combinedUsage.claudeTodayCost || 0,
          codexTodayCost: combinedUsage.codexTodayCost || 0,
        },
        growth: {
          leaves: growth.leaves || 0,
          stars: growth.stars || 0,
          moons: growth.moons || 0,
          days: growth.days || 0,
          totalTokens: growth.totalTokens || 0,
        },
        machineGrowth: {
          totalTokens: machineGrowth.totalTokens || 0,
          claudeTokens: machineGrowth.claudeTokens || 0,
          codexTokens: machineGrowth.codexTokens || 0,
        },
        codex: {
          todayTokens: codexUsage.todayTokens || 0,
          lifetimeTokens: codexUsage.lifetimeTokens || 0,
          todayCost: codexUsage.todayCost || 0,
          lifetimeCost: (codexUsage.lifetime && codexUsage.lifetime.cost) || 0,
        },
      },
      byModel: byModel,
      providerCost: providerCost,
      sessions: cachedSessions || (s.sessions) || [],
      priceInfo: cachedPriceInfo || null,
      postcards: (travel.postcards) || [],
    };
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  function exportData(format) {
    const data = buildExportObject();
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    if (format === 'json') {
      download(`octopus-usage-${ts}.json`, JSON.stringify(data, null, 2), 'application/json');
      return;
    }
    // CSV: flat key-value rows for easy spreadsheet import
    const rows = [];
    rows.push(['Section', 'Field', 'Value']);
    const flat = (prefix, obj) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          flat(prefix ? `${prefix}.${k}` : k, v);
        } else {
          rows.push([prefix || '', k, String(v == null ? '' : v)]);
        }
      }
    };
    flat('summary', data.summary);
    flat('combinedUsage', data.summary.combinedUsage);
    flat('growth', data.summary.growth);
    flat('machineGrowth', data.summary.machineGrowth);
    flat('codex', data.summary.codex);
    // byModel rows
    rows.push([], ['By Model', '', '']);
    if (data.byModel && typeof data.byModel === 'object') {
      for (const [model, info] of Object.entries(data.byModel)) {
        if (info && typeof info === 'object') {
          rows.push([model, 'cost', String(info.cost || 0)]);
          rows.push([model, 'tokens', String(info.tokens || 0)]);
          rows.push([model, 'input', String(info.input || 0)]);
          rows.push([model, 'output', String(info.output || 0)]);
        }
      }
    }
    // providerCost rows
    rows.push([], ['Provider Cost', '', '']);
    if (data.providerCost && typeof data.providerCost === 'object') {
      for (const [prov, cost] of Object.entries(data.providerCost)) {
        rows.push([prov, 'cost', String(cost)]);
      }
    }
    const csv = rows.map((r) => r.map((c) => {
      const s = String(c);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    }).join(',')).join('\n');
    download(`octopus-usage-${ts}.csv`, csv, 'text/csv');
  }

  // Auto-init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { init, exportData, buildExportObject };
})();
