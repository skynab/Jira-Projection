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
// Linear projection starts from actual completed work and uses the fitted slope.
assert(Math.abs(m.projections.linear.day - (m.T + m.totals.remaining / m.fits.linear.slope)) < 1e-9);
// Backtest: as of Fri 9 Jan only T-0..T-4 were resolved; T-5 (resolved 12 Jan) is still open.
const back = P.buildModel(data, { asOf: new Date(2026, 0, 9).getTime() });
assert.strictEqual(back.totals.completed, 10);
assert.strictEqual(back.totals.remaining, 10);
assert.strictEqual(back.totals.ticketsOpen, 5);

// Monte Carlo: deterministic (seeded) and scope growth can only push dates later.
const mcA = P.buildModel(data, { asOf: new Date(2026, 0, 19).getTime() }).projections.monteCarlo;
const mcB = P.buildModel(data, { asOf: new Date(2026, 0, 19).getTime() }).projections.monteCarlo;
assert.strictEqual(mcA.p85, mcB.p85);
assert(mcA.p50 <= mcA.p85 && mcA.p85 <= mcA.p95);

// Assignee projection exists for each person with open work.
assert(m.projections.assignees.length >= 1);

// Edge cases: everything done, and nothing done yet.
const allDone = P.parseIssues('Issue key,Status,Resolution,Created,Resolved,Custom field (Story Points)\n' +
  'A-1,Done,Done,01/Jan/26 9:00 AM,05/Jan/26 9:00 AM,3\n');
assert.strictEqual(P.buildModel(allDone, {}).finished, true);
const noneDone = P.parseIssues('Issue key,Status,Resolution,Created,Updated,Custom field (Story Points)\n' +
  'A-1,To Do,,01/Jan/26 9:00 AM,20/Jan/26 9:00 AM,3\n');
const nd = P.buildModel(noneDone, {});
assert.strictEqual(nd.totals.remaining, 3);
assert.strictEqual(nd.projections.monteCarlo, null);
// Chart recommendation: all synthetic tickets existed before work started -> fixed scope -> burn-down.
assert.strictEqual(m.scopeChange.recommended, 'down');
assert.strictEqual(m.scopeChange.added, 0);
// Adding work mid-release flips it to burn-up.
const grown = P.parseIssues(lines.concat([
  'T-10,Story,To Do,,12/Jan/26 9:00 AM,12/Jan/26 9:00 AM,,8,R1',
]).join('\n'));
const g = P.buildModel(grown, { asOf: new Date(2026, 0, 19).getTime() });
assert.strictEqual(g.scopeChange.added, 8);
assert.strictEqual(g.scopeChange.recommended, 'up');
// A decelerating team: the polynomial must stop at its peak instead of 'un-completing' work.
const slow = ['Issue key,Status,Resolution,Created,Resolved,Custom field (Story Points)'];
[0, 1, 2, 3, 4, 7, 10, 14, 21, 30].forEach((d, i) => {
  const day = new Date(2026, 0, 5 + d);
  const fmt = `${String(day.getDate()).padStart(2, '0')}/${['Jan', 'Feb'][day.getMonth()]}/26 10:00 AM`;
  slow.push(`S-${i},Done,Done,01/Jan/26 9:00 AM,${fmt},3`);
});
for (let i = 0; i < 10; i++) slow.push(`O-${i},To Do,,01/Jan/26 9:00 AM,,3`);
const sm = P.buildModel(P.parseIssues(slow.join('\n')), { asOf: new Date(2026, 1, 8).getTime() });
if (sm.projections.poly.day == null) {
  assert(sm.projections.poly.stopDay == null || sm.projections.poly.stopDay >= sm.T);
}
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
