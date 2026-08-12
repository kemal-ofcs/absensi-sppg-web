import { expect, test } from "@playwright/test";

test("@smoke protects the dashboard and authenticates the starter admin", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await expect(
    page.getByLabel("Email or username", { exact: true }),
  ).toBeVisible();

  await page.getByLabel("Email or username", { exact: true }).fill("admin");
  await page.getByLabel("Password", { exact: true }).fill("admin123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByText("Authenticated successfully", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/hybrid-starter-login-dashboard.png",
    fullPage: true,
  });
});
