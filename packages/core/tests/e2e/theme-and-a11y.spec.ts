import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("applies an explicit theme before any application code runs", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("periplo.theme", "dark"));
  // With the app bundle blocked, only the inline bootstrap script can have set the attribute.
  await page.route("**/main.tsx*", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#root")).toBeEmpty();
});

test("follows the system preference when there is no explicit choice", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe("rgb(12, 13, 14)");
});

for (const theme of ["light", "dark"] as const) {
  test(`has no WCAG A/AA violations in the ${theme} theme, grid included`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("periplo.theme", value), theme);
    await page.goto("/");
    await page.getByRole("button", { name: "Partial" }).click();
    await expect(page.getByRole("grid")).toHaveAttribute("aria-rowcount", "100001");
    await page.getByRole("gridcell").first().focus();

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(" | ")}`)).toEqual([]);
  });
}
