/**
 * Central application state + actions for PDF Studio.
 * A single module-level pdf-lib document (the source of truth) is kept in
 * memory; after every edit it is re-serialized and handed to pdf.js for
 * rendering.
 */
import { reactive } from "vue";
import type { PDFDocumentProxy } from "pdfjs-dist";
import * as edits from "./lib/edits";
import type { FormValues, PDFDocument } from "./lib/edits";
import { loadPdf } from "./lib/pdfjs";
import { baseName, pickImage, pickPdf, savePdf, writePdfTo } from "./lib/files";
import type { PickedFile } from "./lib/files";
import {
  addAnnotation,
  getAnnotations,
  getStickyNotes,
  removeAnnotation,
  transformAnnotation,
  updateStickyNote,
} from "./lib/annotations";
import type { AnnotationTool, AnnotationTransform, PageAnnotation } from "./lib/annotations";
import { annotationTools } from "./lib/annotationTools";
import { clamp } from "./lib/geometry";
import { createInitialState } from "./state";
import { DocumentHistory } from "./lib/history";
import type { DocumentSnapshot, HistoryDirection } from "./lib/history";

export type { ViewerMode } from "./state";

let renderingDoc: PDFDocumentProxy | null = null; // pdf.js doc (rendering)
let editingDoc: PDFDocument | null = null; // pdf-lib doc (editing)
const history = new DocumentHistory();

export const state = reactive(createInitialState());

/** Whether editing and rendering bytes are both available for document actions. */
export function hasDoc(): boolean {
  return editingDoc !== null && state.bytes !== null;
}

/** The pdf.js document proxy for the current bytes (null when no doc). */
export function getPdfDoc(): PDFDocumentProxy | null {
  return renderingDoc;
}

/** Publish a non-error message in the status bar. */
function setStatus(message: string): void {
  state.status = message;
}

/** Publish an operation failure without discarding the current document. */
function setError(message: string): void {
  state.error = message;
}

/** Prepare a candidate document without changing the current PDF or history; restored bytes stay exact. */
async function prepareDocument(doc: PDFDocument, savedBytes?: Uint8Array) {
  const bytes = savedBytes ?? (await edits.saveDoc(doc));
  const formFields = edits.getFormFields(doc);
  const stickyNotes = getStickyNotes(doc);
  const annotations = getAnnotations(doc);
  const renderedDoc = await loadPdf(bytes);
  return { doc, bytes, renderedDoc, formFields, stickyNotes, annotations };
}

/** Publish a fully prepared document and valid selection before invalidating render caches. */
function publishDocument(
  prepared: Awaited<ReturnType<typeof prepareDocument>>,
  label: string,
  view = currentSnapshot(),
): void {
  const { doc, bytes, renderedDoc, formFields, stickyNotes, annotations } = prepared;
  editingDoc = doc;
  state.bytes = bytes;
  renderingDoc = renderedDoc;
  state.version += 1;
  state.pageCount = editingDoc.getPageCount();
  state.formFields = formFields;
  state.stickyNotes = stickyNotes;
  state.annotations = annotations;
  state.selectedAnnotation = annotations.some(
    (annotation) => annotation.id === view.selectedAnnotation,
  )
    ? view.selectedAnnotation
    : null;
  state.selected = view.selected.filter((i) => i >= 0 && i < state.pageCount).sort((a, b) => a - b);
  state.currentPage = clamp(view.currentPage, 1, state.pageCount);
  setStatus(label);
}

/** Capture immutable PDF bytes and a copied selection; zoom, file identity, and tool colors are not edits. */
function currentSnapshot(): DocumentSnapshot {
  if (!state.bytes) throw new Error("No document is available to snapshot.");
  return {
    bytes: state.bytes,
    currentPage: state.currentPage,
    selected: [...state.selected],
    selectedAnnotation: state.selectedAnnotation,
  };
}

/** Synchronize reactive toolbar availability with the private timeline. */
function updateHistoryState(): void {
  state.undoLabel = history.peek("undo")?.label ?? null;
  state.redoLabel = history.peek("redo")?.label ?? null;
}

/** Load a document from raw bytes (also used by drag & drop / dev tooling). */
export async function openBytes(bytes: Uint8Array, name: string, path?: string): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  try {
    const prepared = await prepareDocument(await edits.loadDoc(bytes));
    publishDocument(prepared, `Opened ${name}`, {
      bytes: prepared.bytes,
      currentPage: 1,
      selected: [],
      selectedAnnotation: null,
    });
    state.fileName = name;
    state.filePath = path ?? "";
    state.mode = "view";
    state.pendingImage = null;
    state.error = "";
    history.reset(currentSnapshot());
    updateHistoryState();
  } catch {
    setError(`Could not open "${name}" — the file may be encrypted or corrupted.`);
  } finally {
    state.busy = false;
  }
}

/** Pick and open a PDF, preserving the current document if the dialog is canceled. */
export async function openFile(): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  let picked: PickedFile | null = null;
  try {
    picked = await pickPdf();
  } catch (error) {
    setError(error instanceof Error ? error.message : "Could not open the file dialog.");
  } finally {
    state.busy = false;
  }
  if (!picked) return;
  await openBytes(picked.bytes, picked.name, picked.path);
}

/** Save: overwrite the original file when known, otherwise show a dialog. */
export async function saveCurrent(): Promise<void> {
  if (!state.bytes || state.busy) return;
  try {
    if (state.filePath) {
      await writePdfTo(state.filePath, state.bytes);
      setStatus(`Saved ${state.fileName}`);
    } else {
      await saveAs();
    }
  } catch (e) {
    setError(e instanceof Error ? e.message : "Save failed.");
  }
}

/** Show Save As (or download in a browser); update the native path on success and propagate write errors. */
export async function saveAs(): Promise<void> {
  if (!state.bytes || state.busy) return;
  const path = await savePdf(state.bytes, state.fileName || "document.pdf");
  if (path) {
    state.filePath = path;
    state.fileName = baseName(path);
    setStatus(`Saved as ${state.fileName}`);
  }
}

/** Snapshot the selected zero-based indices, falling back to the current viewer page. */
function selectionOrCurrent(): number[] {
  return state.selected.length ? [...state.selected] : [state.currentPage - 1];
}

/** Rotate selected pages by a quarter turn; +1 is clockwise and -1 counterclockwise. */
export async function rotateSelected(dir: 1 | -1): Promise<void> {
  if (!editingDoc || state.busy) return;
  const indices = selectionOrCurrent();
  await commitEdit("Could not rotate pages.", (doc) => {
    edits.rotatePages(doc, indices, dir);
    return `Rotated ${indices.length} page${indices.length > 1 ? "s" : ""}`;
  });
}

/** Delete selected pages unless doing so would leave the document empty. */
export async function deleteSelected(): Promise<void> {
  if (!editingDoc || state.busy) return;
  const indices = selectionOrCurrent();
  if (indices.length >= state.pageCount) {
    setError("Cannot delete every page of the document.");
    return;
  }
  await commitEdit(
    "Could not delete pages.",
    (doc) => {
      edits.deletePages(doc, indices);
      return `Deleted ${indices.length} page${indices.length > 1 ? "s" : ""}`;
    },
    () => {
      state.selected = [];
    },
  );
}

/** Move a zero-based page to an insertion boundary in the original list (page count means append). */
export async function movePage(from: number, to: number): Promise<void> {
  if (!editingDoc || state.busy) return;
  const target = clamp(to, 0, state.pageCount);
  if (from < 0 || from >= state.pageCount || target === from || target === from + 1) return;
  await commitEdit("Could not reorder pages.", (doc) => {
    edits.movePage(doc, from, to);
    return "Reordered pages";
  });
}

/** Insert a blank page after `afterIndex` (null → at the end). */
export async function insertBlankPage(afterIndex: number | null): Promise<void> {
  if (!editingDoc || state.busy) return;
  const at = afterIndex === null ? state.pageCount : Math.min(afterIndex + 1, state.pageCount);
  await commitEdit("Could not insert a blank page.", (doc) => {
    edits.insertBlankPage(doc, at);
    return "Inserted blank page";
  });
}

/** Pick a PDF to insert at a zero-based boundary (`null` appends); report unreadable input in state. */
export async function mergePdfAt(index: number | null): Promise<void> {
  if (!editingDoc || state.busy) return;
  await commitEdit("Could not merge the PDF.", async (doc) => {
    const picked = await pickPdf();
    if (!picked) return false;
    const at = index === null ? state.pageCount : Math.min(index, state.pageCount);
    let count;
    try {
      count = await edits.mergePdfAt(doc, picked.bytes, at);
    } catch {
      throw new Error(`Could not merge "${picked.name}" — the file may be encrypted or corrupted.`);
    }
    if (count === 0) {
      setStatus("That PDF has no pages.");
      return false;
    }
    return `Merged ${count} page${count > 1 ? "s" : ""} from ${picked.name}`;
  });
}

/** Pick an image and enter click-to-place mode without changing the document yet. */
export async function pickImageToInsert(): Promise<void> {
  if (!editingDoc || state.busy) return;
  state.busy = true;
  try {
    const picked = await pickImage();
    if (!picked) return;
    state.pendingImage = { bytes: picked.bytes, name: picked.name };
    state.selectedAnnotation = null;
    state.mode = "place-image";
    setStatus(`Click on a page to place "${picked.name}" (Esc to cancel).`);
  } catch (error) {
    setError(error instanceof Error ? error.message : "Could not pick an image.");
  } finally {
    state.busy = false;
  }
}

/** Enter text placement mode, clearing annotation selection. */
export function startTextPlacement(): void {
  if (!editingDoc || state.busy) return;
  state.selectedAnnotation = null;
  state.mode = "place-text";
  setStatus("Click on a page to place text (Esc to cancel).");
}

/** Discard pending placement and annotation selection, returning to normal viewing. */
export function cancelPlacement(): void {
  state.selectedAnnotation = null;
  state.mode = "view";
  state.pendingImage = null;
  setStatus(hasDoc() ? "Ready." : "");
}

/** Place the pending image centered at (xPt, yPt) on page `pageIndex`. */
export async function placePendingImage(
  pageIndex: number,
  xPt: number,
  yPt: number,
): Promise<void> {
  if (!editingDoc || !state.pendingImage || state.busy) return;
  const image = state.pendingImage;
  await commitEdit(
    "Could not insert image.",
    async (doc) => {
      const pageWidth = doc.getPage(pageIndex).getSize().width;
      await edits.addImageToPage(doc, pageIndex, image.bytes, xPt, yPt, pageWidth * 0.5);
      return `Inserted ${image.name}`;
    },
    () => {
      state.mode = "view";
      state.pendingImage = null;
    },
  );
}

/** Insert text with baseline at (xPt, yPt) on page `pageIndex`. */
export async function placeText(
  pageIndex: number,
  xPt: number,
  yPt: number,
  text: string,
): Promise<void> {
  if (!editingDoc || !text.trim() || state.busy) return;
  const size = state.textSize;
  await commitEdit("Could not insert text.", async (doc) => {
    await edits.addTextToPage(doc, pageIndex, text.trim(), xPt, yPt, size);
    return "Added text";
  });
}

/** Toggle a creation tool and publish its interaction instructions. */
export function startAnnotation(tool: AnnotationTool): void {
  if (!editingDoc || state.busy) return;
  state.pendingImage = null;
  state.selectedAnnotation = null;
  state.mode = state.mode === tool ? "view" : tool;
  setStatus(
    state.mode === "view" ? "Ready." : `${annotationTools[tool].instruction} Esc to cancel.`,
  );
}

/** Atomically add a mark to a zero-based page; return false and expose errors in state on failure. */
export async function addPageAnnotation(
  page: number,
  annotation: PageAnnotation,
): Promise<boolean> {
  return commitEdit("Could not add annotation.", (doc) => {
    addAnnotation(doc, page, annotation);
    return "Added annotation";
  });
}

/** Edit a clone and publish only after serialization and rendering succeed, preserving retryable failures. */
async function commitEdit(
  failureMessage: string,
  mutate: (doc: PDFDocument) => string | false | Promise<string | false>,
  onCommit?: () => void,
): Promise<boolean> {
  if (!editingDoc || !state.bytes || state.busy) return false;
  state.busy = true;
  state.error = "";
  try {
    const before = currentSnapshot();
    const next = await edits.loadDoc(before.bytes);
    const label = await mutate(next);
    if (label === false) return false;
    const prepared = await prepareDocument(next);
    publishDocument(prepared, label);
    onCommit?.();
    history.record(before, currentSnapshot(), label);
    updateHistoryState();
    return true;
  } catch (error) {
    setError(error instanceof Error ? error.message : failureMessage);
    return false;
  } finally {
    state.busy = false;
  }
}

/** Atomically update a note's contents and color; retain the document and editor on failure. */
export async function editStickyNote(id: string, text: string, color: string): Promise<boolean> {
  return commitEdit("Could not update sticky note.", (doc) => {
    const note = getStickyNotes(doc).find((candidate) => candidate.id === id);
    if (text.trim() && note?.text === text.trim() && note.color === color.toLowerCase())
      return false;
    updateStickyNote(doc, id, text, color);
    return "Updated sticky note";
  });
}

/** Select an existing annotation (or clear selection), excluding simultaneous page selection. */
export function selectAnnotation(id: string | null): void {
  if (id !== null && !state.annotations.some((annotation) => annotation.id === id)) {
    setError("This annotation no longer exists.");
    return;
  }
  state.selectedAnnotation = id;
  if (id !== null) state.selected = [];
}

/** Atomically move or resize an annotation with a PDF-space affine transform. */
export async function transformPageAnnotation(
  id: string,
  matrix: AnnotationTransform,
): Promise<boolean> {
  return commitEdit("Could not move or resize annotation.", (doc) => {
    transformAnnotation(doc, id, matrix);
    if (matrix.every((value, index) => value === [1, 0, 0, 1, 0, 0][index])) return false;
    return "Updated annotation";
  });
}

/** Atomically erase the selected annotation; return false when nothing is selected or editing fails. */
export async function deleteSelectedAnnotation(): Promise<boolean> {
  const id = state.selectedAnnotation;
  if (id === null) return false;
  return commitEdit("Could not delete annotation.", (doc) => {
    removeAnnotation(doc, id);
    return "Deleted annotation";
  });
}

/** Atomically restore a historical PDF, advancing history only when rendering and metadata are ready. */
async function restoreHistory(direction: HistoryDirection): Promise<boolean> {
  if (!editingDoc || !state.bytes || state.busy) return false;
  const target = history.peek(direction);
  if (!target) return false;
  state.busy = true;
  state.error = "";
  try {
    const current = currentSnapshot();
    const prepared = await prepareDocument(
      await edits.loadDoc(target.snapshot.bytes),
      target.snapshot.bytes,
    );
    publishDocument(
      prepared,
      `${direction === "undo" ? "Undid" : "Redid"}: ${target.label}`,
      target.snapshot,
    );
    history.advance(direction, current);
    state.mode = "view";
    state.pendingImage = null;
    updateHistoryState();
    return true;
  } catch (error) {
    setError(error instanceof Error ? error.message : `Could not ${direction} the last edit.`);
    return false;
  } finally {
    state.busy = false;
  }
}

/** Undo one committed PDF edit; failed restoration leaves both the document and timeline unchanged. */
export async function undo(): Promise<boolean> {
  return restoreHistory("undo");
}

/** Redo one undone PDF edit; a successful new edit discards the redo branch. */
export async function redo(): Promise<boolean> {
  return restoreHistory("redo");
}

/** Toggle the form editor, reporting when the open document has no supported fields. */
export function toggleFormsPanel(): void {
  if (!editingDoc) return;
  state.showFormsPanel = !state.showFormsPanel;
  if (state.showFormsPanel && state.formFields.length === 0)
    setStatus("No fillable form fields found.");
}

/** Apply the form editor's draft values and refresh rendered field appearances. */
export async function applyFormValues(values: FormValues): Promise<void> {
  if (!editingDoc || state.busy) return;
  const draft = { ...values };
  await commitEdit("Could not update form fields.", (doc) => {
    const before = JSON.stringify(edits.getFormFields(doc));
    edits.setFormValues(doc, draft);
    if (before === JSON.stringify(edits.getFormFields(doc))) return false;
    return `Updated ${Object.keys(draft).length} form field(s)`;
  });
}

/** Select a zero-based page, toggling membership when additive selection is requested. */
export function selectPage(index: number, additive: boolean): void {
  state.selectedAnnotation = null;
  if (additive) {
    const i = state.selected.indexOf(index);
    if (i >= 0) state.selected.splice(i, 1);
    else state.selected.push(index);
    state.selected.sort((a, b) => a - b);
  } else {
    state.selected = [index];
  }
}

/** Clear both page and annotation selections without changing the active tool. */
export function clearSelection(): void {
  state.selected = [];
  state.selectedAnnotation = null;
}

/** Clamp a one-based viewer page to the current document, retaining 1 for an empty viewer. */
export function setCurrentPage(page: number): void {
  state.currentPage = clamp(page, 1, state.pageCount);
}

/** Limit the display scale to the supported 25–400% range. */
export function setZoom(zoom: number): void {
  state.zoom = clamp(zoom, 0.25, 4);
}
