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
  // Share of final scope added or removed after the release started above which a
  // burn-up is recommended; below it scope is effectively fixed and a burn-down reads best.
  const SCOPE_CHURN_THRESHOLD = 0.15;

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
    mcUncertainty: true,      // Monte Carlo: randomise each open ticket within its min/max bound
    mcScopeGrowth: false,     // Monte Carlo: replay each sampled week's scope additions too
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
      const assignee = it.assignee || 'Unassigned';
      return {
        it, est, missing, resolved, delivered: isDelivered, assignee,
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

    // Everything is evaluated "as of" a date, so moving it into the past gives an honest
    // backtest: tickets created later are ignored and tickets resolved later are still open.
    const asOf = dayStart(s.asOf || data.latestDate);
    const asOfEnd = addDays(asOf, 1) - 1;
    const visible = rows.filter((r) => r.it.created <= asOfEnd);
    for (const r of visible) {
      if (r.resolved && r.doneAt > asOfEnd) { r.resolved = r.delivered = r.discarded = false; r.resolvedLater = true; }
    }
    const scopeRows = visible.filter((r) => !r.discarded);
    const doneRows = visible.filter((r) => r.delivered);
    const openRows = visible.filter((r) => !r.resolved);
    const discardedRows = visible.filter((r) => r.discarded);
    if (!scopeRows.length) return { empty: true, warnings: ['No tickets existed by the as-of date.'], settings: s };

    // --- timeline
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
    const doneByType = new Map(); // issue type -> work completed per day
    for (const r of doneRows) {
      const d = dayDiff(r.doneAt, start);
      if (d < 0) { baseDone += r.est; baseDoneN++; }
      else if (d <= T) {
        done[d] += r.est; doneN[d]++;
        if (!doneByType.has(r.it.type)) doneByType.set(r.it.type, new Array(T + 1).fill(0));
        doneByType.get(r.it.type)[d] += r.est;
      }
    }
    const cumulate = (arr, base) => { let acc = base; return arr.map((v) => (acc += v)); };
    const scopeCum = cumulate(scope, baseScope);
    const doneCum = cumulate(done, baseDone);
    const scopeNCum = cumulate(scopeN, baseScopeN);
    const doneNCum = cumulate(doneN, baseDoneN);

    const total = scopeCum[T];
    const completed = doneCum[T];
    const remaining = Math.max(0, openRows.reduce((a, r) => a + r.est, 0));
    for (const r of openRows) { r.low = boundEstimate(r.est, -1); r.high = boundEstimate(r.est, 1); }
    const remainingLow = openRows.reduce((a, r) => a + r.low, 0);
    const remainingHigh = openRows.reduce((a, r) => a + r.high, 0);
    function boundEstimate(e, dir) {
      if (s.unit === 'points') return dir < 0 ? fibDown(e) : fibUp(e);
      if (s.unit === 'days') return e * (1 + dir * s.daysUncertainty);
      return e;
    }

    // --- how much scope moved during the release, and which chart that suggests
    const added = total - baseScope;
    const removed = discardedRows.filter((r) => r.doneAt >= start).reduce((a, r) => a + r.est, 0);
    const churnShare = total > 0 ? (added + removed) / total : 0;
    const scopeChange = {
      initial: baseScope, added, removed, churnShare,
      addedTickets: scopeNCum[T] - baseScopeN,
      addedTicketShare: scopeNCum[T] > 0 ? (scopeNCum[T] - baseScopeN) / scopeNCum[T] : 0,
      recommended: churnShare >= SCOPE_CHURN_THRESHOLD ? 'up' : 'down',
    };
    // Ticket-flow view: when a meaningful share of tickets arrived mid-release, the net
    // (completed - created) view answers "is the backlog actually shrinking?" directly.
    scopeChange.flowRecommended = scopeChange.addedTicketShare >= SCOPE_CHURN_THRESHOLD ? 'net' : 'split';

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
        scopeAdded: scopeCum[b] - (a === 0 ? baseScope : scopeCum[a - 1]),
        velocityByType: Object.fromEntries([...doneByType].map(([type, perDay]) =>
          [type, perDay.slice(a, b + 1).reduce((x, y) => x + y, 0)])),
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
      // Regressions supply the rate (and for the polynomial, the shape); projections start
      // from the actual completed work on the as-of date so charts and dates line up.
      if (lin && lin.slope > 0) {
        proj.linear = { day: T + remaining / lin.slope, note: null };
      } else proj.linear = { day: null, note: 'No upward trend in the fit window' };

      if (poly) {
        // Completed work can't go down, so the curve is only followed while it is rising.
        let hit = null, peak = null;
        const base = poly.at(T);
        for (let d = T + 1; d <= T + MAX_HORIZON_DAYS; d++) {
          if (poly.at(d) < poly.at(d - 1)) { peak = d - 1; break; }
          if (completed + poly.at(d) - base >= total) { hit = d; break; }
        }
        proj.poly = { day: hit, stopDay: hit == null ? peak : null, note: hit == null ? 'Curve flattens out before reaching scope' : null };
      } else proj.poly = { day: null, note: 'Not enough data points' };

      if (lin && scopeLin && lin.slope > scopeLin.slope) {
        const d = T + remaining / (lin.slope - scopeLin.slope);
        proj.scopeGrowth = { day: d, scopeAt: total + scopeLin.slope * (d - T), note: null };
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

      proj.monteCarlo = monteCarlo({
        weeks: windowWeeks, openRows, T, runs: s.mcRuns,
        uncertainty: s.mcUncertainty && s.unit !== 'count', scopeGrowth: s.mcScopeGrowth,
      });
      proj.assignees = assigneeProjections(visible, openRows, windowWeeks, start, T);
      const blocking = proj.assignees.filter((a) => a.remaining > 0 && a.day != null && a.name !== 'Unassigned');
      const worst = blocking.reduce((m, a) => (m == null || a.day > m.day ? a : m), null);
      const stuck = proj.assignees.filter((a) => a.remaining > 0 && a.day == null).map((a) => a.name);
      proj.bottleneck = {
        day: worst ? worst.day : null,
        name: worst ? worst.name : null,
        note: stuck.length ? `Not projectable (no recent throughput): ${stuck.join(', ')}` : null,
      };
    }

    // --- chart horizon
    const candidates = [T + 28];
    for (const k of ['linear', 'poly', 'velocity', 'optimistic', 'pessimistic']) {
      if (proj[k] && proj[k].day != null) candidates.push(proj[k].day + 7);
    }
    if (proj.monteCarlo && isFinite(proj.monteCarlo.p95)) candidates.push(proj.monteCarlo.p95 + 7);
    let horizon = Math.max(...candidates);
    // A far-off scope-growth crossing would squash the rest of the chart; its line just runs off the edge instead.
    if (proj.scopeGrowth && proj.scopeGrowth.day != null && proj.scopeGrowth.day - T <= 1.5 * (horizon - T)) {
      horizon = Math.max(horizon, proj.scopeGrowth.day + 7);
    }
    horizon = Math.ceil(Math.min(T + MAX_HORIZON_DAYS, horizon));

    const quality = dataQuality({ s, scopeRows, openRows, doneRows, start, asOfEnd, fill });

    return {
      settings: s,
      warnings,
      quality,
      start, asOf, T, horizon,
      unit: s.unit,
      totals: {
        scope: total, completed, remaining, remainingLow, remainingHigh,
        tickets: scopeRows.length, ticketsDone: doneRows.length, ticketsOpen: openRows.length,
        ticketsDiscarded: discardedRows.length, baseScopeN,
        avgVelocity: avgVel, avgTickets: mean(ticketVel), weeksInWindow: vel.length,
      },
      series: { scopeCum, doneCum, scopeNCum, doneNCum, scopePerDay: scope, scopeNPerDay: scopeN },
      scopeChange,
      fits: { linear: lin, poly, scope: scopeLin, fitStart },
      weeks, rolling,
      projections: proj,
      finished,
      openRows: openRows.sort((a, b) => b.est - a.est),
      fill, unestimated,
    };
  }

  // Per-assignee remaining work divided by that person's own weekly throughput in the
  // fit window. The slowest person bounds the release if work cannot be reassigned.
  function assigneeProjections(rows, openRows, windowWeeks, start, T) {
    const nWeeks = windowWeeks.length;
    const from = nWeeks ? dayDiff(windowWeeks[0].start, start) : 0;
    const to = nWeeks ? dayDiff(windowWeeks[nWeeks - 1].start, start) + 6 : -1;
    const by = new Map();
    const get = (name) => {
      if (!by.has(name)) by.set(name, { name, remaining: 0, open: 0, delivered: 0 });
      return by.get(name);
    };
    for (const r of openRows) { const a = get(r.assignee); a.remaining += r.est; a.open++; }
    for (const r of rows) {
      if (!r.delivered) continue;
      const d = dayDiff(r.doneAt, start);
      if (d >= from && d <= to) get(r.assignee).delivered += r.est;
    }
    return [...by.values()].map((a) => {
      a.perWeek = nWeeks ? a.delivered / nWeeks : 0;
      a.day = a.remaining <= 0 ? T : a.perWeek > 0 ? T + (a.remaining / a.perWeek) * 7 : null;
      a.note = a.remaining > 0 && a.perWeek <= 0 ? 'No completed work in the fit window' : null;
      return a;
    }).sort((x, y) => (y.day ?? Infinity) - (x.day ?? Infinity) || y.remaining - x.remaining);
  }

  // Resample historical weeks until the remaining work is burned down. Optionally
  // each open ticket's size is drawn from its min/nominal/max estimate, and each
  // sampled week also adds the scope that was added in that historical week.
  function monteCarlo({ weeks, openRows, T, runs, uncertainty, scopeGrowth }) {
    if (!weeks.length || !weeks.some((w) => w.velocity > 0)) return null;
    const rnd = mulberry32(42);
    const MAX_WEEKS = 260;
    const out = [];
    let unfinished = 0;
    for (let i = 0; i < runs; i++) {
      let rem = 0;
      for (const r of openRows) {
        if (!uncertainty) { rem += r.est; continue; }
        const x = rnd();
        rem += x < 0.25 ? r.low : x < 0.75 ? r.est : r.high;
      }
      let w = 0;
      while (rem > 0 && w < MAX_WEEKS) {
        const wk = weeks[Math.floor(rnd() * weeks.length)];
        const v = wk.velocity;
        if (v >= rem) { w += rem / v; rem = 0; break; }
        rem -= v;
        if (scopeGrowth) rem += Math.max(0, wk.scopeAdded);
        w++;
      }
      if (rem > 0) { unfinished++; out.push(Infinity); } else out.push(T + w * 7);
    }
    out.sort((a, b) => a - b);
    return {
      samples: out,
      unfinishedShare: unfinished / runs,
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

  // ---------------------------------------------------------------- data quality
  // Things in the export that commonly skew a forecast. Each finding names the tickets
  // involved and, where there is an obvious one, a fix the page can apply.

  const TRACKING_TYPES = /^(release|epic|initiative|test plan|test execution|test set)$/i;
  const STALE_DAYS = 30;

  function dataQuality({ s, scopeRows, openRows, doneRows, start, asOfEnd, fill }) {
    const out = [];
    const u = UNIT_ABBR[s.unit];
    const keys = (rows) => rows.map((r) => r.it.key);
    const sum = (rows) => round(rows.reduce((a, r) => a + r.est, 0));
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

    // Tracking tickets (a "Release" ticket, epics...) count as work but usually aren't.
    const byType = new Map();
    for (const r of openRows) if (TRACKING_TYPES.test(r.it.type)) byType.set(r.it.type, [...(byType.get(r.it.type) || []), r]);
    for (const [type, rows] of byType) {
      out.push({
        id: `tracking:${type}`, severity: 'warning',
        title: `${plural(rows.length, `open “${type}” ticket`)} counted as work`,
        detail: `${type} tickets usually track work rather than being work. ${rows.length === 1 ? 'It adds' : 'They add'} ${sum(rows)} ${u} to remaining work and can make ${rows.length === 1 ? 'its assignee' : 'their assignees'} look like the bottleneck.`,
        keys: keys(rows), fix: { type: 'excludeType', value: type, label: `Exclude ${type} tickets` },
      });
    }

    if (s.unit !== 'count') {
      const missing = openRows.filter((r) => r.missing);
      if (missing.length) {
        const how = s.fillMissing === 'zero' ? 'counted as zero' : `given the ${s.fillMissing} estimate (${round(fill)} ${u})`;
        out.push({
          id: 'unestimated', severity: missing.length / openRows.length > 0.2 ? 'warning' : 'info',
          title: `${plural(missing.length, 'open ticket')} without an estimate`,
          detail: `${missing.length === 1 ? 'It is' : 'They are'} ${how}. Estimating ${missing.length === 1 ? 'it' : 'them'} in Jira makes the forecast more reliable.`,
          keys: keys(missing),
        });
      }
      const zero = scopeRows.filter((r) => !r.missing && r.est === 0);
      if (zero.length) {
        out.push({
          id: 'zero', severity: 'info',
          title: `${plural(zero.length, 'ticket')} estimated at 0 ${u}`,
          detail: 'They count as no work, so they never move the burn-down or velocity.',
          keys: keys(zero),
        });
      }
      const big = openRows.filter((r) => !r.missing && r.est >= (s.unit === 'points' ? 13 : 10));
      if (big.length) {
        out.push({
          id: 'large', severity: 'info',
          title: `${plural(big.length, 'large open ticket')} (${s.unit === 'points' ? '13+ points' : '10+ days'})`,
          detail: `${sum(big)} ${u} of the remaining work sits in ${big.length === 1 ? 'this ticket' : 'these tickets'}, so ${big.length === 1 ? 'it dominates' : 'they dominate'} the uncertainty. Splitting ${big.length === 1 ? 'it' : 'them'} would tighten the range.`,
          keys: keys(big),
        });
      }
    }

    const unassigned = openRows.filter((r) => !r.it.assignee);
    if (unassigned.length) {
      out.push({
        id: 'unassigned', severity: 'info',
        title: `${plural(unassigned.length, 'open ticket')} unassigned`,
        detail: `${sum(unassigned)} ${u} with no owner. The assignee bottleneck can't account for ${unassigned.length === 1 ? 'it' : 'them'}.`,
        keys: keys(unassigned),
      });
    }

    const stale = openRows.filter((r) => r.it.updated && r.it.updated <= asOfEnd && (asOfEnd - r.it.updated) / MS_DAY > STALE_DAYS);
    if (stale.length) {
      out.push({
        id: 'stale', severity: 'info',
        title: `${plural(stale.length, 'open ticket')} not updated in ${STALE_DAYS}+ days`,
        detail: 'Check whether they still belong in this release.',
        keys: keys(stale),
      });
    }

    const early = doneRows.filter((r) => r.doneAt < start);
    if (early.length) {
      const first = mondayOf(Math.min(...early.map((r) => r.doneAt)));
      out.push({
        id: 'before-start', severity: 'warning',
        title: `${plural(early.length, 'ticket')} finished before the release start`,
        detail: `${sum(early)} ${u} count as already done on day one, so they don't show up in velocity. Either the start date is too late or older work was moved into this version.`,
        keys: keys(early), fix: { type: 'setStart', value: first, label: 'Start the release earlier' },
      });
    }

    const shared = scopeRows.filter((r) => r.it.versions.length > 1);
    if (shared.length) {
      out.push({
        id: 'multi-version', severity: 'info',
        title: `${plural(shared.length, 'ticket')} in more than one fix version`,
        detail: 'They count in full here and in the other versions too, which can double-count work across release forecasts.',
        keys: keys(shared),
      });
    }

    const rank = { warning: 0, info: 1 };
    return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  }

  // ---------------------------------------------------------------- forecast history
  // Re-runs the whole model as of the end of each past week (plus the current as-of
  // date) with the release start held fixed, so every run is on the same day axis.

  function forecastHistory(data, userSettings, model) {
    if (model.empty) return [];
    const s = Object.assign({}, userSettings, { start: model.start, mcRuns: 2000 });
    const dates = [];
    // Start once two full weeks exist; earlier forecasts are mostly noise.
    for (let w = 1; ; w++) {
      const d = addDays(model.start, w * 7 + 6);
      if (d >= model.asOf) break;
      dates.push(d);
    }
    dates.push(model.asOf);
    return dates.map((asOf) => {
      const m = asOf === model.asOf ? model : buildModel(data, Object.assign({}, s, { asOf }));
      const point = { asOf, day: dayDiff(asOf, model.start) };
      if (m.empty) return point;
      if (m.finished) return Object.assign(point, { finished: true });
      const p = m.projections;
      const finite = (v) => (v != null && isFinite(v) ? v : null);
      return Object.assign(point, {
        p50: p.monteCarlo ? finite(p.monteCarlo.p50) : null,
        p85: p.monteCarlo ? finite(p.monteCarlo.p85) : null,
        linear: finite(p.linear.day),
        scopeGrowth: p.scopeGrowth ? finite(p.scopeGrowth.day) : null,
        velocity: finite(p.velocity.day),
      });
    });
  }

  // Average change in a forecast series (days of finish date per week of as-of date).
  function forecastDrift(history, key) {
    const pts = history.filter((h) => h[key] != null);
    if (pts.length < 2) return null;
    const fit = linearFit(pts.map((h) => h.day), pts.map((h) => h[key]));
    return fit ? { perWeek: fit.slope * 7, first: pts[0], last: pts[pts.length - 1] } : null;
  }

  const UNIT_ABBR = { points: 'pts', days: 'days', count: 'tickets' };

  function unitWord(unit) {
    return unit === 'points' ? 'story point' : unit === 'days' ? 'Original estimate' : 'ticket';
  }
  function round(v, dp = 1) {
    const f = 10 ** dp;
    return Math.round(v * f) / f;
  }

  const api = {
    MS_DAY, FIB, DEFAULT_SETTINGS, DELIVERED_RESOLUTIONS, SCOPE_CHURN_THRESHOLD,
    parseCsv, parseIssues, parseJiraDate, estimateToDays, buildModel, forecastHistory, forecastDrift,
    linearFit, polyFit, fibDown, fibUp, dayStart, addDays, dayDiff, mondayOf, round,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Projection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
