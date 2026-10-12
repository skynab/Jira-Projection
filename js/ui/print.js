/* PDF export through the browser's print dialog. */
'use strict';

// ---------------------------------------------------------------- PDF export
// Uses the browser's print-to-PDF: text stays selectable and charts stay sharp. Before
// the dialog opens the page switches to a print layout in the light theme and every
// chart is re-drawn at the print width and 2x resolution; afterwards it's all restored.

let printState = null;

function settingsSummary(model) {
  const st = model.settings;
  const unitName = { points: 'Story points', days: `Original estimate (days, ${st.hoursPerDay} h/day)`, count: 'Ticket count' }[st.unit];
  const types = data.types.map((t) => t.name).filter((n) => !st.excludedTypes.includes(n));
  const delivered = st.deliveredResolutions || data.resolutions.map((r) => r.name).filter((n) => P.DELIVERED_RESOLUTIONS.includes(n.toLowerCase()));
  const mc = [st.mcUncertainty && st.unit !== 'count' && 'randomised ticket sizes', st.mcScopeGrowth && 'with scope growth'].filter(Boolean);
  return [
    ['Fix version', st.version || 'All issues in file'],
    ['Source file', fileName],
    ['Estimate by', unitName],
    ['Release start', dateFmt.format(model.start)],
    ['As of', dateFmt.format(model.asOf)],
    ['Fit window', st.fitWeeks ? `Last ${st.fitWeeks} weeks` : 'All weeks since start'],
    ['Polynomial degree', String(st.polyDegree)],
    ['Velocity smoothing', st.rollWeeks > 1 ? `${st.rollWeeks}-week rolling average` : 'None'],
    ['Monte Carlo', `5,000 runs${mc.length ? `, ${mc.join(', ')}` : ''}`],
    ['Issue types', types.join(', ') || 'None'],
    ['Counted as delivered', delivered.join(', ') || 'None'],
    ['In-progress credit', data.wipStatuses.map((w) => w.name).filter((n) => (st.statusCredit || {})[n]).map((n) => `${n} ${Math.round(st.statusCredit[n] * 100)}%`).join(', ') || 'None'],
    ['Target date', settings.target ? dateFmt.format(settings.target) : 'None'],
  ];
}

function preparePrint() {
  if (printState || !current || current.empty) return;
  const root = document.documentElement;
  printState = { theme: root.getAttribute('data-theme'), title: document.title };
  root.setAttribute('data-theme', 'light');
  document.body.classList.add('printing');
  const name = settings.version || fileName;
  $('print-title').textContent = `${name}: Release Projection`;
  $('print-meta').textContent = `Data as of ${dateFmt.format(current.asOf)} · Generated ${dateFmt.format(Date.now())}`;
  $('print-settings').innerHTML = settingsSummary(current).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  // The settings form itself never prints; its collapsed state controls the summary block instead.
  $('print-settings').hidden = $('controls').classList.contains('collapsed');
  // Browsers use the document title as the suggested PDF file name.
  document.title = `${name} projection ${toInputDate(current.asOf)}`;
  exporting.pixelRatio = 2;
  try {
    Object.values(chartRenderers).forEach((fn) => fn(current));
  } finally {
    exporting.pixelRatio = null;
  }
  // Print image snapshots instead of live canvases: browsers print <canvas> unreliably
  // (blurry or with stray blocks in Chrome's PDF output), while images print cleanly.
  for (const [id, chart] of Object.entries(charts)) {
    const canvas = $(id);
    if (!canvas || !chart.canvas) continue;
    const img = document.createElement('img');
    img.className = 'print-snapshot';
    img.alt = canvas.getAttribute('aria-label') || '';
    img.src = chart.toBase64Image('image/png');
    canvas.after(img);
    canvas.classList.add('print-hidden');
  }
}

function restorePrint() {
  if (!printState) return;
  const root = document.documentElement;
  if (printState.theme == null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', printState.theme);
  document.body.classList.remove('printing');
  document.querySelectorAll('img.print-snapshot').forEach((img) => img.remove());
  document.querySelectorAll('canvas.print-hidden').forEach((c) => c.classList.remove('print-hidden'));
  document.title = printState.title;
  printState = null;
  render();
}

window.addEventListener('beforeprint', preparePrint);
window.addEventListener('afterprint', restorePrint);
$('export-pdf').addEventListener('click', () => {
  preparePrint();
  window.print();
});
