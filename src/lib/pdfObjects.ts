import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";

/** Visit dictionary annotations in page order, retaining their page, array entry, and page index. */
export function* pageAnnotations(doc: PDFDocument) {
  const pages = doc.getPages();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    for (const ref of page.node.Annots()?.asArray() ?? []) {
      const dict = doc.context.lookup(ref);
      if (dict instanceof PDFDict) yield { page, pageIndex, ref, dict };
    }
  }
}

/** Decode a literal or UTF-16 PDF string, leaving absent or non-text entries undefined. */
export function readPdfText(dict: PDFDict, key: string): string | undefined {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFString || value instanceof PDFHexString
    ? value.decodeText()
    : undefined;
}
