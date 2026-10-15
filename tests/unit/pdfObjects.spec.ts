import { describe, expect, it } from "vite-plus/test";
import { PDFHexString, PDFName, PDFString } from "pdf-lib";
import { pageAnnotations, readPdfText } from "../../src/lib/pdfObjects";
import { makeDoc } from "./fixtures";

describe("PDF object helpers", () => {
  it("visits direct and indirect dictionaries in page order and skips non-dictionary entries", async () => {
    const doc = await makeDoc();
    const direct = doc.context.obj({ Type: "Annot", Subtype: "Widget" });
    const indirect = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Text" }));
    const final = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Ink" }));
    doc.getPage(1).node.set(PDFName.of("Annots"), doc.context.obj([direct, null, 42, indirect]));
    doc.getPage(2).node.addAnnot(final);
    const entries = [...pageAnnotations(doc)];
    expect(entries.map(({ ref, pageIndex }) => ({ ref, pageIndex }))).toEqual([
      { ref: direct, pageIndex: 1 },
      { ref: indirect, pageIndex: 1 },
      { ref: final, pageIndex: 2 },
    ]);
    expect(entries[0].page).toBe(doc.getPage(1));
    expect(entries[0].dict).toBe(direct);
    expect(entries[1].dict).toBe(doc.context.lookup(indirect));
  });

  it("decodes literal, Unicode, and indirect strings without coercing non-text PDF objects", async () => {
    const doc = await makeDoc(0);
    const dict = doc.context.obj({
      Literal: PDFString.of("A comment"),
      Unicode: PDFHexString.fromText("Note \u2713"),
      Indirect: doc.context.register(PDFHexString.fromText("Field name")),
      Number: 42,
      Name: PDFName.of("NotAString"),
    });
    expect(readPdfText(dict, "Literal")).toBe("A comment");
    expect(readPdfText(dict, "Unicode")).toBe("Note \u2713");
    expect(readPdfText(dict, "Indirect")).toBe("Field name");
    for (const key of ["Missing", "Number", "Name"]) expect(readPdfText(dict, key)).toBeUndefined();
  });
});
