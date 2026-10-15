/**
 * PDF editing and form inspection. Mutations are in place; callers serialize
 * with saveDoc and refresh the renderer after completing an operation.
 */
import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  degrees,
  rgb,
  StandardFonts,
} from "pdf-lib";
import { clamp } from "./geometry";
import { pageAnnotations, readPdfText } from "./pdfObjects";

export type { PDFDocument };

/**
 * Invalidate pdf-lib's private page cache after removals (insertions invalidate it themselves).
 * Fail explicitly if that dependency changes rather than returning a stale page list.
 */
function invalidatePageCache(doc: PDFDocument): void {
  const cache: unknown = Reflect.get(doc, "pageCache");
  if (
    typeof cache !== "object" ||
    cache === null ||
    !("invalidate" in cache) ||
    typeof cache.invalidate !== "function"
  )
    throw new Error("The PDF page cache cannot be invalidated.");
  cache.invalidate();
}

/** Remove pages at the given indices (0-based). */
export function deletePages(doc: PDFDocument, indices: number[]): void {
  for (const i of [...indices].sort((a, b) => b - a)) doc.removePage(i);
  invalidatePageCache(doc);
}

/** Move a zero-based page to an insertion boundary in the original list; `to === count` appends. */
export function movePage(doc: PDFDocument, from: number, to: number): void {
  const count = doc.getPageCount();
  if (from < 0 || from >= count) return;
  const target = clamp(to, 0, count);
  if (target === from) return;
  const page = doc.getPage(from);
  doc.removePage(from);
  const insertAt = from < target ? target - 1 : target;
  doc.insertPage(clamp(insertAt, 0, count - 1), page);
}

/** Insert a blank page at `index` (size copied from the neighbouring page). */
export function insertBlankPage(doc: PDFDocument, index: number): void {
  const pages = doc.getPages();
  const { width, height } = pages.length
    ? pages[Math.min(index, pages.length - 1)].getSize()
    : { width: 612, height: 792 };
  doc.insertPage(clamp(index, 0, pages.length), [width, height]);
}

/** Insert another PDF at a zero-based insertion boundary and return the number of copied pages. */
export async function mergePdfAt(
  doc: PDFDocument,
  otherBytes: Uint8Array,
  index: number,
): Promise<number> {
  const other = await loadDoc(otherBytes);
  const count = other.getPageCount();
  if (count === 0) return 0;
  const copied = await doc.copyPages(other, other.getPageIndices());
  const at = clamp(index, 0, doc.getPageCount());
  for (let k = 0; k < count; k++) {
    doc.insertPage(at + k, copied[k]);
  }
  return count;
}

/** Load a document from bytes. Throws on encrypted/corrupt input. */
export async function loadDoc(bytes: Uint8Array): Promise<PDFDocument> {
  return await PDFDocument.load(bytes);
}

/** Serialize the document back to bytes. */
export async function saveDoc(doc: PDFDocument): Promise<Uint8Array> {
  const out = await doc.save();
  return new Uint8Array(out);
}

/** Rotate the given (0-based) page indices by ±90°. */
export function rotatePages(doc: PDFDocument, indices: number[], dir: 1 | -1): void {
  for (const i of [...indices].sort((a, b) => a - b)) {
    const page = doc.getPage(i);
    const current = page.getRotation().angle;
    const next = (((current + (dir === 1 ? 90 : -90)) % 360) + 360) % 360;
    page.setRotation(degrees(next));
  }
}

/** Recognize PNG bytes; other image input is passed to the JPEG decoder for validation. */
function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

/** Draw an image centered on (x, y) in PDF points. */
export async function addImageToPage(
  doc: PDFDocument,
  pageIndex: number,
  imageBytes: Uint8Array,
  x: number,
  y: number,
  widthPt: number,
): Promise<void> {
  const page = doc.getPage(pageIndex);
  const image = isPng(imageBytes) ? await doc.embedPng(imageBytes) : await doc.embedJpg(imageBytes);
  const pageSize = page.getSize();
  const width = Math.min(widthPt, pageSize.width * 0.95);
  const height = (width / image.width) * image.height;
  const left = clamp(x - width / 2, 4, pageSize.width - width - 4);
  const bottom = clamp(y - height / 2, 4, pageSize.height - height - 4);
  page.drawImage(image, { x: left, y: bottom, width, height });
}

/** Draw text with its baseline origin at (x, y) in PDF points. */
export async function addTextToPage(
  doc: PDFDocument,
  pageIndex: number,
  text: string,
  x: number,
  y: number,
  sizePt: number,
): Promise<void> {
  const page = doc.getPage(pageIndex);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x, y, size: sizePt, font, color: rgb(0.1, 0.1, 0.1) });
}

export type FormFieldType = "text" | "checkbox" | "radio" | "dropdown";
export type FormValues = Record<string, string | boolean>;

export interface FormFieldInfo {
  name: string;
  type: FormFieldType;
  page: number; // 0-based, -1 if unknown
  value: string | boolean;
  options?: string[];
}

/**
 * Map each form-field name to the (0-based) index of the first page that
 * carries one of its widgets. Widget annotations reference their parent
 * field dict via /Parent, whose /T holds the field name.
 */
function fieldPageMap(doc: PDFDocument): Map<string, number> {
  const map = new Map<string, number>();
  for (const { dict, pageIndex } of pageAnnotations(doc)) {
    const parent = dict.get(PDFName.of("Parent"));
    if (!parent) continue;
    const fieldDict = doc.context.lookup(parent);
    if (!(fieldDict instanceof PDFDict)) continue;
    const name = readPdfText(fieldDict, "T");
    if (name !== undefined && !map.has(name)) map.set(name, pageIndex);
  }
  return map;
}

/** Enumerate all fillable AcroForm fields in the document. */
export function getFormFields(doc: PDFDocument): FormFieldInfo[] {
  const form = doc.getForm();
  const pages = fieldPageMap(doc);
  const fields: FormFieldInfo[] = [];
  for (const field of form.getFields()) {
    const name = field.getName();
    const common = { name, page: pages.get(name) ?? -1 };
    if (field instanceof PDFTextField) {
      fields.push({
        ...common,
        type: "text",
        value: field.getText() ?? "",
      });
    } else if (field instanceof PDFCheckBox) {
      fields.push({
        ...common,
        type: "checkbox",
        value: field.isChecked(),
      });
    } else if (field instanceof PDFRadioGroup) {
      fields.push({
        ...common,
        type: "radio",
        value: field.getSelected() ?? "",
        options: field.getOptions(),
      });
    } else if (field instanceof PDFDropdown) {
      const selected = field.getSelected();
      fields.push({
        ...common,
        type: "dropdown",
        value: selected[0] ?? "",
        options: field.getOptions(),
      });
    }
  }
  return fields;
}

/** Apply a map of field name → value (string for text/radio/dropdown, boolean for checkbox). */
export function setFormValues(doc: PDFDocument, values: FormValues): void {
  const form = doc.getForm();
  for (const [name, value] of Object.entries(values)) {
    const field = form.getField(name);
    if (!field) continue;
    if (field instanceof PDFTextField) {
      let text = String(value);
      // setText() throws when the field's MaxLen is exceeded — truncate instead.
      const max = field.getMaxLength();
      if (max !== undefined && text.length > max) text = text.slice(0, max);
      field.setText(text);
    } else if (field instanceof PDFCheckBox) {
      if (value === true) field.check();
      else field.uncheck();
    } else if (field instanceof PDFRadioGroup || field instanceof PDFDropdown) {
      const label = String(value);
      if (!label) {
        field.clear();
      } else if (field.getOptions().includes(label)) {
        field.select(label);
      }
    }
  }
}
