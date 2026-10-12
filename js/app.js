/* UI wiring and charts. All math lives in projection.js. */
(function () {
  'use strict';
  const P = window.Projection;
  const $ = (id) => document.getElementById(id);

  let data = null;
  let fileName = '';
  const settings = {};
  const charts = {};

  // ---------------------------------------------------------------- formatting

  const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const shortFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const dayToMs = (model, day) => P.addDays(model.start, Math.round(day));
  const fmtDay = (model, day) => (day == null ? '—' : dateFmt.format(dayToMs(model, day)));
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
      default:
        if (t.closest('#ctl-types')) {
          settings.excludedTypes = [...document.querySelectorAll('#ctl-types input:not(:checked)')].map((i) => i.value);
        } else if (t.closest('#ctl-resolutions')) {
          settings.deliveredResolutions = [...document.querySelectorAll('#ctl-resolutions input:checked')].map((i) => i.value);
        }
    }
    render();
  });

  // ---------------------------------------------------------------- render

  function render() {
    if (!data) return;
    const model = P.buildModel(data, settings);
    const cols = data.columns;
    $('file-line').textContent = `${fileName} · ${data.issues.length} issues · ` +
      (cols.hasResolved ? 'has Resolved dates' : 'no Resolved column') + ' · ' +
      [cols.hasStoryPoints && 'Story Points', cols.hasOrigEst && 'Original estimate'].filter(Boolean).join(' & ') + ' columns found';

    const warnings = [...model.warnings];
    if (!model.empty && model.unit === 'days' && !data.counts.origEst) warnings.unshift('No ticket has an Original estimate, so every estimate is filled in. Switch "Estimate by" to Story points or Ticket count.');
    if (!model.empty && model.unit === 'points' && !data.counts.storyPoints) warnings.unshift('No ticket has Story Points. Switch "Estimate by" to Original estimate or Ticket count.');
    if (!model.empty && !model.finished && model.totals.weeksInWindow < 3) warnings.push(`Only ${model.totals.weeksInWindow} full week(s) of history in the fit window, so treat these projections as rough.`);
    $('warnings').innerHTML = warnings.map((w) => `<li>${esc(w)}</li>`).join('');

    if (model.empty) {
      ['headline', 'tiles'].forEach((id) => ($(id).innerHTML = ''));
      Object.values(charts).forEach((c) => c.destroy());
      return;
    }
    if (!settings.start) $('ctl-start').value = toInputDate(model.start);
    if (!settings.asOf) $('ctl-asof').value = toInputDate(model.asOf);

    renderHeadline(model);
    renderTiles(model);
    renderProjectionTable(model);
    renderBurnup(model);
    renderVelocity(model);
    renderTickets(model);
    renderMonteCarlo(model);
    renderRemaining(model);
  }

  function renderHeadline(model) {
    const p = model.projections;
    if (model.finished) {
      $('headline').innerHTML = '<div class="big">All work in this release is complete.</div>';
      return;
    }
    const mc = p.monteCarlo;
    const main = mc ? mc.p50 : p.velocity.day;
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
    ];
    if (p.monteCarlo) {
      rows.push(['Monte Carlo P50', p.monteCarlo.p50, '50% of simulations finished by here']);
      rows.push(['Monte Carlo P85', p.monteCarlo.p85, '85% of simulations finished by here']);
      rows.push(['Monte Carlo P95', p.monteCarlo.p95, '95% of simulations finished by here']);
    } else {
      rows.push(['Monte Carlo', null, 'Needs at least one full week with completed work']);
    }
    $('projection-table').innerHTML =
      '<thead><tr><th>Method</th><th>Projected finish</th><th class="num">Days from as-of</th><th>Details</th></tr></thead><tbody>' +
      rows.map(([name, day, note]) =>
        `<tr><td>${name}</td><td>${fmtDay(model, day)}</td><td class="num">${day == null ? '—' : Math.round(day - model.T)}</td><td class="note">${esc(note || '')}</td></tr>`).join('') +
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
        ctx.fillStyle = opts.textColor;
        ctx.font = '12px system-ui, -apple-system, sans-serif';
        ctx.textAlign = x > chartArea.right - 80 ? 'right' : 'left';
        ctx.fillText(l.label, x + (ctx.textAlign === 'left' ? 4 : -4), chartArea.top + 12 + (l.row || 0) * 14);
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
            // Swatch = the line/bar colour (area fills are only a faint wash).
            generateLabels: (chart) => Chart.defaults.plugins.legend.labels.generateLabels(chart).map((l) => {
              const ds = chart.data.datasets[l.datasetIndex];
              const color = ds.type === 'bar' || chart.config.type === 'bar' ? (Array.isArray(ds.backgroundColor) ? ds.backgroundColor[0] : ds.backgroundColor) : ds.borderColor;
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

  function draw(id, config) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart($(id), Object.assign({ plugins: [vlinePlugin] }, config));
  }

  // x axis in day indexes from the (Monday) release start, so ticks land on Mondays.
  function dayAxis(model, c, min, max) {
    const span = max - min;
    const step = span <= 70 ? 7 : span <= 200 ? 14 : 28;
    min = Math.floor(min / step) * step;
    max = Math.ceil(max / step) * step;
    return {
      type: 'linear', min, max,
      grid: { color: c.grid }, border: { color: c.axis },
      ticks: { color: c.muted, stepSize: step, callback: (v) => shortFmt.format(dayToMs(model, v)), maxRotation: 0, autoSkipPadding: 12 },
    };
  }

  function renderBurnup(model) {
    const c = palette();
    const { T, horizon, series, fits, projections: p, totals } = model;
    const u = unitShort(model.unit);
    const days = Array.from({ length: horizon + 1 }, (_, d) => d);
    const pts = (fn) => days.map((d) => ({ x: d, y: fn(d) }));
    const endDot = (lastDay) => (ctx) => (ctx.raw && ctx.raw.x === lastDay ? 4 : 0);
    const line = (label, color, data, extra) => Object.assign({
      label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0,
      pointHoverRadius: 4, pointBorderColor: c.surface, pointBorderWidth: 2, tension: 0, spanGaps: false,
    }, extra);

    const datasets = [
      line('Scope', c.scope, pts((d) => (d <= T ? series.scopeCum[d] : null))),
      line('Completed', c.s1, pts((d) => (d <= T ? series.doneCum[d] : null)), { fill: 'origin', backgroundColor: alpha(c.s1, 0.1) }),
    ];
    if (!model.finished) {
      const until = (day) => (day == null ? horizon : Math.min(horizon, Math.ceil(day)));
      const fitLine = (fit, endDay) => pts((d) => (fit && d >= fits.fitStart && d <= endDay ? fit.at(d) : null));
      if (fits.scope && p.scopeGrowth) {
        const end = until(p.scopeGrowth.day);
        datasets.push(line('Scope trend', c.scope, pts((d) => (d >= fits.fitStart && d <= end ? fits.scope.at(d) : null)), { borderDash: [6, 4], borderWidth: 1.5 }));
      }
      if (fits.linear) {
        const end = until(p.linear.day);
        datasets.push(line('Linear fit', c.s2, fitLine(fits.linear, end), { borderDash: [6, 4], pointRadius: endDot(end) }));
      }
      if (fits.poly) {
        const end = until(p.poly.day);
        datasets.push(line(`Polynomial fit (deg ${model.settings.polyDegree})`, c.s3, fitLine(fits.poly, end), { borderDash: [2, 3], pointRadius: endDot(end) }));
      }
      if (p.optimistic.day != null && p.pessimistic.day != null) {
        const end = until(p.pessimistic.day);
        const cone = (proj) => pts((d) => (d >= T && d <= end ? Math.min(totals.completed + proj.amount, totals.completed + (proj.velocity / 7) * (d - T)) : null));
        datasets.push(line('Optimistic', c.s4, cone(p.optimistic), { borderWidth: 1.5, pointRadius: endDot(until(p.optimistic.day)) }));
        datasets.push(line('Pessimistic', c.s4, cone(p.pessimistic), { borderWidth: 1.5, fill: '-1', backgroundColor: alpha(c.s4, 0.12), pointRadius: endDot(end) }));
      }
    }

    const opts = baseOptions(c);
    opts.scales.x = dayAxis(model, c, 0, horizon);
    opts.scales.y.title = { display: true, text: u, color: c.muted };
    opts.scales.y.min = 0;
    opts.plugins.tooltip.callbacks = {
      title: (items) => items.length ? dateFmt.format(dayToMs(model, items[0].raw.x)) : '',
      label: (i) => `${i.dataset.label}: ${fmtNum(i.raw.y)} ${u}`,
    };
    opts.plugins.vlines.lines = [{ x: T, label: 'As of', color: c.muted, dash: [3, 3] }];
    draw('chart-burnup', { type: 'line', data: { datasets }, options: opts });

    const fitDesc = model.settings.fitWeeks ? `the last ${model.settings.fitWeeks} weeks` : 'all weeks since the start';
    $('burnup-sub').textContent = `Cumulative ${u} in scope vs completed. Regression lines are fitted to ${fitDesc}. ` +
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
    const c = palette();
    const labels = model.weeks.map((w) => shortFmt.format(w.start) + (w.complete ? '' : ' (partial)'));
    const datasets = [
      barDataset('Created', c.s2, model.weeks.map((w) => w.ticketsCreated)),
      barDataset('Completed', c.s1, model.weeks.map((w) => w.ticketsDone)),
    ];
    const opts = baseOptions(c);
    opts.scales.x.grid = { display: false };
    opts.scales.y.ticks.precision = 0;
    opts.scales.y.title = { display: true, text: 'tickets / week', color: c.muted };
    opts.plugins.legend.labels.pointStyle = 'rect';
    draw('chart-tickets', { data: { labels, datasets }, options: opts });
  }

  function renderMonteCarlo(model) {
    const c = palette();
    const mc = model.projections.monteCarlo;
    if (!mc) {
      if (charts['chart-mc']) charts['chart-mc'].destroy();
      return;
    }
    const min = model.T;
    const max = Math.ceil(mc.samples[mc.samples.length - 1]) + 3;
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
    opts.plugins.vlines.lines = [
      { x: mc.p50, label: `P50 ${shortFmt.format(dayToMs(model, mc.p50))}`, color: c.muted, dash: [3, 3] },
      { x: mc.p85, label: `P85 ${shortFmt.format(dayToMs(model, mc.p85))}`, color: c.muted, dash: [3, 3], row: 1 },
      { x: mc.p95, label: `P95 ${shortFmt.format(dayToMs(model, mc.p95))}`, color: c.muted, dash: [3, 3], row: 2 },
    ];
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
        `<tr><td class="nowrap">${esc(r.it.key)}</td><td>${esc(r.it.summary)}</td><td>${esc(r.it.type)}</td><td class="nowrap">${esc(r.it.status)}</td><td class="nowrap">${esc(r.it.assignee || '—')}</td>` +
        `<td class="num">${fmtNum(r.est)}${r.missing ? ' <span class="note">(filled)</span>' : ''}</td></tr>`).join('') +
      '</tbody>';
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
})();
