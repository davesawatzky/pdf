import { describe, expect, it, vi } from "vite-plus/test";
import { PDFName, StandardFonts, rgb } from "pdf-lib";
import * as edits from "../../src/lib/edits";
import { makeDoc, makeFormDoc, png } from "./fixtures";

describe("document serialization", () => {
  it("round-trips page dimensions and rotations", async () => {
    const doc = await makeDoc();
    edits.rotatePages(doc, [1], 1);
    const bytes = await edits.saveDoc(doc);
    expect(bytes).toBeInstanceOf(Uint8Array);
    const loaded = await edits.loadDoc(bytes);
    expect(loaded.getPages().map((page) => page.getSize())).toEqual(
      doc.getPages().map((page) => page.getSize()),
    );
    expect(loaded.getPage(1).getRotation().angle).toBe(90);
  });

  it("rejects corrupt input", async () => {
    await expect(edits.loadDoc(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});

describe("page operations", () => {
  it.each([
    [1, 90],
    [-1, 270],
  ] as const)("rotates selected pages in direction %s", async (direction, angle) => {
    const doc = await makeDoc();
    edits.rotatePages(doc, [2, 0], direction);
    expect(doc.getPages().map((page) => page.getRotation().angle)).toEqual([angle, 0, angle]);
  });

  it("wraps rotations in both directions", async () => {
    const doc = await makeDoc(1);
    for (let i = 0; i < 4; i++) edits.rotatePages(doc, [0], 1);
    expect(doc.getPage(0).getRotation().angle).toBe(0);
    edits.rotatePages(doc, [0], -1);
    edits.rotatePages(doc, [0], 1);
    expect(doc.getPage(0).getRotation().angle).toBe(0);
  });

  it("deletes unsorted indices without stale page caches or lost forms", async () => {
    const doc = await makeFormDoc();
    doc.addPage([100, 100]);
    doc.addPage([200, 200]);
    const kept = [doc.getPage(0).ref, doc.getPage(2).ref];
    edits.deletePages(doc, [1, 3]);
    expect(doc.getPages().map((page) => page.ref)).toEqual(kept);
    expect(doc.getPageIndices()).toEqual([0, 1]);
    const loaded = await edits.loadDoc(await edits.saveDoc(doc));
    expect(loaded.getPageCount()).toBe(2);
    expect(loaded.getForm().getTextField("Name")).toBeDefined();
  });

  it("leaves the document intact for an empty deletion", async () => {
    const doc = await makeDoc();
    const pages = doc.getPages();
    edits.deletePages(doc, []);
    expect(doc.getPages()).toEqual(pages);
  });

  it("reports an incompatible page cache rather than silently leaving stale pages", async () => {
    const doc = await makeDoc();
    for (const cache of [undefined, null, {}, { invalidate: false }]) {
      Object.defineProperty(doc, "pageCache", { value: cache, configurable: true });
      expect(() => edits.deletePages(doc, [])).toThrow("page cache cannot be invalidated");
    }
  });

  it.each([
    [0, 2, [310, 300, 320]],
    [2, 0, [320, 300, 310]],
    [0, 99, [310, 320, 300]],
    [2, -10, [320, 300, 310]],
    [1, 1, [300, 310, 320]],
    [-1, 2, [300, 310, 320]],
    [3, 0, [300, 310, 320]],
  ])("moves page %s to insertion boundary %s", async (from, to, widths) => {
    const doc = await makeDoc();
    const originalRefs = doc.getPages().map((page) => page.ref);
    edits.movePage(doc, from, to);
    expect(doc.getPages().map((page) => page.getWidth())).toEqual(widths);
    expect(new Set(doc.getPages().map((page) => page.ref))).toEqual(new Set(originalRefs));
    const loaded = await edits.loadDoc(await edits.saveDoc(doc));
    expect(loaded.getPages().map((page) => page.getWidth())).toEqual(widths);
  });

  it.each([0, 1, 3, 99])("copies a neighbor's size when inserting at %s", async (index) => {
    const doc = await makeDoc();
    const size = doc.getPage(Math.min(index, 2)).getSize();
    edits.insertBlankPage(doc, index);
    expect(doc.getPageCount()).toBe(4);
    expect(doc.getPage(Math.min(index, 3)).getSize()).toEqual(size);
  });

  it("uses letter size for an empty document", async () => {
    const doc = await makeDoc(0);
    edits.insertBlankPage(doc, 0);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
  });

  it.each([
    [-5, [100, 110, 300, 310, 320]],
    [1, [300, 100, 110, 310, 320]],
    [99, [300, 310, 320, 100, 110]],
  ])("merges pages in order at boundary %s", async (index, widths) => {
    const doc = await makeFormDoc();
    doc.addPage([320, 220]);
    const other = await makeDoc(0);
    other.addPage([100, 100]);
    other.addPage([110, 110]);
    expect(await edits.mergePdfAt(doc, await edits.saveDoc(other), index)).toBe(2);
    const loaded = await edits.loadDoc(await edits.saveDoc(doc));
    expect(loaded.getPages().map((page) => page.getWidth())).toEqual(widths);
    expect(loaded.getForm().getFields()).toHaveLength(4);
  });

  it("rejects a corrupt merge without changing existing pages", async () => {
    const doc = await makeDoc();
    await expect(edits.mergePdfAt(doc, new Uint8Array([1]), 1)).rejects.toThrow();
    expect(doc.getPageCount()).toBe(3);
  });

  it("returns zero for an empty source without adding a default page", async () => {
    const doc = await makeDoc();
    const empty = await makeDoc(0);
    const bytes = await empty.save({ addDefaultPage: false });
    expect(await edits.mergePdfAt(doc, bytes, 1)).toBe(0);
    expect(doc.getPageCount()).toBe(3);
  });
});

describe("form fields", () => {
  it("enumerates all supported field types, defaults, options, and page indices", async () => {
    const doc = await makeFormDoc();
    doc.getForm().createTextField("Hidden");
    expect(edits.getFormFields(doc)).toEqual([
      { name: "Name", type: "text", page: 0, value: "" },
      { name: "Agree", type: "checkbox", page: 0, value: false },
      { name: "Country", type: "dropdown", page: 1, value: "", options: ["US", "DE"] },
      { name: "Delivery", type: "radio", page: 1, value: "", options: ["Email", "Post"] },
      { name: "Hidden", type: "text", page: -1, value: "" },
    ]);
  });

  it("maps multi-page widgets to the first page and skips unsupported fields", async () => {
    const doc = await makeFormDoc();
    doc.getForm().getTextField("Name").addToPage(doc.getPage(1));
    doc.getForm().createButton("Submit").addToPage("Submit", doc.getPage(0));
    const fields = edits.getFormFields(doc);
    expect(fields.find((field) => field.name === "Name")?.page).toBe(0);
    expect(fields.some((field) => field.name === "Submit")).toBe(false);
  });

  it("persists all field values through serialization", async () => {
    const doc = await makeFormDoc();
    const values = { Name: "Ada Lovelace", Agree: true, Country: "DE", Delivery: "Email" };
    edits.setFormValues(doc, values);
    const loaded = await edits.loadDoc(await edits.saveDoc(doc));
    expect(Object.fromEntries(edits.getFormFields(loaded).map((f) => [f.name, f.value]))).toEqual(
      values,
    );
  });

  it("truncates text at MaxLen and converts non-text values", async () => {
    const doc = await makeFormDoc();
    doc.getForm().getTextField("Name").setMaxLength(3);
    edits.setFormValues(doc, { Name: "long name" });
    expect(doc.getForm().getTextField("Name").getText()).toBe("lon");
    edits.setFormValues(doc, { Name: false });
    expect(doc.getForm().getTextField("Name").getText()).toBe("fal");
  });

  it("clears choices and unchecks checkboxes", async () => {
    const doc = await makeFormDoc();
    edits.setFormValues(doc, { Agree: true, Country: "US", Delivery: "Post" });
    edits.setFormValues(doc, { Agree: false, Country: "", Delivery: "" });
    expect(edits.getFormFields(doc).map((field) => field.value)).toEqual(["", false, "", ""]);
  });

  it("does not replace valid choices with invalid options", async () => {
    const doc = await makeFormDoc();
    edits.setFormValues(doc, { Country: "US", Delivery: "Post" });
    edits.setFormValues(doc, { Country: "invalid", Delivery: "invalid" });
    expect(doc.getForm().getDropdown("Country").getSelected()).toEqual(["US"]);
    expect(doc.getForm().getRadioGroup("Delivery").getSelected()).toBe("Post");
  });

  it("reports unknown field names", async () => {
    const doc = await makeFormDoc();
    expect(() => edits.setFormValues(doc, { Missing: "value" })).toThrow();
  });

  it("returns no fields for a plain document", async () => {
    expect(edits.getFormFields(await makeDoc())).toEqual([]);
  });
});

describe("image and text insertion", () => {
  it("embeds a PNG, centers it, and persists the image resource", async () => {
    const doc = await makeDoc(1);
    const draw = vi.spyOn(doc.getPage(0), "drawImage");
    await edits.addImageToPage(doc, 0, png, 150, 100, 40);
    expect(draw).toHaveBeenCalledWith(expect.objectContaining({ width: 1, height: 1 }), {
      x: 130,
      y: 80,
      width: 40,
      height: 40,
    });
    const loaded = await edits.loadDoc(await edits.saveDoc(doc));
    expect(loaded.getPage(0).node.Resources()?.lookup(PDFName.of("XObject"))).toBeDefined();
  });

  it("caps image width and clamps placement inside page margins", async () => {
    const doc = await makeDoc(1);
    const draw = vi.spyOn(doc.getPage(0), "drawImage");
    await edits.addImageToPage(doc, 0, png, -100, -100, 1000);
    expect(draw).toHaveBeenCalledWith(expect.anything(), {
      x: 4,
      y: 4,
      width: 285,
      height: 285,
    });
    await edits.addImageToPage(doc, 0, png, 999, 999, 40);
    expect(draw).toHaveBeenLastCalledWith(expect.anything(), {
      x: 256,
      y: 156,
      width: 40,
      height: 40,
    });
  });

  it("routes non-PNG bytes to the JPEG decoder and propagates errors", async () => {
    const doc = await makeDoc(1);
    const jpeg = vi.spyOn(doc, "embedJpg");
    const invalid = new Uint8Array([0xff, 0xd8, 0xff]);
    await expect(edits.addImageToPage(doc, 0, invalid, 0, 0, 40)).rejects.toThrow();
    expect(jpeg).toHaveBeenCalledWith(invalid);
  });

  it("draws an image returned by the JPEG decoder", async () => {
    const doc = await makeDoc(1);
    const image = await doc.embedPng(png);
    const jpeg = vi.spyOn(doc, "embedJpg").mockResolvedValue(image);
    const draw = vi.spyOn(doc.getPage(0), "drawImage");
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    await edits.addImageToPage(doc, 0, bytes, 150, 100, 40);
    expect(jpeg).toHaveBeenCalledWith(bytes);
    expect(draw).toHaveBeenCalledWith(image, { x: 130, y: 80, width: 40, height: 40 });
  });

  it("draws text with the requested baseline, size, font, and color", async () => {
    const doc = await makeDoc(1);
    const font = vi.spyOn(doc, "embedFont");
    const draw = vi.spyOn(doc.getPage(0), "drawText");
    await edits.addTextToPage(doc, 0, "Hello", 20, 50, 18);
    expect(font).toHaveBeenCalledWith(StandardFonts.Helvetica);
    expect(draw).toHaveBeenCalledWith("Hello", {
      x: 20,
      y: 50,
      size: 18,
      font: expect.anything(),
      color: rgb(0.1, 0.1, 0.1),
    });
    const loaded = await edits.loadDoc(await edits.saveDoc(doc));
    expect(loaded.getPage(0).node.Contents()).toBeDefined();
  });
});
