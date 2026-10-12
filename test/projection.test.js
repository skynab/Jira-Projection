// Run: node test/projection.test.js [path/to/export.csv ...]
const assert = require('assert');
const fs = require('fs');
const P = require('../js/projection.js');

// Date parsing
const d = new Date(P.parseJiraDate('29/Sep/26 4:41 PM'));
assert.deepStrictEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2026, 8, 29, 16, 41]);
assert.strictEqual(new Date(P.parseJiraDate('01/Jan/26 12:05 AM')).getHours(), 0);
assert.strictEqual(new Date(P.parseJiraDate('2026-03-04 10:00')).getDate(), 4);

// Estimates: seconds and duration strings -> days at 8h/day
assert.strictEqual(P.estimateToDays('28800', 8), 1);
assert.strictEqual(P.estimateToDays('1w 2d 4h', 8), 7.5);

// Fibonacci bounds
assert.strictEqual(P.fibDown(5), 3);
assert.strictEqual(P.fibUp(5), 8);
assert.strictEqual(P.fibDown(1), 0.5);

// CSV with quotes, embedded newlines and duplicate headers
const rows = P.parseCsv('a,b,b\n"x, y","line1\nline2",""""\n');
assert.deepStrictEqual(rows, [['a', 'b', 'b'], ['x, y', 'line1\nline2', '"']]);

// Fits recover exact data
const xs = [0, 1, 2, 3, 4], ys = xs.map((x) => 2 * x * x - x + 3);
const poly = P.polyFit(xs, ys, 2);
assert(Math.abs(poly.at(10) - 193) < 1e-6);
const lin = P.linearFit(xs, xs.map((x) => 3 * x + 1));
assert(Math.abs(lin.slope - 3) < 1e-9 && Math.abs(lin.r2 - 1) < 1e-9);

// Synthetic release: 10 tickets x 2 pts, one finished per weekday from a Monday.
const lines = ['Issue key,Issue Type,Status,Resolution,Created,Updated,Resolved,Custom field (Story Points),Fix versions'];
for (let i = 0; i < 10; i++) {
  const day = 5 + i + Math.floor(i / 5) * 2; // Mon 5 Jan 2026 + weekdays
  const done = i < 6;
  const date = `${String(day).padStart(2, '0')}/Jan/26 10:00 AM`;
  lines.push(`T-${i},Story,${done ? 'Done' : 'To Do'},${done ? 'Done' : ''},01/Jan/26 9:00 AM,${date},${done ? date : ''},2,R1`);
}
const data = P.parseIssues(lines.join('\n'));
const m = P.buildModel(data, { asOf: new Date(2026, 0, 19).getTime() });
assert.strictEqual(m.totals.scope, 20);
assert.strictEqual(m.totals.completed, 12);
assert.strictEqual(m.totals.remaining, 8);
assert.strictEqual(m.weeks[0].velocity, 10);
assert(m.projections.velocity.day > m.T);
console.log('unit tests passed');

// Smoke-test real exports passed on the command line.
for (const file of process.argv.slice(2)) {
  const data = P.parseIssues(fs.readFileSync(file, 'utf8'));
  const model = P.buildModel(data, {});
  const fmt = (day) => (day == null ? '—' : new Date(P.addDays(model.start, Math.round(day))).toDateString());
  const p = model.projections;
  console.log(`\n${file}: ${data.issues.length} issues, columns`, data.columns);
  console.log('start', new Date(model.start).toDateString(), 'asOf', new Date(model.asOf).toDateString(), 'totals', model.totals);
  console.log('warnings', model.warnings);
  for (const k of ['linear', 'poly', 'scopeGrowth', 'velocity', 'optimistic', 'pessimistic', 'tickets']) {
    console.log(k.padEnd(12), fmt(p[k] && p[k].day), (p[k] && p[k].note) || '');
  }
  if (p.monteCarlo) console.log('MC p50/p85/p95', fmt(p.monteCarlo.p50), '/', fmt(p.monteCarlo.p85), '/', fmt(p.monteCarlo.p95));
  console.log('weekly velocity', model.weeks.map((w) => w.velocity + (w.complete ? '' : '*')).join(' '));
}
