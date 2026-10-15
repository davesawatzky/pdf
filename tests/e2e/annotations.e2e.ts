import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "fs";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";

async function dragMark(page: Page, tool: string, color: string, y: number): Promise<void> {
  await page.getByRole("button", { name: tool, exact: true }).click();
  await page.getByLabel(`${tool} color`, { exact: true }).fill(color);
  const surface = page.locator(".annotation-surface").first();
  await expect(surface).toHaveClass(/active/);
  const bounds = await surface.boundingBox();
  if (!bounds) throw new Error("Annotation surface is not visible");
  await page.mouse.move(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.35, bounds.y + bounds.height * (y + 0.01), {
    steps: 5,
  });
  await page.mouse.move(bounds.x + bounds.width * 0.55, bounds.y + bounds.height * (y + 0.04), {
    steps: 5,
  });
  await page.mouse.up();
  await expect(page.locator(".statusbar")).toContainText("Added annotation");
  await expect(page.getByRole("button", { name: tool, exact: true })).toBeEnabled();
}

test("annotations render, survive saving and reopening, and retain editable notes", async ({
  page,
}, testInfo) => {
  await page.goto("/?demo");
  const canvas = page.locator(".page-surface canvas").first();
  await expect(canvas).toBeVisible();
  await expect
    .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width))
    .toBeGreaterThan(300);
  let previous = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  for (const [tool, color, y] of [
    ["Highlight", "#ff8800", 0.15],
    ["Underline", "#ef5350", 0.25],
    ["Draw", "#2196f3", 0.35],
  ] as const) {
    await dragMark(page, tool, color, y);
    await expect
      .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL()))
      .not.toBe(previous);
    previous = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  }

  await page.getByRole("button", { name: "Sticky Note", exact: true }).click();
  await page.getByLabel("Sticky Note color", { exact: true }).fill("#81c784");
  await page
    .locator(".annotation-surface")
    .first()
    .click({ position: { x: 80, y: 100 } });
  const dialog = page.getByRole("dialog", { name: "Sticky note" });
  await dialog.getByLabel("Note text").fill("Review this section");
  await dialog.getByRole("button", { name: "Save note" }).click();
  const note = page.getByRole("button", {
    name: "Sticky note: Review this section",
    exact: true,
  });
  await expect(note).toBeVisible();
  await note.dblclick();
  await dialog.getByLabel("Note text").fill("Updated comment");
  await dialog.getByLabel("Note color", { exact: true }).fill("#ba68c8");
  await dialog.getByRole("button", { name: "Save note" }).click();
  await expect(dialog).not.toBeVisible();
  await page.keyboard.press("Escape");

  const pendingDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const download = await pendingDownload;
  const path = testInfo.outputPath("annotated.pdf");
  await download.saveAs(path);
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(path)));
  const annotations = doc
    .getPage(0)
    .node.Annots()!
    .asArray()
    .map((ref) => doc.context.lookup(ref, PDFDict));
  expect(annotations.map((dict) => dict.get(PDFName.of("Subtype"))?.toString())).toEqual(
    expect.arrayContaining(["/Highlight", "/Underline", "/Ink", "/Text"]),
  );

  const pendingPicker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open", exact: false }).click();
  const picker = await pendingPicker;
  await picker.setFiles(path);
  const updated = page.getByRole("button", {
    name: "Sticky note: Updated comment",
    exact: true,
  });
  await expect(updated).toBeVisible();
  await updated.dblclick();
  await expect(dialog.getByLabel("Note text")).toHaveValue("Updated comment");
  await expect(dialog.getByLabel("Note color", { exact: true })).toHaveValue("#ba68c8");
  await page.screenshot({ path: testInfo.outputPath("annotations.png") });
});

test("annotation placement works after rotating and zooming a page", async ({ page }) => {
  await page.goto("/?demo");
  await page.locator(".thumb").first().click();
  const canvas = page.locator(".page-surface canvas").first();
  await page.getByTitle("Rotate selected (or current) page right", { exact: true }).click();
  await expect
    .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width > element.height))
    .toBe(true);
  await page.getByTitle("Zoom in", { exact: true }).click();
  await dragMark(page, "Highlight", "#fff176", 0.2);
  await page.getByRole("button", { name: "Sticky Note", exact: true }).click();
  await page
    .locator(".annotation-surface")
    .first()
    .click({ position: { x: 100, y: 120 } });
  const dialog = page.getByRole("dialog", { name: "Sticky note" });
  await dialog.getByLabel("Note text").fill("Rotated note");
  await dialog.getByRole("button", { name: "Save note" }).click();
  const note = page.getByRole("button", { name: "Sticky note: Rotated note", exact: true });
  await expect(note).toBeVisible();
  const bounds = await note.boundingBox();
  const surface = await page.locator(".annotation-surface").first().boundingBox();
  if (!bounds || !surface) throw new Error("Missing note or page bounds");
  expect(bounds.x - surface.x).toBeCloseTo(100, 0);
  expect(bounds.y - surface.y).toBeCloseTo(120, 0);
});

async function dragSelection(page: Page, target: Locator, dx: number, dy: number): Promise<void> {
  const bounds = await target.boundingBox();
  if (!bounds) throw new Error("Missing selection bounds");
  const x = bounds.x + bounds.width / 2,
    y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up();
}

async function blueInkBounds(canvas: Locator) {
  let bounds: { x: number; y: number; width: number; height: number } | undefined;
  await expect(async () => {
    bounds = await canvas.evaluate((element: HTMLCanvasElement) => {
      const ctx = element.getContext("2d");
      if (!ctx) throw new Error("Missing canvas context");
      const { data } = ctx.getImageData(0, 0, element.width, element.height);
      let x1 = Infinity,
        y1 = Infinity,
        x2 = -Infinity,
        y2 = -Infinity;
      for (let y = 0; y < element.height; y++) {
        for (let x = 0; x < element.width; x++) {
          const i = (y * element.width + x) * 4;
          if (data[i] < 80 && data[i + 1] >= 100 && data[i + 1] < 200 && data[i + 2] > 200) {
            x1 = Math.min(x1, x);
            y1 = Math.min(y1, y);
            x2 = Math.max(x2, x);
            y2 = Math.max(y2, y);
          }
        }
      }
      if (!Number.isFinite(x1)) throw new Error("Blue ink was not rendered");
      return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    });
  }).toPass({ timeout: 5000 });
  if (!bounds) throw new Error("Blue ink bounds were not measured");
  return bounds;
}

test("selects, moves, resizes, and erases persisted annotations with safe keyboard behavior", async ({
  page,
}, testInfo) => {
  await page.goto("/?demo");
  const canvas = page.locator(".page-surface canvas").first();
  await expect(page.getByRole("button", { name: "Highlight", exact: true })).toBeEnabled();
  await dragMark(page, "Highlight", "#ff8800", 0.15);
  await dragMark(page, "Underline", "#ef5350", 0.25);
  await dragMark(page, "Draw", "#2196f3", 0.35);
  const inkBefore = await blueInkBounds(canvas);
  const ink = page.locator('.annotation-hit[aria-label="Select draw annotation"]').first();
  await page.keyboard.down("Control");
  await ink.click();
  await page.keyboard.up("Control");
  const outline = page.locator(".selection-outline");
  await expect(outline).toHaveCount(1);
  await expect(page.locator(".resize-handle")).toHaveCount(8);
  await expect(outline).toHaveCSS("cursor", "grab");
  const originalBox = await outline.boundingBox();
  if (!originalBox) throw new Error("Ink selection is missing");
  await dragSelection(page, outline, 40, 30);
  await expect
    .poll(async () => (await outline.boundingBox())?.x)
    .toBeCloseTo(originalBox.x + 40, 0);
  await expect.poll(async () => (await blueInkBounds(canvas)).x).toBeCloseTo(inkBefore.x + 40, 0);
  const movedBox = await outline.boundingBox();
  if (!movedBox) throw new Error("Moved selection is missing");
  await dragSelection(page, page.locator('[data-handle="se"]'), 60, 25);
  await expect
    .poll(async () => (await outline.boundingBox())?.width)
    .toBeCloseTo(movedBox.width + 60, 0);
  const resizedBox = await outline.boundingBox();
  if (!resizedBox) throw new Error("Resized selection is missing");
  await expect
    .poll(async () =>
      Math.abs(
        (await blueInkBounds(canvas)).width - (inkBefore.width * resizedBox.width) / movedBox.width,
      ),
    )
    .toBeLessThan(3);
  await page.screenshot({ path: testInfo.outputPath("annotation-selection.png") });

  await page.keyboard.press("Escape");
  const underlineHit = await page
    .locator('.annotation-hit[aria-label="Select underline annotation"]')
    .first()
    .boundingBox();
  if (!underlineHit) throw new Error("Underline hit target is missing");
  await page.mouse.click(
    underlineHit.x + underlineHit.width / 2,
    underlineHit.y + underlineHit.height / 2,
  );
  const underlineBox = await outline.boundingBox();
  if (!underlineBox) throw new Error("Underline selection is missing");
  await dragSelection(page, outline, 15, 10);
  await expect
    .poll(async () => (await outline.boundingBox())?.x)
    .toBeCloseTo(underlineBox.x + 15, 0);
  await dragSelection(page, page.locator('[data-handle="e"]'), 30, 0);
  await expect
    .poll(async () => (await outline.boundingBox())?.width)
    .toBeCloseTo(underlineBox.width + 30, 0);
  await page.locator('.annotation-hit[aria-label="Select highlight annotation"]').first().click();
  await page.keyboard.press("Delete");
  await expect(
    page.locator('.annotation-hit[aria-label="Select highlight annotation"]'),
  ).toHaveCount(0);
  await expect(outline).toHaveCount(0);
  await expect(page.locator(".thumb")).toHaveCount(3);

  await page.getByRole("button", { name: "Sticky Note", exact: true }).click();
  await page
    .locator(".annotation-surface")
    .first()
    .click({ position: { x: 280, y: 400 } });
  const dialog = page.getByRole("dialog", { name: "Sticky note" });
  await dialog.getByLabel("Note text").fill("Movable note");
  await dialog.getByRole("button", { name: "Save note" }).click();
  const note = page.getByRole("button", { name: "Sticky note: Movable note", exact: true });
  await note.click();
  await expect(page.locator(".resize-handle")).toHaveCount(0);
  await expect(outline).toHaveCount(1);
  const beforeNote = await note.boundingBox();
  if (!beforeNote) throw new Error("Sticky note is missing");
  await dragSelection(page, note, 35, 20);
  await expect.poll(async () => (await note.boundingBox())?.x).toBeCloseTo(beforeNote.x + 35, 0);
  await expect.poll(async () => (await note.boundingBox())?.y).toBeCloseTo(beforeNote.y + 20, 0);
  await page.getByRole("button", { name: "Edit note", exact: true }).click();
  await dialog.getByLabel("Note text").press("End");
  await dialog.getByLabel("Note text").press("Delete");
  await expect(note).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const savedInkBounds = await blueInkBounds(canvas);
  const pendingDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const download = await pendingDownload;
  const path = testInfo.outputPath("edited-annotations.pdf");
  await download.saveAs(path);
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(path)));
  const subtypes = doc
    .getPage(0)
    .node.Annots()!
    .asArray()
    .map((ref) => doc.context.lookup(ref, PDFDict).get(PDFName.of("Subtype"))?.toString());
  expect(
    subtypes.filter((type) => ["/Highlight", "/Underline", "/Ink", "/Text"].includes(type ?? "")),
  ).toEqual(["/Underline", "/Ink", "/Text"]);
  const pendingPicker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open", exact: false }).click();
  await (await pendingPicker).setFiles(path);
  await expect(note).toBeVisible();
  await expect.poll(() => blueInkBounds(canvas)).toEqual(savedInkBounds);
  await note.click();
  await page.keyboard.press("Delete");
  await expect(note).toHaveCount(0);
});

test("moves and resizes selections after rotation and zoom", async ({ page }) => {
  await page.goto("/?demo");
  await page.locator(".thumb").first().click();
  await page.getByTitle("Rotate selected (or current) page right", { exact: true }).click();
  const canvas = page.locator(".page-surface canvas").first();
  await expect
    .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width > element.height))
    .toBe(true);
  await page.getByTitle("Zoom in", { exact: true }).click();
  await dragMark(page, "Highlight", "#ff8800", 0.2);
  await page.keyboard.press("Escape");
  await page.locator('.annotation-hit[aria-label="Select highlight annotation"]').first().click();
  const outline = page.locator(".selection-outline");
  const original = await outline.boundingBox();
  if (!original) throw new Error("Missing rotated selection");
  await dragSelection(page, outline, 25, 20);
  await expect.poll(async () => (await outline.boundingBox())?.x).toBeCloseTo(original.x + 25, 0);
  await expect.poll(async () => (await outline.boundingBox())?.y).toBeCloseTo(original.y + 20, 0);
  await dragSelection(page, page.locator('[data-handle="se"]'), 50, 30);
  await expect
    .poll(async () => (await outline.boundingBox())?.width)
    .toBeCloseTo(original.width + 50, 0);
  await expect
    .poll(async () => (await outline.boundingBox())?.height)
    .toBeCloseTo(original.height + 30, 0);
  const beforeCancel = await outline.boundingBox();
  if (!beforeCancel) throw new Error("Missing selection before cancellation");
  await page.mouse.move(
    beforeCancel.x + beforeCancel.width / 2,
    beforeCancel.y + beforeCancel.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    beforeCancel.x + beforeCancel.width / 2 + 20,
    beforeCancel.y + beforeCancel.height / 2 + 15,
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(outline).toHaveCount(0);
  await page.locator('.annotation-hit[aria-label="Select highlight annotation"]').first().click();
  await expect.poll(() => outline.boundingBox()).toEqual(beforeCancel);
});
