# Jira Release Projection

A static web page that reads a Jira CSV export for one fix version and projects when the release will finish. It has no build step and no backend: the CSV is parsed in the browser and never uploaded.

## Run it

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

Then drop a CSV onto the page.

## Which export to use

In Jira, search for `fixVersion = "Motive 3.5.1 Final"` (or your version), then **Export → Export CSV (all fields)**.

| Export | Works? | Notes |
|---|---|---|
| **CSV (all fields)** | ✅ Preferred | Includes `Resolved`, `Status category changed`, `Story Points` and `Original estimate`. |
| CSV (current fields) | ⚠️ Approximate | The default column set has no completion date, so the app falls back to `Updated`. Any later edit to a ticket moves its "done" date. Add the **Resolved** column to your issue view before exporting to fix this. |

The "Excel CSV" variants (with a UTF-8 BOM) work too.

Columns the app reads: `Issue key`, `Issue Type`, `Summary`, `Status`, `Status category`, `Resolution`, `Created`, `Updated`, `Resolved`, `Assignee`, `Fix versions`, `Custom field (Story Points)` / `Custom field (Story point estimate)`, and `Original estimate` (exported in seconds; converted to days at a configurable hours per day).

## What it shows

- **Burn-up or burn-down**, with linear and polynomial regression projections, a scope-growth trend and an optimistic/pessimistic cone. The page picks the chart for each file: if more than 15% of the final scope was added or removed after the release started, it shows the burn-up (scope changes stay visible); otherwise the burn-down. A toggle switches between them, and on the burn-down, triangles mark days when work was added.
  Regressions are fitted to history but projected forward from the actual numbers on the as-of date, so both charts and the projections table agree.
- **Projected finish dates** from linear regression, linear regression with scope growth, polynomial regression (degree 2 or 3), average velocity, min/max bounds, ticket completion rate, and Monte Carlo P50/P85/P95.
- **Velocity**, either as a total with a rolling average or stacked by issue type (for example Bug vs Feature) to show where capacity goes. It can be grouped per week or per 2 weeks.
- **Ticket completion rate**, with two views: created vs completed per week, or net (completed − created) per week with a running total. Either view can be grouped per week or per 2 weeks (counted from the release start). Positive weeks mean the backlog shrank. The net view is picked automatically when at least 15% of tickets were created after the release started.
- **Chance of finishing by date** from the Monte Carlo simulation.
- **Remaining work by assignee**: each person's open work divided by their own recent throughput. The slowest person is reported as the assignee bottleneck.
- **Remaining tickets** table, plus a collapsible table of the weekly numbers behind the charts.

Monte Carlo options:
- **Randomise ticket sizes** (on by default): each open ticket's size is drawn from its optimistic, estimated or pessimistic size.
- **Keep adding scope** (off by default): each replayed week also adds the scope that was added in that historical week. Turn it on when tickets keep landing in the version.

Other features:
- **Backtesting**: set "As of" to a past date to see what the app would have predicted then. Tickets created later are ignored, and tickets resolved later count as open.
- **Copy summary** puts a Slack-ready text summary on the clipboard. **PNG** menus download each chart with a light, dark or transparent background, at 2× resolution. Light and dark use that theme's colours regardless of how the page is currently shown; transparent keeps the current theme's colours.
- **Try sample data** loads a made-up release, so you can demo the page without a real export.
- Modelling preferences (fit window, smoothing, Monte Carlo options and so on) are remembered in your browser.

Min/max bounds use the Fibonacci scale for story points: each remaining ticket moves one step down (5 → 3) for the optimistic bound and one step up (5 → 8) for the pessimistic bound. These are combined with the fastest and slowest rolling-average velocity. For Original estimate, a ± percentage is used instead.

Tickets resolved as something other than delivered work (for example "No Action") are removed from scope. You can choose which resolutions count in the page.

## Tests

```bash
node test/projection.test.js [optional/path/to/export.csv]
```
