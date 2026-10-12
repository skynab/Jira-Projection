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

- **Burn-up**: cumulative scope vs completed work, with linear and polynomial regression lines, a scope-growth trend and an optimistic/pessimistic cone.
- **Projected finish dates** from linear regression, linear regression with scope growth, polynomial regression (degree 2 or 3), average velocity, min/max bounds, ticket completion rate, and Monte Carlo P50/P85/P95.
- **Velocity per week** with a rolling average.
- **Ticket completion rate**: tickets created vs completed per week.
- **Chance of finishing by date** from the Monte Carlo simulation.
- **Remaining tickets** table.

Min/max bounds use the Fibonacci scale for story points: each remaining ticket moves one step down (5 → 3) for the optimistic bound and one step up (5 → 8) for the pessimistic bound. These are combined with the fastest and slowest rolling-average velocity. For Original estimate, a ± percentage is used instead.

Tickets resolved as something other than delivered work (for example "No Action") are removed from scope. You can choose which resolutions count in the page.

## Tests

```bash
node test/projection.test.js [optional/path/to/export.csv]
```
