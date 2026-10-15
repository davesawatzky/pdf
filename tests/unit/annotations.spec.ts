import { describe, expect, it } from "vite-plus/test";
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  degrees,
} from "pdf-lib";
import {
  addAnnotation,
  getAnnotations,
  getStickyNotes,
  isAnnotationTool,
  updateStickyNote,
  removeAnnotation,
  transformAnnotation,
} from "../../src/lib/annotations";
import type { PageAnnotation, Point } from "../../src/lib/annotations";
import { deletePages, loadDoc, mergePdfAt, movePage, saveDoc } from "../../src/lib/edits";
import { makeDoc, makeFormDoc } from "./fixtures";

const points: [Point, Point, Point, Point] = [
  { x: 20, y: 100 },
  { x: 180, y: 100 },
  { x: 20, y: 80 },
  { x: 180, y: 80 },
];
const note: PageAnnotation = {
  type: "sticky-note",
  color: "#ff8800",
  point: { x: 40, y: 150 },
  text: "  A comment \u2713  ",
};

describe("PDF annotations", () => {
  it.each(["highlight", "underline", "draw", "sticky-note"])("recognizes %s tools", (tool) => {
    expect(isAnnotationTool(tool)).toBe(true);
    expect(isAnnotationTool("view")).toBe(false);
  });

  describe("editing existing PDF annotations", () => {
    it.each(["highlight", "underline", "draw"] as const)(
      "moves and resizes %s geometry while preserving its appearance and metadata",
      async (type) => {
        const doc = await makeFormDoc();
        addAnnotation(doc, 0, { type, color: "#2196f3", points });
        const original = getAnnotations(doc)[0];
        const dict = doc.context.lookup(doc.getPage(0).node.Annots()!.asArray().at(-1)!, PDFDict);
        dict.set(PDFName.of("Contents"), PDFHexString.fromText("Keep my comment"));
        const appearance = dict.get(PDFName.of("AP"));
        transformAnnotation(doc, original.id, [2, 0, 0, 3, 10, -20]);
        expect(dict.get(PDFName.of("AP"))).toBe(appearance);
        const loaded = await loadDoc(await saveDoc(doc));
        const [updated] = getAnnotations(loaded);
        expect(updated).toMatchObject({
          id: original.id,
          page: 0,
          type,
          rect: { x: 46, y: 214, width: 328, height: 72 },
          paths: [points.map(({ x, y }) => ({ x: 2 * x + 10, y: 3 * y - 20 }))],
        });
        expect(loaded.getForm().getFields()).toHaveLength(4);
        expect(getAnnotations(loaded)).toHaveLength(1);
        transformAnnotation(loaded, updated.id, [1, 0, 0, 1, -5, 8]);
        expect(getAnnotations(loaded)[0].rect).toEqual({ x: 41, y: 222, width: 328, height: 72 });
      },
    );

    it("moves sticky notes without changing size, contents, or color", async () => {
      const doc = await makeDoc();
      addAnnotation(doc, 0, note);
      const original = getAnnotations(doc)[0];
      transformAnnotation(doc, original.id, [1, 0, 0, 1, 25, -30]);
      const loaded = await loadDoc(await saveDoc(doc));
      expect(getStickyNotes(loaded)[0]).toMatchObject({
        point: { x: 65, y: 120 },
        text: "A comment \u2713",
        color: "#ff8800",
      });
      expect(getAnnotations(loaded)[0].rect).toMatchObject({ width: 22, height: 22 });
      expect(() => transformAnnotation(doc, original.id, [2, 0, 0, 1, 0, 0])).toThrow(
        "not resized",
      );
    });

    it("transforms multiple highlight quadrilaterals and ink strokes", async () => {
      const doc = await makeDoc(1);
      const page = doc.getPage(0);
      const quads = [...points, ...points.map(({ x, y }) => ({ x, y: y - 40 }))];
      const mark = doc.context.obj({
        Type: "Annot",
        Subtype: "Highlight",
        Rect: [20, 40, 180, 100],
        QuadPoints: quads.flatMap(({ x, y }) => [x, y]),
      });
      page.node.addAnnot(doc.context.register(mark));
      const ink = doc.context.obj({
        Type: "Annot",
        Subtype: "Ink",
        Rect: [20, 40, 180, 100],
        InkList: [
          [20, 40, 30, 50],
          [60, 70, 80, 90],
        ],
      });
      page.node.addAnnot(doc.context.register(ink));
      for (const annotation of getAnnotations(doc))
        transformAnnotation(doc, annotation.id, [1, 0, 0, 1, 10, 20]);
      expect(getAnnotations(doc).map((annotation) => annotation.paths.length)).toEqual([2, 2]);
      expect(getAnnotations(doc)[1].paths).toEqual([
        [
          { x: 30, y: 60 },
          { x: 40, y: 70 },
        ],
        [
          { x: 70, y: 90 },
          { x: 90, y: 110 },
        ],
      ]);
    });

    it.each([
      [0, 0, 0, 1, 0, 0],
      [-1, 0, 0, 1, 0, 0],
      [1, 0, 0, Infinity, 0, 0],
      [1, 1, 0, 1, 0, 0],
      [1, 0, 1, 1, 0, 0],
      [1, 0, 0, 1, NaN, 0],
    ] satisfies import("../../src/lib/annotations").AnnotationTransform[])(
      "rejects invalid transforms without mutating the annotation",
      async (...matrix) => {
        const doc = await makeDoc();
        addAnnotation(doc, 0, { type: "highlight", points, color: "#fff176" });
        const original = getAnnotations(doc)[0];
        expect(() => transformAnnotation(doc, original.id, matrix)).toThrow("valid annotation");
        expect(getAnnotations(doc)[0]).toEqual(original);
      },
    );

    it("erases only the chosen annotation and its popup, preserving widgets and other marks", async () => {
      const doc = await makeFormDoc();
      addAnnotation(doc, 0, note);
      addAnnotation(doc, 0, { type: "highlight", points, color: "#fff176" });
      const original = getAnnotations(doc);
      const page = doc.getPage(0);
      const noteRef = page.node.Annots()!.asArray().at(-2)!;
      const dict = doc.context.lookup(noteRef, PDFDict);
      const popup = doc.context.register(
        doc.context.obj({
          Type: "Annot",
          Subtype: "Popup",
          Rect: [0, 0, 100, 100],
          Parent: noteRef,
        }),
      );
      dict.set(PDFName.of("Popup"), popup);
      page.node.addAnnot(popup);
      removeAnnotation(doc, original[0].id);
      const loaded = await loadDoc(await saveDoc(doc));
      expect(getStickyNotes(loaded)).toEqual([]);
      expect(getAnnotations(loaded)).toHaveLength(1);
      expect(getAnnotations(loaded)[0].id).toBe(original[1].id);
      expect(loaded.getPage(0).node.Annots()!.size()).toBe(3);
      expect(loaded.getForm().getFields()).toHaveLength(4);
    });

    it("does not allow editing unknown IDs or unsupported form widgets", async () => {
      const doc = await makeFormDoc();
      const widget = doc.getPage(0).node.Annots()!.get(0).toString();
      expect(() => removeAnnotation(doc, widget)).toThrow("cannot be edited");
      expect(() => removeAnnotation(doc, "missing")).toThrow("no longer exists");
      expect(() => transformAnnotation(doc, "missing", [1, 0, 0, 1, 10, 10])).toThrow(
        "no longer exists",
      );
      expect(getAnnotations(doc)).toEqual([]);
    });
  });

  it.each([
    ["highlight", "Highlight"],
    ["underline", "Underline"],
    ["draw", "Ink"],
  ] as const)(
    "serializes a standard %s annotation with a printable appearance",
    async (type, subtype) => {
      const doc = await makeDoc();
      addAnnotation(doc, 1, { type, points, color: "#ff8800" });
      const loaded = await loadDoc(await saveDoc(doc));
      const page = loaded.getPage(1);
      const dict = loaded.context.lookup(page.node.Annots()!.get(0), PDFDict);
      expect(dict.get(PDFName.of("Type"))).toBe(PDFName.of("Annot"));
      expect(dict.get(PDFName.of("Subtype"))).toBe(PDFName.of(subtype));
      expect(dict.get(PDFName.of("P"))).toEqual(page.ref);
      expect(dict.lookup(PDFName.of("F"), PDFNumber).asNumber()).toBe(4);
      expect(
        dict
          .lookup(PDFName.of("C"), PDFArray)
          .asArray()
          .map((value) => value.toString()),
      ).toEqual(["1", (136 / 255).toString(), "0"]);
      expect(dict.lookup(PDFName.of("Rect"), PDFArray).asRectangle()).toEqual({
        x: 18,
        y: 78,
        width: 164,
        height: 24,
      });
      const appearance = dict.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"));
      if (!(appearance instanceof PDFRawStream)) throw new Error("Missing annotation appearance");
      expect(appearance.dict.get(PDFName.of("Subtype"))).toBe(PDFName.of("Form"));
      expect(appearance.getContents().length).toBeGreaterThan(0);
      if (type === "draw") {
        expect(dict.lookup(PDFName.of("InkList"), PDFArray).lookup(0, PDFArray).size()).toBe(8);
        expect(
          dict.lookup(PDFName.of("BS"), PDFDict).lookup(PDFName.of("W"), PDFNumber).asNumber(),
        ).toBe(2);
      } else {
        expect(dict.lookup(PDFName.of("QuadPoints"), PDFArray).size()).toBe(8);
        expect(dict.lookup(PDFName.of("CA"), PDFNumber).asNumber()).toBe(
          type === "highlight" ? 0.35 : 1,
        );
      }
    },
  );

  it("round-trips Unicode sticky notes, colors, positions, and updates", async () => {
    const doc = await makeDoc();
    addAnnotation(doc, 1, note);
    const loaded = await loadDoc(await saveDoc(doc));
    expect(getStickyNotes(loaded)).toEqual([
      {
        id: expect.any(String),
        page: 1,
        point: { x: 40, y: 150 },
        color: "#ff8800",
        text: "A comment \u2713",
      },
    ]);
    const [saved] = getStickyNotes(loaded);
    updateStickyNote(loaded, saved.id, "  Updated \u2713  ", "#2196f3");
    const reopened = await loadDoc(await saveDoc(loaded));
    expect(getStickyNotes(reopened)[0]).toMatchObject({
      point: saved.point,
      page: 1,
      text: "Updated \u2713",
      color: "#2196f3",
    });
  });

  it("keeps notes with their pages through reorder, rotation, deletion, and merging", async () => {
    const doc = await makeFormDoc();
    addAnnotation(doc, 1, note);
    movePage(doc, 1, 0);
    doc.getPage(0).setRotation(degrees(90));
    deletePages(doc, [1]);
    expect(getStickyNotes(doc)[0].page).toBe(0);
    const target = await makeDoc(1);
    await mergePdfAt(target, await saveDoc(doc), 1);
    const loaded = await loadDoc(await saveDoc(target));
    expect(getStickyNotes(loaded)[0]).toMatchObject({
      page: 1,
      point: note.point,
      text: "A comment \u2713",
    });
    expect(loaded.getPage(1).getRotation().angle).toBe(90);
  });

  it("does not replace existing form widgets or other annotations", async () => {
    const doc = await makeFormDoc();
    const before = doc.getPage(0).node.Annots()!.size();
    addAnnotation(doc, 0, note);
    expect(doc.getPage(0).node.Annots()!.size()).toBe(before + 1);
    expect(getStickyNotes(doc)).toHaveLength(1);
    expect(doc.getForm().getFields()).toHaveLength(4);
    const id = doc.getPage(0).node.Annots()!.get(0).toString();
    expect(() => updateStickyNote(doc, id, "No", "#ffffff")).toThrow("no longer exists");
  });

  it("reads existing notes with optional content and colors", async () => {
    const doc = await makeDoc(1);
    const dict = doc.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [20, 30, 42, 52],
      Contents: PDFString.of("External"),
    });
    doc.getPage(0).node.addAnnot(doc.context.register(dict));
    expect(getStickyNotes(doc)[0]).toMatchObject({ text: "External", color: "#fff176" });
    dict.delete(PDFName.of("Contents"));
    expect(getStickyNotes(doc)[0].text).toBe("");
    dict.set(PDFName.of("Contents"), PDFHexString.fromText("Hex text"));
    dict.set(PDFName.of("AP"), doc.context.obj({}));
    updateStickyNote(doc, getStickyNotes(doc)[0].id, "Edited", "#ffffff");
    expect(dict.has(PDFName.of("AP"))).toBe(false);
  });

  it.each([
    { ...note, color: "red" },
    { ...note, text: "   " },
    { ...note, point: { x: NaN, y: 0 } },
    { type: "draw", color: "#ffffff", points: [] },
    { type: "draw", color: "#ffffff", points: [{ x: 1, y: 1 }] },
  ] satisfies PageAnnotation[])(
    "rejects invalid annotations without modifying the page",
    async (annotation) => {
      const doc = await makeDoc(1);
      expect(() => addAnnotation(doc, 0, annotation)).toThrow();
      expect(doc.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
    },
  );

  it("handles long freehand strokes without exceeding argument limits", async () => {
    const doc = await makeDoc(1);
    const path = Array.from({ length: 150000 }, (_, index) => ({ x: index % 300, y: index % 200 }));
    addAnnotation(doc, 0, { type: "draw", color: "#ffffff", points: path });
    expect(doc.getPage(0).node.Annots()!.size()).toBe(1);
  });

  it("rejects invalid page indices and missing note IDs", async () => {
    const doc = await makeDoc(1);
    expect(() => addAnnotation(doc, 99, note)).toThrow();
    expect(() => updateStickyNote(doc, "missing", "text", "#ffffff")).toThrow("no longer exists");
  });
});
