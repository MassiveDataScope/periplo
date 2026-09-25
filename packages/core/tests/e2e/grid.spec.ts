import { expect, test, type Page } from "@playwright/test";

const grid = (page: Page) => page.getByRole("grid", { name: "Query results" });

async function loadAll(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Load 100k × 200" }).click();
  await expect(grid(page)).toHaveAttribute("aria-rowcount", "100001");
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
}

async function scrollTo(page: Page, top: number, left: number): Promise<void> {
  await grid(page).evaluate((element, position) => element.scrollTo(position.left, position.top), { top, left });
  await settle(page);
}

test("keeps mounted and formatted cells proportional to the viewport, not to the result", async ({ page }) => {
  await loadAll(page);
  await expect(grid(page)).toHaveAttribute("aria-colcount", "200");
  const cells = page.getByRole("gridcell");
  const initial = await cells.count();
  expect(initial).toBeGreaterThan(20);
  expect(initial).toBeLessThan(1200);

  for (const [top, left] of [[1_400_000, 0], [2_799_000, 31_000], [700_000, 15_000]] as const) {
    await page.evaluate(() => (window.__cellCalls = 0));
    await scrollTo(page, top, left);
    const mounted = await cells.count();
    const formatted = await page.evaluate(() => window.__cellCalls);
    expect(mounted).toBeLessThan(1200);
    expect(formatted).toBeGreaterThan(0);
    // Proportional to the viewport, not to the 20M-cell result. Slower CI runners paint a few extra frames
    // between the reset and the measurement, so the bound leaves room for them (4x flaked there, ~5x seen).
    expect(formatted).toBeLessThanOrEqual(mounted * 10);
  }

  await scrollTo(page, Number.MAX_SAFE_INTEGER, 0);
  await expect(page.getByRole("row").last()).toHaveAttribute("aria-rowindex", "100001");
  await expect(page.getByText("9007199254840992", { exact: true })).toBeVisible();
});

test("keeps the scroll position while batches keep arriving, through window and column resizes", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Stream slowly" }).click();
  await expect(grid(page)).toHaveAttribute("aria-rowcount", "10001");
  await scrollTo(page, 120_000, 0);
  const before = await grid(page).evaluate((element) => element.scrollTop);
  // 120,000px into 28px rows: row 4,290 sits inside the viewport and must stay there.
  const anchor = page.locator('[role="row"][aria-rowindex="4290"]');
  await expect(anchor).toBeInViewport();

  await page.setViewportSize({ width: 1000, height: 760 });
  const header = page.getByRole("columnheader").first();
  const widthBefore = (await header.boundingBox())?.width ?? 0;
  await header.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");

  await expect(grid(page)).toHaveAttribute("aria-rowcount", "100001", { timeout: 15_000 });
  expect(await grid(page).evaluate((element) => element.scrollTop)).toBe(before);
  await expect(anchor).toBeInViewport();
  expect((await header.boundingBox())?.width).toBe(widthBefore + 32);
  await expect(page.getByRole("region", { name: "Results grid" }).getByRole("progressbar")).toHaveCount(0);
});

test("never drops keyboard focus while moving across virtualized rows and columns", async ({ page }) => {
  await loadAll(page);
  await page.getByRole("gridcell").first().focus();
  for (let press = 0; press < 25; press++) await page.keyboard.press("PageDown");
  await page.keyboard.press("End");
  await settle(page);

  const active = await page.evaluate(() => ({
    role: document.activeElement?.getAttribute("role"),
    column: document.activeElement?.getAttribute("aria-colindex"),
    row: Number(document.activeElement?.parentElement?.getAttribute("aria-rowindex")),
  }));
  expect(active.role).toBe("gridcell");
  expect(active.column).toBe("200");
  expect(active.row).toBeGreaterThan(200);
  await expect(page.locator(":focus")).toBeInViewport();

  await page.keyboard.press("Control+Home");
  await settle(page);
  await expect(page.locator(":focus")).toHaveAttribute("aria-colindex", "1");
  expect(await page.locator(":focus").evaluate((element) => element.parentElement?.getAttribute("aria-rowindex"))).toBe("2");
});

test("says a partial result is partial and opens the exact value of a shortened cell", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Partial" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Partial result" })).toContainText("connection lost");

  const long = page.getByRole("gridcell", { name: /^long long/ }).first();
  await long.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Cell value" });
  await expect(dialog).toContainText("long ".repeat(80).trim());
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(":focus")).toHaveAttribute("role", "gridcell");
});
