import { expect, test } from "@playwright/test";
import { readFileSync } from "fs";
import { PDFDocument, PDFTextField } from "pdf-lib";

test("page and form history works through toolbar/shortcuts and saves the restored PDF", async ({
  page,
}, testInfo) => {
  await page.goto("/?demo");
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const redo = page.getByRole("button", { name: "Redo", exact: true });
  const canvas = page.locator(".page-surface canvas").first();
  await expect(page.locator(".thumb")).toHaveCount(3);
  await expect
    .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width))
    .toBeGreaterThan(300);
  const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();

  await page.getByRole("button", { name: "Rotate R", exact: false }).click();
  await expect(undo).toHaveAttribute("title", /Rotated 1 page/);
  await page.getByRole("button", { name: "+ Blank Page", exact: true }).click();
  await expect(page.locator(".thumb")).toHaveCount(4);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".thumb")).toHaveCount(3);
  await expect(redo).toHaveAttribute("title", /Inserted blank page/);
  await page.keyboard.press("Control+y");
  await expect(page.locator(".thumb")).toHaveCount(4);
  await undo.click();
  await expect(page.locator(".thumb")).toHaveCount(3);
  await undo.click();
  await expect(undo).toBeDisabled();
  await expect
    .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL()))
    .toBe(original);

  await page.getByRole("button", { name: "Form Fields", exact: true }).click();
  const input = page.locator(".form-panel .field input:not([type=checkbox])").first();
  const originalValue = await input.inputValue();
  await input.fill("History test");
  await page.getByRole("button", { name: "Apply Changes", exact: true }).click();
  await expect(redo).toBeDisabled();
  await expect(undo).toHaveAttribute("title", /Updated .* form field/);
  await page.keyboard.press("Control+z");
  await expect(input).toHaveValue(originalValue);
  await page.keyboard.press("Control+Shift+z");
  await expect(input).toHaveValue("History test");
  await undo.click();
  await expect(input).toHaveValue(originalValue);

  const pendingDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const download = await pendingDownload;
  const path = testInfo.outputPath("restored.pdf");
  await download.saveAs(path);
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(path)));
  expect(doc.getPageCount()).toBe(3);
  expect(doc.getPage(0).getRotation().angle).toBe(0);
  const text = doc
    .getForm()
    .getFields()
    .find((field) => field instanceof PDFTextField);
  if (!(text instanceof PDFTextField)) throw new Error("Expected the demo text field");
  expect(text.getText() ?? "").toBe(originalValue);
  await expect(redo).toBeEnabled();

  const pendingPicker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open", exact: false }).click();
  await (await pendingPicker).setFiles(path);
  await expect(page.locator(".statusbar")).toContainText("Opened restored.pdf");
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();
});

test("annotation history restores rendered marks, note contents, erasure, and selection", async ({
  page,
}) => {
  await page.goto("/?demo");
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const redo = page.getByRole("button", { name: "Redo", exact: true });
  const canvas = page.locator(".page-surface canvas").first();
  await expect
    .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width))
    .toBeGreaterThan(300);
  const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await page.getByRole("button", { name: "Draw", exact: true }).click();
  const surface = page.locator(".annotation-surface").first();
  const bounds = await surface.boundingBox();
  if (!bounds) throw new Error("Expected the annotation surface");
  await page.mouse.move(bounds.x + 80, bounds.y + 80);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 180, bounds.y + 110, { steps: 6 });
  await page.mouse.up();
  await expect(undo).toHaveAttribute("title", /Added annotation/);
  await expect
    .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL()))
    .not.toBe(original);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".annotation-hit")).toHaveCount(0);
  await expect
    .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL()))
    .toBe(original);
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator(".annotation-hit")).toHaveCount(1);
  await expect
    .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL()))
    .not.toBe(original);
  await undo.click();

  await page.getByRole("button", { name: "Sticky Note", exact: true }).click();
  await surface.click({ position: { x: 80, y: 100 } });
  const dialog = page.getByRole("dialog", { name: "Sticky note" });
  await dialog.getByLabel("Note text").fill("Original note");
  await dialog.getByRole("button", { name: "Save note" }).click();
  const note = page.getByRole("button", { name: "Sticky note: Original note", exact: true });
  await expect(note).toBeVisible();
  await expect(redo).toBeDisabled();
  await note.dblclick();
  await dialog.getByLabel("Note text").fill("Edited note");
  await page.keyboard.press("Control+z");
  await expect(dialog).toBeVisible();
  await expect(note).toBeVisible();
  await expect(undo).toHaveAttribute("title", /Added annotation/);
  await dialog.getByLabel("Note text").fill("Edited note");
  await dialog.getByRole("button", { name: "Save note" }).click();
  await expect(
    page.getByRole("button", { name: "Sticky note: Edited note", exact: true }),
  ).toBeVisible();
  await undo.click();
  await expect(note).toBeVisible();
  await page.keyboard.press("Escape");
  await note.click();
  await page.keyboard.press("Delete");
  await expect(note).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(note).toBeVisible();
  await expect(page.locator(".annotation-selection-box")).toBeVisible();
  await page.keyboard.press("Control+y");
  await expect(note).toHaveCount(0);
  await expect(page.locator(".annotation-selection-box")).toHaveCount(0);
});
