# PDF Studio

A cross-platform desktop **PDF viewer & editor** built with [Vue 3](https://vuejs.org/) + [Vite](https://vitejs.dev/) on the frontend and [Tauri 2](https://tauri.app/) for the native shell. All PDF manipulation runs client-side in the webview — no server, no Rust PDF code.

## Features

| Area         | What you can do                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **View**     | Page-by-page rendering (pdf.js), zoom in/out, fit-width, page navigation, thumbnail strip with lazy rendering                      |
| **Pages**    | Rotate pages (±90°), delete pages, insert blank pages, reorder by drag & drop on the thumbnails, merge another PDF at any position |
| **Forms**    | Detect all AcroForm fields (text, checkbox, radio, dropdown) and fill them from a side panel; values are written into the file     |
| **Insert**   | Insert PNG/JPEG images — pick a file, then click where to place it. Add text at any point with a chosen font size                  |
| **Annotate** | Highlight areas, underline, draw freehand strokes, and add editable sticky notes; choose colors for each tool                      |
| **Files**    | Native open/save dialogs (Tauri), in-place Save when the original path is known, Save As…                                          |
| **History**  | Undo and redo committed PDF edits with toolbar buttons and cross-platform keyboard shortcuts                                       |

Selection model: click a thumbnail or page to select; hold **Ctrl/⌘** for multi-select. Rotate/Delete act on the selection, falling back to the current page.

### Undo and redo

Use the **Undo** and **Redo** toolbar buttons; their tooltips identify the next
action. Keyboard shortcuts are **Ctrl/⌘+Z** for undo, **Ctrl/⌘+Shift+Z** for redo,
and **Ctrl+Y** for redo. Shortcuts leave native text-field undo alone and do not
run during text/note dialogs, IME composition, or another document operation.

Each committed operation is one step: page rotation, deletion, insertion,
reordering, merging, image/text insertion, applied form values, and annotation
creation, editing, movement, resizing, and erasure. Undo/redo restores the PDF,
its fields and annotations, and the corresponding page/annotation selection.
It cancels pending placement and gestures, but preserves zoom, tool colors, and
the current file name/path. Navigation, selections, uncommitted drafts, and
Save/Save As are not history steps. Save again after undoing to write that version
to disk; undo does not change an already saved file automatically.

History is in memory for the current document, retaining up to **50 edits** and
**256 MiB of historical PDF bytes**, excluding the current document. Oldest undo
snapshots are discarded first; if necessary, distant redo snapshots are also
discarded. A snapshot larger than the budget cannot be retained for undo/redo.
Opening another PDF successfully clears both branches. A new successful edit
after undo discards the redo branch; canceled or failed edits do not. Failed
undo/redo leaves the document and history unchanged so the action can be retried.

### Annotations

Use the separate **Highlight**, **Underline**, **Draw**, and **Sticky Note** icon
buttons in the toolbar. Selecting a tool reveals its color picker; each tool
remembers its own color. Click the active button again, or press **Esc**, to
return to normal page selection.

- **Highlight:** drag a rectangle over an area. The translucent color keeps the
  page content readable.
- **Underline:** drag across an area to mark its bottom edge.
- **Draw:** drag to create a freehand stroke with a live preview.
- **Sticky Note:** click a page, enter a comment, choose a color, and save.
  Double-click a saved note icon (or select it and choose **Edit note**) to edit
  its text or color. Cancel or Esc discards the
  open draft without changing the saved note.

**Editing saved annotations:** in normal view mode, click a highlight,
underline, freehand stroke, or sticky note to select it. While a creation tool
is active, hold **Ctrl/⌘** and click an existing mark to select it instead of
creating another mark. The selection box shows eight resize handles for marks;
sticky notes have no resize handles.

Once selected, drag the annotation or the inside of its selection box to move it
(the cursor changes to a hand), or drag a handle to resize it. Dragging shows a
live selection outline; releasing the mouse commits the change. **Delete**
erases only the selected annotation, never a page, and does not erase annotations
while you are typing in a text field or note editor. **Esc** cancels an unfinished
drag or clears the selection. Clicking the page background also deselects.
Moves, resizes, and erasures are included in Save/Save As and survive reopening.

Highlights and underlines are area-based, not text-selection-based, so they also
work on scanned pages. Annotations follow rotated pages and zoom levels. Save or
Save As writes standard PDF Highlight, Underline, Ink, and Text annotations,
including appearance streams for the marks. Sticky notes remain editable in
other PDF readers rather than being flattened into page text. Existing form
fields and unrelated annotation types are preserved. Editing is supported for
standard Highlight, Underline, Ink, and Text annotations, including those loaded
from an existing PDF. Sticky notes can be moved, but not resized.

## Architecture

```text
src/
├── main.ts                 # Vue entry point
├── App.vue                 # Layout + text-insertion modal + Esc handling
├── store.ts                # Reactive state + all actions (single source of truth)
├── state.ts                # Typed state and fresh application/test defaults
├── lib/
│   ├── edits.ts            # pdf-lib operations: rotate/delete/move/insert/merge, forms, image & text
│   ├── annotations.ts      # Standard PDF annotations, appearances, and sticky-note updates
│   ├── annotationTools.ts  # Shared tool labels, icons, colors, instructions, and PDF subtypes
│   ├── geometry.ts         # Pointer projection, bounds, resizing, and PDF-space transforms
│   ├── pdfObjects.ts       # Shared annotation traversal and PDF string decoding
│   ├── history.ts          # Bounded document snapshots and undo/redo timeline
│   ├── pdfjs.ts            # pdf.js rendering helpers (worker setup, page/thumbnail render)
│   └── files.ts            # Tauri dialog/fs wrappers with plain-browser fallbacks
├── components/
│   ├── Toolbar.vue         # All actions, zoom, page navigation
│   ├── ThumbnailsPanel.vue # Thumbnail strip + drag & drop reordering
│   ├── PdfViewer.vue       # Lazy per-page canvas rendering (IntersectionObserver)
│   ├── AnnotationLayer.vue # Pointer previews, PDF coordinate transforms, and note popups
│   ├── AnnotationSelection.vue # Selection boxes, drag/resize handles, and sticky-note icons
│   ├── FormPanel.vue       # AcroForm field editor
│   └── StatusBar.vue       # Status / error line
tests/
├── unit/                   # Vitest tests for PDF operations, state, adapters, and Vue components
└── e2e/
    ├── thumbnails.e2e.ts    # Playwright regression tests for thumbnail refreshes
    ├── annotations.e2e.ts   # Annotation creation, manipulation, and saved-PDF regressions
    └── history.e2e.ts       # Undo/redo rendering, forms, annotations, saving, and opening
src-tauri/                  # Tauri 2 shell (Rust): dialog + fs plugins, capabilities
```

**How editing works.** The store keeps the current `pdf-lib` editing document and
serialized PDF bytes as the source of truth. Structural edits
(delete/move/insert/merge) go through pdf-lib's own page API
(`removePage` / `insertPage`), preserving the `/Pages` tree and existing AcroForm
data. One quirk handled in `edits.ts`: `removePage` does not invalidate pdf-lib's
cached page list, so deletions explicitly re-invalidate it.

All document edits use a clone and publish it only after serialization, metadata
extraction, and renderer loading succeed. The same transaction records a history
snapshot. Undo/redo prepares the target snapshot before publishing it and advancing
the timeline, without re-serializing its saved bytes. Failed edits and history
restorations leave the previous document intact and expose an error for retry.

**Maintenance conventions.** Keep PDF operations in the library modules and
document lifecycle/UI actions in the store. Components share the tested geometry
helpers instead of duplicating pointer and coordinate math. Tool metadata has a
single definition, while `createInitialState()` supplies independent defaults for
the application and component tests. Function JSDoc describes coordinate spaces,
page-index conventions, side effects, and failure behavior where relevant.

## Getting started

### Prerequisites

- **Node.js 18+** and **pnpm** (`npm install -g pnpm`)
- **Rust** (stable) — <https://rustup.rs>
- Platform-specific:
  - **Windows**: WebView2 Runtime (preinstalled on Windows 10/11). Nothing else needed.
  - **macOS**: Xcode command-line tools (`xcode-select --install`).
  - **Linux**: `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file` (Debian/Ubuntu: `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file`).

### Develop

```bash
pnpm install
pnpm tauri dev         # launches the desktop app with hot reload
```

For UI-only work you can skip Tauri entirely — the frontend falls back to browser file pickers/downloads:

```bash
pnpm dev               # plain Vite dev server on http://localhost:5173
```

To try it without hunting for a PDF, visit **`http://localhost:5173/?demo`** in dev mode — it auto-loads the bundled `sample.pdf` (a 3-page doc with a text field and a checkbox).

### Unit tests (no browser or Tauri needed)

```bash
vp test                # run all Vitest unit tests
vp test --watch        # rerun tests while editing
vp run test:coverage   # coverage summary and HTML report in coverage/
```

Unit tests use real pdf-lib documents to verify edits and saved form values.
File dialogs, native filesystem calls, and pdf.js rendering are mocked at their
boundaries. Vue components run in a lightweight DOM environment, covering
navigation, selection, placement, forms, rendering refreshes, and error states.
Vitest discovers only `tests/**/*.spec.ts`; Playwright discovers only
`tests/e2e/**/*.e2e.ts`.
Coverage checks require at least 95% of lines and functions and 90% of statements
and branches across the application, excluding the bootstrap entry point.

### Browser regression tests

```bash
pnpm exec playwright install chromium  # once, to install the test browser
pnpm test:ui                          # thumbnail regression and annotation save/reopen tests
```

The browser tests start a dedicated Vite server on port 5174. Each thumbnail
keeps exactly one canvas when an edit refreshes the document.

### Build installers

```bash
pnpm tauri build       # produces platform installers under src-tauri/target/release/bundle
```

> **Icons:** a simple placeholder icon set is included in `src-tauri/icons/`. To use your own, drop a 1024×1024 PNG somewhere and run `pnpm tauri icon path/to/logo.png` — it regenerates every required format.

## Notes & limitations

- **Encrypted PDFs** are rejected with an error message (pdf-lib cannot open password-protected files).
- **Deleted pages** are removed from the page tree but their objects remain in the file, so file size doesn't shrink. A future "optimize/save compact" pass could garbage-collect them.
- **Image insertion** supports PNG and JPEG (GIF/BMP/TIFF would need conversion first). Inserted images default to 50% of page width, centered on your click point.
- **Text insertion** uses the built-in Helvetica; custom fonts can be embedded with `doc.embedFont` if needed later.
- **Form filling** is panel-based (field list → edit → Apply). Interactive on-page editing of widgets is a natural next step — pdf.js already renders the widget appearances, so an annotation-layer overlay could sync with the same store.
- Thumbnails are rendered for all pages up front; very large documents (1000+ pages) would benefit from virtualization.

## Roadmap ideas

- Interactive on-page form editing (click a field in the viewer to edit it)
- Text boxes that can be moved/resized after insertion
- Page splitting & extraction ("save selected pages as new PDF")
- File-size optimization pass (object garbage collection + object streams)
- Undo/redo history
