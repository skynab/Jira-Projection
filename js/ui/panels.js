/* Headline, key numbers, target date, data quality, and the copy-to-clipboard summary. */
'use strict';

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
    ['Remaining', `${fmtNum(t.remaining)} ${u}`, `${t.ticketsOpen} open tickets` + (t.credit > 0 ? ` · ${fmtNum(t.credit)} ${u} in-progress credit` : '')],
    ['Avg velocity', `${fmtNum(t.avgVelocity)} ${u}/wk`, `over ${t.weeksInWindow} full weeks`],
    ['Tickets completed', `${fmtNum(t.avgTickets)}/wk`, 'same window'],
    ['Removed from scope', `${t.ticketsDiscarded}`, 'non-delivered resolutions'],
  ];
  $('tiles').innerHTML = tiles.map(([l, v, s]) =>
    `<div class="tile"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`).join('');
}

// ---------------------------------------------------------------- target date
// The target is remembered per fix version (or file, when there are no versions).

const TARGET_KEY = 'jira-projection:targets';
const VERDICT = {
  'on-track': { label: 'On track', icon: '✓' },
  'at-risk': { label: 'At risk', icon: '!' },
  unlikely: { label: 'Unlikely', icon: '✕' },
};
const targetScope = () => settings.version || fileName;
function readTargets() {
  try { return JSON.parse(localStorage.getItem(TARGET_KEY)) || {}; } catch (e) { return {}; }
}
function loadTarget() {
  const v = readTargets()[targetScope()];
  settings.target = v ? fromInputDate(v) : null;
  $('ctl-target').value = v || '';
}
function saveTarget() {
  const all = readTargets();
  if (settings.target) all[targetScope()] = toInputDate(settings.target); else delete all[targetScope()];
  try { localStorage.setItem(TARGET_KEY, JSON.stringify(all)); } catch (e) { /* not persisted */ }
}
// The date input lives in the section header, outside the settings form.
$('ctl-target').addEventListener('change', (e) => { settings.target = fromInputDate(e.target.value); saveTarget(); render(); });
$('clear-target').addEventListener('click', () => { settings.target = null; $('ctl-target').value = ''; saveTarget(); render(); });

function targetLine(model, c, day) {
  return { x: day, label: `Target ${shortFmt.format(dayToMs(model, day))}`, color: c.text, dash: [6, 3], width: 1.5 };
}

function renderTarget(model) {
  const tc = model.target, u = unitShort(model.unit);
  // With no target there is nothing to report, so the section stays out of the PDF.
  document.querySelector('[data-section=target]').classList.toggle('no-target', !settings.target);
  if (!settings.target) {
    $('target-sub').textContent = '';
    $('target-body').innerHTML = '<p class="empty">Pick the date you need to ship to see the chance of making it and what it would take.</p>';
    return;
  }
  $('target-sub').textContent = `Ship by ${dateFmt.format(settings.target)}${tc && !tc.past && !tc.done ? ` · ${fmtNum(tc.weeksLeft)} weeks after the as-of date` : ''}.`;
  if (tc.done) { $('target-body').innerHTML = '<p class="empty">All work is already complete.</p>'; return; }
  if (tc.past) { $('target-body').innerHTML = '<p class="empty">That date is on or before the as-of date.</p>'; return; }
  const v = tc.verdict && VERDICT[tc.verdict];
  const ratio = tc.avgPerWeek > 0 ? tc.requiredPerWeek / tc.avgPerWeek : null;
  const tiles = [
    ['Chance by target', tc.chance == null ? '—' : `${fmtNum(tc.chance * 100, 0)}%`, 'share of Monte Carlo runs done by then'],
    ['Required pace', `${fmtNum(tc.requiredPerWeek)} ${u}/wk`,
      ratio == null ? 'no velocity history yet' : `${fmtNum(ratio, 2)}× your ${fmtNum(tc.avgPerWeek)} ${u}/wk average`],
    ['To be 85% confident', tc.cut85 == null ? '—' : tc.cut85 > 0 ? `Cut ${fmtNum(tc.cut85)} ${u}` : 'No cuts needed',
      tc.capacity85 == null ? '' : `about ${fmtNum(tc.capacity85)} ${u} can be done by then in 85% of runs`],
  ];
  $('target-body').innerHTML =
    (v ? `<p class="verdict ${tc.verdict}"><span class="icon" aria-hidden="true">${v.icon}</span>${v.label}</p>` : '') +
    '<div class="tiles">' + tiles.map(([l, val, sub]) =>
      `<div class="tile"><div class="label">${l}</div><div class="value">${val}</div><div class="sub">${esc(sub)}</div></div>`).join('') + '</div>';
}

// ---------------------------------------------------------------- forecast history

function driftText(model) {
  const drift = P.forecastDrift(model.history || [], 'p50') || P.forecastDrift(model.history || [], 'linear');
  if (!drift) return null;
  const key = drift.first.p50 != null && drift.last.p50 != null ? 'p50' : 'linear';
  const label = key === 'p50' ? 'Monte Carlo P50' : 'linear-regression';
  const d = Math.abs(drift.perWeek);
  const span = `from ${fmtDay(model, drift.first[key])} (as of ${shortFmt.format(drift.first.asOf)}) to ${fmtDay(model, drift.last[key])} (as of ${shortFmt.format(drift.last.asOf)})`;
  if (drift.perWeek > 1) return { short: `slipping about ${fmtNum(d)} days per week`, long: `Slipping: the ${label} date has moved about ${fmtNum(d)} days later for every week that passed, ${span}.` };
  if (drift.perWeek < -1) return { short: `pulling in about ${fmtNum(d)} days per week`, long: `Pulling in: the ${label} date has moved about ${fmtNum(d)} days earlier for every week that passed, ${span}.` };
  return { short: 'holding steady', long: `Holding steady: the ${label} date has moved less than a day per week, ${span}.` };
}

// ---------------------------------------------------------------- data quality

function renderQuality(model) {
  const q = model.quality || [];
  $('quality-count').textContent = q.length ? String(q.length) : '';
  if (!q.length) {
    $('quality-list').innerHTML = '<li class="ok">✓ No data-quality issues found.</li>';
    return;
  }
  const keyList = (keys) => {
    const shown = keys.slice(0, 8).map(esc).join(', ');
    return keys.length > 8 ? `${shown} and ${keys.length - 8} more` : shown;
  };
  $('quality-list').innerHTML = q.map((f, i) =>
    `<li><span class="sev ${f.severity}">${f.severity === 'warning' ? 'Warning' : 'Note'}</span>` +
    `<div><div class="q-title">${esc(f.title)}</div><div class="q-detail">${esc(f.detail)}</div><div class="q-keys">${keyList(f.keys)}</div></div>` +
    (f.fix ? `<button type="button" class="ghost-button" data-fix="${i}">${esc(f.fix.label)}</button>` : '<span></span>') +
    '</li>').join('');
}

$('quality-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-fix]');
  if (!btn || !current || current.empty) return;
  const fix = current.quality[+btn.dataset.fix].fix;
  if (fix.type === 'excludeType') {
    settings.excludedTypes = [...new Set([...(settings.excludedTypes || []), fix.value])];
    document.querySelectorAll('#ctl-types input').forEach((i) => { if (i.value === fix.value) i.checked = false; });
  } else if (fix.type === 'setStart') {
    settings.start = fix.value;
    $('ctl-start').value = toInputDate(fix.value);
  }
  render();
});

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
  const drift = driftText(model);
  if (drift) lines.push(`Forecast trend: ${drift.short}.`);
  const tc = model.target;
  if (tc && !tc.past && !tc.done && tc.chance != null) {
    lines.push(`Target ${dateFmt.format(settings.target)}: ${fmtNum(tc.chance * 100, 0)}% chance (${VERDICT[tc.verdict].label.toLowerCase()}); needs ${fmtNum(tc.requiredPerWeek)} ${u}/week vs ${fmtNum(tc.avgPerWeek)} average` +
      (tc.cut85 > 0 ? `; cut about ${fmtNum(tc.cut85)} ${u} to be 85% confident.` : '.'));
  }
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
