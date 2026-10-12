/*
 * Shared state and helpers for the page scripts.
 *
 * The js/ui/*.js files and js/app.js are classic scripts (not ES modules, so the page
 * still works when index.html is opened straight from disk). They share one global
 * scope and load in this order: core, charts, tables, panels, print, sections, app.
 * Top-level code may only use what earlier files define; functions can call anything.
 */
'use strict';

const P = window.Projection;
const $ = (id) => document.getElementById(id);

let data = null;
let fileName = '';
let chartMode = null; // 'up' | 'down' once the user picks one; null = follow the recommendation
let flowMode = null;  // 'split' | 'net' likewise for the ticket chart
let typeOrder = [];
const settings = {};
const charts = {};
let current = null; // the model from the latest render

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
const PERSIST = ['hoursPerDay', 'daysUncertainty', 'fillMissing', 'fitWeeks', 'polyDegree', 'rollWeeks', 'mcUncertainty', 'mcScopeGrowth', 'flowBucket', 'velBucket', 'velView', 'statusCredit'];
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
}
function savePrefs() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(PERSIST.filter((k) => k in settings).map((k) => [k, settings[k]]))));
  } catch (e) { /* storage unavailable: preferences just won't persist */ }
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
