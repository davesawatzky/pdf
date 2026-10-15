import type { FormFieldInfo } from "./lib/edits";
import type { AnnotationInfo, StickyNote } from "./lib/annotations";
import { annotationTools } from "./lib/annotationTools";
import type { AnnotationTool } from "./lib/annotationTools";

export type ViewerMode = "view" | "place-image" | "place-text" | AnnotationTool;

export interface AppState {
  fileName: string;
  filePath: string;
  bytes: Uint8Array | null;
  version: number;
  pageCount: number;
  /** Sorted, zero-based page indices. */
  selected: number[];
  /** One-based viewer page number. */
  currentPage: number;
  zoom: number;
  mode: ViewerMode;
  pendingImage: { bytes: Uint8Array; name: string } | null;
  textSize: number;
  annotationColors: Record<AnnotationTool, string>;
  stickyNotes: StickyNote[];
  annotations: AnnotationInfo[];
  selectedAnnotation: string | null;
  formFields: FormFieldInfo[];
  showFormsPanel: boolean;
  busy: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  status: string;
  error: string;
}

/** Create independent defaults for the application and test fixtures; no arrays or color maps are shared. */
export function createInitialState(): AppState {
  return {
    fileName: "",
    filePath: "",
    bytes: null,
    version: 0,
    pageCount: 0,
    selected: [],
    currentPage: 1,
    zoom: 1.25,
    mode: "view",
    pendingImage: null,
    textSize: 14,
    annotationColors: {
      highlight: annotationTools.highlight.color,
      underline: annotationTools.underline.color,
      draw: annotationTools.draw.color,
      "sticky-note": annotationTools["sticky-note"].color,
    },
    stickyNotes: [],
    annotations: [],
    selectedAnnotation: null,
    formFields: [],
    showFormsPanel: false,
    busy: false,
    undoLabel: null,
    redoLabel: null,
    status: "Open a PDF to get started.",
    error: "",
  };
}
