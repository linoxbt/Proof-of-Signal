import { expect, test, type Page } from "@playwright/test";

const BANNED = new RegExp(["rig" + "ging", "fra" + "ud", "suspi" + "cious"].join("|"), "i");

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

const PAGES: { path: string; ready: (p: Page) => Promise<void> }[] = [
  { path: "/", ready: (p) => expect(p.getByRole("heading", { name: "Coverage map" })).toBeVisible() },
  { path: "/night", ready: (p) => expect(p.getByTestId("night-units").locator("li").first()).toBeVisible() },
  { path: "/review", ready: (p) => expect(p.getByTestId("evidence-card")).toBeVisible() },
  { path: "/register", ready: (p) => expect(p.getByRole("table")).toBeVisible() },
  { path: "/pu/99-01-01-002", ready: (p) => expect(p.getByRole("heading", { name: "Demo Market Square" })).toBeVisible() },
  { path: "/method", ready: (p) => expect(p.getByText("b7d5353d28d476cce003057643212913f28ecfad425c61be9af3ac981c71ec74").first()).toBeVisible() },
];

for (const pg of PAGES) {
  test(`${pg.path} loads in demo mode with no console errors`, async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto(pg.path);
    await expect(page.getByTestId("demo-banner")).toContainText(/synthetic demo data/i);
    await pg.ready(page);
    await page.waitForTimeout(500);
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(BANNED);
    expect(errors).toEqual([]);
  });
}

test("night timeline shows the system-stall banner at the pause", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/night?step=4");
  await expect(page.getByTestId("night-units")).toBeVisible();
  await expect(page.getByTestId("stall-banner")).toHaveCount(0);
  await page.getByRole("button", { name: /Uploads pause/ }).click();
  await expect(page.getByTestId("stall-banner")).toContainText("Uploads paused system-wide: the cause is not field network coverage");
  await expect(page.getByTestId("night-units").locator('[data-bucket="held_system_stall"]').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("review flow: two-person rule and reason required for explained", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/review");
  const card = page.getByTestId("evidence-card");
  await expect(card).toContainText("Demo Market Square");
  await expect(card).toContainText("b7d5353d28d4");
  await expect(page.getByTestId("caveat")).toContainText("not a finding");

  // Explained without a reason is refused.
  await page.getByText("Explained", { exact: true }).last().click();
  await page.getByRole("button", { name: "Submit decision" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Write the reason" })).toBeVisible();

  // Reviewer A confirms → awaiting second.
  await page.getByText("Confirm concern", { exact: true }).click();
  await page.getByRole("button", { name: "Submit decision" }).click();
  await expect(page.getByTestId("two-person")).toHaveAttribute("data-status", "awaiting_second");
  await expect(page.getByTestId("already-reviewed")).toBeVisible();

  // Reviewer B confirms → confirmed by two reviewers.
  await page.getByLabel(/Acting as/).selectOption({ label: "Demo reviewer B" });
  await page.getByText("Confirm concern", { exact: true }).click();
  await page.getByRole("button", { name: "Submit decision" }).click();
  await expect(page.getByTestId("flag-list")).not.toContainText("Awaiting second reviewer", { timeout: 10_000 });
  expect(errors).toEqual([]);
});

test("language switch changes the UI and keeps labels", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/night?step=4");
  await page.getByLabel("Language").selectOption("pcm");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Election night");
  await expect(page.getByText("Network failure fit be the reason").first()).toBeVisible();
  await page.context().clearCookies();
  expect(errors).toEqual([]);
});
