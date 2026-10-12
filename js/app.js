/* UI wiring and charts. All math lives in projection.js. */
(function () {
  'use strict';
  const P = window.Projection;
  const $ = (id) => document.getElementById(id);

  let data = null;
  let fileName = '';
  let chartMode = null; // 'up' | 'down' once the user picks one; null = follow the recommendation
  let flowMode = null;  // 'split' | 'net' likewise for the ticket chart
  const settings = {};
  const charts = {};

  // ---------------------------------------------------------------- formatting

  const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const shortFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const dayToMs = (model, day) => P.addDays(model.start, Math.round(day));
  const fmtDay = (model, day) => (day == null ? '—' : !isFinite(day) ? 'Not within 5 years' : dateFmt.format(dayToMs(model, day)));
  const fmtNum = (v, dp = 1) => (v == null || isNaN(v) ? '—' : (Math.round(v * 10 ** dp) / 10 ** dp).toLocaleString());
  const unitShort = (u) => ({ points: 'pts', days: 'days', count: 'tickets' }[u]);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toInputDate = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const fromInputDate = (v) => {
    if (!v) return null;
    const [y, m, d] = v.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const alpha = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  };

  // ---------------------------------------------------------------- remembered settings
  // Modelling preferences (not file-specific filters) survive reloads in this browser.

  const STORE_KEY = 'jira-projection:settings';
  const PERSIST = ['hoursPerDay', 'daysUncertainty', 'fillMissing', 'fitWeeks', 'polyDegree', 'rollWeeks', 'mcUncertainty', 'mcScopeGrowth', 'flowBucket'];
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
  }
  function savePrefs() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(PERSIST.filter((k) => k in settings).map((k) => [k, settings[k]]))));
    } catch (e) { /* storage unavailable: preferences just won't persist */ }
  }

  // ---------------------------------------------------------------- loading

  function loadText(text, name) {
    try {
      data = P.parseIssues(text);
    } catch (e) {
      $('load-error').textContent = e.message;
      $('load-error').hidden = false;
      return;
    }
    fileName = name;
    chartMode = null;
    flowMode = null;
    $('load-error').hidden = true;
    $('drop-zone').classList.add('compact');
    initControls();
    $('report').hidden = false;
    render();
  }
  window.loadCsvText = loadText; // handy for debugging from the console

  function readFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => loadText(reader.result, file.name);
    reader.readAsText(file);
  }

  $('file-input').addEventListener('change', (e) => readFile(e.target.files[0]));
  $('sample-button').addEventListener('click', () => loadText(window.generateSampleCsv(), 'Sample data (made up)'));
  const dz = $('drop-zone');
  ['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('dragging'); }));
  document.addEventListener('drop', (e) => readFile(e.dataTransfer.files[0]));

  // ---------------------------------------------------------------- controls

  function initControls() {
    Object.keys(settings).forEach((k) => delete settings[k]);

    const vSel = $('ctl-version');
    vSel.innerHTML = '<option value="">All issues in file</option>' +
      data.versions.map((v) => `<option value="${esc(v.name)}">${esc(v.name)} (${v.count})</option>`).join('');
    settings.version = data.versions.length ? data.versions[0].name : null;
    vSel.value = settings.version || '';

    const half = data.issues.length / 2;
    settings.unit = data.counts.storyPoints >= half ? 'points' : data.counts.origEst > 0 ? 'days' : data.counts.storyPoints ? 'points' : 'count';
    $('ctl-unit').value = settings.unit;
    for (const opt of $('ctl-unit').options) {
      const n = opt.value === 'points' ? data.counts.storyPoints : opt.value === 'days' ? data.counts.origEst : data.issues.length;
      opt.textContent = opt.textContent.replace(/ \(.*\)$/, '') + (opt.value === 'count' ? '' : ` (${n} set)`);
    }

    settings.excludedTypes = data.types.map((t) => t.name).filter((n) => /^epic$/i.test(n));
    $('ctl-types').innerHTML = data.types.map((t) =>
      `<label><input type="checkbox" value="${esc(t.name)}" ${settings.excludedTypes.includes(t.name) ? '' : 'checked'}>${esc(t.name)} <span class="count">${t.count}</span></label>`).join('');

    settings.deliveredResolutions = data.resolutions.map((r) => r.name).filter((n) => P.DELIVERED_RESOLUTIONS.includes(n.toLowerCase()));
    $('ctl-resolutions').innerHTML = data.resolutions.length
      ? data.resolutions.map((r) =>
        `<label><input type="checkbox" value="${esc(r.name)}" ${settings.deliveredResolutions.includes(r.name) ? 'checked' : ''}>${esc(r.name)} <span class="count">${r.count}</span></label>`).join('')
      : '<span class="hint">No resolved tickets.</span>';

    $('ctl-start').value = '';
    $('ctl-asof').value = '';

    const d = P.DEFAULT_SETTINGS;
    const prefs = loadPrefs();
    for (const k of PERSIST) settings[k] = k in prefs ? prefs[k] : d[k];
    if (settings.flowBucket !== 2) settings.flowBucket = 1;
    $('flow-bucket').value = String(settings.flowBucket);
    $('ctl-hpd').value = settings.hoursPerDay;
    $('ctl-unc').value = Math.round(settings.daysUncertainty * 100);
    $('ctl-fill').value = settings.fillMissing;
    $('ctl-fit').value = String(settings.fitWeeks);
    $('ctl-degree').value = String(settings.polyDegree);
    $('ctl-roll').value = String(settings.rollWeeks);
    $('ctl-mc-unc').checked = settings.mcUncertainty;
    $('ctl-mc-scope').checked = settings.mcScopeGrowth;
    syncUnitVisibility();
  }

  function syncUnitVisibility() {
    document.querySelectorAll('[data-for-unit]').forEach((el) => {
      el.hidden = !el.dataset.forUnit.split(' ').includes(settings.unit);
    });
  }

  $('controls').addEventListener('change', (e) => {
    const t = e.target;
    switch (t.id) {
      case 'ctl-version': settings.version = t.value || null; break;
      case 'ctl-unit': settings.unit = t.value; syncUnitVisibility(); break;
      case 'ctl-hpd': settings.hoursPerDay = Math.max(1, +t.value || 8); break;
      case 'ctl-unc': settings.daysUncertainty = Math.max(0, +t.value || 0) / 100; break;
      case 'ctl-fill': settings.fillMissing = t.value; break;
      case 'ctl-start': settings.start = fromInputDate(t.value); break;
      case 'ctl-asof': settings.asOf = fromInputDate(t.value); break;
      case 'ctl-fit': settings.fitWeeks = +t.value; break;
      case 'ctl-degree': settings.polyDegree = +t.value; break;
      case 'ctl-roll': settings.rollWeeks = +t.value; break;
      case 'ctl-mc-unc': settings.mcUncertainty = t.checked; break;
      case 'ctl-mc-scope': settings.mcScopeGrowth = t.checked; break;
      default:
        if (t.closest('#ctl-types')) {
          settings.excludedTypes = [...document.querySelectorAll('#ctl-types input:not(:checked)')].map((i) => i.value);
        } else if (t.closest('#ctl-resolutions')) {
          settings.deliveredResolutions = [...document.querySelectorAll('#ctl-resolutions input:checked')].map((i) => i.value);
        }
    }
    savePrefs();
    render();
  });

  // ---------------------------------------------------------------- render

  let current = null;

  function render() {
    if (!data) return;
    const model = P.buildModel(data, settings);
    current = model;
    const cols = data.columns;
    $('file-line').textContent = `${fileName} · ${data.issues.length} issues · ` +
      (cols.hasResolved ? 'has Resolved dates' : 'no Resolved column') + ' · ' +
      [cols.hasStoryPoints && 'Story Points', cols.hasOrigEst && 'Original estimate'].filter(Boolean).join(' & ') + ' columns found';

    const warnings = [...model.warnings];
    if (!model.empty && model.unit === 'days' && !data.counts.origEst) warnings.unshift('No ticket has an Original estimate, so every estimate is filled in. Switch "Estimate by" to Story points or Ticket count.');
    if (!model.empty && model.unit === 'points' && !data.counts.storyPoints) warnings.unshift('No ticket has Story Points. Switch "Estimate by" to Original estimate or Ticket count.');
    if (!model.empty && settings.asOf && model.asOf < P.dayStart(data.latestDate)) warnings.push(`Backtest: showing what the data looked like on ${dateFmt.format(model.asOf)}. Tickets resolved after that date count as open.`);
    const mcU = !model.empty && model.projections && model.projections.monteCarlo;
    if (mcU && mcU.unfinishedShare > 0.05) warnings.push(`${fmtNum(mcU.unfinishedShare * 100, 0)}% of Monte Carlo runs never finished within 5 years, because scope was added faster than it was completed in those weeks.`);
    if (!model.empty && !model.finished && model.totals.weeksInWindow < 3) warnings.push(`Only ${model.totals.weeksInWindow} full week(s) of history in the fit window, so treat these projections as rough.`);
    $('warnings').innerHTML = warnings.map((w) => `<li>${esc(w)}</li>`).join('');

    if (model.empty) {
      ['headline', 'tiles', 'projection-table', 'weekly-table', 'assignee-table', 'remaining-table'].forEach((id) => ($(id).innerHTML = ''));
      Object.values(charts).forEach((c) => c.destroy());
      return;
    }
    if (!settings.start) $('ctl-start').value = toInputDate(model.start);
    if (!settings.asOf) $('ctl-asof').value = toInputDate(model.asOf);

    renderHeadline(model);
    renderTiles(model);
    renderProjectionTable(model);
    renderTrend(model);
    renderVelocity(model);
    renderTickets(model);
    renderMonteCarlo(model);
    renderWeekly(model);
    renderAssignees(model);
    renderRemaining(model);
  }

  function renderHeadline(model) {
    const p = model.projections;
    if (model.finished) {
      $('headline').innerHTML = '<div class="big">All work in this release is complete.</div>';
      return;
    }
    const mc = p.monteCarlo;
    const main = mc && isFinite(mc.p50) ? mc.p50 : p.velocity.day;
    const conf = mc ? ` <span class="subtle">· 85% likely by ${fmtDay(model, mc.p85)}</span>` : '';
    $('headline').innerHTML =
      `<div class="big">Likely finish: ${fmtDay(model, main)}${conf}</div>` +
      `<div class="range">Range from the min/max bounds: ${fmtDay(model, p.optimistic.day)} to ${fmtDay(model, p.pessimistic.day)}. ` +
      `As of ${dateFmt.format(model.asOf)}.</div>`;
  }

  function renderTiles(model) {
    const t = model.totals, u = unitShort(model.unit);
    const pct = t.scope ? (t.completed / t.scope) * 100 : 0;
    const tiles = [
      ['Scope', `${fmtNum(t.scope)} ${u}`, `${t.tickets} tickets`],
      ['Completed', `${fmtNum(t.completed)} ${u}`, `${fmtNum(pct, 0)}% · ${t.ticketsDone} tickets`],
      ['Remaining', `${fmtNum(t.remaining)} ${u}`, `${t.ticketsOpen} open tickets`],
      ['Avg velocity', `${fmtNum(t.avgVelocity)} ${u}/wk`, `over ${t.weeksInWindow} full weeks`],
      ['Tickets completed', `${fmtNum(t.avgTickets)}/wk`, 'same window'],
      ['Removed from scope', `${t.ticketsDiscarded}`, 'non-delivered resolutions'],
    ];
    $('tiles').innerHTML = tiles.map(([l, v, s]) =>
      `<div class="tile"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`).join('');
  }

  function renderProjectionTable(model) {
    const p = model.projections, f = model.fits, u = unitShort(model.unit);
    const c = palette();
    if (model.finished) {
      $('projection-table').innerHTML = '<tr><td>Everything in scope is resolved.</td></tr>';
      return;
    }
    const sw = (color, dashed) => `<span class="key-swatch${dashed ? ' dashed' : ''}" style="background:${color};color:${color}"></span>`;
    const rows = [
      [sw(c.s2, true) + 'Linear regression', p.linear.day, p.linear.note || (f.linear ? `R² ${fmtNum(f.linear.r2, 2)} · ${fmtNum(f.linear.slope * 7)} ${u}/wk trend` : '')],
      [sw(c.scope, true) + 'Linear + scope growth', p.scopeGrowth && p.scopeGrowth.day, (p.scopeGrowth && p.scopeGrowth.note) ||
        (f.scope ? `Scope growing ${fmtNum(f.scope.slope * 7)} ${u}/wk → ~${fmtNum(p.scopeGrowth.scopeAt, 0)} ${u} at finish` : '')],
      [sw(c.s3, true) + `Polynomial regression (degree ${model.settings.polyDegree})`, p.poly.day, p.poly.note || (f.poly ? `R² ${fmtNum(f.poly.r2, 3)}` : '')],
      ['Average velocity', p.velocity.day, p.velocity.note || `${fmtNum(model.totals.remaining)} ${u} ÷ ${fmtNum(model.totals.avgVelocity)} ${u}/wk`],
      [sw(c.s4) + 'Optimistic bound', p.optimistic.day, `${fmtNum(p.optimistic.amount)} ${u} at ${fmtNum(p.optimistic.velocity)} ${u}/wk (fastest)`],
      [sw(c.s4) + 'Pessimistic bound', p.pessimistic.day, `${fmtNum(p.pessimistic.amount)} ${u} at ${fmtNum(p.pessimistic.velocity)} ${u}/wk (slowest)`],
      ['Ticket completion rate', p.tickets.day, `${p.tickets.left} tickets ÷ ${fmtNum(p.tickets.perWeek)} tickets/wk`],
      ['Assignee bottleneck', p.bottleneck.day, [p.bottleneck.name && `${p.bottleneck.name} finishes last`, p.bottleneck.note].filter(Boolean).join('. ')],
    ];
    if (p.monteCarlo) {
      const opts = [model.settings.mcUncertainty && model.unit !== 'count' && 'randomised sizes', model.settings.mcScopeGrowth && 'with scope growth'].filter(Boolean);
      const how = opts.length ? ` (${opts.join(', ')})` : '';
      rows.push(['Monte Carlo P50', p.monteCarlo.p50, `50% of simulations finished by here${how}`]);
      rows.push(['Monte Carlo P85', p.monteCarlo.p85, `85% of simulations finished by here${how}`]);
      rows.push(['Monte Carlo P95', p.monteCarlo.p95, `95% of simulations finished by here${how}`]);
    } else {
      rows.push(['Monte Carlo', null, 'Needs at least one full week with completed work']);
    }
    $('projection-table').innerHTML =
      '<thead><tr><th>Method</th><th>Projected finish</th><th class="num">Days from as-of</th><th>Details</th></tr></thead><tbody>' +
      rows.map(([name, day, note]) =>
        `<tr><td>${name}</td><td>${fmtDay(model, day)}</td><td class="num">${day == null || !isFinite(day) ? '—' : Math.round(day - model.T)}</td><td class="note">${esc(note || '')}</td></tr>`).join('') +
      '</tbody>';
  }

  // ---------------------------------------------------------------- charts

  function palette() {
    return {
      s1: css('--series-1'), s2: css('--series-2'), s3: css('--series-3'), s4: css('--series-4'),
      scope: css('--scope'), text: css('--text-secondary'), muted: css('--text-muted'),
      grid: css('--grid'), axis: css('--axis'), surface: css('--surface'),
    };
  }

  // Draws labelled vertical rules, e.g. the as-of date or Monte Carlo percentiles.
  const vlinePlugin = {
    id: 'vlines',
    afterDatasetsDraw(chart, _args, opts) {
      const { ctx, chartArea, scales } = chart;
      for (const l of opts.lines || []) {
        if (!isFinite(l.x)) continue;
        const x = scales.x.getPixelForValue(l.x);
        if (x < chartArea.left || x > chartArea.right) continue;
        ctx.save();
        ctx.strokeStyle = l.color;
        ctx.lineWidth = 1;
        if (l.dash) ctx.setLineDash(l.dash);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.font = '12px system-ui, -apple-system, sans-serif';
        ctx.setLineDash([]);
        const right = x > chartArea.right - 80;
        const w = ctx.measureText(l.label).width;
        const tx = right ? x - 4 - w : x + 4;
        const ty = chartArea.top + 12 + (l.row || 0) * 16;
        // Surface-coloured backing so labels stay readable over the data.
        if (!exporting.transparent) {
          ctx.fillStyle = css('--surface');
          ctx.fillRect(tx - 2, ty - 11, w + 4, 15);
        }
        ctx.fillStyle = opts.textColor;
        ctx.fillText(l.label, tx, ty);
        ctx.restore();
      }
    },
  };

  function baseOptions(c) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top', align: 'start',
          labels: {
            color: c.text, boxWidth: 16, boxHeight: 3, padding: 14,
            filter: (l) => !l.text.startsWith('_'),
            // Swatch = the line/bar colour (area fills are only a faint wash).
            generateLabels: (chart) => Chart.defaults.plugins.legend.labels.generateLabels(chart).map((l) => {
              const ds = chart.data.datasets[l.datasetIndex];
              const color = ds.type === 'bar' || chart.config.type === 'bar' || ds.showLine === false ? (Array.isArray(ds.backgroundColor) ? ds.backgroundColor[0] : ds.backgroundColor) : ds.borderColor;
              return Object.assign(l, { fillStyle: color, strokeStyle: color, lineWidth: 0, lineDash: [] });
            }),
          },
        },
        tooltip: { filter: (i) => i.raw != null && !i.dataset.label.startsWith('_') },
        vlines: { lines: [], textColor: c.text },
      },
      scales: {
        x: { grid: { color: c.grid }, border: { color: c.axis }, ticks: { color: c.muted } },
        y: { grid: { color: c.grid }, border: { color: c.axis }, ticks: { color: c.muted }, beginAtZero: true },
      },
    };
  }

  // Export state: while a PNG is being produced, charts can skip the background and
  // render at a higher pixel ratio.
  const exporting = { transparent: false, pixelRatio: null };

  // Paints the card surface behind the chart so downloaded PNGs aren't transparent.
  const backgroundPlugin = {
    id: 'surface',
    beforeDraw(chart) {
      if (exporting.transparent) return;
      const { ctx, width, height } = chart;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = css('--surface');
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    },
  };

  function draw(id, config) {
    if (charts[id]) charts[id].destroy();
    if (exporting.pixelRatio) config.options.devicePixelRatio = exporting.pixelRatio;
    charts[id] = new Chart($(id), Object.assign({ plugins: [vlinePlugin, backgroundPlugin] }, config));
  }

  // x axis in day indexes from the (Monday) release start, so ticks land on Mondays.
  function dayAxis(model, c, min, max) {
    const span = max - min;
    const step = span <= 70 ? 7 : span <= 200 ? 14 : 28;
    return {
      type: 'linear', min, max,
      // Ticks on multiples of the step from the start Monday, whatever the axis bounds are.
      afterBuildTicks: (axis) => {
        const ticks = [];
        for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push({ value: v });
        axis.ticks = ticks;
      },
      grid: { color: c.grid }, border: { color: c.axis },
      ticks: { color: c.muted, stepSize: step, callback: (v) => shortFmt.format(dayToMs(model, v)), maxRotation: 0, autoSkipPadding: 12 },
    };
  }

  // Burn-up / burn-down: the recommendation comes from how much scope moved during the release.
  function renderTrend(model) {
    const rec = model.scopeChange.recommended;
    const mode = chartMode || rec;
    const sc = model.scopeChange, u = unitShort(model.unit);
    const pct = fmtNum(sc.churnShare * 100, 0);
    const moved = [sc.added > 0 && `${fmtNum(sc.added)} ${u} added`, sc.removed > 0 && `${fmtNum(sc.removed)} ${u} removed`].filter(Boolean).join(' and ');
    const why = rec === 'up'
      ? `${pct}% of the scope changed after the release started (${moved}), so a burn-up keeps new work separate from progress.`
      : `Scope barely changed after the release started (${pct}%${moved ? `: ${moved}` : ''}), so a burn-down shows remaining work most directly.`;
    $('trend-why').textContent = (chartMode && chartMode !== rec ? `Suggested: ${rec === 'up' ? 'burn-up' : 'burn-down'}. ` : 'Picked automatically. ') + why;
    setToggle('trend-toggle', mode);
    $('trend-title').textContent = mode === 'up' ? 'Burn-up with projections' : 'Burn-down with projections';
    $('chart-burnup').setAttribute('aria-label', mode === 'up'
      ? 'Burn-up chart of scope and completed work with projected finish lines'
      : 'Burn-down chart of remaining work with projected finish lines');
    if (mode === 'up') renderBurnup(model); else renderBurndown(model);
  }

  function setToggle(id, mode) {
    $(id).querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  }
  function onToggle(id, fn) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mode]');
      if (b && current && !current.empty) fn(b.dataset.mode);
    });
  }
  onToggle('trend-toggle', (mode) => { chartMode = mode; renderTrend(current); });
  onToggle('flow-toggle', (mode) => { flowMode = mode; renderTickets(current); });
  $('flow-bucket').addEventListener('change', (e) => {
    settings.flowBucket = +e.target.value;
    savePrefs();
    if (current && !current.empty) renderTickets(current);
  });

  // Groups consecutive weeks (counted from the release start) into periods of n weeks.
  function periodsOf(weeks, n) {
    const out = [];
    for (let i = 0; i < weeks.length; i += n) {
      const group = weeks.slice(i, i + n);
      out.push({
        start: group[0].start,
        end: P.addDays(group[0].start, n * 7 - 1),
        complete: group.length === n && group.every((w) => w.complete),
        ticketsDone: group.reduce((a, w) => a + w.ticketsDone, 0),
        ticketsCreated: group.reduce((a, w) => a + w.ticketsCreated, 0),
      });
    }
    return out;
  }

  function trendKit(model) {
    const c = palette();
    const days = Array.from({ length: model.horizon + 1 }, (_, d) => d);
    return {
      c,
      pts: (fn) => days.map((d) => ({ x: d, y: fn(d) })),
      endDot: (lastDay) => (ctx) => (ctx.raw && ctx.raw.x === lastDay ? 4 : 0),
      until: (day) => (day == null ? model.horizon : Math.min(model.horizon, Math.ceil(day))),
      line: (label, color, data, extra) => Object.assign({
        label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0,
        pointHoverRadius: 4, pointBorderColor: c.surface, pointBorderWidth: 2, tension: 0, spanGaps: false,
      }, extra),
    };
  }

  function trendOptions(model, c, yLabel) {
    const u = unitShort(model.unit);
    const opts = baseOptions(c);
    opts.scales.x = dayAxis(model, c, 0, model.horizon);
    opts.scales.y.title = { display: true, text: yLabel, color: c.muted };
    opts.scales.y.min = 0;
    opts.plugins.tooltip.callbacks = {
      title: (items) => items.length ? dateFmt.format(dayToMs(model, items[0].raw.x)) : '',
      label: (i) => i.raw.note || `${i.dataset.label}: ${fmtNum(i.raw.y)} ${u}`,
    };
    opts.plugins.vlines.lines = [{ x: model.T, label: 'As of', color: c.muted, dash: [3, 3] }];
    return opts;
  }

  function renderBurndown(model) {
    const { c, pts, endDot, until, line } = trendKit(model);
    const { T, series, fits, projections: p, totals } = model;
    const u = unitShort(model.unit);
    const remainingAt = (d) => series.scopeCum[d] - series.doneCum[d];

    const datasets = [
      line('Remaining', c.s1, pts((d) => (d <= T ? remainingAt(d) : null)), { fill: 'origin', backgroundColor: alpha(c.s1, 0.1) }),
    ];
    // Mark days when work was added, so upward steps read as new scope rather than lost progress.
    // Same daily grid as the other datasets so the shared (index-mode) tooltip lines up.
    const added = (d) => d >= 1 && d <= T && series.scopeNPerDay[d] > 0;
    const adds = pts((d) => (added(d) ? remainingAt(d) : null)).map((pt) => (pt.y == null ? pt : Object.assign(pt, {
      note: `Scope added: +${fmtNum(series.scopePerDay[pt.x])} ${u} (${series.scopeNPerDay[pt.x]} ticket${series.scopeNPerDay[pt.x] === 1 ? '' : 's'})`,
    })));
    if (adds.some((pt) => pt.y != null)) {
      datasets.push({ label: 'Scope added', data: adds, showLine: false, pointStyle: 'triangle', pointRadius: 6, pointHoverRadius: 7, borderColor: c.surface, borderWidth: 2, backgroundColor: c.scope });
    }
    // Projections run forward from the as-of date down to zero remaining.
    if (!model.finished) {
      const fwd = (fn, endDay) => pts((d) => (d >= T && d <= endDay ? Math.max(0, fn(d)) : null));
      const gain = (fit, d) => fit.at(d) - fit.at(T);
      const rem = totals.remaining;
      if (fits.scope && p.scopeGrowth && fits.linear) {
        const end = until(p.scopeGrowth.day);
        datasets.push(line('Linear + scope growth', c.scope, fwd((d) => rem + gain(fits.scope, d) - gain(fits.linear, d), end), { borderDash: [6, 4], borderWidth: 1.5, pointRadius: endDot(end) }));
      }
      if (fits.linear) {
        const end = until(p.linear.day);
        datasets.push(line('Linear fit', c.s2, fwd((d) => rem - gain(fits.linear, d), end), { borderDash: [6, 4], pointRadius: endDot(end) }));
      }
      if (fits.poly) {
        const end = until(p.poly.day ?? p.poly.stopDay);
        datasets.push(line(`Polynomial fit (deg ${model.settings.polyDegree})`, c.s3, fwd((d) => rem - gain(fits.poly, d), end), { borderDash: [2, 3], pointRadius: endDot(end) }));
      }
      if (p.optimistic.day != null && p.pessimistic.day != null) {
        const end = until(p.pessimistic.day);
        const cone = (proj) => fwd((d) => proj.amount - (proj.velocity / 7) * (d - T), end);
        datasets.push(line('Optimistic', c.s4, cone(p.optimistic), { borderWidth: 1.5, pointRadius: endDot(until(p.optimistic.day)) }));
        datasets.push(line('Pessimistic', c.s4, cone(p.pessimistic), { borderWidth: 1.5, fill: '-1', backgroundColor: alpha(c.s4, 0.12), pointRadius: endDot(end) }));
      }
    }

    draw('chart-burnup', { type: 'line', data: { datasets }, options: trendOptions(model, c, `${u} remaining`) });
    const fitDesc = model.settings.fitWeeks ? `the last ${model.settings.fitWeeks} weeks` : 'all weeks since the start';
    $('burnup-sub').textContent = `Remaining ${u} over time, with projections from the as-of date to zero. Regression lines are fitted to ${fitDesc}. ` +
      'The shaded cone starts from the optimistic and pessimistic remaining work.';
  }

  function renderBurnup(model) {
    const { c, pts, endDot, until, line } = trendKit(model);
    const { T, series, fits, projections: p, totals } = model;
    const u = unitShort(model.unit);

    const datasets = [
      line('Scope', c.scope, pts((d) => (d <= T ? series.scopeCum[d] : null))),
      line('Completed', c.s1, pts((d) => (d <= T ? series.doneCum[d] : null)), { fill: 'origin', backgroundColor: alpha(c.s1, 0.1) }),
    ];
    if (!model.finished) {
      // Faint fitted curves over the fit window show how well each regression matches history;
      // the projections then continue from the actual values on the as-of date.
      const history = (fit) => pts((d) => (d >= fits.fitStart && d <= T ? fit.at(d) : null));
      const ahead = (base, fit, endDay) => pts((d) => (d >= T && d <= endDay ? base + fit.at(d) - fit.at(T) : null));
      const faint = { borderWidth: 1, pointRadius: 0, pointHoverRadius: 0 };
      if (fits.scope && p.scopeGrowth) {
        const end = until(p.scopeGrowth.day);
        datasets.push(line('Scope trend', c.scope, ahead(totals.scope, fits.scope, end), { borderDash: [6, 4], borderWidth: 1.5 }));
      }
      if (fits.linear) {
        const end = until(p.linear.day);
        datasets.push(line('_linear history', alpha(c.s2, 0.5), history(fits.linear), faint));
        datasets.push(line('Linear fit', c.s2, ahead(totals.completed, fits.linear, end), { borderDash: [6, 4], pointRadius: endDot(end) }));
      }
      if (fits.poly) {
        const end = until(p.poly.day ?? p.poly.stopDay);
        datasets.push(line('_poly history', alpha(c.s3, 0.5), history(fits.poly), faint));
        datasets.push(line(`Polynomial fit (deg ${model.settings.polyDegree})`, c.s3, ahead(totals.completed, fits.poly, end), { borderDash: [2, 3], pointRadius: endDot(end) }));
      }
      if (p.optimistic.day != null && p.pessimistic.day != null) {
        const end = until(p.pessimistic.day);
        const cone = (proj) => pts((d) => (d >= T && d <= end ? Math.min(totals.completed + proj.amount, totals.completed + (proj.velocity / 7) * (d - T)) : null));
        datasets.push(line('Optimistic', c.s4, cone(p.optimistic), { borderWidth: 1.5, pointRadius: endDot(until(p.optimistic.day)) }));
        datasets.push(line('Pessimistic', c.s4, cone(p.pessimistic), { borderWidth: 1.5, fill: '-1', backgroundColor: alpha(c.s4, 0.12), pointRadius: endDot(end) }));
      }
    }

    draw('chart-burnup', { type: 'line', data: { datasets }, options: trendOptions(model, c, u) });

    const fitDesc = model.settings.fitWeeks ? `the last ${model.settings.fitWeeks} weeks` : 'all weeks since the start';
    $('burnup-sub').textContent = `Cumulative ${u} in scope vs completed. Regressions are fitted to ${fitDesc} (faint lines) and projected from today's actual progress. ` +
      'The shaded cone runs from the optimistic to the pessimistic bound.';
  }

  function barDataset(label, color, data, extra) {
    return Object.assign({ type: 'bar', label, data, backgroundColor: color, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom', maxBarThickness: 24, categoryPercentage: 0.7, barPercentage: 0.9 }, extra);
  }

  function renderVelocity(model) {
    const c = palette();
    const u = unitShort(model.unit);
    const labels = model.weeks.map((w) => shortFmt.format(w.start) + (w.complete ? '' : ' (partial)'));
    const rollingByWeek = model.weeks.map((w, i) => (w.complete ? model.rolling[i] : null));
    const datasets = [
      barDataset('Completed per week', model.weeks.map((w) => (w.complete ? c.s1 : alpha(c.s1, 0.4))), model.weeks.map((w) => w.velocity)),
    ];
    if (model.settings.rollWeeks > 1) {
      datasets.push({ type: 'line', label: `${model.settings.rollWeeks}-week rolling average`, data: rollingByWeek, borderColor: c.s2, backgroundColor: c.s2, borderWidth: 2, pointRadius: 4, pointBorderColor: c.surface, pointBorderWidth: 2, spanGaps: true });
    }
    datasets.push({ type: 'line', label: 'Average (fit window)', data: model.weeks.map(() => model.totals.avgVelocity), borderColor: c.muted, borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0 });
    const opts = baseOptions(c);
    opts.scales.x.grid = { display: false };
    opts.scales.y.title = { display: true, text: `${u} / week`, color: c.muted };
    opts.plugins.tooltip.callbacks = { label: (i) => `${i.dataset.label}: ${fmtNum(i.raw)} ${u}` };
    draw('chart-velocity', { data: { labels, datasets }, options: opts });
    $('velocity-sub').textContent = `${u === 'tickets' ? 'Tickets' : 'Estimated ' + u} completed in each calendar week (Mon–Sun). The faded bar is the current, unfinished week.`;
  }

  function renderTickets(model) {
    const sc = model.scopeChange;
    const rec = sc.flowRecommended;
    const mode = flowMode || rec;
    const pct = fmtNum(sc.addedTicketShare * 100, 0);
    const why = rec === 'net'
      ? `${pct}% of tickets (${sc.addedTickets}) were created after the release started, so the net view shows whether the backlog is actually shrinking.`
      : `Only ${pct}% of tickets were created after the release started, so the side-by-side view is shown.`;
    $('tickets-why').textContent = (flowMode && flowMode !== rec ? `Suggested: ${rec === 'net' ? 'net' : 'created vs completed'}. ` : 'Picked automatically. ') + why;
    setToggle('flow-toggle', mode);

    const c = palette();
    const n = settings.flowBucket === 2 ? 2 : 1;
    const per = n === 2 ? '2 weeks' : 'week';
    const weeks = periodsOf(model.weeks, n);
    const labels = weeks.map((w) => shortFmt.format(w.start) + (w.complete ? '' : ' (partial)'));
    const opts = baseOptions(c);
    opts.scales.x.grid = { display: false };
    opts.scales.y.ticks.precision = 0;
    opts.scales.y.title = { display: true, text: `tickets / ${per}`, color: c.muted };
    opts.plugins.tooltip.callbacks = {
      title: (items) => {
        if (!items.length) return '';
        const w = weeks[items[0].dataIndex];
        return `${shortFmt.format(w.start)} – ${shortFmt.format(w.end)}${w.complete ? '' : ' (in progress)'}`;
      },
    };
    let datasets;

    if (mode === 'split') {
      $('tickets-sub').textContent = `Tickets created vs completed each ${per}. If creation keeps pace with completion, the end date keeps moving.`;
      $('chart-tickets').setAttribute('aria-label', 'Tickets created and completed per week');
      datasets = [
        barDataset('Created', c.s2, weeks.map((w) => w.ticketsCreated)),
        barDataset('Completed', c.s1, weeks.map((w) => w.ticketsDone)),
      ];
    } else {
      $('tickets-sub').textContent = `Completed minus created each ${per}. Above zero the backlog shrank; below zero it grew. The line is the running total since the start.`;
      $('chart-tickets').setAttribute('aria-label', 'Net tickets completed minus created per week, with running total');
      const net = weeks.map((w) => w.ticketsDone - w.ticketsCreated);
      let run = 0;
      const running = net.map((v) => (run += v));
      const fade = (color, w) => (w.complete ? color : alpha(color, 0.4));
      // Two bar series sharing one slot (grouped: false) so the legend can name both directions.
      const pos = barDataset('Backlog shrank', weeks.map((w) => fade(c.s1, w)), net.map((v) => (v >= 0 ? v : null)), { grouped: false });
      const neg = barDataset('Backlog grew', weeks.map((w) => fade(css('--negative'), w)), net.map((v) => (v < 0 ? v : null)),
        { grouped: false, borderRadius: { bottomLeft: 4, bottomRight: 4 }, borderSkipped: 'top' });
      datasets = [pos, neg, {
        type: 'line', label: 'Running total', data: running, borderColor: c.scope, backgroundColor: c.scope,
        borderWidth: 2, pointRadius: 3, pointBorderColor: c.surface, pointBorderWidth: 2, tension: 0,
      }];
      opts.scales.y.beginAtZero = true;
      opts.scales.y.grid = { color: (ctx) => (ctx.tick.value === 0 ? c.axis : c.grid) };
      opts.plugins.tooltip.callbacks.label = (i) => {
        const w = weeks[i.dataIndex];
        if (i.dataset.type === 'line') return `Running total: ${i.raw > 0 ? '+' : ''}${i.raw}`;
        return `Net: ${i.raw > 0 ? '+' : ''}${i.raw} (${w.ticketsDone} completed − ${w.ticketsCreated} created)`;
      };
    }
    draw('chart-tickets', { data: { labels, datasets }, options: opts });
  }

  function renderMonteCarlo(model) {
    const c = palette();
    const mc = model.projections.monteCarlo;
    if (!mc) {
      if (charts['chart-mc']) charts['chart-mc'].destroy();
      $('mc-sub').textContent = 'Needs at least one full week with completed work.';
      return;
    }
    const min = model.T;
    const finite = mc.samples.filter(isFinite);
    const max = Math.min(model.T + 5 * 365, Math.ceil(finite.length ? finite[finite.length - 1] : model.T + 28) + 3);
    const data = [];
    for (let d = min; d <= max; d++) data.push({ x: d, y: mc.probabilityBy(d) * 100 });
    const opts = baseOptions(c);
    opts.scales.x = dayAxis(model, c, min, max);
    opts.scales.y.max = 100;
    opts.scales.y.ticks.callback = (v) => `${v}%`;
    opts.plugins.legend.display = false;
    opts.plugins.tooltip.callbacks = {
      title: (items) => items.length ? dateFmt.format(dayToMs(model, items[0].raw.x)) : '',
      label: (i) => `${fmtNum(i.raw.y, 0)}% chance of being done`,
    };
    opts.plugins.vlines.lines = [['P50', mc.p50, 0], ['P85', mc.p85, 1], ['P95', mc.p95, 2]]
      .filter(([, x]) => isFinite(x))
      .map(([name, x, row]) => ({ x, label: `${name} ${shortFmt.format(dayToMs(model, x))}`, color: c.muted, dash: [3, 3], row }));
    const parts = ['replays randomly chosen past weeks until the remaining work is done, 5,000 times'];
    if (model.settings.mcUncertainty && model.unit !== 'count') parts.push('ticket sizes vary within their min/max bounds');
    if (model.settings.mcScopeGrowth) parts.push('each replayed week also adds that week\'s new scope');
    $('mc-sub').textContent = `Monte Carlo: ${parts.join('; ')}.`;
    draw('chart-mc', {
      type: 'line',
      data: { datasets: [{ label: 'Chance done', data, borderColor: c.s1, backgroundColor: alpha(c.s1, 0.1), fill: 'origin', borderWidth: 2, pointRadius: 0, stepped: true }] },
      options: opts,
    });
  }

  function renderRemaining(model) {
    const u = unitShort(model.unit);
    if (!model.openRows.length) {
      $('remaining-table').innerHTML = '<tr><td>No open tickets.</td></tr>';
      return;
    }
    $('remaining-table').innerHTML =
      `<thead><tr><th class="nowrap">Key</th><th>Summary</th><th>Type</th><th>Status</th><th>Assignee</th><th class="num">Estimate (${u})</th></tr></thead><tbody>` +
      model.openRows.map((r) =>
        `<tr><td class="nowrap">${esc(r.it.key)}</td><td>${esc(r.it.summary)}</td><td>${esc(r.it.type)}</td><td class="nowrap">${r.resolvedLater ? 'Open on as-of date' : esc(r.it.status)}</td><td class="nowrap">${esc(r.it.assignee || '—')}</td>` +
        `<td class="num">${fmtNum(r.est)}${r.missing ? ' <span class="note">(filled)</span>' : ''}</td></tr>`).join('') +
      '</tbody>';
  }

  function renderWeekly(model) {
    const u = unitShort(model.unit);
    let rollIdx = 0;
    $('weekly-table').innerHTML =
      `<thead><tr><th>Week of</th><th class="num">Completed (${u})</th><th class="num">Rolling avg (${u})</th><th class="num">Scope added (${u})</th>` +
      '<th class="num">Tickets completed</th><th class="num">Tickets created</th><th class="num">Net tickets</th></tr></thead><tbody>' +
      model.weeks.map((w) => {
        const roll = w.complete ? model.rolling[rollIdx++] : null;
        return `<tr><td>${dateFmt.format(w.start)}${w.complete ? '' : ' <span class="note">(partial)</span>'}</td>` +
          `<td class="num">${fmtNum(w.velocity)}</td><td class="num">${fmtNum(roll)}</td><td class="num">${fmtNum(w.scopeAdded)}</td>` +
          `<td class="num">${w.ticketsDone}</td><td class="num">${w.ticketsCreated}</td>` +
          `<td class="num">${w.ticketsDone - w.ticketsCreated > 0 ? '+' : ''}${w.ticketsDone - w.ticketsCreated}</td></tr>`;
      }).join('') + '</tbody>';
  }

  function renderAssignees(model) {
    const list = (model.projections.assignees || []).filter((a) => a.remaining > 0 || a.perWeek > 0);
    const u = unitShort(model.unit);
    if (!list.length) {
      $('assignee-table').innerHTML = '<tr><td>No open work.</td></tr>';
      return;
    }
    const worst = model.projections.bottleneck && model.projections.bottleneck.name;
    $('assignee-table').innerHTML =
      `<thead><tr><th>Assignee</th><th class="num">Open tickets</th><th class="num">Remaining (${u})</th><th class="num">Completed / wk</th><th>Projected finish</th></tr></thead><tbody>` +
      list.map((a) => `<tr><td>${esc(a.name)}${a.name === worst ? ' <span class="note">(bottleneck)</span>' : ''}</td>` +
        `<td class="num">${a.open}</td><td class="num">${fmtNum(a.remaining)}</td><td class="num">${fmtNum(a.perWeek)}</td>` +
        `<td>${a.remaining <= 0 ? '<span class="note">Nothing open</span>' : a.day == null ? `<span class="note">${esc(a.note || '—')}</span>` : fmtDay(model, a.day)}</td></tr>`).join('') +
      '</tbody>';
  }

  // Plain-text summary for pasting into Slack, email or a ticket.
  function summaryText(model) {
    const t = model.totals, p = model.projections, u = unitShort(model.unit);
    const name = settings.version || fileName;
    const lines = [`*${name}* (as of ${dateFmt.format(model.asOf)})`];
    lines.push(`Scope ${fmtNum(t.scope)} ${u}, completed ${fmtNum(t.completed)} (${fmtNum(t.scope ? (t.completed / t.scope) * 100 : 0, 0)}%), remaining ${fmtNum(t.remaining)} ${u} in ${t.ticketsOpen} tickets.`);
    if (model.finished) {
      lines.push('All work is complete.');
      return lines.join('\n');
    }
    lines.push(`Velocity: ${fmtNum(t.avgVelocity)} ${u}/week, ${fmtNum(t.avgTickets)} tickets/week (last ${t.weeksInWindow} full weeks).`);
    if (p.monteCarlo) lines.push(`Likely finish: ${fmtDay(model, p.monteCarlo.p50)} (P50), ${fmtDay(model, p.monteCarlo.p85)} (P85).`);
    lines.push(`Range: ${fmtDay(model, p.optimistic.day)} (optimistic) to ${fmtDay(model, p.pessimistic.day)} (pessimistic).`);
    lines.push(`Linear regression: ${fmtDay(model, p.linear.day)}. With current scope growth: ${fmtDay(model, p.scopeGrowth && p.scopeGrowth.day)}.`);
    if (p.bottleneck.name) lines.push(`Bottleneck: ${p.bottleneck.name}, ${fmtDay(model, p.bottleneck.day)}.`);
    return lines.join('\n');
  }

  $('copy-summary').addEventListener('click', async () => {
    if (!current || current.empty) return;
    const text = summaryText(current);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
    }
    $('copy-status').textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => ($('copy-status').textContent = ''), 2000);
  });

  const chartRenderers = {
    'chart-burnup': renderTrend,
    'chart-velocity': renderVelocity,
    'chart-tickets': renderTickets,
    'chart-mc': renderMonteCarlo,
  };

  // Re-draws one chart in the requested theme at 2x, captures it, then restores the
  // on-screen version. Everything happens synchronously, so nothing flickers.
  function exportChart(id, bg) {
    if (!current || current.empty || !charts[id]) return;
    const root = document.documentElement;
    const prevTheme = root.getAttribute('data-theme');
    if (bg === 'light' || bg === 'dark') root.setAttribute('data-theme', bg);
    exporting.transparent = bg === 'transparent';
    exporting.pixelRatio = Math.max(2, window.devicePixelRatio || 1);
    let url;
    try {
      chartRenderers[id](current);
      url = charts[id].toBase64Image('image/png');
    } finally {
      exporting.transparent = false;
      exporting.pixelRatio = null;
      if (prevTheme == null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', prevTheme);
      chartRenderers[id](current);
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(settings.version || 'release').replace(/[^\w.-]+/g, '_')}-${id.replace('chart-', '')}-${bg}.png`;
    a.click();
  }

  document.addEventListener('click', (e) => {
    const item = e.target.closest('.export-menu .menu button[data-bg]');
    if (item) {
      const menu = item.closest('.export-menu');
      menu.open = false;
      exportChart(menu.dataset.chart, item.dataset.bg);
      return;
    }
    // Clicking anywhere else closes any open export menu.
    document.querySelectorAll('.export-menu[open]').forEach((m) => { if (!m.contains(e.target)) m.open = false; });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.export-menu[open]').forEach((m) => { m.open = false; m.querySelector('summary').focus(); });
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
})();
