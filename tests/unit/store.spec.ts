import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as edits from "../../src/lib/edits";
import { makeDoc, makeFormDoc, png } from "./fixtures";

const files = vi.hoisted(() => ({
  pickPdf: vi.fn(),
  pickImage: vi.fn(),
  savePdf: vi.fn(),
  writePdfTo: vi.fn(),
}));
const rendering = vi.hoisted(() => ({
  pdf: { numPages: 3 },
  loadPdf: vi.fn(),
}));

vi.mock("../../src/lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/files")>()),
  ...files,
}));
vi.mock("../../src/lib/pdfjs", () => ({ loadPdf: rendering.loadPdf }));

let store: typeof import("../../src/store");

beforeEach(async () => {
  vi.resetModules();
  files.pickPdf.mockResolvedValue(null);
  files.pickImage.mockResolvedValue(null);
  files.savePdf.mockResolvedValue(null);
  files.writePdfTo.mockResolvedValue(undefined);
  rendering.loadPdf.mockResolvedValue(rendering.pdf);
  store = await import("../../src/store");
});

async function openDocument(withForms = false): Promise<void> {
  const doc = withForms ? await makeFormDoc() : await makeDoc();
  await store.openBytes(await edits.saveDoc(doc), "original.pdf", "/docs/original.pdf");
}

async function currentDoc() {
  if (!store.state.bytes) throw new Error("Expected an open document");
  return edits.loadDoc(store.state.bytes);
}

describe("initial and view state", () => {
  it("starts without a document", () => {
    expect(store.hasDoc()).toBe(false);
    expect(store.getPdfDoc()).toBeNull();
    expect(store.state).toMatchObject({
      bytes: null,
      pageCount: 0,
      currentPage: 1,
      selected: [],
      zoom: 1.25,
      mode: "view",
      busy: false,
      status: "Open a PDF to get started.",
      error: "",
    });
  });

  it("replaces, toggles, sorts, and clears page selections", () => {
    store.selectPage(2, false);
    store.selectPage(0, true);
    expect(store.state.selected).toEqual([0, 2]);
    store.selectPage(2, true);
    expect(store.state.selected).toEqual([0]);
    store.selectPage(1, false);
    expect(store.state.selected).toEqual([1]);
    store.clearSelection();
    expect(store.state.selected).toEqual([]);
  });

  it.each([
    [0.01, 0.25],
    [0.75, 0.75],
    [10, 4],
  ])("clamps zoom %s to %s", (input, expected) => {
    store.setZoom(input);
    expect(store.state.zoom).toBe(expected);
  });

  it("clamps navigation to the available page range", async () => {
    store.setCurrentPage(5);
    expect(store.state.currentPage).toBe(1);
    await openDocument();
    store.setCurrentPage(99);
    expect(store.state.currentPage).toBe(3);
    store.setCurrentPage(-5);
    expect(store.state.currentPage).toBe(1);
    store.setCurrentPage(2);
    expect(store.state.currentPage).toBe(2);
  });

  it("ignores document actions when no document is open", async () => {
    await store.saveCurrent();
    await store.saveAs();
    await store.rotateSelected(1);
    await store.deleteSelected();
    await store.movePage(0, 1);
    await store.insertBlankPage(null);
    await store.mergePdfAt(null);
    await store.pickImageToInsert();
    store.startTextPlacement();
    await store.placePendingImage(0, 0, 0);
    await store.placeText(0, 0, 0, "text");
    store.toggleFormsPanel();
    await store.applyFormValues({});
    expect(store.state.version).toBe(0);
    expect(store.state.mode).toBe("view");
    expect(store.state.showFormsPanel).toBe(false);
    expect(files.pickPdf).not.toHaveBeenCalled();
    expect(files.pickImage).not.toHaveBeenCalled();
    expect(files.savePdf).not.toHaveBeenCalled();
  });
});

describe("opening and saving", () => {
  it("opens bytes, resets document-specific state, and loads the renderer", async () => {
    store.state.selected = [2];
    store.state.currentPage = 3;
    store.state.mode = "place-image";
    store.state.pendingImage = { bytes: png, name: "image.png" };
    store.state.error = "old error";
    await openDocument(true);
    expect(store.hasDoc()).toBe(true);
    expect(store.getPdfDoc()).toBe(rendering.pdf);
    expect(store.state).toMatchObject({
      fileName: "original.pdf",
      filePath: "/docs/original.pdf",
      selected: [],
      currentPage: 1,
      mode: "view",
      pendingImage: null,
      busy: false,
      error: "",
      pageCount: 2,
      version: 1,
      status: "Opened original.pdf",
    });
    expect(store.state.formFields).toHaveLength(4);
    expect(rendering.loadPdf).toHaveBeenCalledWith(store.state.bytes);
  });

  it("opens browser bytes without an original path", async () => {
    await store.openBytes(await edits.saveDoc(await makeDoc()), "browser.pdf");
    expect(store.state.filePath).toBe("");
  });

  it("waits for the renderer before publishing an edit's new version", async () => {
    await openDocument();
    let complete: ((pdf: typeof rendering.pdf) => void) | undefined;
    rendering.loadPdf.mockImplementationOnce(
      () =>
        new Promise<typeof rendering.pdf>((resolve) => {
          complete = resolve;
        }),
    );
    const edit = store.rotateSelected(1);
    await vi.waitFor(() => expect(complete).toBeDefined());
    expect(store.state.version).toBe(1);
    const nextPdf = { numPages: 3 };
    if (!complete) throw new Error("Renderer did not start");
    complete(nextPdf);
    await edit;
    expect(store.getPdfDoc()).toBe(nextPdf);
    expect(store.state.version).toBe(2);
  });

  it("reports invalid documents and preserves an existing document", async () => {
    await openDocument();
    const bytes = store.state.bytes;
    await store.openBytes(new Uint8Array([1]), "broken.pdf");
    expect(store.state.error).toBe(
      'Could not open "broken.pdf" — the file may be encrypted or corrupted.',
    );
    expect(store.state.busy).toBe(false);
    expect(store.state.bytes).toBe(bytes);
    expect(store.state.fileName).toBe("original.pdf");
    expect(store.state.version).toBe(1);
  });

  it("opens picked files and leaves state unchanged on cancellation", async () => {
    await store.openFile();
    expect(store.hasDoc()).toBe(false);
    files.pickPdf.mockResolvedValue({
      bytes: await edits.saveDoc(await makeDoc(1)),
      name: "picked.pdf",
      path: "/picked.pdf",
    });
    await store.openFile();
    expect(store.state.fileName).toBe("picked.pdf");
    expect(store.state.filePath).toBe("/picked.pdf");
    expect(store.state.pageCount).toBe(1);
  });

  it("saves in place when an original path exists", async () => {
    await openDocument();
    await store.saveCurrent();
    expect(files.writePdfTo).toHaveBeenCalledWith("/docs/original.pdf", store.state.bytes);
    expect(files.savePdf).not.toHaveBeenCalled();
    expect(store.state.status).toBe("Saved original.pdf");
  });

  it("uses Save As once for a new file, then saves in place", async () => {
    await openDocument();
    store.state.filePath = "";
    files.savePdf.mockResolvedValue("C:\\docs\\saved.pdf");
    await store.saveCurrent();
    expect(files.savePdf).toHaveBeenCalledWith(store.state.bytes, "original.pdf");
    expect(store.state.fileName).toBe("saved.pdf");
    expect(store.state.filePath).toBe("C:\\docs\\saved.pdf");
    expect(store.state.status).toBe("Saved as saved.pdf");
    await store.saveCurrent();
    expect(files.writePdfTo).toHaveBeenCalledWith("C:\\docs\\saved.pdf", store.state.bytes);
  });

  it("always opens a dialog for Save As", async () => {
    await openDocument();
    files.savePdf.mockResolvedValue("/other/renamed.pdf");
    await store.saveAs();
    expect(files.savePdf).toHaveBeenCalledWith(store.state.bytes, "original.pdf");
    expect(files.writePdfTo).not.toHaveBeenCalled();
    expect(store.state.filePath).toBe("/other/renamed.pdf");
    expect(store.state.fileName).toBe("renamed.pdf");
  });

  it("retains filename, path, and status when Save As is cancelled", async () => {
    await openDocument();
    await store.saveAs();
    expect(store.state.filePath).toBe("/docs/original.pdf");
    expect(store.state.fileName).toBe("original.pdf");
    expect(store.state.status).toBe("Opened original.pdf");
  });

  it("uses a default filename when no name is known", async () => {
    await openDocument();
    store.state.fileName = "";
    store.state.filePath = "";
    await store.saveCurrent();
    await store.saveAs();
    expect(files.savePdf).toHaveBeenNthCalledWith(1, store.state.bytes, "document.pdf");
    expect(files.savePdf).toHaveBeenNthCalledWith(2, store.state.bytes, "document.pdf");
  });

  it.each([new Error("Disk full"), "failure"])("reports save errors", async (error) => {
    await openDocument();
    files.writePdfTo.mockRejectedValue(error);
    await store.saveCurrent();
    expect(store.state.error).toBe(error instanceof Error ? "Disk full" : "Save failed.");
  });
});

describe("editing actions", () => {
  beforeEach(async () => {
    await openDocument();
  });

  it("rotates the current page when nothing is selected", async () => {
    store.setCurrentPage(2);
    await store.rotateSelected(-1);
    expect((await currentDoc()).getPages().map((page) => page.getRotation().angle)).toEqual([
      0, 270, 0,
    ]);
    expect(store.state.status).toBe("Rotated 1 page");
    expect(store.state.version).toBe(2);
  });

  it("rotates all selected pages and refreshes rendering", async () => {
    store.state.selected = [0, 2];
    await store.rotateSelected(1);
    expect((await currentDoc()).getPages().map((page) => page.getRotation().angle)).toEqual([
      90, 0, 90,
    ]);
    expect(store.state.status).toBe("Rotated 2 pages");
    expect(rendering.loadPdf).toHaveBeenCalledTimes(2);
  });

  it("deletes selected pages and clamps current page", async () => {
    store.state.selected = [0, 2];
    store.state.currentPage = 3;
    await store.deleteSelected();
    expect(store.state.pageCount).toBe(1);
    expect(store.state.selected).toEqual([]);
    expect(store.state.currentPage).toBe(1);
    expect(store.state.status).toBe("Deleted 2 pages");
    expect((await currentDoc()).getPage(0).getWidth()).toBe(310);
  });

  it("deletes the current page without a selection", async () => {
    store.setCurrentPage(2);
    await store.deleteSelected();
    expect((await currentDoc()).getPages().map((page) => page.getWidth())).toEqual([300, 320]);
    expect(store.state.status).toBe("Deleted 1 page");
  });

  it("refuses to delete every page", async () => {
    store.state.selected = [0, 1, 2];
    await store.deleteSelected();
    expect(store.state.error).toBe("Cannot delete every page of the document.");
    expect(store.state.pageCount).toBe(3);
    expect(store.state.version).toBe(1);
  });

  it("reorders pages and keeps valid selection indices", async () => {
    store.state.selected = [2, 99, 0];
    await store.movePage(2, 0);
    expect((await currentDoc()).getPages().map((page) => page.getWidth())).toEqual([320, 300, 310]);
    expect(store.state.selected).toEqual([0, 2]);
    expect(store.state.status).toBe("Reordered pages");
  });

  it.each([
    [0, [300, 310, 310, 320]],
    [null, [300, 310, 320, 320]],
  ] as const)("inserts a blank page after %s", async (index, widths) => {
    await store.insertBlankPage(index);
    expect((await currentDoc()).getPages().map((page) => page.getWidth())).toEqual(widths);
    expect(store.state.pageCount).toBe(4);
    expect(store.state.status).toBe("Inserted blank page");
  });

  it("merges a picked PDF and resets busy state", async () => {
    const other = await makeDoc(1);
    other.getPage(0).setSize(100, 100);
    files.pickPdf.mockResolvedValue({ bytes: await edits.saveDoc(other), name: "other.pdf" });
    await store.mergePdfAt(1);
    expect((await currentDoc()).getPages().map((page) => page.getWidth())).toEqual([
      300, 100, 310, 320,
    ]);
    expect(store.state.status).toBe("Merged 1 page from other.pdf");
    expect(store.state.busy).toBe(false);
  });

  it("appends merged pages when no position is provided", async () => {
    files.pickPdf.mockResolvedValue({
      bytes: await edits.saveDoc(await makeDoc(2)),
      name: "other.pdf",
    });
    await store.mergePdfAt(null);
    expect(store.state.pageCount).toBe(5);
    expect(store.state.status).toBe("Merged 2 pages from other.pdf");
  });

  it("does not refresh on cancelled merge", async () => {
    await store.mergePdfAt(null);
    expect(store.state.version).toBe(1);
    expect(store.state.busy).toBe(false);
  });

  it("reports empty merged PDFs without refreshing the document", async () => {
    const empty = await makeDoc(0);
    files.pickPdf.mockResolvedValue({
      bytes: await empty.save({ addDefaultPage: false }),
      name: "empty.pdf",
    });
    await store.mergePdfAt(null);
    expect(store.state.status).toBe("That PDF has no pages.");
    expect(store.state.version).toBe(1);
    expect(store.state.pageCount).toBe(3);
    expect(store.state.busy).toBe(false);
  });

  it("reports corrupt merges and clears busy state", async () => {
    files.pickPdf.mockResolvedValue({ bytes: new Uint8Array([1]), name: "broken.pdf" });
    await store.mergePdfAt(null);
    expect(store.state.error).toBe(
      'Could not merge "broken.pdf" — the file may be encrypted or corrupted.',
    );
    expect(store.state.busy).toBe(false);
    expect(store.state.pageCount).toBe(3);
    expect(store.state.version).toBe(1);
  });
});

describe("placement and forms", () => {
  it("cancels placement with and without a document", async () => {
    store.cancelPlacement();
    expect(store.state.status).toBe("");
    await openDocument();
    store.startTextPlacement();
    expect(store.state.mode).toBe("place-text");
    store.cancelPlacement();
    expect(store.state.mode).toBe("view");
    expect(store.state.status).toBe("Ready.");
  });

  describe("document undo and redo", () => {
    it("preserves redo for unchanged notes and identity transforms", async () => {
      await openDocument();
      await store.addPageAnnotation(0, {
        type: "sticky-note",
        color: "#aabbcc",
        point: { x: 40, y: 100 },
        text: "Keep",
      });
      const id = store.state.stickyNotes[0].id;
      await store.rotateSelected(1);
      await store.undo();
      const bytes = store.state.bytes,
        version = store.state.version;
      expect(await store.editStickyNote(id, " Keep ", "#AABBCC")).toBe(false);
      expect(await store.transformPageAnnotation(id, [1, 0, 0, 1, 0, 0])).toBe(false);
      expect(store.state.bytes).toBe(bytes);
      expect(store.state.version).toBe(version);
      expect(store.state.redoLabel).toBe("Rotated 1 page");
    });

    it("reports picker failures and releases the operation lock without losing history", async () => {
      await openDocument();
      await store.rotateSelected(1);
      const bytes = store.state.bytes;
      files.pickPdf.mockRejectedValueOnce(new Error("Dialog failed"));
      await store.openFile();
      expect(store.state.error).toBe("Dialog failed");
      expect(store.state.busy).toBe(false);
      files.pickImage.mockRejectedValueOnce("Image dialog failed");
      await store.pickImageToInsert();
      expect(store.state.error).toBe("Could not pick an image.");
      expect(store.state.busy).toBe(false);
      expect(store.state.bytes).toBe(bytes);
      expect(await store.undo()).toBe(true);
    });

    it("starts with no history and treats unavailable actions as no-ops", async () => {
      expect(store.state.undoLabel).toBeNull();
      expect(store.state.redoLabel).toBeNull();
      expect(await store.undo()).toBe(false);
      expect(await store.redo()).toBe(false);
      await openDocument();
      expect(await store.undo()).toBe(false);
      expect(await store.redo()).toBe(false);
      expect(store.state.version).toBe(1);
    });

    it.each([
      [
        "rotation",
        async () => {
          await store.rotateSelected(1);
        },
      ],
      [
        "page deletion",
        async () => {
          await store.deleteSelected();
        },
      ],
      [
        "page insertion",
        async () => {
          await store.insertBlankPage(0);
        },
      ],
      [
        "page reordering",
        async () => {
          await store.movePage(0, 2);
        },
      ],
      [
        "PDF merging",
        async () => {
          files.pickPdf.mockResolvedValue({
            name: "merged.pdf",
            bytes: await edits.saveDoc(await makeDoc(1)),
          });
          await store.mergePdfAt(null);
        },
      ],
      [
        "image insertion",
        async () => {
          files.pickImage.mockResolvedValue({ name: "picture.png", bytes: png });
          await store.pickImageToInsert();
          await store.placePendingImage(0, 100, 100);
        },
      ],
      [
        "text insertion",
        async () => {
          await store.placeText(0, 20, 40, "Undo this");
        },
      ],
      [
        "form values",
        async () => {
          await store.applyFormValues({
            Name: "Ada",
            Agree: true,
            Country: "DE",
            Delivery: "Email",
          });
        },
      ],
      ...(["highlight", "underline", "draw"] as const).map(
        (type) =>
          [
            `${type} creation`,
            async () => {
              await store.addPageAnnotation(0, {
                type,
                color: "#2196f3",
                points: [
                  { x: 20, y: 100 },
                  { x: 80, y: 100 },
                  { x: 20, y: 80 },
                  { x: 80, y: 80 },
                ],
              });
            },
          ] as const,
      ),
      [
        "note creation",
        async () => {
          await store.addPageAnnotation(0, {
            type: "sticky-note",
            color: "#fff176",
            point: { x: 40, y: 100 },
            text: "New note",
          });
        },
      ],
    ] as const)("restores exact PDF bytes and metadata for %s", async (_label, mutate) => {
      await openDocument(true);
      const before = store.state.bytes;
      const fields = store.state.formFields;
      const pageCount = store.state.pageCount;
      await mutate();
      expect(store.state.error).toBe("");
      expect(store.state.bytes).not.toEqual(before);
      const after = store.state.bytes;
      const afterFields = store.state.formFields;
      const afterAnnotations = store.state.annotations;
      const afterNotes = store.state.stickyNotes;
      const afterPageCount = store.state.pageCount;
      const label = store.state.undoLabel;
      expect(label).not.toBeNull();
      expect(await store.undo()).toBe(true);
      expect(store.state.bytes).toBe(before);
      expect(store.state.pageCount).toBe(pageCount);
      expect(store.state.formFields).toEqual(fields);
      expect(store.state.annotations).toEqual([]);
      expect(store.state.stickyNotes).toEqual([]);
      expect(store.state.undoLabel).toBeNull();
      expect(store.state.redoLabel).toBe(label);
      expect(store.state.status).toBe(`Undid: ${label}`);
      expect(await store.redo()).toBe(true);
      expect(store.state.bytes).toBe(after);
      expect(store.state.pageCount).toBe(afterPageCount);
      expect(store.state.formFields).toEqual(afterFields);
      expect(store.state.annotations).toEqual(afterAnnotations);
      expect(store.state.stickyNotes).toEqual(afterNotes);
      expect(store.state.redoLabel).toBeNull();
      expect(store.state.version).toBe(4);
    });

    it("restores annotation selection, contents, colors, moves, resizes, and deletion in order", async () => {
      await openDocument();
      await store.addPageAnnotation(0, {
        type: "sticky-note",
        color: "#fff176",
        point: { x: 40, y: 100 },
        text: "Original",
      });
      const id = store.state.stickyNotes[0].id;
      store.selectAnnotation(id);
      const original = store.state.bytes;
      await store.editStickyNote(id, "Updated", "#2196f3");
      const updated = store.state.bytes;
      await store.transformPageAnnotation(id, [1, 0, 0, 1, 30, 20]);
      const moved = store.state.bytes;
      await store.deleteSelectedAnnotation();
      expect(store.state.annotations).toEqual([]);
      expect(await store.undo()).toBe(true);
      expect(store.state.bytes).toBe(moved);
      expect(store.state.selectedAnnotation).toBe(id);
      expect(store.state.stickyNotes[0]).toMatchObject({
        text: "Updated",
        color: "#2196f3",
        point: { x: 70, y: 120 },
      });
      await store.undo();
      expect(store.state.bytes).toBe(updated);
      await store.undo();
      expect(store.state.bytes).toBe(original);
      expect(store.state.stickyNotes[0]).toMatchObject({
        text: "Original",
        color: "#fff176",
        point: { x: 40, y: 100 },
      });
      await store.redo();
      await store.redo();
      await store.redo();
      expect(store.state.annotations).toEqual([]);
      expect(store.state.selectedAnnotation).toBeNull();
      await store.addPageAnnotation(0, {
        type: "draw",
        color: "#2196f3",
        points: [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
      });
      const ink = store.state.bytes;
      await store.transformPageAnnotation(store.state.annotations[0].id, [2, 0, 0, 3, 10, -5]);
      const resized = store.state.bytes;
      await store.undo();
      expect(store.state.bytes).toBe(ink);
      await store.redo();
      expect(store.state.bytes).toBe(resized);
    });

    it("restores page context but preserves zoom, colors, file identity, and save semantics", async () => {
      await openDocument();
      store.state.selected = [0, 2];
      store.state.currentPage = 3;
      const before = store.state.bytes;
      await store.deleteSelected();
      store.setZoom(2);
      store.state.annotationColors.highlight = "#ff0000";
      await store.saveAs();
      await store.undo();
      expect(store.state.bytes).toBe(before);
      expect(store.state.selected).toEqual([0, 2]);
      expect(store.state.currentPage).toBe(3);
      expect(store.state.zoom).toBe(2);
      expect(store.state.annotationColors.highlight).toBe("#ff0000");
      expect(store.state.fileName).toBe("original.pdf");
      await store.saveCurrent();
      expect(files.writePdfTo).toHaveBeenLastCalledWith("/docs/original.pdf", before);
      expect(store.state.redoLabel).not.toBeNull();
      await store.redo();
      expect(store.state.pageCount).toBe(1);
      expect(store.state.selected).toEqual([]);
      expect(store.state.currentPage).toBe(1);
    });

    it("does not record navigation, selection, color changes, cancelled dialogs, or semantic no-ops", async () => {
      await openDocument(true);
      await store.rotateSelected(1);
      await store.undo();
      const redo = store.state.redoLabel;
      store.setCurrentPage(2);
      store.setZoom(2);
      store.selectPage(1, false);
      store.clearSelection();
      store.startAnnotation("draw");
      store.cancelPlacement();
      await store.movePage(0, 1);
      await store.movePage(-1, 0);
      await store.placeText(0, 20, 40, "  ");
      await store.applyFormValues({});
      await store.applyFormValues({ Name: "", Agree: false });
      await store.mergePdfAt(null);
      await store.pickImageToInsert();
      await store.openFile();
      await store.saveCurrent();
      expect(store.state.undoLabel).toBeNull();
      expect(store.state.redoLabel).toBe(redo);
      await store.insertBlankPage(0);
      expect(store.state.redoLabel).toBeNull();
      expect(await store.redo()).toBe(false);
    });

    it.each(["undo", "redo"] as const)(
      "keeps a failed %s retryable without corrupting either history branch",
      async (direction) => {
        await openDocument();
        await store.rotateSelected(1);
        if (direction === "redo") await store.undo();
        const before = store.state.bytes,
          version = store.state.version;
        const undoLabel = store.state.undoLabel,
          redoLabel = store.state.redoLabel;
        rendering.loadPdf.mockRejectedValueOnce(new Error("Worker failed"));
        expect(await store[direction]()).toBe(false);
        expect(store.state.bytes).toBe(before);
        expect(store.state.version).toBe(version);
        expect(store.state.undoLabel).toBe(undoLabel);
        expect(store.state.redoLabel).toBe(redoLabel);
        expect(store.state.error).toBe("Worker failed");
        expect(store.state.busy).toBe(false);
        expect(await store[direction]()).toBe(true);
        expect(store.state.error).toBe("");
      },
    );

    it.each(["loadDoc", "saveDoc", "getFormFields"] as const)(
      "rolls back a failed edit during %s without losing redo",
      async (stage) => {
        await openDocument();
        await store.rotateSelected(1);
        await store.undo();
        const before = store.state.bytes;
        const currentEdits = await import("../../src/lib/edits");
        vi.spyOn(currentEdits, stage).mockImplementationOnce(() => {
          throw new Error("Edit failed");
        });
        await store.insertBlankPage(0);
        expect(store.state.bytes).toBe(before);
        expect(store.state.pageCount).toBe(3);
        expect(store.state.undoLabel).toBeNull();
        expect(store.state.redoLabel).toBe("Rotated 1 page");
        expect(store.state.error).toBe("Edit failed");
        expect(store.state.busy).toBe(false);
        await store.insertBlankPage(0);
        expect(store.state.pageCount).toBe(4);
        expect(store.state.redoLabel).toBeNull();
      },
    );

    it("serializes edits, undo/redo, and document replacement while a renderer is pending", async () => {
      await openDocument();
      await store.rotateSelected(1);
      let resolve: ((pdf: typeof rendering.pdf) => void) | undefined;
      rendering.loadPdf.mockImplementationOnce(
        () =>
          new Promise<typeof rendering.pdf>((complete) => {
            resolve = complete;
          }),
      );
      const undo = store.undo();
      await vi.waitFor(() => expect(resolve).toBeDefined());
      const before = store.state.bytes;
      expect(store.state.busy).toBe(true);
      await store.insertBlankPage(0);
      await store.openBytes(await edits.saveDoc(await makeDoc(1)), "other.pdf");
      await store.openFile();
      expect(await store.undo()).toBe(false);
      expect(await store.redo()).toBe(false);
      expect(store.state.bytes).toBe(before);
      expect(store.state.fileName).toBe("original.pdf");
      if (!resolve) throw new Error("Renderer did not start");
      resolve(rendering.pdf);
      expect(await undo).toBe(true);
      expect(store.state.pageCount).toBe(3);
      expect(store.state.redoLabel).toBe("Rotated 1 page");
      expect(store.state.busy).toBe(false);
    });

    it("keeps document and history on failed opening, but resets both branches after successful opening", async () => {
      await openDocument();
      await store.rotateSelected(1);
      const before = store.state.bytes;
      rendering.loadPdf.mockRejectedValueOnce(new Error("Cannot render new document"));
      await store.openBytes(await edits.saveDoc(await makeDoc(1)), "failed.pdf");
      expect(store.state.bytes).toBe(before);
      expect(store.state.fileName).toBe("original.pdf");
      expect(store.state.undoLabel).toBe("Rotated 1 page");
      expect(store.state.busy).toBe(false);
      await store.undo();
      await store.openBytes(await edits.saveDoc(await makeDoc(1)), "replacement.pdf");
      expect(store.state.pageCount).toBe(1);
      expect(store.state.undoLabel).toBeNull();
      expect(store.state.redoLabel).toBeNull();
      expect(await store.undo()).toBe(false);
      expect(await store.redo()).toBe(false);
    });

    it("cancels pending placement only when history restoration succeeds", async () => {
      await openDocument();
      await store.rotateSelected(1);
      files.pickImage.mockResolvedValue({ bytes: png, name: "pending.png" });
      await store.pickImageToInsert();
      rendering.loadPdf.mockRejectedValueOnce("worker error");
      expect(await store.undo()).toBe(false);
      expect(store.state.mode).toBe("place-image");
      expect(store.state.pendingImage?.name).toBe("pending.png");
      expect(store.state.error).toBe("Could not undo the last edit.");
      expect(await store.undo()).toBe(true);
      expect(store.state.mode).toBe("view");
      expect(store.state.pendingImage).toBeNull();
    });
  });

  describe("annotation actions", () => {
    it("selects, transforms, erases, and clears stale annotation selections", async () => {
      await openDocument();
      await store.addPageAnnotation(0, {
        type: "sticky-note",
        point: { x: 40, y: 100 },
        text: "Move me",
        color: "#fff176",
      });
      const id = store.state.annotations[0].id;
      store.state.selected = [0, 1];
      store.selectAnnotation(id);
      expect(store.state.selectedAnnotation).toBe(id);
      expect(store.state.selected).toEqual([]);
      expect(await store.transformPageAnnotation(id, [1, 0, 0, 1, 20, -10])).toBe(true);
      expect(store.state.selectedAnnotation).toBe(id);
      expect(store.state.stickyNotes[0].point).toEqual({ x: 60, y: 90 });
      expect(await store.deleteSelectedAnnotation()).toBe(true);
      expect(store.state.selectedAnnotation).toBeNull();
      expect(store.state.annotations).toEqual([]);
      expect(store.state.stickyNotes).toEqual([]);
      expect(store.state.status).toBe("Deleted annotation");
      expect(await store.deleteSelectedAnnotation()).toBe(false);
    });

    it("preserves the PDF and selection when transforming or erasing fails", async () => {
      await openDocument();
      await store.addPageAnnotation(0, {
        type: "sticky-note",
        point: { x: 40, y: 100 },
        text: "Keep me",
        color: "#fff176",
      });
      const id = store.state.annotations[0].id;
      store.selectAnnotation(id);
      const original = store.state.bytes;
      rendering.loadPdf.mockRejectedValueOnce(new Error("Worker failed"));
      expect(await store.transformPageAnnotation(id, [1, 0, 0, 1, 20, 10])).toBe(false);
      expect(store.state.bytes).toBe(original);
      expect(store.state.selectedAnnotation).toBe(id);
      rendering.loadPdf.mockRejectedValueOnce(new Error("Worker failed"));
      expect(await store.deleteSelectedAnnotation()).toBe(false);
      expect(store.state.bytes).toBe(original);
      expect(store.state.annotations).toHaveLength(1);
      expect(store.state.busy).toBe(false);
      store.selectAnnotation("missing");
      expect(store.state.error).toContain("no longer exists");
      expect(store.state.selectedAnnotation).toBe(id);
      store.selectPage(0, false);
      expect(store.state.selectedAnnotation).toBeNull();
      store.selectAnnotation(id);
      store.clearSelection();
      expect(store.state.selectedAnnotation).toBeNull();
      store.selectAnnotation(id);
      await store.openBytes(await edits.saveDoc(await makeDoc()), "other.pdf");
      expect(store.state.selectedAnnotation).toBeNull();
    });
    it("does not annotate without a document", async () => {
      store.startAnnotation("draw");
      expect(store.state.mode).toBe("view");
      expect(await store.addPageAnnotation(0, { type: "draw", color: "#ffffff", points: [] })).toBe(
        false,
      );
      expect(await store.editStickyNote("missing", "text", "#ffffff")).toBe(false);
    });

    it.each(["highlight", "underline", "draw", "sticky-note"] as const)(
      "selects and toggles the %s tool, preserving per-tool colors",
      async (tool) => {
        await openDocument();
        store.state.pendingImage = { bytes: png, name: "image.png" };
        store.state.annotationColors[tool] = "#aabbcc";
        store.startAnnotation(tool);
        expect(store.state.mode).toBe(tool);
        expect(store.state.pendingImage).toBeNull();
        expect(store.state.status).toContain("Esc to cancel.");
        store.startAnnotation(tool);
        expect(store.state.mode).toBe("view");
        expect(store.state.annotationColors[tool]).toBe("#aabbcc");
      },
    );

    it("persists, refreshes, edits, and reopens sticky notes", async () => {
      await openDocument();
      store.startAnnotation("sticky-note");
      expect(
        await store.addPageAnnotation(1, {
          type: "sticky-note",
          point: { x: 40, y: 100 },
          text: "First",
          color: "#fff176",
        }),
      ).toBe(true);
      expect(store.state.version).toBe(2);
      expect(store.state.mode).toBe("sticky-note");
      expect(store.state.stickyNotes[0]).toMatchObject({
        page: 1,
        text: "First",
        color: "#fff176",
      });
      expect(await store.editStickyNote(store.state.stickyNotes[0].id, "Updated", "#2196f3")).toBe(
        true,
      );
      expect(store.state.version).toBe(3);
      const bytes = store.state.bytes!;
      await store.openBytes(bytes, "annotated.pdf");
      expect(store.state.stickyNotes[0]).toMatchObject({ text: "Updated", color: "#2196f3" });
      expect(store.state.busy).toBe(false);
      await store.openBytes(await edits.saveDoc(await makeDoc()), "plain.pdf");
      expect(store.state.stickyNotes).toEqual([]);
    });

    it("guards against overlapping annotation operations", async () => {
      await openDocument();
      store.state.busy = true;
      store.startAnnotation("draw");
      expect(store.state.mode).toBe("view");
      expect(await store.addPageAnnotation(0, { type: "draw", color: "#ffffff", points: [] })).toBe(
        false,
      );
      expect(await store.editStickyNote("missing", "text", "#ffffff")).toBe(false);
      await store.rotateSelected(1);
      await store.deleteSelected();
      await store.movePage(0, 1);
      await store.insertBlankPage(null);
      await store.mergePdfAt(null);
      await store.pickImageToInsert();
      store.startTextPlacement();
      await store.placePendingImage(0, 20, 20);
      await store.placeText(0, 20, 20, "text");
      await store.applyFormValues({});
      await store.saveCurrent();
      await store.saveAs();
      expect(files.pickPdf).not.toHaveBeenCalled();
      expect(files.pickImage).not.toHaveBeenCalled();
      expect(files.savePdf).not.toHaveBeenCalled();
      expect(files.writePdfTo).not.toHaveBeenCalled();
      expect(store.state.version).toBe(1);
    });

    it("keeps the original document on rendering failure, so retrying does not duplicate notes", async () => {
      await openDocument();
      const originalBytes = store.state.bytes;
      const annotation = {
        type: "sticky-note" as const,
        point: { x: 40, y: 100 },
        text: "Only once",
        color: "#fff176",
      };
      rendering.loadPdf.mockRejectedValueOnce(new Error("Worker failed"));
      expect(await store.addPageAnnotation(0, annotation)).toBe(false);
      expect(store.state.bytes).toBe(originalBytes);
      expect(store.state.stickyNotes).toEqual([]);
      expect(store.state.version).toBe(1);
      expect(store.state.error).toBe("Worker failed");
      expect(store.state.busy).toBe(false);
      expect(await store.addPageAnnotation(0, annotation)).toBe(true);
      expect(store.state.stickyNotes).toHaveLength(1);
      const savedBytes = store.state.bytes;
      rendering.loadPdf.mockRejectedValueOnce(new Error("Worker failed"));
      expect(await store.editStickyNote(store.state.stickyNotes[0].id, "Changed", "#2196f3")).toBe(
        false,
      );
      expect(store.state.bytes).toBe(savedBytes);
      expect(store.state.stickyNotes[0].text).toBe("Only once");
      expect(store.state.busy).toBe(false);
    });

    it("reports annotation failures and clears busy state", async () => {
      await openDocument();
      expect(await store.addPageAnnotation(0, { type: "draw", color: "invalid", points: [] })).toBe(
        false,
      );
      expect(store.state.error).toBe("Choose a valid annotation color.");
      expect(store.state.busy).toBe(false);
      expect(store.state.version).toBe(1);
      expect(await store.editStickyNote("missing", "text", "#ffffff")).toBe(false);
      expect(store.state.error).toContain("no longer exists");
      expect(store.state.busy).toBe(false);
    });
  });

  it("picks and places an image then resets placement mode", async () => {
    await openDocument();
    files.pickImage.mockResolvedValue({ bytes: png, name: "picture.png" });
    await store.pickImageToInsert();
    expect(store.state.pendingImage).toEqual({ bytes: png, name: "picture.png" });
    expect(store.state.mode).toBe("place-image");
    expect(store.state.status).toContain('Click on a page to place "picture.png"');
    await store.placePendingImage(0, 150, 100);
    expect(store.state.mode).toBe("view");
    expect(store.state.pendingImage).toBeNull();
    expect(store.state.status).toBe("Inserted picture.png");
    expect(store.state.version).toBe(2);
  });

  it("does not enter placement when the image picker is cancelled", async () => {
    await openDocument();
    await store.pickImageToInsert();
    await store.placePendingImage(0, 0, 0);
    expect(store.state.mode).toBe("view");
    expect(store.state.version).toBe(1);
  });

  it("retains a failed image for retry and exposes the error", async () => {
    await openDocument();
    files.pickImage.mockResolvedValue({ bytes: new Uint8Array([1]), name: "broken.jpg" });
    await store.pickImageToInsert();
    await store.placePendingImage(0, 0, 0);
    expect(store.state.error).not.toBe("");
    expect(store.state.mode).toBe("place-image");
    expect(store.state.pendingImage?.name).toBe("broken.jpg");
    expect(store.state.version).toBe(1);
    store.cancelPlacement();
    expect(store.state.pendingImage).toBeNull();
  });

  it("reports non-Error image insertion failures", async () => {
    await openDocument();
    const currentEdits = await import("../../src/lib/edits");
    vi.spyOn(currentEdits, "addImageToPage").mockRejectedValueOnce("decoder failed");
    files.pickImage.mockResolvedValue({ bytes: png, name: "image.png" });
    await store.pickImageToInsert();
    await store.placePendingImage(0, 0, 0);
    expect(store.state.error).toBe("Could not insert image.");
  });

  it("ignores blank text and persists nonblank text", async () => {
    await openDocument();
    await store.placeText(0, 10, 20, "   ");
    expect(store.state.version).toBe(1);
    await store.placeText(0, 10, 20, "  Hello  ");
    expect((await currentDoc()).getPage(0).node.Contents()).toBeDefined();
    expect(store.state.version).toBe(2);
    expect(store.state.status).toBe("Added text");
  });

  it("toggles the forms panel and reports documents without fields", async () => {
    await openDocument();
    store.toggleFormsPanel();
    expect(store.state.showFormsPanel).toBe(true);
    expect(store.state.status).toBe("No fillable form fields found.");
    store.toggleFormsPanel();
    expect(store.state.showFormsPanel).toBe(false);
  });

  it("applies and refreshes form values", async () => {
    await openDocument(true);
    store.toggleFormsPanel();
    await store.applyFormValues({ Name: "Ada", Agree: true });
    expect(store.state.formFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Name", value: "Ada" }),
        expect.objectContaining({ name: "Agree", value: true }),
      ]),
    );
    expect(store.state.status).toBe("Updated 2 form field(s)");
    expect(store.state.version).toBe(2);
  });
});
