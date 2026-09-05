import { expect, test } from "@playwright/test";

/**
 * Smoke coverage for the pages a visitor can reach without a wallet.
 *
 * Run against a production build: `npm run build && npm run test:e2e`.
 */

test("landing page renders and offers a wallet connection", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Private invoices");
  await expect(page.getByText("Not connected")).toBeVisible();
});

test("dashboard prompts for a wallet when disconnected", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  // Either the wallet prompt or the not-configured notice, depending on env.
  await expect(
    page.getByText(/Wallet access needed|Escrow not configured/),
  ).toBeVisible();
});

test("new-invoice page renders its form scaffolding", async ({ page }) => {
  await page.goto("/invoices/new");
  await expect(page.getByRole("heading", { name: "New invoice" })).toBeVisible();
});

test("an invalid invoice id is reported rather than crashing", async ({ page }) => {
  await page.goto("/invoices/not-a-number");
  await expect(page.getByText("Invalid invoice id")).toBeVisible();
});

test("payment page renders for a numeric id", async ({ page }) => {
  await page.goto("/pay/1");
  await expect(page.getByRole("heading", { name: "Pay invoice #1" })).toBeVisible();
});

test.describe("mobile viewport (375px)", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  const paths = ["/", "/dashboard", "/invoices/new", "/pay/1"];
  for (const path of paths) {
    test(`no horizontal overflow at ${path}`, async ({ page }) => {
      await page.goto(path);
      // The document must not scroll sideways on a phone.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }

  test("bottom navigation is visible on mobile", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  });
});
