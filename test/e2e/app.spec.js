// Browser tests: load the page, drive the UI, and check what a user would see.
// The fixture is a made-up export with fixed dates (see test/fixtures/release.csv).
const path = require('path');
const { test, expect } = require('@playwright/test');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'release.csv');

let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/index.html');
});
test.afterEach(() => expect(errors).toEqual([]));

async function loadFixture(page) {
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('#headline .big')).toContainText('Likely finish');
}
const section = (page, id) => page.locator(`[data-section="${id}"]`);

test('loads a CSV and renders every section', async ({ page }) => {
  await loadFixture(page);
  await expect(page.locator('#file-line')).toContainText('release.csv · 29 issues');
  await expect(page.locator('#tiles .tile')).toHaveCount(6);
  for (const id of ['chart-burnup', 'chart-history', 'chart-velocity', 'chart-tickets', 'chart-mc']) {
    expect(await page.evaluate((c) => !!window.Chart.getChart(c), id), id).toBe(true);
  }
  await expect(page.locator('#projection-table tbody tr')).toHaveCount(11);
  await expect(page.locator('#remaining-table tbody tr')).toHaveCount(9);
});

test('flags a tracking ticket and applies the one-click fix', async ({ page }) => {
  await loadFixture(page);
  const list = page.locator('#quality-list');
  await expect(list).toContainText('open “Release” ticket counted as work');
  await page.getByRole('button', { name: 'Exclude Release tickets' }).click();
  await expect(list).not.toContainText('Release');
  await expect(page.locator('#ctl-types input[value="Release"]')).not.toBeChecked();
});

test('burn chart auto-picks burn-up and toggles to burn-down', async ({ page }) => {
  await loadFixture(page);
  await expect(page.locator('#trend-title')).toHaveText('Burn-Up with Projections');
  await expect(page.locator('#trend-why')).toContainText('Picked automatically');
  await page.locator('#trend-toggle button[data-mode="down"]').click();
  await expect(page.locator('#trend-title')).toHaveText('Burn-Down with Projections');
  await expect(page.locator('#trend-why')).toContainText('Suggested: burn-up');
});

test('ticket chart auto-picks the net view and switches back', async ({ page }) => {
  await loadFixture(page);
  await expect(page.locator('#flow-toggle button[data-mode="net"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#flow-toggle button[data-mode="split"]').click();
  await expect(page.locator('#tickets-sub')).toContainText('created vs completed');
});

test('projection table sorts by date and returns to its default order', async ({ page }) => {
  await loadFixture(page);
  const header = page.locator('#projection-table th:has(button[data-key="date"])');
  const firstMethod = () => page.locator('#projection-table tbody tr').first().locator('td').first();
  const dates = async () => (await page.locator('#projection-table tbody tr td:nth-child(2)').allTextContents())
    .map((t) => Date.parse(t)).filter((t) => !isNaN(t));

  await header.locator('button').click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  const desc = await dates();
  expect(desc).toEqual([...desc].sort((a, b) => b - a));

  await header.locator('button').click();
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
  const asc = await dates();
  expect(asc).toEqual([...asc].sort((a, b) => a - b));

  await header.locator('button').click();
  await expect(header).toHaveAttribute('aria-sort', 'none');
  await expect(firstMethod()).toContainText('Linear regression');
});

test('collapsed sections are remembered and left out of the PDF', async ({ page }) => {
  await loadFixture(page);
  await section(page, 'velocity').locator('.collapse-toggle').click();
  await expect(section(page, 'velocity')).toHaveClass(/collapsed/);

  await page.reload();
  await loadFixture(page);
  await expect(section(page, 'velocity')).toHaveClass(/collapsed/);

  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await expect(section(page, 'velocity')).toBeHidden();
  await expect(section(page, 'history')).toBeVisible();
  await expect(section(page, 'weekly')).toBeHidden(); // collapsed by default
  await expect(page.locator('#print-settings')).toBeVisible();
  await expect(page.locator('img.print-snapshot')).toHaveCount(5);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('img.print-snapshot')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveClass(/printing/);
});

test('target date shows a verdict and is remembered', async ({ page }) => {
  await loadFixture(page);
  await page.locator('#ctl-target').fill('2026-09-01');
  await expect(page.locator('#target-body .verdict')).toBeVisible();
  await expect(page.locator('#target-body .tile')).toHaveCount(3);
  await expect(page.locator('#target-body')).toContainText('Chance by target');

  await page.reload();
  await loadFixture(page);
  await expect(page.locator('#ctl-target')).toHaveValue('2026-09-01');
});

test('partial credit for Code Review lowers remaining work', async ({ page }) => {
  await loadFixture(page);
  const remaining = page.locator('#tiles .tile').nth(2).locator('.value');
  await expect(remaining).toHaveText('29 pts');
  const input = page.locator('#ctl-credit input[data-status="Code Review"]');
  await input.fill('50');
  await input.press('Tab');
  // Two 3-point tickets at 50% done leave 3 points of credit.
  await expect(remaining).toHaveText('26 pts');
  await expect(page.locator('#tiles .tile').nth(2)).toContainText('3 pts in-progress credit');
});

test('downloads a chart as PNG', async ({ page }) => {
  await loadFixture(page);
  const menu = page.locator('.export-menu[data-chart="chart-burnup"]');
  await menu.locator('summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    menu.getByRole('menuitem', { name: 'Light background' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('Demo_2.0-burnup-light.png');
});

test('copies a text summary', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await loadFixture(page);
  await page.getByRole('button', { name: 'Copy summary' }).click();
  await expect(page.locator('#copy-status')).toHaveText('Copied');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('*Demo 2.0*');
  expect(text).toContain('Likely finish:');
});

test('sample data loads without a file', async ({ page }) => {
  await page.getByRole('button', { name: 'Try sample data' }).click();
  await expect(page.locator('#file-line')).toContainText('Sample data (made up)');
  await expect(page.locator('#headline .big')).toContainText('Likely finish');
});
