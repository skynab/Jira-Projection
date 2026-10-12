/* Chart.js rendering: burn-up/down, forecast history, velocity, ticket flow, Monte Carlo, and PNG export. */
'use strict';

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
      if (l.horizontal) {
        const y = scales.y.getPixelForValue(l.x);
        if (y < chartArea.top || y > chartArea.bottom) continue;
        ctx.save();
        ctx.strokeStyle = l.color;
        ctx.lineWidth = l.width || 1;
        if (l.dash) ctx.setLineDash(l.dash);
        ctx.beginPath();
        ctx.moveTo(chartArea.left, y);
        ctx.lineTo(chartArea.right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '12px system-ui, -apple-system, sans-serif';
        const w = ctx.measureText(l.label).width;
        if (!exporting.transparent) { ctx.fillStyle = css('--surface'); ctx.fillRect(chartArea.left + 2, y - 15, w + 4, 14); }
        ctx.fillStyle = opts.textColor;
        ctx.fillText(l.label, chartArea.left + 4, y - 4);
        ctx.restore();
        continue;
      }
      if (!isFinite(l.x)) continue;
      const x = scales.x.getPixelForValue(l.x);
      if (x < chartArea.left || x > chartArea.right) continue;
      ctx.save();
      ctx.strokeStyle = l.color;
      ctx.lineWidth = l.width || 1;
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
  $('trend-title').textContent = mode === 'up' ? 'Burn-Up with Projections' : 'Burn-Down with Projections';
  $('chart-burnup').setAttribute('aria-label', mode === 'up'
    ? 'Burn-up chart of scope and completed work with projected finish lines'
    : 'Burn-down chart of remaining work with projected finish lines');
  if (mode === 'up') renderBurnup(model); else renderBurndown(model);
}

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
      velocity: group.reduce((a, w) => a + w.velocity, 0),
      velocityByType: group.reduce((acc, w) => {
        for (const [k, v] of Object.entries(w.velocityByType)) acc[k] = (acc[k] || 0) + v;
        return acc;
      }, {}),
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
  const tg = model.target && !model.target.past && !model.target.done ? model.target.day : null;
  opts.scales.x = dayAxis(model, c, 0, tg != null ? Math.max(model.horizon, tg + 3) : model.horizon);
  opts.scales.y.title = { display: true, text: yLabel, color: c.muted };
  opts.scales.y.min = 0;
  opts.plugins.tooltip.callbacks = {
    title: (items) => items.length ? dateFmt.format(dayToMs(model, items[0].raw.x)) : '',
    label: (i) => i.raw.note || `${i.dataset.label}: ${fmtNum(i.raw.y)} ${u}`,
  };
  opts.plugins.vlines.lines = [{ x: model.T, label: 'As of', color: c.muted, dash: [3, 3] }];
  if (tg != null) opts.plugins.vlines.lines.push(targetLine(model, c, tg));
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
    (totals.credit > 0 ? `Projections start ${fmtNum(totals.credit)} ${u} below the remaining line: credit for work in progress. ` : '') +
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
      datasets.push(line('Linear fit', c.s2, ahead(totals.completed + totals.credit, fits.linear, end), { borderDash: [6, 4], pointRadius: endDot(end) }));
    }
    if (fits.poly) {
      const end = until(p.poly.day ?? p.poly.stopDay);
      datasets.push(line('_poly history', alpha(c.s3, 0.5), history(fits.poly), faint));
      datasets.push(line(`Polynomial fit (deg ${model.settings.polyDegree})`, c.s3, ahead(totals.completed + totals.credit, fits.poly, end), { borderDash: [2, 3], pointRadius: endDot(end) }));
    }
    if (p.optimistic.day != null && p.pessimistic.day != null) {
      const end = until(p.pessimistic.day);
      const base = totals.completed + totals.credit;
      const cone = (proj) => pts((d) => (d >= T && d <= end ? Math.min(base + proj.amount, base + (proj.velocity / 7) * (d - T)) : null));
      datasets.push(line('Optimistic', c.s4, cone(p.optimistic), { borderWidth: 1.5, pointRadius: endDot(until(p.optimistic.day)) }));
      datasets.push(line('Pessimistic', c.s4, cone(p.pessimistic), { borderWidth: 1.5, fill: '-1', backgroundColor: alpha(c.s4, 0.12), pointRadius: endDot(end) }));
    }
  }

  draw('chart-burnup', { type: 'line', data: { datasets }, options: trendOptions(model, c, u) });

  const fitDesc = model.settings.fitWeeks ? `the last ${model.settings.fitWeeks} weeks` : 'all weeks since the start';
  $('burnup-sub').textContent = `Cumulative ${u} in scope vs completed. Regressions are fitted to ${fitDesc} (faint lines) and projected from today's actual progress. ` +
    (totals.credit > 0 ? `Projections start ${fmtNum(totals.credit)} ${u} above the completed line: credit for work in progress. ` : '') +
    'The shaded cone runs from the optimistic to the pessimistic bound.';
}

function barDataset(label, color, data, extra) {
  return Object.assign({ type: 'bar', label, data, backgroundColor: color, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom', maxBarThickness: 24, categoryPercentage: 0.7, barPercentage: 0.9 }, extra);
}

function renderHistory(model) {
  const h = model.history || [];
  const usable = h.filter((p) => p.p50 != null || p.linear != null);
  if (usable.length < 2) {
    if (charts['chart-history']) { charts['chart-history'].destroy(); delete charts['chart-history']; }
    $('history-why').textContent = 'Needs at least three weeks of history since the release start.';
    return;
  }
  const c = palette();
  const series = (key) => h.map((p) => ({ x: p.day, y: p[key] ?? null }));
  const line = (label, key, color, extra) => Object.assign({
    label, data: series(key), borderColor: color, backgroundColor: color, borderWidth: 2,
    pointRadius: 3, pointHoverRadius: 5, pointBorderColor: c.surface, pointBorderWidth: 2, tension: 0, spanGaps: true,
    clip: 0, // values beyond the y range are cut at the plot edge instead of drawing over the legend
  }, extra);
  const datasets = [
    line('Monte Carlo P50', 'p50', c.s1),
    line('Monte Carlo P85', 'p85', alpha(c.s1, 0.55), { borderWidth: 1.5, pointRadius: 0, fill: '-1', backgroundColor: alpha(c.s1, 0.1) }),
    line('Linear regression', 'linear', c.s2, { borderDash: [6, 4], pointRadius: 0 }),
    line('Linear + scope growth', 'scopeGrowth', c.scope, { borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0 }),
  ];
  // Size the y axis to the main forecasts; a far-off scope-growth line may run off the top
  // rather than squash everything else into a strip.
  const core = h.flatMap((p) => [p.p50, p.p85, p.linear]).filter((v) => v != null);
  const coreMin = Math.min(...core), coreMax = Math.max(...core);
  const growth = h.map((p) => p.scopeGrowth).filter((v) => v != null);
  const tgDay = model.target && !model.target.past && !model.target.done ? model.target.day : null;
  const yMin = Math.min(coreMin, ...growth, ...(tgDay != null ? [tgDay] : []));
  const yMax = Math.max(coreMax, ...(tgDay != null ? [tgDay] : []), ...growth.map((v) => Math.min(v, coreMax + Math.max(14, coreMax - coreMin))));
  const pad = Math.max(3, (yMax - yMin) * 0.06);
  const lo = Math.floor(yMin - pad), hi = Math.ceil(yMax + pad);
  const yStep = hi - lo <= 49 ? 7 : hi - lo <= 140 ? 14 : 28;
  const opts = baseOptions(c);
  opts.scales.x = dayAxis(model, c, h[0].day, h[h.length - 1].day);
  opts.scales.x.title = { display: true, text: 'Forecast made on', color: c.muted };
  opts.scales.y = {
    min: lo, max: hi,
    grid: { color: c.grid }, border: { color: c.axis },
    // Mondays, evenly spaced, like the date axes elsewhere.
    afterBuildTicks: (axis) => {
      const ticks = [];
      for (let v = Math.ceil(lo / yStep) * yStep; v <= hi; v += yStep) ticks.push({ value: v });
      axis.ticks = ticks;
    },
    ticks: { color: c.muted, callback: (v) => shortFmt.format(dayToMs(model, v)) },
    title: { display: true, text: 'Projected finish', color: c.muted },
  };
  opts.plugins.tooltip.callbacks = {
    title: (items) => (items.length ? `Forecast as of ${dateFmt.format(dayToMs(model, items[0].raw.x))}` : ''),
    label: (i) => `${i.dataset.label}: ${fmtDay(model, i.raw.y)}`,
  };
  if (tgDay != null) opts.plugins.vlines.lines = [Object.assign(targetLine(model, c, tgDay), { horizontal: true })];
  draw('chart-history', { type: 'line', data: { datasets }, options: opts });
  const drift = driftText(model);
  $('history-why').textContent = drift ? drift.long : '';
}

const TYPE_SLOTS = 8;

function renderVelocity(model) {
  const c = palette();
  const u = unitShort(model.unit);
  const n = settings.velBucket === 2 ? 2 : 1;
  const per = n === 2 ? '2 weeks' : 'week';
  const view = settings.velView === 'type' ? 'type' : 'total';
  setToggle('vel-toggle', view);
  const periods = periodsOf(model.weeks, n);
  const labels = periods.map((w) => shortFmt.format(w.start) + (w.complete ? '' : ' (partial)'));
  const fade = (color, w) => (w.complete ? color : alpha(color, 0.4));
  const avgLine = {
    type: 'line', label: 'Average (fit window)', data: periods.map(() => model.totals.avgVelocity * n),
    borderColor: c.muted, borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, stack: 'reference',
  };
  const opts = baseOptions(c);
  opts.scales.x.grid = { display: false };
  opts.scales.y.title = { display: true, text: `${u} / ${per}`, color: c.muted };
  opts.plugins.tooltip.callbacks = {
    title: (items) => {
      if (!items.length) return '';
      const w = periods[items[0].dataIndex];
      return n === 1 ? `Week of ${shortFmt.format(w.start)}${w.complete ? '' : ' (in progress)'}`
        : `${shortFmt.format(w.start)} – ${shortFmt.format(w.end)}${w.complete ? '' : ' (in progress)'}`;
    },
    label: (i) => `${i.dataset.label}: ${fmtNum(i.raw)} ${u}`,
  };
  let datasets;

  if (view === 'total') {
    // Rolling average over complete periods, spanning the smoothing setting's number of weeks.
    const k = Math.max(1, Math.round(model.settings.rollWeeks / n));
    const done = periods.filter((w) => w.complete).map((w) => w.velocity);
    const rolling = periods.map((w, i) => (w.complete && i >= k - 1 ? done.slice(i - k + 1, i + 1).reduce((a, b) => a + b, 0) / k : null));
    datasets = [barDataset(`Completed per ${per}`, periods.map((w) => fade(c.s1, w)), periods.map((w) => w.velocity))];
    if (k > 1) {
      datasets.push({ type: 'line', label: `${k * n}-week rolling average`, data: rolling, borderColor: c.s2, backgroundColor: c.s2, borderWidth: 2, pointRadius: 4, pointBorderColor: c.surface, pointBorderWidth: 2, spanGaps: true });
    }
    datasets.push(avgLine);
    $('velocity-sub').textContent = `${u === 'tickets' ? 'Tickets' : 'Estimated ' + u} completed in each ${n === 1 ? 'calendar week (Mon–Sun)' : 'two-week period from the release start'}. A faded bar is a period still in progress.`;
    $('chart-velocity').setAttribute('aria-label', `Velocity per ${per} bar chart`);
  } else {
    const slots = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7', '--series-8'].map(css);
    const present = new Set(periods.flatMap((w) => Object.keys(w.velocityByType)));
    // Keep the file-wide order; anything past the palette folds into "Other".
    const ordered = typeOrder.filter((t) => present.has(t));
    const shown = ordered.length > TYPE_SLOTS ? ordered.slice(0, TYPE_SLOTS - 1) : ordered;
    const rest = ordered.filter((t) => !shown.includes(t));
    const series = shown.map((t) => ({ label: t, color: slots[typeOrder.indexOf(t) % TYPE_SLOTS], value: (w) => w.velocityByType[t] || 0 }));
    if (rest.length) series.push({ label: 'Other', color: c.muted, value: (w) => rest.reduce((a, t) => a + (w.velocityByType[t] || 0), 0) });
    datasets = series.map((sr) => barDataset(sr.label, periods.map((w) => fade(sr.color, w)), periods.map(sr.value), {
      stack: 'work', borderRadius: 0, borderSkipped: false,
      borderColor: c.surface, borderWidth: { top: 2, bottom: 0, left: 0, right: 0 }, // 2px surface gap between segments
    }));
    datasets.push(avgLine);
    opts.scales.x.stacked = true;
    opts.scales.y.stacked = true;
    opts.plugins.tooltip.callbacks.footer = (items) => {
      if (!items.length) return '';
      return `Total: ${fmtNum(periods[items[0].dataIndex].velocity)} ${u}`;
    };
    opts.plugins.tooltip.filter = (i) => i.raw != null && i.dataset.type !== 'line' && i.raw !== 0;
    $('velocity-sub').textContent = `${u === 'tickets' ? 'Tickets' : 'Estimated ' + u} completed per ${per}, split by issue type. The dashed line is the average total.`;
    $('chart-velocity').setAttribute('aria-label', `Velocity per ${per} stacked by issue type`);
  }
  $('velocity-title').textContent = n === 2 ? 'Velocity per 2 Weeks' : 'Velocity per Week';
  draw('chart-velocity', { data: { labels, datasets }, options: opts });
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
  const tgDay = model.target && !model.target.past && !model.target.done ? model.target.day : null;
  const max = Math.max(tgDay != null ? tgDay + 3 : 0, Math.min(model.T + 5 * 365, Math.ceil(finite.length ? finite[finite.length - 1] : model.T + 28) + 3));
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
  if (tgDay != null) opts.plugins.vlines.lines.push(Object.assign(targetLine(model, c, tgDay), { row: 3 }));
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

const chartRenderers = {
  'chart-burnup': renderTrend,
  'chart-history': renderHistory,
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

onToggle('trend-toggle', (mode) => { chartMode = mode; renderTrend(current); });
onToggle('flow-toggle', (mode) => { flowMode = mode; renderTickets(current); });
onToggle('vel-toggle', (mode) => { settings.velView = mode; savePrefs(); renderVelocity(current); });
$('vel-bucket').addEventListener('change', (e) => {
  settings.velBucket = +e.target.value;
  savePrefs();
  if (current && !current.empty) renderVelocity(current);
});
$('flow-bucket').addEventListener('change', (e) => {
  settings.flowBucket = +e.target.value;
  savePrefs();
  if (current && !current.empty) renderTickets(current);
});
