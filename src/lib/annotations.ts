import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
} from "pdf-lib";
import { annotationTools, isAnnotationTool } from "./annotationTools";
import type { AnnotationTool } from "./annotationTools";
import { clamp, pointBounds } from "./geometry";
import type { Point, Rect, Transform } from "./geometry";
import { pageAnnotations, readPdfText } from "./pdfObjects";

export { isAnnotationTool } from "./annotationTools";
export type { AnnotationTool } from "./annotationTools";
export type { Point, Rect as AnnotationRect, Transform as AnnotationTransform } from "./geometry";
export type PageAnnotation =
  | { type: "highlight" | "underline"; color: string; points: [Point, Point, Point, Point] }
  | { type: "draw"; color: string; points: Point[] }
  | { type: "sticky-note"; color: string; point: Point; text: string };

export interface StickyNote {
  id: string;
  page: number;
  point: Point;
  text: string;
  color: string;
}

export interface AnnotationInfo {
  id: string;
  page: number;
  type: AnnotationTool;
  rect: Rect;
  paths: Point[][];
}

/** Resolve a PDF annotation subtype to an editable tool; leave unrelated annotations untouched. */
function annotationType(dict: PDFDict): AnnotationTool | undefined {
  const subtype = dict.get(PDFName.of("Subtype"))?.toString();
  for (const tool in annotationTools) {
    if (isAnnotationTool(tool) && subtype === `/${annotationTools[tool].subtype}`) return tool;
  }
}

/** Read alternating PDF x/y values, rejecting incomplete or non-finite coordinates. */
function readPoints(array: PDFArray): Point[] {
  if (array.size() % 2) throw new Error("Invalid annotation coordinates.");
  const points: Point[] = [];
  for (let i = 0; i < array.size(); i += 2) {
    points.push({
      x: array.lookup(i, PDFNumber).asNumber(),
      y: array.lookup(i + 1, PDFNumber).asNumber(),
    });
  }
  if (points.length) assertPoints(points);
  return points;
}

/** Read editable annotation IDs, zero-based page indices, bounds, and paths in document order. */
export function getAnnotations(doc: PDFDocument): AnnotationInfo[] {
  const annotations: AnnotationInfo[] = [];
  for (const { ref, dict, pageIndex } of pageAnnotations(doc)) {
    if (!(ref instanceof PDFRef)) continue;
    const type = annotationType(dict);
    if (!type) continue;
    const rect = dict.lookup(PDFName.of("Rect"), PDFArray).asRectangle();
    const paths: Point[][] = [];
    const quads = dict.lookup(PDFName.of("QuadPoints"));
    const ink = dict.lookup(PDFName.of("InkList"));
    if ((type === "highlight" || type === "underline") && quads instanceof PDFArray) {
      const points = readPoints(quads);
      if (points.length % 4) throw new Error("Invalid annotation quadrilateral.");
      for (let i = 0; i < points.length; i += 4) paths.push(points.slice(i, i + 4));
    } else if (type === "draw" && ink instanceof PDFArray) {
      for (let i = 0; i < ink.size(); i++) paths.push(readPoints(ink.lookup(i, PDFArray)));
    }
    annotations.push({ id: ref.toString(), page: pageIndex, type, rect, paths });
  }
  return annotations;
}

/** Find an editable indirect annotation, reporting missing IDs and unsupported types explicitly. */
function findAnnotation(doc: PDFDocument, id: string) {
  for (const { page, ref, dict } of pageAnnotations(doc)) {
    if (!(ref instanceof PDFRef) || ref.toString() !== id) continue;
    if (!annotationType(dict)) throw new Error("This annotation type cannot be edited.");
    return { page, ref, dict };
  }
  throw new Error("This annotation no longer exists.");
}

/**
 * Move or resize PDF bounds and paths using a positive, axis-aligned affine transform.
 * Preserve the existing appearance: readers map its BBox to the updated Rect, retaining styles.
 * @throws If the ID is missing, the transform is invalid, or a sticky note would be resized.
 */
export function transformAnnotation(doc: PDFDocument, id: string, matrix: Transform): void {
  const [a, b, c, d, e, f] = matrix;
  if (
    !matrix.every(Number.isFinite) ||
    a <= 0 ||
    d <= 0 ||
    Math.abs(b) > 1e-6 ||
    Math.abs(c) > 1e-6
  ) {
    throw new Error("Choose a valid annotation size and position.");
  }
  const { dict } = findAnnotation(doc, id);
  if (
    annotationType(dict) === "sticky-note" &&
    (Math.abs(a - 1) > 1e-6 || Math.abs(d - 1) > 1e-6)
  ) {
    throw new Error("Sticky notes can be moved, but not resized.");
  }
  /** Apply the validated PDF-space scale and translation to one coordinate. */
  const apply = ({ x, y }: Point): Point => ({ x: a * x + c * y + e, y: b * x + d * y + f });
  const rect = dict.lookup(PDFName.of("Rect"), PDFArray).asRectangle();
  const start = apply(rect);
  const end = apply({ x: rect.x + rect.width, y: rect.y + rect.height });
  const quads = dict.lookup(PDFName.of("QuadPoints"));
  const ink = dict.lookup(PDFName.of("InkList"));
  const transformedQuads =
    quads instanceof PDFArray ? readPoints(quads).map(apply).flatMap(flattenPoint) : null;
  const transformedInk =
    ink instanceof PDFArray
      ? Array.from({ length: ink.size() }, (_, i) =>
          readPoints(ink.lookup(i, PDFArray)).map(apply).flatMap(flattenPoint),
        )
      : null;
  dict.set(PDFName.of("Rect"), doc.context.obj([start.x, start.y, end.x, end.y]));
  if (transformedQuads) dict.set(PDFName.of("QuadPoints"), doc.context.obj(transformedQuads));
  if (transformedInk) dict.set(PDFName.of("InkList"), doc.context.obj(transformedInk));
  dict.set(PDFName.of("M"), PDFString.fromDate(new Date()));
}

/** Remove one editable annotation and its popup from the page without disturbing widgets or other marks. */
export function removeAnnotation(doc: PDFDocument, id: string): void {
  const { page, ref, dict } = findAnnotation(doc, id);
  const popup = dict.get(PDFName.of("Popup"));
  for (const candidate of page.node.Annots()?.asArray() ?? []) {
    const annotation = doc.context.lookup(candidate);
    if (
      candidate instanceof PDFRef &&
      (candidate === ref ||
        candidate === popup ||
        (annotation instanceof PDFDict &&
          annotation.get(PDFName.of("Subtype")) === PDFName.of("Popup") &&
          annotation.get(PDFName.of("Parent")) === ref))
    ) {
      page.node.removeAnnot(candidate);
    }
  }
}

/** Decode an HTML RGB color for PDF color arrays and appearance streams. */
function colorComponents(color: string): number[] {
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error("Choose a valid annotation color.");
  return [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
}

/** Require at least one finite coordinate before writing PDF geometry. */
function assertPoints(points: Point[]): void {
  if (!points.length || points.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y))) {
    throw new Error("Annotation coordinates must be finite.");
  }
}

/** Trim nonempty note text and encode it as a Unicode-capable PDF string. */
function noteContents(text: string): PDFHexString {
  if (!text.trim()) throw new Error("Enter some text for the sticky note.");
  return PDFHexString.fromText(text.trim());
}

/** Flatten one coordinate for PDF QuadPoints and InkList arrays. */
function flattenPoint({ x, y }: Point): [number, number] {
  return [x, y];
}

/** Format one point with a PDF path operator for a printable appearance stream. */
function pathPoint(point: Point, operator: string): string {
  return `${point.x} ${point.y} ${operator}`;
}

/** Append a standard PDF annotation in page-space points, preserving existing annotations and forms. */
export function addAnnotation(
  doc: PDFDocument,
  pageIndex: number,
  annotation: PageAnnotation,
): void {
  const page = doc.getPage(pageIndex);
  const color = colorComponents(annotation.color);
  const points = annotation.type === "sticky-note" ? [annotation.point] : annotation.points;
  assertPoints(points);
  if (annotation.type === "draw" && points.length < 2) {
    throw new Error("Draw a stroke with at least two points.");
  }
  const bounds = pointBounds(points);
  const rect = [
    bounds.x - 2,
    bounds.y - 2,
    bounds.x + bounds.width + 2,
    bounds.y + bounds.height + 2,
  ];
  const dict = doc.context.obj({
    Type: "Annot",
    Subtype: annotationTools[annotation.type].subtype,
    P: page.ref,
    Rect: rect,
    C: color,
    F: 4,
    M: PDFString.fromDate(new Date()),
  });
  if (annotation.type === "sticky-note") {
    dict.set(PDFName.of("Contents"), noteContents(annotation.text));
    dict.set(PDFName.of("Name"), PDFName.of("Comment"));
    dict.set(
      PDFName.of("Rect"),
      doc.context.obj([
        annotation.point.x,
        annotation.point.y - 22,
        annotation.point.x + 22,
        annotation.point.y,
      ]),
    );
  } else {
    let content: string;
    if (annotation.type === "draw") {
      dict.set(PDFName.of("InkList"), doc.context.obj([points.flatMap(flattenPoint)]));
      dict.set(PDFName.of("BS"), doc.context.obj({ W: 2, S: "S" }));
      content = `${color.join(" ")} RG 2 w 1 J 1 j ${points.map((point, i) => pathPoint(point, i ? "l" : "m")).join(" ")} S`;
    } else {
      dict.set(PDFName.of("QuadPoints"), doc.context.obj(points.flatMap(flattenPoint)));
      const [topLeft, topRight, bottomLeft, bottomRight] = annotation.points;
      content =
        annotation.type === "highlight"
          ? `${color.join(" ")} rg ${pathPoint(topLeft, "m")} ${pathPoint(topRight, "l")} ${pathPoint(bottomRight, "l")} ${pathPoint(bottomLeft, "l")} h f`
          : `${color.join(" ")} RG 1.5 w ${pathPoint(bottomLeft, "m")} ${pathPoint(bottomRight, "l")} S`;
    }
    const opacity = annotation.type === "highlight" ? 0.35 : 1;
    dict.set(PDFName.of("CA"), doc.context.obj(opacity));
    // Explicit appearances preserve stroke direction on rotated pages in other readers.
    const appearance = doc.context.flateStream(`q /GS gs ${content} Q`, {
      Type: "XObject",
      Subtype: "Form",
      BBox: rect,
      Resources: {
        ExtGState: {
          GS: {
            Type: "ExtGState",
            ca: opacity,
            CA: opacity,
            BM: annotation.type === "highlight" ? "Multiply" : "Normal",
          },
        },
      },
    });
    dict.set(PDFName.of("AP"), doc.context.obj({ N: doc.context.register(appearance) }));
  }
  page.node.addAnnot(doc.context.register(dict));
}

/** Read Text annotations for note icons and editors; notes without a color use the tool's default. */
export function getStickyNotes(doc: PDFDocument): StickyNote[] {
  const notes: StickyNote[] = [];
  for (const { ref, dict, pageIndex } of pageAnnotations(doc)) {
    if (!(ref instanceof PDFRef) || dict.get(PDFName.of("Subtype")) !== PDFName.of("Text"))
      continue;
    const rect = dict.lookup(PDFName.of("Rect"), PDFArray).asRectangle();
    const components = dict.lookup(PDFName.of("C"));
    let color: string = annotationTools["sticky-note"].color;
    if (components instanceof PDFArray && components.size() === 3) {
      color = `#${components
        .asArray()
        .map((component) => {
          if (!(component instanceof PDFNumber)) throw new Error("Invalid sticky note color.");
          return Math.round(clamp(component.asNumber(), 0, 1) * 255)
            .toString(16)
            .padStart(2, "0");
        })
        .join("")}`;
    }
    notes.push({
      id: ref.toString(),
      page: pageIndex,
      point: { x: rect.x, y: rect.y + rect.height },
      text: readPdfText(dict, "Contents") ?? "",
      color,
    });
  }
  return notes;
}

/** Update a saved note's Unicode text and color, discarding its cached icon appearance for regeneration. */
export function updateStickyNote(doc: PDFDocument, id: string, text: string, color: string): void {
  const contents = noteContents(text);
  const components = colorComponents(color);
  for (const { ref, dict } of pageAnnotations(doc)) {
    if (ref.toString() !== id) continue;
    if (dict.get(PDFName.of("Subtype")) !== PDFName.of("Text")) break;
    dict.set(PDFName.of("Contents"), contents);
    dict.set(PDFName.of("C"), doc.context.obj(components));
    dict.delete(PDFName.of("AP"));
    dict.set(PDFName.of("M"), PDFString.fromDate(new Date()));
    return;
  }
  throw new Error("This sticky note no longer exists.");
}
