/*
 * Generates a made-up Jira "all fields"-style export so the page can be tried
 * without real data. Deterministic, and dated relative to today.
 */
(function (root) {
  'use strict';

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const PEOPLE = ['Alex Rivera', 'Sam Chen', 'Jordan Patel', 'Casey Morgan'];
  const POINTS = [1, 2, 2, 3, 3, 3, 5, 5, 8];
  const WORDS = ['Export', 'Login', 'Sync', 'Settings', 'Report', 'Import', 'Search', 'Cache', 'Upload', 'Dashboard'];
  const PROBLEMS = ['fails on large files', 'shows the wrong total', 'is slow after restart', 'needs a retry option', 'drops the last row', 'ignores user locale'];

  function rng(seed) {
    return () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
  }

  function fmt(d) {
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${String(d.getDate()).padStart(2, '0')}/${MONTHS[d.getMonth()]}/${String(d.getFullYear()).slice(2)} ` +
      `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
  }

  function csvField(v) {
    v = String(v);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }

  function generateSampleCsv() {
    const rand = rng(7);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const today = new Date();
    today.setHours(17, 0, 0, 0);
    const DAY = 86400000;
    const weeks = 8;
    const start = today.getTime() - weeks * 7 * DAY;

    const header = ['Summary', 'Issue key', 'Issue Type', 'Status', 'Status category', 'Resolution', 'Assignee',
      'Created', 'Updated', 'Resolved', 'Fix versions', 'Original estimate', 'Custom field (Story Points)'];
    const rows = [header];
    const n = 52;
    for (let i = 0; i < n; i++) {
      // 25 tickets exist at kick-off; the rest trickle in (scope growth).
      const created = i < 25 ? start - Math.floor(rand() * 30) * DAY : start + Math.floor(rand() * weeks * 7 * 0.9) * DAY;
      const pts = pick(POINTS);
      const assignee = rand() < 0.06 ? '' : pick(PEOPLE);
      // Older tickets are more likely to be finished; finish ~1.3 days per point after being picked up.
      const age = (today.getTime() - created) / DAY;
      const doneChance = Math.min(0.92, age / 45);
      const r = rand();
      let status = 'To Do', cat = 'To Do', resolution = '', resolved = null;
      if (r < doneChance) {
        const pickup = Math.max(created, start) + rand() * Math.max(1, today.getTime() - Math.max(created, start) - pts * 1.3 * DAY);
        resolved = Math.min(today.getTime() - DAY, pickup + pts * 1.3 * DAY * (0.6 + rand()));
        status = 'Done'; cat = 'Done'; resolution = rand() < 0.1 ? "Won't Do" : 'Done';
      } else if (r < doneChance + 0.15) {
        status = pick(['In Progress', 'Code Review', 'Test']); cat = 'In Progress';
      }
      const type = rand() < 0.55 ? 'Bug' : rand() < 0.85 ? 'Story' : 'Task';
      const summary = `${pick(WORDS)} ${type === 'Bug' ? pick(PROBLEMS) : 'improvements'}`;
      const updated = resolved || (i % 5 === 0 ? today.getTime() : created + rand() * (today.getTime() - created));
      rows.push([
        summary, `DEMO-${100 + i}`, type, status, cat, resolution, assignee,
        fmt(new Date(created)), fmt(new Date(updated)), resolved ? fmt(new Date(resolved)) : '',
        'Sample 1.0', String(pts * 8 * 3600), pts.toFixed(1),
      ]);
    }
    return rows.map((r) => r.map(csvField).join(',')).join('\n');
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { generateSampleCsv };
  else root.generateSampleCsv = generateSampleCsv;
})(typeof globalThis !== 'undefined' ? globalThis : this);
