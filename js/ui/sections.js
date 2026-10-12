/* Collapsible sections (remembered per browser; collapsed sections are left out of the PDF). */
'use strict';

// ---------------------------------------------------------------- collapsible sections
// Every [data-section] can be collapsed; the state is remembered in this browser and a
// collapsed section is left out of the PDF. <details> sections use their own toggle.

const COLLAPSE_KEY = 'jira-projection:collapsed';
let collapsedPrefs = {};
try { collapsedPrefs = JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {}; } catch (e) { collapsedPrefs = {}; }
function rememberCollapsed(id, collapsed) {
  collapsedPrefs[id] = collapsed;
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsedPrefs)); } catch (e) { /* not persisted */ }
}

function setCollapsed(section, collapsed) {
  section.classList.toggle('collapsed', collapsed);
  const btn = section.querySelector('.collapse-toggle');
  btn.setAttribute('aria-expanded', String(!collapsed));
  // Charts drawn while hidden have no size; redraw them once visible again.
  if (!collapsed) section.querySelectorAll('canvas').forEach((c) => { const ch = Chart.getChart(c); if (ch) ch.resize(); });
}

document.querySelectorAll('[data-section]').forEach((section) => {
  const id = section.dataset.section;
  if (section.tagName === 'DETAILS') {
    if (id in collapsedPrefs) section.open = !collapsedPrefs[id];
    section.addEventListener('toggle', () => rememberCollapsed(id, !section.open));
    return;
  }
  const h2 = section.querySelector('h2');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'collapse-toggle';
  btn.setAttribute('aria-expanded', 'true');
  const title = document.createElement('span');
  // Keep any id on the visible text so renderers can still retitle the section.
  if (h2.id) { title.id = h2.id; h2.removeAttribute('id'); }
  title.append(...h2.childNodes);
  btn.innerHTML = '<span class="chev" aria-hidden="true">▾</span>';
  btn.append(title);
  h2.append(btn);
  btn.addEventListener('click', () => {
    const collapsed = !section.classList.contains('collapsed');
    setCollapsed(section, collapsed);
    rememberCollapsed(id, collapsed);
  });
  if (collapsedPrefs[id]) setCollapsed(section, true);
});
