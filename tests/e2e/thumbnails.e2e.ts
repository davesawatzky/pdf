import { expect, test, type Page } from "@playwright/test";

async function expectThumbnails(page: Page, count: number): Promise<void> {
  await expect(page.locator(".thumb")).toHaveCount(count);
  await expect
    .poll(() =>
      page
        .locator(".thumb-canvas")
        .evaluateAll((slots) => slots.map((slot) => slot.querySelectorAll("canvas").length)),
    )
    .toEqual(Array(count).fill(1));
  await expect(page.locator("canvas[data-previous-render]")).toHaveCount(0);
}

async function markPreviousRender(page: Page): Promise<void> {
  await page.locator(".thumb-canvas canvas").evaluateAll((canvases) => {
    for (const canvas of canvases) canvas.setAttribute("data-previous-render", "");
  });
}

test("page edits replace thumbnails without duplicating canvases or selection", async ({
  page,
}) => {
  await page.goto("/?demo");
  await expectThumbnails(page, 3);

  const thumbs = page.locator(".thumb");
  const firstCanvas = thumbs.first().locator("canvas");
  const originalSize = await firstCanvas.evaluate((canvas: HTMLCanvasElement) => ({
    width: canvas.width,
    height: canvas.height,
  }));
  await thumbs.first().click();

  for (const direction of ["right", "left", "right", "left"]) {
    await markPreviousRender(page);
    await page
      .getByTitle(`Rotate selected (or current) page ${direction}`, { exact: true })
      .click();
    await expectThumbnails(page, 3);
    const rotated = await firstCanvas.evaluate(
      (canvas: HTMLCanvasElement) => canvas.width / canvas.height,
    );
    const original = originalSize.width / originalSize.height;
    expect(rotated).toBeCloseTo(direction === "right" ? 1 / original : original, 1);
    await expect(page.locator(".thumb.selected")).toHaveCount(1);
  }

  await thumbs.nth(1).click();
  await expect(thumbs.first()).not.toHaveClass(/selected/);
  await expect(thumbs.nth(1)).toHaveClass(/selected/);
  await thumbs.nth(2).click({ modifiers: ["ControlOrMeta"] });
  await expect(page.locator(".thumb.selected")).toHaveCount(2);

  await markPreviousRender(page);
  await page.getByTitle("Rotate selected (or current) page right", { exact: true }).click();
  await expectThumbnails(page, 3);
  await expect(page.locator(".thumb.selected")).toHaveCount(2);

  await markPreviousRender(page);
  await page.getByTitle("Insert a blank page after the current page", { exact: true }).click();
  await expectThumbnails(page, 4);

  await thumbs.last().click();
  await markPreviousRender(page);
  await page.getByTitle("Delete selected pages (or the current one)", { exact: true }).click();
  await expectThumbnails(page, 3);
});
