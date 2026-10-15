/**
 * Thin wrapper around pdf.js (pdfjs-dist) for rendering pages.
 */
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";

let workerStarted = false;

/** Start one module worker shared by all rendering documents. */
function ensureWorker(): void {
  if (workerStarted) return;
  const worker = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), {
    type: "module",
  });
  pdfjs.GlobalWorkerOptions.workerPort = worker;
  workerStarted = true;
}

/** Load a document for rendering. Passes a copy — pdf.js may transfer the buffer to its worker. */
export async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  ensureWorker();
  return await pdfjs.getDocument({ data: bytes.slice() }).promise;
}

export interface PageSize {
  width: number;
  height: number;
}

/** Render page (1-based) into canvas at the given scale. Returns CSS pixel size. */
export async function renderPage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  scale: number,
  canvas: HTMLCanvasElement,
): Promise<PageSize> {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return { width: viewport.width, height: viewport.height };
}

/** Render a small thumbnail (target CSS width in px). */
export async function renderThumbnail(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  targetWidthPx: number,
): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = targetWidthPx / base.width;
  const canvas = document.createElement("canvas");
  await renderPage(pdf, pageNumber, scale, canvas);
  return canvas;
}

/** Page size in points (scale-1 viewport) for a 1-based page number. */
export function pageSizeAtScale1(pdf: PDFDocumentProxy, pageNumber: number): Promise<PageSize> {
  return pageViewportAtScale1(pdf, pageNumber).then((v) => {
    return { width: v.width, height: v.height };
  });
}

/** Get a one-based page's scale-one viewport, retaining crop and rotation coordinate transforms. */
export async function pageViewportAtScale1(pdf: PDFDocumentProxy, pageNumber: number) {
  return (await pdf.getPage(pageNumber)).getViewport({ scale: 1 });
}
