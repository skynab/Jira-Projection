/* Sortable tables: projections, weekly numbers, assignees, remaining tickets. */
'use strict';

function renderProjectionTable(model) {
  const p = model.projections, f = model.fits, u = unitShort(model.unit);
  const c = palette();
  if (model.finished) {
    $('projection-table').innerHTML = '<tr><td>Everything in scope is resolved.</td></tr>';
    return;
  }
  const sw = (color, dashed) => `<span class="key-swatch${dashed ? ' dashed' : ''}" style="background:${color};color:${color}"></span>`;
  const rows = [
    [sw(c.s2, true), 'Linear regression', p.linear.day, p.linear.note || (f.linear ? `R² ${fmtNum(f.linear.r2, 2)} · ${fmtNum(f.linear.slope * 7)} ${u}/wk trend` : '')],
    [sw(c.scope, true), 'Linear + scope growth', p.scopeGrowth && p.scopeGrowth.day, (p.scopeGrowth && p.scopeGrowth.note) ||
      (f.scope ? `Scope growing ${fmtNum(f.scope.slope * 7)} ${u}/wk → ~${fmtNum(p.scopeGrowth.scopeAt, 0)} ${u} at finish` : '')],
    [sw(c.s3, true), `Polynomial regression (degree ${model.settings.polyDegree})`, p.poly.day, p.poly.note || (f.poly ? `R² ${fmtNum(f.poly.r2, 3)}` : '')],
    ['', 'Average velocity', p.velocity.day, p.velocity.note || `${fmtNum(model.totals.remaining)} ${u} ÷ ${fmtNum(model.totals.avgVelocity)} ${u}/wk`],
    [sw(c.s4), 'Optimistic bound', p.optimistic.day, `${fmtNum(p.optimistic.amount)} ${u} at ${fmtNum(p.optimistic.velocity)} ${u}/wk (fastest)`],
    [sw(c.s4), 'Pessimistic bound', p.pessimistic.day, `${fmtNum(p.pessimistic.amount)} ${u} at ${fmtNum(p.pessimistic.velocity)} ${u}/wk (slowest)`],
    ['', 'Ticket completion rate', p.tickets.day, `${p.tickets.left} tickets ÷ ${fmtNum(p.tickets.perWeek)} tickets/wk`],
    ['', 'Assignee bottleneck', p.bottleneck.day, [p.bottleneck.name && `${p.bottleneck.name} finishes last`, p.bottleneck.note].filter(Boolean).join('. ')],
  ];
  if (p.monteCarlo) {
    const opts = [model.settings.mcUncertainty && model.unit !== 'count' && 'randomised sizes', model.settings.mcScopeGrowth && 'with scope growth'].filter(Boolean);
    const how = opts.length ? ` (${opts.join(', ')})` : '';
    rows.push(['', 'Monte Carlo P50', p.monteCarlo.p50, `50% of simulations finished by here${how}`]);
    rows.push(['', 'Monte Carlo P85', p.monteCarlo.p85, `85% of simulations finished by here${how}`]);
    rows.push(['', 'Monte Carlo P95', p.monteCarlo.p95, `95% of simulations finished by here${how}`]);
  } else {
    rows.push(['', 'Monte Carlo', null, 'Needs at least one full week with completed work']);
  }
  // Only Details wraps; method, date and day count always stay on one line.
  renderSortable('projection-table', [
    { key: 'method', label: 'Method', value: (r) => r[1] },
    { key: 'date', label: 'Projected finish', num: true, align: 'left', value: (r) => r[2] },
    { key: 'days', label: 'Days from as-of', num: true, value: (r) => r[2] },
    { key: 'details', label: 'Details', value: (r) => r[3] },
  ], rows, ([swatch, name, day, note]) =>
    `<tr><td class="nowrap">${swatch}${esc(name)}</td><td class="nowrap">${fmtDay(model, day)}</td>` +
    `<td class="num nowrap">${day == null || !isFinite(day) ? '—' : Math.round(day - model.T)}</td><td class="note wrap">${esc(note || '')}</td></tr>`);
}

// ---------------------------------------------------------------- sortable tables
// Click a header to sort; click again to reverse. Text starts A→Z, numbers and dates
// start largest-first, and blank values always sort last.

// key: null means "original order" (only the projections table starts that way, and a
// third click on the same header returns it there).
const sortState = {
  'projection-table': { key: null, dir: -1, resettable: true },
  'weekly-table': { key: 'week', dir: 1 },
  'assignee-table': { key: 'day', dir: -1 },
  'remaining-table': { key: 'est', dir: -1 },
};
const tableArgs = {};
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function renderSortable(id, columns, rows, rowHtml) {
  tableArgs[id] = [columns, rows, rowHtml];
  const state = sortState[id];
  const col = state.key == null ? null : columns.find((c) => c.key === state.key) || columns[0];
  const indexed = rows.map((row, i) => ({ row, i }));
  if (col) {
    indexed.sort((a, b) => {
      const va = col.value(a.row), vb = col.value(b.row);
      const blankA = va == null || va === '', blankB = vb == null || vb === '';
      if (blankA || blankB) return blankA === blankB ? a.i - b.i : blankA ? 1 : -1;
      const cmp = col.num ? (va === vb ? 0 : va < vb ? -1 : 1) : collator.compare(va, vb);
      // Ties fall back to the original row order.
      return cmp * state.dir || a.i - b.i;
    });
  }
  const sorted = indexed.map((x) => x.row);
  $(id).innerHTML = '<thead><tr>' + columns.map((c) => {
    const active = col != null && c.key === col.key;
    const aria = active ? (state.dir > 0 ? 'ascending' : 'descending') : 'none';
    const right = c.num && c.align !== 'left';
    return `<th class="${right ? 'num ' : ''}${c.className || ''}" aria-sort="${aria}">` +
      `<button type="button" class="sort" data-key="${c.key}">${c.label}<span class="sort-arrow" aria-hidden="true">${active ? (state.dir > 0 ? '▲' : '▼') : ''}</span></button></th>`;
  }).join('') + '</tr></thead><tbody>' + sorted.map(rowHtml).join('') + '</tbody>';
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('th button.sort');
  if (!btn) return;
  const id = btn.closest('table').id;
  if (!tableArgs[id]) return;
  const [columns] = tableArgs[id];
  const col = columns.find((c) => c.key === btn.dataset.key);
  const state = sortState[id];
  const first = col.num ? -1 : 1;
  if (state.key !== col.key) { state.key = col.key; state.dir = first; }
  else if (state.resettable && state.dir !== first) state.key = null; // third click: original order
  else state.dir = -state.dir;
  renderSortable(id, ...tableArgs[id]);
  $(id).querySelector(`th button[data-key="${col.key}"]`).focus();
});

function renderRemaining(model) {
  const u = unitShort(model.unit);
  if (!model.openRows.length) {
    $('remaining-table').innerHTML = '<tr><td>No open tickets.</td></tr>';
    return;
  }
  const status = (r) => (r.resolvedLater ? 'Open on as-of date' : r.it.status);
  renderSortable('remaining-table', [
    { key: 'key', label: 'Key', value: (r) => r.it.key, className: 'nowrap' },
    { key: 'summary', label: 'Summary', value: (r) => r.it.summary },
    { key: 'type', label: 'Type', value: (r) => r.it.type },
    { key: 'status', label: 'Status', value: status },
    { key: 'assignee', label: 'Assignee', value: (r) => r.it.assignee },
    { key: 'est', label: `Estimate (${u})`, num: true, value: (r) => r.est },
  ], model.openRows, (r) =>
    `<tr><td class="nowrap">${esc(r.it.key)}</td><td>${esc(r.it.summary)}</td><td>${esc(r.it.type)}</td><td class="nowrap">${esc(status(r))}</td><td class="nowrap">${esc(r.it.assignee || '—')}</td>` +
    `<td class="num">${r.credit > 0 ? `<span class="note">${Math.round(r.credit * 100)}% done · </span>` : ''}${fmtNum(r.est)}${r.missing ? ' <span class="note">(filled)</span>' : ''}</td></tr>`);
}

function renderWeekly(model) {
  const u = unitShort(model.unit);
  let rollIdx = 0;
  const rows = model.weeks.map((w) => ({ w, roll: w.complete ? model.rolling[rollIdx++] : null, net: w.ticketsDone - w.ticketsCreated }));
  renderSortable('weekly-table', [
    { key: 'week', label: 'Week of', num: true, align: 'left', value: (r) => r.w.start },
    { key: 'velocity', label: `Completed (${u})`, num: true, value: (r) => r.w.velocity },
    { key: 'roll', label: `Rolling avg (${u})`, num: true, value: (r) => r.roll },
    { key: 'scope', label: `Scope added (${u})`, num: true, value: (r) => r.w.scopeAdded },
    { key: 'done', label: 'Tickets completed', num: true, value: (r) => r.w.ticketsDone },
    { key: 'created', label: 'Tickets created', num: true, value: (r) => r.w.ticketsCreated },
    { key: 'net', label: 'Net tickets', num: true, value: (r) => r.net },
  ], rows, ({ w, roll, net }) =>
    `<tr><td class="nowrap">${dateFmt.format(w.start)}${w.complete ? '' : ' <span class="note">(partial)</span>'}</td>` +
    `<td class="num">${fmtNum(w.velocity)}</td><td class="num">${fmtNum(roll)}</td><td class="num">${fmtNum(w.scopeAdded)}</td>` +
    `<td class="num">${w.ticketsDone}</td><td class="num">${w.ticketsCreated}</td><td class="num">${net > 0 ? '+' : ''}${net}</td></tr>`);
}

function renderAssignees(model) {
  const list = (model.projections.assignees || []).filter((a) => a.remaining > 0 || a.perWeek > 0);
  const u = unitShort(model.unit);
  if (!list.length) {
    $('assignee-table').innerHTML = '<tr><td>No open work.</td></tr>';
    return;
  }
  const worst = model.projections.bottleneck && model.projections.bottleneck.name;
  renderSortable('assignee-table', [
    // "Unassigned" is not a person, so it sorts with the blanks at the end.
    { key: 'name', label: 'Assignee', value: (a) => (a.name === 'Unassigned' ? null : a.name) },
    { key: 'open', label: 'Open tickets', num: true, value: (a) => a.open },
    { key: 'remaining', label: `Remaining (${u})`, num: true, value: (a) => a.remaining },
    { key: 'perWeek', label: 'Completed / wk', num: true, value: (a) => a.perWeek },
    // People with nothing open finish "now"; unprojectable people sort last.
    { key: 'day', label: 'Projected finish', num: true, align: 'left', value: (a) => (a.remaining <= 0 ? model.T : a.day) },
  ], list, (a) => `<tr><td>${esc(a.name)}${a.name === worst ? ' <span class="note">(bottleneck)</span>' : ''}</td>` +
    `<td class="num">${a.open}</td><td class="num">${fmtNum(a.remaining)}</td><td class="num">${fmtNum(a.perWeek)}</td>` +
    `<td>${a.remaining <= 0 ? '<span class="note">Nothing open</span>' : a.day == null ? `<span class="note">${esc(a.note || '—')}</span>` : fmtDay(model, a.day)}</td></tr>`);
}
