import { expect } from "@playwright/test";

export async function checkBlueprintRules(page, tag) {
  const panel = page.locator("details.blueprint-rules");
  await panel.locator(":scope > summary").click();
  await expect(panel.getByRole("heading", {name: "Active rules"})).toBeVisible();
  await panel.getByLabel("What changes").selectOption("weld:setup");
  await panel.getByLabel("Allowance multiplier").fill("1.18");
  await panel.getByText("Limit to a material, process or customer").click();
  await panel.getByLabel("Customer name").fill("Rule fixture " + tag);
  await panel.getByLabel("Process", {exact: true}).selectOption("GTAW");
  await panel.getByLabel("Reason for this rule").fill("Fixture allowance " + tag);
  await panel.getByLabel("Approved by", {exact: true}).fill("Test reviewer");
  await panel.getByRole("button", {name: "Approve rule", exact: true}).click();
  const card = panel.locator("article").filter({hasText: "Fixture allowance " + tag});
  await expect(card).toContainText("Welding setup time × 1.18");
  await page.reload();
  await panel.locator(":scope > summary").click();
  await expect(card).toContainText("GTAW");
  await card.getByRole("button", {name: "Retire rule", exact: true}).click();
  await card.getByLabel("Retired by").fill("Test reviewer");
  await card.getByLabel("Reason for retiring").fill("Completed browser check");
  await card.getByRole("button", {name: "Save retirement"}).click();
  await expect(card).toHaveCount(0);
  await expect(panel.getByRole("status")).toContainText("Rule retired");
  await panel.locator(":scope > summary").click();
}
