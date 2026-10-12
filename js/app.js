/* Entry point: loading a CSV, the settings form, and the render pass. Math lives in projection.js. */
'use strict';

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
  if (settings.velBucket !== 2) settings.velBucket = 1;
  if (settings.velView !== 'type') settings.velView = 'total';
  $('flow-bucket').value = String(settings.flowBucket);
  if (!settings.statusCredit || typeof settings.statusCredit !== 'object') settings.statusCredit = {};
  $('credit-fieldset').hidden = !data.wipStatuses.length;
  $('ctl-credit').innerHTML = data.wipStatuses.map((st) =>
    `<label>${esc(st.name)} <span class="count">${st.count}</span>` +
    `<input type="number" min="0" max="100" step="5" data-status="${esc(st.name)}" value="${Math.round((settings.statusCredit[st.name] || 0) * 100)}">%</label>`).join('');
  loadTarget();
  $('vel-bucket').value = String(settings.velBucket);
  // Issue-type colours follow the type (ordered by how common it is in the whole file),
  // so filtering never repaints the remaining types.
  typeOrder = data.types.map((t) => t.name);
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
    case 'ctl-version': settings.version = t.value || null; loadTarget(); break;
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
      } else if (t.closest('#ctl-credit')) {
        // Keep credit for statuses not in this file (it's remembered across files).
        const credit = Object.assign({}, settings.statusCredit);
        document.querySelectorAll('#ctl-credit input').forEach((i) => {
          const v = Math.min(100, Math.max(0, +i.value || 0));
          if (v) credit[i.dataset.status] = v / 100; else delete credit[i.dataset.status];
        });
        settings.statusCredit = credit;
      } else if (t.closest('#ctl-resolutions')) {
        settings.deliveredResolutions = [...document.querySelectorAll('#ctl-resolutions input:checked')].map((i) => i.value);
      }
  }
  savePrefs();
  render();
});

// ---------------------------------------------------------------- render

function render() {
  if (!data) return;
  const model = P.buildModel(data, settings);
  model.history = model.empty ? [] : P.forecastHistory(data, settings, model);
  model.target = model.empty ? null : P.targetCheck(model, settings.target);
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
    ['headline', 'tiles', 'projection-table', 'weekly-table', 'assignee-table', 'remaining-table', 'quality-list', 'quality-count'].forEach((id) => ($(id).innerHTML = ''));
    Object.values(charts).forEach((c) => c.destroy());
    return;
  }
  if (!settings.start) $('ctl-start').value = toInputDate(model.start);
  if (!settings.asOf) $('ctl-asof').value = toInputDate(model.asOf);

  renderHeadline(model);
  renderTiles(model);
  renderProjectionTable(model);
  renderQuality(model);
  renderTarget(model);
  renderTrend(model);
  renderHistory(model);
  renderVelocity(model);
  renderTickets(model);
  renderMonteCarlo(model);
  renderWeekly(model);
  renderAssignees(model);
  renderRemaining(model);
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
