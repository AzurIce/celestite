import { expect, type Page } from "@playwright/test";

export function vaultSwitcher(page: Page) {
  return page.getByRole("button", { name: "当前 Vault", exact: true });
}

export async function openVaultMenu(page: Page) {
  await vaultSwitcher(page).click();
  const menu = page.locator(".vault-switcher-menu");
  await expect(menu).toBeVisible();
  return menu;
}

export async function selectVault(page: Page, label: string | RegExp) {
  const menu = await openVaultMenu(page);
  await menu
    .getByRole("menuitemradio", {
      name: label,
      exact: typeof label === "string",
    })
    .click();
}

export async function expectActiveVault(page: Page, label: string) {
  const menu = await openVaultMenu(page);
  await expect(
    menu.getByRole("menuitemradio", { name: label, exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
}

export async function openVaultManager(page: Page) {
  const menu = await openVaultMenu(page);
  await menu.getByRole("menuitem", { name: "管理 Vault", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "管理 Vault", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
