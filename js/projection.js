/*
 * Jira release projection — parsing and math. No DOM access here so it can be
 * unit-tested from Node (`node test/projection.test.js`).
 */
(function (root) {
  'use strict';

  const MS_DAY = 86400000;
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  // Jira / planning-poker Fibonacci scale. Used to bound story-point estimates.
  const FIB = [0.5, 1, 2, 3, 5, 8, 13, 20, 40, 100];
  // Resolutions that mean "work was actually delivered". Anything else (No Action,
  // Won't Do, Duplicate, Cannot Reproduce...) is treated as removed from scope by default.
  const DELIVERED_RESOLUTIONS = ['done', 'fixed', 'complete', 'completed', 'resolved', 'released'];
  const MAX_HORIZON_DAYS = 3 * 365;

  // ---------------------------------------------------------------- dates

  function dayStart(ms) {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  function addDays(ms, n) {
    const d = new Date(ms);
    d.setDate(d.getDate() + n);
    return dayStart(d.getTime());
  }
  function dayDiff(a, b) {
    return Math.round((dayStart(a) - dayStart(b)) / MS_DAY);
  }
  function mondayOf(ms) {
    const wd = (new Date(ms).getDay() + 6) % 7;
    return addDays(ms, -wd);
  }

  // Jira exports dates like "29/Sep/26 4:41 PM" (the default dd/MMM/yy h:mm a format).
  // ISO-ish and anything Date.parse understands are accepted as fallbacks.
  function parseJiraDate(s) {
    s = (s || '').trim();
    if (!s) return null;
    let m = s.match(/^(\d{1,2})[\/\-\s]([A-Za-z]{3})[a-z]*[\/\-\s](\d{2,4})(?:[\sT]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?)?/);
    if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
      let y = +m[3];
      if (y < 100) y += 2000;
      let h = +(m[4] || 0);
      const min = +(m[5] || 0);
      if (m[6]) {
        const pm = m[6].toLowerCase() === 'pm';
        if (h === 12) h = pm ? 12 : 0;
        else if (pm) h += 12;
      }
      return new Date(y, MONTHS[m[2].toLowerCase()], +m[1], h, min).getTime();
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[\sT](\d{2}):(\d{2}))?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime();
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
  }

  // Jira exports time-tracking fields (Original estimate) in seconds. Duration
  // strings like "2d 4h" or "1w" are also accepted. Returns working days.
  function estimateToDays(raw, hoursPerDay) {
    raw = (raw || '').trim();
    if (!raw) return null;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return +raw / 3600 / hoursPerDay;
    const per = { w: 5, d: 1, h: 1 / hoursPerDay, m: 1 / (60 * hoursPerDay) };
    let total = 0;
    let found = false;
    raw.replace(/(\d+(?:\.\d+)?)\s*([wdhm])/gi, (_, n, u) => {
      total += +n * per[u.toLowerCase()];
      found = true;
    });
    return found ? total : null;
  }

  // ---------------------------------------------------------------- CSV

  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const nl = text.indexOf('\n');
    const firstLine = nl >= 0 ? text.slice(0, nl) : text;
    const delim = [',', ';', '\t']
      .map((d) => [d, firstLine.split(d).length])
      .sort((a, b) => b[1] - a[1])[0][0];

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else field += c;
      } else if (c === '"' && field === '') inQuotes = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((f) => f.trim() !== ''));
  }

  function parseIssues(text) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error('The file has no issue rows.');
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const one = (...names) => {
      for (const n of names) {
        const i = header.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    };
    const all = (...names) => header.map((h, i) => (names.includes(h) ? i : -1)).filter((i) => i >= 0);

    const c = {
      key: one('issue key', 'key'),
      type: one('issue type'),
      summary: one('summary'),
      status: one('status'),
      statusCat: one('status category'),
      statusCatChanged: one('status category changed'),
      resolution: one('resolution'),
      created: one('created'),
      updated: one('updated'),
      resolved: one('resolved', 'resolution date'),
      assignee: one('assignee'),
      origEst: one('original estimate', 'σ original estimate'),
      sp: all('custom field (story points)', 'custom field (story point estimate)', 'story points', 'story point estimate'),
      versions: all('fix versions', 'fix version/s', 'fix version'),
    };
    if (c.key < 0 || c.created < 0) {
      throw new Error('Could not find the "Issue key" and "Created" columns. Is this a Jira issue export?');
    }
    if (c.status < 0 && c.resolution < 0 && c.statusCat < 0) {
      throw new Error('Could not find a Status or Resolution column, so done-ness cannot be determined.');
    }

    const get = (r, i) => (i >= 0 && i < r.length ? r[i].trim() : '');
    const issues = [];
    for (const r of rows.slice(1)) {
      const key = get(r, c.key);
      const created = parseJiraDate(get(r, c.created));
      if (!key || created == null) continue;
      let sp = null;
      for (const i of c.sp) {
        const v = parseFloat(get(r, i));
        if (!isNaN(v)) { sp = v; break; }
      }
      issues.push({
        key,
        type: get(r, c.type) || 'Unknown',
        summary: get(r, c.summary),
        status: get(r, c.status),
        statusCat: get(r, c.statusCat),
        resolution: get(r, c.resolution),
        assignee: get(r, c.assignee),
        created,
        updated: parseJiraDate(get(r, c.updated)),
        resolvedAt: parseJiraDate(get(r, c.resolved)),
        statusCatChanged: parseJiraDate(get(r, c.statusCatChanged)),
        storyPoints: sp,
        origEstRaw: get(r, c.origEst),
        versions: c.versions.map((i) => get(r, i)).filter(Boolean),
      });
    }
    if (!issues.length) throw new Error('No rows with an issue key and a readable Created date.');

    const tally = (fn) => {
      const m = new Map();
      for (const it of issues) for (const v of [].concat(fn(it))) if (v) m.set(v, (m.get(v) || 0) + 1);
      return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    };

    return {
      issues,
      columns: {
        hasResolved: c.resolved >= 0,
        hasStatusCat: c.statusCat >= 0,
        hasStatusCatChanged: c.statusCatChanged >= 0,
        hasStoryPoints: c.sp.length > 0,
        hasOrigEst: c.origEst >= 0,
        hasVersions: c.versions.length > 0,
      },
      counts: {
        storyPoints: issues.filter((i) => i.storyPoints != null).length,
        origEst: issues.filter((i) => i.origEstRaw).length,
      },
      versions: tally((i) => i.versions),
      types: tally((i) => i.type),
      resolutions: tally((i) => resolutionLabel(i)),
      latestDate: Math.max(...issues.map((i) => Math.max(i.created, i.updated || 0, i.resolvedAt || 0))),
    };
  }

  // ---------------------------------------------------------------- per-issue helpers

  function isResolved(it) {
    if (it.statusCat) return it.statusCat.toLowerCase() === 'done';
    if (it.resolution) return it.resolution.toLowerCase() !== 'unresolved';
    return /^(done|closed|resolved|released|complete|completed|cancel+ed|won'?t do|no action)$/i.test(it.status);
  }
  function resolutionLabel(it) {
    if (!isResolved(it)) return null;
    return it.resolution || it.status || 'Done';
  }
  // Best available "finished" timestamp, plus whether it is only an approximation.
  function doneTimestamp(it) {
    if (it.resolvedAt) return { at: it.resolvedAt, approx: false };
    if (it.statusCatChanged) return { at: it.statusCatChanged, approx: false };
    return { at: it.updated || it.created, approx: true };
  }

  function fibIndex(x) {
    let best = 0;
    for (let i = 1; i < FIB.length; i++) if (Math.abs(FIB[i] - x) < Math.abs(FIB[best] - x)) best = i;
    return best;
  }
  function fibDown(x) {
    if (x <= 0) return 0;
    const i = fibIndex(x);
    return i > 0 ? FIB[i - 1] : x / 2;
  }
  function fibUp(x) {
    if (x <= 0) return 0;
    const i = fibIndex(x);
    return i < FIB.length - 1 ? FIB[i + 1] : x * 1.6;
  }

  // ---------------------------------------------------------------- statistics

  function linearFit(xs, ys) {
    const n = xs.length;
    if (n < 2) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    }
    if (sxx === 0) return null;
    const slope = sxy / sxx;
    const intercept = my - slope * mx;
    const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
    return { slope, intercept, r2, at: (x) => intercept + slope * x };
  }

  // Least-squares polynomial. x is normalised to [0, 1] over the fit window to keep
  // the normal equations well-conditioned.
  function polyFit(xs, ys, degree) {
    const n = xs.length;
    if (n <= degree) return null;
    const x0 = xs[0];
    const scale = xs[n - 1] - x0 || 1;
    const us = xs.map((x) => (x - x0) / scale);
    const k = degree + 1;
    const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const pw = [1];
      for (let j = 1; j < 2 * k; j++) pw.push(pw[j - 1] * us[i]);
      for (let r = 0; r < k; r++) {
        for (let c = 0; c < k; c++) A[r][c] += pw[r + c];
        A[r][k] += pw[r] * ys[i];
      }
    }
    // Gaussian elimination with partial pivoting.
    for (let col = 0; col < k; col++) {
      let piv = col;
      for (let r = col + 1; r < k; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      [A[col], A[piv]] = [A[piv], A[col]];
      if (Math.abs(A[col][col]) < 1e-12) return null;
      for (let r = 0; r < k; r++) {
        if (r === col) continue;
        const f = A[r][col] / A[col][col];
        for (let c = col; c <= k; c++) A[r][c] -= f * A[col][c];
      }
    }
    const coef = A.map((row, i) => row[k] / row[i]);
    const at = (x) => {
      const u = (x - x0) / scale;
      let y = 0;
      for (let i = k - 1; i >= 0; i--) y = y * u + coef[i];
      return y;
    };
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let ssr = 0, sst = 0;
    for (let i = 0; i < n; i++) {
      ssr += (ys[i] - at(xs[i])) ** 2;
      sst += (ys[i] - my) ** 2;
    }
    return { coef, at, r2: sst === 0 ? 1 : 1 - ssr / sst };
  }

  function percentile(sorted, p) {
    if (!sorted.length) return null;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[i];
  }

  function mean(arr) {
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  }

  // Seeded PRNG so Monte Carlo results don't jitter every time a control changes.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------- model

  const DEFAULT_SETTINGS = {
    version: null,            // fix version name, or null for every row
    excludedTypes: [],        // issue types to leave out
    unit: 'points',           // 'points' | 'days' | 'count'
    hoursPerDay: 8,
    fillMissing: 'median',    // 'median' | 'mean' | 'zero'
    deliveredResolutions: null, // lower-case resolution names that count as delivered work
    start: null,              // ms; defaults to the Monday of the first completion
    asOf: null,               // ms; defaults to the latest date in the file
    fitWeeks: 0,              // 0 = all history since start
    polyDegree: 2,
    rollWeeks: 2,
    daysUncertainty: 0.3,
    mcRuns: 5000,
  };

  function buildModel(data, userSettings) {
    const s = Object.assign({}, DEFAULT_SETTINGS, userSettings);
    const warnings = [];
    const delivered = new Set(
      (s.deliveredResolutions || data.resolutions.map((r) => r.name).filter((n) => DELIVERED_RESOLUTIONS.includes(n.toLowerCase())))
        .map((n) => n.toLowerCase())
    );
    const excluded = new Set(s.excludedTypes);

    let items = data.issues.filter((it) => !excluded.has(it.type));
    if (s.version) items = items.filter((it) => it.versions.includes(s.version));
    if (!items.length) return { empty: true, warnings: ['No issues match the current filters.'], settings: s };

    // --- estimates
    const rawEstimate = (it) => {
      if (s.unit === 'count') return 1;
      if (s.unit === 'points') return it.storyPoints;
      return estimateToDays(it.origEstRaw, s.hoursPerDay);
    };
    const known = items.map(rawEstimate).filter((v) => v != null && v > 0).sort((a, b) => a - b);
    let fill = 0;
    if (s.fillMissing === 'median' && known.length) fill = known[Math.floor((known.length - 1) / 2)];
    if (s.fillMissing === 'mean' && known.length) fill = mean(known);
    let unestimated = 0;

    let approxDone = 0;
    const rows = items.map((it) => {
      let est = rawEstimate(it);
      const missing = est == null;
      if (missing) { est = fill; unestimated++; }
      const resolved = isResolved(it);
      const label = resolutionLabel(it);
      const isDelivered = resolved && delivered.has((label || '').toLowerCase());
      const done = resolved ? doneTimestamp(it) : null;
      if (isDelivered && done.approx) approxDone++;
      return {
        it, est, missing, resolved, delivered: isDelivered,
        discarded: resolved && !isDelivered,
        doneAt: done ? done.at : null,
      };
    });
    if (unestimated) {
      const how = s.fillMissing === 'zero' ? 'counted as 0' : `filled with the ${s.fillMissing} (${round(fill)})`;
      warnings.push(`${unestimated} of ${items.length} tickets have no ${unitWord(s.unit)} estimate; ${how}.`);
    }
    if (approxDone) {
      warnings.push(`${approxDone} completed tickets have no Resolved date, so their Updated date is used instead. ` +
        'Use the "All fields" export (or add the Resolved column) for accurate completion dates.');
    }

    const scopeRows = rows.filter((r) => !r.discarded);
    const doneRows = rows.filter((r) => r.delivered);
    const openRows = rows.filter((r) => !r.resolved);
    const discardedRows = rows.filter((r) => r.discarded);

    // --- timeline
    const asOf = dayStart(s.asOf || data.latestDate);
    const firstDone = doneRows.length ? Math.min(...doneRows.map((r) => r.doneAt)) : null;
    const start = mondayOf(s.start || firstDone || Math.min(...items.map((r) => r.created)));
    const T = dayDiff(asOf, start);
    if (T < 0) return { empty: true, warnings: ['The start date is after the as-of date.'], settings: s };

    const scope = new Array(T + 1).fill(0);
    const done = new Array(T + 1).fill(0);
    const scopeN = new Array(T + 1).fill(0);
    const doneN = new Array(T + 1).fill(0);
    const createdPerDay = new Array(T + 1).fill(0);
    let baseScope = 0, baseDone = 0, baseScopeN = 0, baseDoneN = 0;
    for (const r of scopeRows) {
      const d = dayDiff(r.it.created, start);
      if (d < 0) { baseScope += r.est; baseScopeN++; }
      else if (d <= T) { scope[d] += r.est; scopeN[d]++; createdPerDay[d]++; }
    }
    for (const r of doneRows) {
      const d = dayDiff(r.doneAt, start);
      if (d < 0) { baseDone += r.est; baseDoneN++; }
      else if (d <= T) { done[d] += r.est; doneN[d]++; }
    }
    const cumulate = (arr, base) => { let acc = base; return arr.map((v) => (acc += v)); };
    const scopeCum = cumulate(scope, baseScope);
    const doneCum = cumulate(done, baseDone);
    const scopeNCum = cumulate(scopeN, baseScopeN);
    const doneNCum = cumulate(doneN, baseDoneN);

    const total = scopeCum[T];
    const completed = doneCum[T];
    const remaining = Math.max(0, openRows.reduce((a, r) => a + r.est, 0));
    const remainingLow = openRows.reduce((a, r) => a + boundEstimate(r.est, -1), 0);
    const remainingHigh = openRows.reduce((a, r) => a + boundEstimate(r.est, 1), 0);
    function boundEstimate(e, dir) {
      if (s.unit === 'points') return dir < 0 ? fibDown(e) : fibUp(e);
      if (s.unit === 'days') return e * (1 + dir * s.daysUncertainty);
      return e;
    }

    // --- weekly buckets (weeks start on Monday, week 0 = start week)
    const nWeeks = Math.floor(T / 7) + 1;
    const weeks = [];
    for (let w = 0; w < nWeeks; w++) {
      const a = w * 7;
      const b = Math.min(a + 6, T);
      weeks.push({
        index: w,
        start: addDays(start, a),
        complete: a + 6 <= T,
        velocity: doneCum[b] - (a === 0 ? baseDone : doneCum[a - 1]),
        ticketsDone: doneNCum[b] - (a === 0 ? baseDoneN : doneNCum[a - 1]),
        ticketsCreated: createdPerDay.slice(a, b + 1).reduce((x, y) => x + y, 0),
      });
    }
    const completeWeeks = weeks.filter((w) => w.complete);
    const windowWeeks = s.fitWeeks ? completeWeeks.slice(-s.fitWeeks) : completeWeeks;
    const vel = windowWeeks.map((w) => w.velocity);
    const ticketVel = windowWeeks.map((w) => w.ticketsDone);
    const rolling = [];
    for (let i = 0; i < completeWeeks.length; i++) {
      rolling.push(i >= s.rollWeeks - 1 ? mean(completeWeeks.slice(i - s.rollWeeks + 1, i + 1).map((w) => w.velocity)) : null);
    }
    const windowRolling = [];
    for (let i = 0; i < vel.length; i++) {
      if (i >= s.rollWeeks - 1) windowRolling.push(mean(vel.slice(i - s.rollWeeks + 1, i + 1)));
    }
    if (!windowRolling.length && vel.length) windowRolling.push(mean(vel));

    // --- regressions over the fit window (daily cumulative points)
    const fitStart = s.fitWeeks ? Math.max(0, T + 1 - s.fitWeeks * 7) : 0;
    const xs = [], ysDone = [], ysScope = [];
    for (let d = fitStart; d <= T; d++) { xs.push(d); ysDone.push(doneCum[d]); ysScope.push(scopeCum[d]); }
    const lin = linearFit(xs, ysDone);
    const poly = polyFit(xs, ysDone, s.polyDegree);
    const scopeLin = linearFit(xs, ysScope);

    // --- projections (day index relative to start; null = never / not enough data)
    const proj = {};
    const finished = remaining <= 0;
    const avgVel = mean(vel);

    if (finished) {
      proj.done = T;
    } else {
      if (lin && lin.slope > 0) {
        const d = (total - lin.intercept) / lin.slope;
        proj.linear = { day: Math.max(d, T), note: d < T ? 'Fit line is already past scope; showing today' : null };
      } else proj.linear = { day: null, note: 'No upward trend in the fit window' };

      if (poly) {
        let hit = null;
        for (let d = T; d <= T + MAX_HORIZON_DAYS; d++) if (poly.at(d) >= total) { hit = d; break; }
        proj.poly = { day: hit, note: hit == null ? 'Curve flattens out before reaching scope' : null };
      } else proj.poly = { day: null, note: 'Not enough data points' };

      if (lin && scopeLin && lin.slope > scopeLin.slope) {
        const d = (scopeLin.intercept - lin.intercept) / (lin.slope - scopeLin.slope);
        proj.scopeGrowth = { day: Math.max(d, T), scopeAt: scopeLin.at(Math.max(d, T)), note: null };
      } else if (scopeLin) {
        proj.scopeGrowth = { day: null, note: 'Scope is growing as fast as work is completed' };
      }

      const days = (amount, perWeek) => (perWeek > 0 ? T + (amount / perWeek) * 7 : null);
      proj.velocity = { day: days(remaining, avgVel), note: vel.length ? null : 'Needs at least one complete week' };
      const vMax = windowRolling.length ? Math.max(...windowRolling) : 0;
      const positive = windowRolling.filter((v) => v > 0);
      const vMin = positive.length ? Math.min(...positive) : 0;
      proj.optimistic = { day: days(remainingLow, vMax), velocity: vMax, amount: remainingLow };
      proj.pessimistic = { day: days(remainingHigh, vMin), velocity: vMin, amount: remainingHigh };
      const ticketsLeft = openRows.length;
      const avgTickets = mean(ticketVel);
      proj.tickets = { day: days(ticketsLeft, avgTickets), perWeek: avgTickets, left: ticketsLeft };

      proj.monteCarlo = monteCarlo(vel, remaining, T, s.mcRuns);
    }

    // --- chart horizon
    const candidates = [T + 28];
    for (const k of ['linear', 'poly', 'scopeGrowth', 'velocity', 'optimistic', 'pessimistic']) {
      if (proj[k] && proj[k].day != null) candidates.push(proj[k].day + 7);
    }
    if (proj.monteCarlo) candidates.push(proj.monteCarlo.p95 + 7);
    const horizon = Math.ceil(Math.min(T + MAX_HORIZON_DAYS, Math.max(...candidates)));

    return {
      settings: s,
      warnings,
      start, asOf, T, horizon,
      unit: s.unit,
      totals: {
        scope: total, completed, remaining, remainingLow, remainingHigh,
        tickets: scopeRows.length, ticketsDone: doneRows.length, ticketsOpen: openRows.length,
        ticketsDiscarded: discardedRows.length, baseScopeN,
        avgVelocity: avgVel, avgTickets: mean(ticketVel), weeksInWindow: vel.length,
      },
      series: { scopeCum, doneCum, scopeNCum, doneNCum },
      fits: { linear: lin, poly, scope: scopeLin, fitStart },
      weeks, rolling,
      projections: proj,
      finished,
      openRows: openRows.sort((a, b) => b.est - a.est),
      fill, unestimated,
    };
  }

  // Resample historical weekly velocity until the remaining work is burned down.
  function monteCarlo(velocities, remaining, T, runs) {
    if (!velocities.length || !velocities.some((v) => v > 0)) return null;
    const rnd = mulberry32(42);
    const out = [];
    for (let i = 0; i < runs; i++) {
      let rem = remaining;
      let w = 0;
      while (rem > 0 && w < 520) {
        const v = velocities[Math.floor(rnd() * velocities.length)];
        if (v >= rem) { w += rem / v; rem = 0; } else { rem -= v; w++; }
      }
      out.push(T + w * 7);
    }
    out.sort((a, b) => a - b);
    return {
      samples: out,
      p50: percentile(out, 0.5),
      p85: percentile(out, 0.85),
      p95: percentile(out, 0.95),
      probabilityBy: (day) => {
        let lo = 0, hi = out.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (out[m] <= day) lo = m + 1; else hi = m; }
        return lo / out.length;
      },
    };
  }

  function unitWord(unit) {
    return unit === 'points' ? 'story point' : unit === 'days' ? 'Original estimate' : 'ticket';
  }
  function round(v, dp = 1) {
    const f = 10 ** dp;
    return Math.round(v * f) / f;
  }

  const api = {
    MS_DAY, FIB, DEFAULT_SETTINGS, DELIVERED_RESOLUTIONS,
    parseCsv, parseIssues, parseJiraDate, estimateToDays, buildModel,
    linearFit, polyFit, fibDown, fibUp, dayStart, addDays, dayDiff, mondayOf, round,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Projection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
