// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { defineComponent, h, nextTick } from "vue";
import { enableAutoUnmount, flushPromises, mount, shallowMount } from "@vue/test-utils";
import Toolbar from "../../src/components/Toolbar.vue";
import FormPanel from "../../src/components/FormPanel.vue";
import StatusBar from "../../src/components/StatusBar.vue";
import ThumbnailsPanel from "../../src/components/ThumbnailsPanel.vue";
import PdfViewer from "../../src/components/PdfViewer.vue";
import App from "../../src/App.vue";
import { state } from "../../src/store";
import { createInitialState } from "../../src/state";

const actions = vi.hoisted(() => ({
  hasDoc: vi.fn(() => true),
  getPdfDoc: vi.fn(() => ({ id: "pdf" })),
  openFile: vi.fn(),
  saveCurrent: vi.fn(),
  saveAs: vi.fn(),
  rotateSelected: vi.fn(),
  deleteSelected: vi.fn(),
  insertBlankPage: vi.fn(),
  mergePdfAt: vi.fn(),
  pickImageToInsert: vi.fn(),
  startTextPlacement: vi.fn(),
  startAnnotation: vi.fn(),
  toggleFormsPanel: vi.fn(),
  setZoom: vi.fn(),
  setCurrentPage: vi.fn(),
  selectPage: vi.fn(),
  clearSelection: vi.fn(),
  movePage: vi.fn(),
  applyFormValues: vi.fn(),
  placePendingImage: vi.fn(),
  placeText: vi.fn(),
  cancelPlacement: vi.fn(),
  deleteSelectedAnnotation: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
}));

vi.mock("../../src/store", async () => {
  const { reactive } = await import("vue");
  const { createInitialState } = await import("../../src/state");
  return {
    ...actions,
    state: reactive(createInitialState()),
  };
});

const rendering = vi.hoisted(() => ({
  renderThumbnail: vi.fn(),
  renderPage: vi.fn(),
  pageSizeAtScale1: vi.fn(),
}));
vi.mock("../../src/lib/pdfjs", () => rendering);
vi.mock("../../src/components/AnnotationLayer.vue", () => ({
  default: { props: ["page"], template: "<div />" },
}));

enableAutoUnmount(afterEach);

type VisibilityEntry = { target: Element; isIntersecting: boolean };
let onVisibility: (entries: VisibilityEntry[]) => void;
const observe = vi.fn();
const disconnect = vi.fn();

beforeEach(() => {
  Object.assign(state, createInitialState());
  actions.hasDoc.mockReturnValue(true);
  actions.getPdfDoc.mockReturnValue({ id: "pdf" });
  rendering.renderThumbnail.mockImplementation(async () => document.createElement("canvas"));
  rendering.renderPage.mockResolvedValue({ width: 300, height: 200 });
  rendering.pageSizeAtScale1.mockResolvedValue({ width: 300, height: 200 });
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof onVisibility) {
        onVisibility = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
});

/** Supply a small open-document state for component tests without loading a real renderer. */
function loadedState(): void {
  state.bytes = new Uint8Array([1]);
  state.fileName = "document.pdf";
  state.pageCount = 3;
  state.currentPage = 2;
}

describe("Toolbar", () => {
  it("enables document actions when a PDF finishes opening and disables them while busy", async () => {
    actions.hasDoc.mockReturnValue(false);
    const wrapper = mount(Toolbar);
    const save = wrapper.findAll("button").find((button) => button.text() === "Save");
    if (!save) throw new Error("Missing Save button");
    expect(save.attributes("disabled")).toBeDefined();
    actions.hasDoc.mockReturnValue(true);
    loadedState();
    await nextTick();
    expect(save.attributes("disabled")).toBeUndefined();
    state.busy = true;
    await nextTick();
    expect(save.attributes("disabled")).toBeDefined();
    state.busy = false;
    await nextTick();
    expect(save.attributes("disabled")).toBeUndefined();
  });
  it.each([
    ["Highlight", "highlight"],
    ["Underline", "underline"],
    ["Draw", "draw"],
    ["Sticky Note", "sticky-note"],
  ] as const)("offers an icon button and color control for %s", async (label, tool) => {
    loadedState();
    const wrapper = mount(Toolbar);
    const button = wrapper.get(`button[title="${label}"]`);
    expect(button.find("svg").exists()).toBe(true);
    await button.trigger("click");
    expect(actions.startAnnotation).toHaveBeenCalledWith(tool);
    state.mode = tool;
    await nextTick();
    expect(button.attributes("aria-pressed")).toBe("true");
    await wrapper.get(`input[aria-label="${label} color"]`).setValue("#ff8800");
    expect(state.annotationColors[tool]).toBe("#ff8800");
  });
  it("disables document actions when nothing is open", () => {
    actions.hasDoc.mockReturnValue(false);
    const wrapper = mount(Toolbar);
    const buttons = wrapper
      .findAll("button")
      .filter((button) => button.attributes("disabled") !== undefined);
    expect(buttons).toHaveLength(18);
    expect(wrapper.get("button").attributes("disabled")).toBeUndefined();
  });

  it("disables opening and merging while busy", () => {
    state.busy = true;
    const wrapper = mount(Toolbar);
    expect(wrapper.get("button").attributes("disabled")).toBeDefined();
    expect(wrapper.get('button[title^="Merge"]').attributes("disabled")).toBeDefined();
  });

  it("exposes labeled undo/redo controls only when history is available and the document is idle", async () => {
    loadedState();
    const wrapper = mount(Toolbar);
    const undo = wrapper.get('button[title^="Undo"]');
    const redo = wrapper.get('button[title^="Redo"]');
    expect(undo.attributes("disabled")).toBeDefined();
    expect(redo.attributes("disabled")).toBeDefined();
    expect(undo.find("svg").exists()).toBe(true);
    expect(redo.find("svg").exists()).toBe(true);
    state.undoLabel = "Rotated 1 page";
    state.redoLabel = "Added annotation";
    await nextTick();
    expect(undo.attributes("disabled")).toBeUndefined();
    expect(undo.attributes("title")).toContain("Rotated 1 page");
    await undo.trigger("click");
    await redo.trigger("click");
    expect(actions.undo).toHaveBeenCalledOnce();
    expect(actions.redo).toHaveBeenCalledOnce();
    state.busy = true;
    await nextTick();
    expect(undo.attributes("disabled")).toBeDefined();
    expect(redo.attributes("disabled")).toBeDefined();
  });

  it.each([
    ["Save", "saveCurrent", []],
    ["Save As", "saveAs", []],
    ["Rotate L", "rotateSelected", [-1]],
    ["Rotate R", "rotateSelected", [1]],
    ["Delete Page", "deleteSelected", []],
    ["Blank Page", "insertBlankPage", [1]],
    ["Merge PDF", "mergePdfAt", [1]],
    ["Insert Image", "pickImageToInsert", []],
    ["Add Text", "startTextPlacement", []],
    ["Form Fields", "toggleFormsPanel", []],
  ] as const)("wires the %s action", async (label, action, args) => {
    loadedState();
    const wrapper = mount(Toolbar);
    const button = wrapper.findAll("button").find((item) => item.text().includes(label));
    if (!button) throw new Error(`Missing button: ${label}`);
    await button.trigger("click");
    if (args.length) expect(actions[action]).toHaveBeenCalledWith(...args);
    else expect(actions[action]).toHaveBeenCalledOnce();
  });

  it("opens files", async () => {
    const wrapper = mount(Toolbar);
    await wrapper.get("button").trigger("click");
    expect(actions.openFile).toHaveBeenCalledOnce();
  });

  it("emits page jumps, clamps typed values, and ignores invalid values", async () => {
    loadedState();
    const wrapper = mount(Toolbar);
    await wrapper.get('button[title="Previous page"]').trigger("click");
    await wrapper.get('button[title="Next page"]').trigger("click");
    await wrapper.get(".page-input").setValue("99");
    await wrapper.get(".page-input").setValue("0");
    await wrapper.get(".page-input").setValue("");
    expect(wrapper.emitted("goto-page")).toEqual([[1], [3], [3], [1]]);
  });

  it("reflects external navigation and disables navigation at document boundaries", async () => {
    loadedState();
    const wrapper = mount(Toolbar);
    state.currentPage = 3;
    await nextTick();
    expect(wrapper.get<HTMLInputElement>(".page-input").element.value).toBe("3");
    expect(wrapper.get('button[title="Next page"]').attributes("disabled")).toBeDefined();
    state.currentPage = 1;
    await nextTick();
    expect(wrapper.get('button[title="Previous page"]').attributes("disabled")).toBeDefined();
  });

  it("wires zoom, fit-width, text size, and forms-panel active state", async () => {
    const wrapper = mount(Toolbar);
    await wrapper.get('button[title="Zoom in"]').trigger("click");
    expect(actions.setZoom).toHaveBeenLastCalledWith(1.5);
    await wrapper.get('button[title="Zoom out"]').trigger("click");
    expect(actions.setZoom).toHaveBeenLastCalledWith(1.25 / 1.2);
    const fit = wrapper.findAll("button").find((button) => button.text() === "Fit Width");
    if (!fit) throw new Error("Missing Fit Width");
    await fit.trigger("click");
    expect(wrapper.emitted("fit-width")).toEqual([[]]);
    await wrapper.get(".size-label input").setValue(20);
    expect(state.textSize).toBe(20);
    state.showFormsPanel = true;
    await nextTick();
    expect(wrapper.get("button.active").text()).toBe("Form Fields");
  });
});

describe("FormPanel", () => {
  function fields(): void {
    state.formFields = [
      { name: "Name", type: "text", page: 0, value: "Ada" },
      { name: "Agree", type: "checkbox", page: 0, value: false },
      { name: "Country", type: "dropdown", page: 1, value: "US", options: ["US", "DE"] },
      { name: "Delivery", type: "radio", page: -1, value: "", options: ["Email", "Post"] },
    ];
  }

  it("shows an empty state and disables applying without fields", () => {
    const wrapper = mount(FormPanel);
    expect(wrapper.text()).toContain("No fillable form fields");
    expect(wrapper.get(".apply").attributes("disabled")).toBeDefined();
  });

  it("keeps edits local until Apply and submits all supported value types", async () => {
    fields();
    const wrapper = mount(FormPanel);
    await wrapper.get('input:not([type="checkbox"])').setValue("Grace");
    await wrapper.get('input[type="checkbox"]').setValue(true);
    await wrapper.findAll("select")[0].setValue("DE");
    await wrapper.findAll("select")[1].setValue("Email");
    expect(state.formFields[0].value).toBe("Ada");
    expect(actions.applyFormValues).not.toHaveBeenCalled();
    await wrapper.get(".apply").trigger("click");
    expect(actions.applyFormValues).toHaveBeenCalledWith({
      Name: "Grace",
      Agree: true,
      Country: "DE",
      Delivery: "Email",
    });
  });

  it("replaces stale drafts when the document's fields change", async () => {
    fields();
    const wrapper = mount(FormPanel);
    state.formFields = [{ name: "New", type: "text", page: 0, value: "fresh" }];
    await nextTick();
    await wrapper.get(".apply").trigger("click");
    expect(actions.applyFormValues).toHaveBeenCalledWith({ New: "fresh" });
  });

  it("emits page jumps only for known pages and closes on request", async () => {
    fields();
    const wrapper = mount(FormPanel);
    await wrapper.findAll(".field-name")[2].trigger("click");
    await wrapper.findAll(".field-name")[3].trigger("click");
    expect(wrapper.emitted("goto-page")).toEqual([[2]]);
    await wrapper.get('button[title="Close panel"]').trigger("click");
    expect(wrapper.emitted("close")).toEqual([[]]);
  });
});

describe("StatusBar", () => {
  it("shows the initial status and document placeholder", () => {
    const wrapper = mount(StatusBar);
    expect(wrapper.text()).toContain("Open a PDF to get started.");
    expect(wrapper.text()).toContain("No document");
    expect(wrapper.text()).not.toContain("selected");
    expect(wrapper.text()).not.toContain("pages");
  });

  it("prioritizes errors and reflects document and selection counts", () => {
    loadedState();
    state.selected = [0, 2];
    state.error = "Save failed";
    const wrapper = mount(StatusBar);
    expect(wrapper.get(".error").text()).toBe("Save failed");
    expect(wrapper.text()).not.toContain(state.status);
    expect(wrapper.text()).toContain("2 selected");
    expect(wrapper.text()).toContain("3 pages");
    expect(wrapper.text()).toContain("document.pdf");
  });
});

describe("ThumbnailsPanel", () => {
  beforeEach(loadedState);

  it("renders one canvas per page and replaces canvases after edits", async () => {
    const wrapper = mount(ThumbnailsPanel);
    await flushPromises();
    expect(wrapper.findAll(".thumb")).toHaveLength(3);
    const old = wrapper.get("canvas").element;
    state.version++;
    await flushPromises();
    expect(wrapper.findAll("canvas")).toHaveLength(3);
    expect(wrapper.get("canvas").element).not.toBe(old);
    expect(rendering.renderThumbnail).toHaveBeenCalledWith({ id: "pdf" }, 1, 128);
    state.pageCount = 2;
    await flushPromises();
    expect(wrapper.findAll("canvas")).toHaveLength(2);
  });

  it("discards stale in-flight thumbnails after the document changes", async () => {
    let finish: ((canvas: HTMLCanvasElement) => void) | undefined;
    rendering.renderThumbnail.mockImplementationOnce(
      () =>
        new Promise<HTMLCanvasElement>((resolve) => {
          finish = resolve;
        }),
    );
    const wrapper = mount(ThumbnailsPanel);
    state.version++;
    await flushPromises();
    const stale = document.createElement("canvas");
    if (!finish) throw new Error("Thumbnail did not start");
    finish(stale);
    await flushPromises();
    expect(wrapper.findAll("canvas")).toHaveLength(3);
    expect(wrapper.findAll("canvas").some((canvas) => canvas.element === stale)).toBe(false);
  });

  it("selects with modifiers, clears the background, and emits one-based jumps", async () => {
    state.selected = [0];
    const wrapper = mount(ThumbnailsPanel);
    await flushPromises();
    expect(wrapper.findAll(".thumb")[0].classes()).toContain("selected");
    expect(wrapper.findAll(".thumb")[1].classes()).toContain("current");
    await wrapper.findAll(".thumb")[1].trigger("click");
    await wrapper.findAll(".thumb")[2].trigger("click", { ctrlKey: true });
    await wrapper.findAll(".thumb")[0].trigger("click", { metaKey: true });
    expect(actions.selectPage.mock.calls).toEqual([
      [1, false],
      [2, true],
      [0, true],
    ]);
    await wrapper.findAll(".thumb")[2].trigger("dblclick");
    expect(wrapper.emitted("jump")).toEqual([[3]]);
    await wrapper.trigger("click");
    expect(actions.clearSelection).toHaveBeenCalledOnce();
  });

  it.each([
    [0, 1],
    [20, 2],
  ])("reorders before or after the drop midpoint (%s)", async (clientY, to) => {
    const wrapper = mount(ThumbnailsPanel);
    await flushPromises();
    const thumbs = wrapper.findAll(".thumb");
    vi.spyOn(thumbs[1].element, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 100, 20),
    );
    await thumbs[0].trigger("dragstart");
    await thumbs[1].trigger("dragover", { clientY });
    expect(thumbs[1].classes()).toContain(to === 1 ? "drop-before" : "drop-after");
    await thumbs[1].trigger("drop");
    expect(actions.movePage).toHaveBeenCalledWith(0, to);
    expect(thumbs[1].classes()).not.toContain("drop-before");
    expect(thumbs[1].classes()).not.toContain("drop-after");
  });

  it("ignores external drops, same-page drops, and ended drags", async () => {
    const wrapper = mount(ThumbnailsPanel);
    await flushPromises();
    const thumbs = wrapper.findAll(".thumb");
    await thumbs[0].trigger("drop");
    await thumbs[0].trigger("dragstart");
    await thumbs[0].trigger("drop");
    await thumbs[0].trigger("dragstart");
    await thumbs[1].trigger("dragover");
    await thumbs[0].trigger("dragend");
    await thumbs[1].trigger("drop");
    expect(actions.movePage).not.toHaveBeenCalled();
  });

  it("logs thumbnail errors and continues rendering later pages", async () => {
    const error = new Error("Thumbnail failed");
    rendering.renderThumbnail.mockRejectedValueOnce(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const wrapper = mount(ThumbnailsPanel);
    await flushPromises();
    expect(log).toHaveBeenCalledWith("Failed to render thumbnail 1", error);
    expect(wrapper.findAll("canvas")).toHaveLength(2);
  });
});

describe("PdfViewer", () => {
  it("rerenders a page if an annotation refresh arrives during an existing render", async () => {
    loadedState();
    let finish: (() => void) | undefined;
    rendering.renderPage.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const wrapper = mount(PdfViewer);
    await flushPromises();
    onVisibility([{ target: wrapper.get(".page-slot").element, isIntersecting: true }]);
    state.version++;
    await nextTick();
    if (!finish) throw new Error("Render did not start");
    finish();
    await flushPromises();
    expect(rendering.renderPage).toHaveBeenCalledTimes(2);
  });
  it("shows an empty state without a document", () => {
    const wrapper = mount(PdfViewer);
    expect(wrapper.text()).toContain("No document open.");
    expect(wrapper.find("canvas").exists()).toBe(false);
  });

  it("renders only visible pages and rerenders when zoom or version changes", async () => {
    loadedState();
    const wrapper = mount(PdfViewer);
    await flushPromises();
    expect(observe).toHaveBeenCalledTimes(3);
    expect(rendering.renderPage).not.toHaveBeenCalled();
    const target = wrapper.findAll(".page-slot")[1].element;
    onVisibility([{ target, isIntersecting: true }]);
    await flushPromises();
    expect(rendering.renderPage).toHaveBeenCalledWith(
      { id: "pdf" },
      2,
      1.25,
      wrapper.findAll("canvas")[1].element,
    );
    onVisibility([{ target, isIntersecting: true }]);
    await flushPromises();
    expect(rendering.renderPage).toHaveBeenCalledTimes(1);
    state.zoom = 2;
    await flushPromises();
    expect(rendering.renderPage).toHaveBeenCalledTimes(2);
    onVisibility([{ target, isIntersecting: false }]);
    state.version++;
    await flushPromises();
    expect(rendering.renderPage).toHaveBeenCalledTimes(2);
    wrapper.unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it("rebuilds the observer when page count changes", async () => {
    loadedState();
    const wrapper = mount(PdfViewer);
    await flushPromises();
    state.pageCount = 2;
    await flushPromises();
    expect(wrapper.findAll("canvas")).toHaveLength(2);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(5);
  });

  it("does not start duplicate renders while a page is in flight", async () => {
    loadedState();
    let finish: (() => void) | undefined;
    rendering.renderPage.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const wrapper = mount(PdfViewer);
    await flushPromises();
    const target = wrapper.get(".page-slot").element;
    onVisibility([{ target, isIntersecting: true }]);
    onVisibility([{ target, isIntersecting: true }]);
    expect(rendering.renderPage).toHaveBeenCalledOnce();
    if (!finish) throw new Error("Render did not start");
    finish();
    await flushPromises();
  });

  it("selects pages with Ctrl or Meta modifiers", async () => {
    loadedState();
    const wrapper = mount(PdfViewer);
    await wrapper.findAll("canvas")[1].trigger("click", { metaKey: true });
    await wrapper.findAll("canvas")[0].trigger("click");
    expect(actions.selectPage.mock.calls).toEqual([
      [1, true],
      [0, false],
    ]);
  });

  it.each(["place-image", "place-text"] as const)(
    "converts canvas coordinates to PDF points for %s",
    async (mode) => {
      loadedState();
      state.mode = mode;
      state.zoom = 2;
      const wrapper = mount(PdfViewer);
      const canvas = wrapper.findAll("canvas")[1];
      vi.spyOn(canvas.element, "getBoundingClientRect").mockReturnValue(
        new DOMRect(10, 20, 600, 400),
      );
      await canvas.trigger("click", { clientX: 110, clientY: 80 });
      await flushPromises();
      expect(wrapper.classes()).toContain("placing");
      if (mode === "place-image") {
        expect(actions.placePendingImage).toHaveBeenCalledWith(1, 50, 170);
      } else {
        expect(wrapper.emitted("request-text")).toEqual([[{ page: 1, x: 50, y: 170 }]]);
      }
    },
  );

  it("fits width and scrolls to a requested page", async () => {
    loadedState();
    const wrapper = mount(PdfViewer);
    Object.defineProperty(wrapper.element, "clientWidth", { value: 656 });
    await wrapper.vm.fitWidth();
    expect(actions.setZoom).toHaveBeenCalledWith(2);
    const scroll = vi.fn();
    Object.defineProperty(wrapper.findAll(".page-slot")[1].element, "scrollIntoView", {
      value: scroll,
    });
    wrapper.vm.scrollToPage(2);
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    wrapper.vm.scrollToPage(99);
    expect(scroll).toHaveBeenCalledOnce();
  });

  it("tracks the page nearest the viewport center on scroll", async () => {
    loadedState();
    const wrapper = mount(PdfViewer);
    await flushPromises();
    vi.spyOn(wrapper.element, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 400));
    wrapper.findAll(".page-slot").forEach((slot, index) => {
      vi.spyOn(slot.element, "getBoundingClientRect").mockReturnValue(
        new DOMRect(0, index * 300 - 200, 300, 200),
      );
    });
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      }),
    );
    await wrapper.trigger("scroll");
    await wrapper.trigger("scroll");
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    if (!frame) throw new Error("Scroll frame was not requested");
    frame(0);
    expect(actions.setCurrentPage).toHaveBeenCalledWith(2);
  });

  it("logs rendering failures and allows retry", async () => {
    loadedState();
    const error = new Error("Render failed");
    rendering.renderPage.mockRejectedValueOnce(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const wrapper = mount(PdfViewer);
    await flushPromises();
    const target = wrapper.get(".page-slot").element;
    onVisibility([{ target, isIntersecting: true }]);
    await flushPromises();
    expect(log).toHaveBeenCalledWith("Failed to render page 1", error);
    onVisibility([{ target, isIntersecting: true }]);
    await flushPromises();
    expect(rendering.renderPage).toHaveBeenCalledTimes(2);
  });
});

describe("App", () => {
  const scrollToPage = vi.fn();
  const fitWidth = vi.fn();
  const viewer = defineComponent({
    name: "PdfViewer",
    emits: ["request-text"],
    setup(_, { expose }) {
      expose({ scrollToPage, fitWidth });
      return () => h("div");
    },
  });
  function mountApp() {
    return shallowMount(App, { global: { stubs: { PdfViewer: viewer } } });
  }

  it.each([
    [{ key: "z", ctrlKey: true }, "undo"],
    [{ key: "Z", metaKey: true }, "undo"],
    [{ key: "z", ctrlKey: true, shiftKey: true }, "redo"],
    [{ key: "Z", metaKey: true, shiftKey: true }, "redo"],
    [{ key: "y", ctrlKey: true }, "redo"],
  ] as const)("routes document shortcut %j to %s", (keys, action) => {
    mountApp();
    state.undoLabel = "Edit";
    state.redoLabel = "Edit";
    const event = new KeyboardEvent("keydown", { ...keys, cancelable: true });
    window.dispatchEvent(event);
    expect(actions[action]).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves native text undo alone for form fields, contenteditable targets, and note popups", () => {
    mountApp();
    state.undoLabel = "Edit";
    for (const tag of ["input", "textarea", "select", "div", "form"]) {
      const element = document.createElement(tag);
      if (tag === "div") element.setAttribute("contenteditable", "true");
      if (tag === "form") element.className = "note-popup";
      document.body.append(element);
      const event = new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      element.remove();
    }
    expect(actions.undo).not.toHaveBeenCalled();
  });

  it("ignores history shortcuts when unavailable, busy, composing, repeated, or already handled", async () => {
    const wrapper = mountApp();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }));
    state.undoLabel = "Edit";
    for (const options of [
      { repeat: true },
      { isComposing: true },
      { altKey: true },
      { ctrlKey: false },
    ])
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, ...options }));
    const handled = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    state.busy = true;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }));
    state.busy = false;
    wrapper.getComponent(viewer).vm.$emit("request-text", { page: 0, x: 0, y: 0 });
    await nextTick();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }));
    expect(actions.undo).not.toHaveBeenCalled();
    expect(actions.redo).not.toHaveBeenCalled();
  });

  it("deletes selected annotations with Delete, but not while typing or during a modal", async () => {
    const wrapper = mountApp();
    state.selectedAnnotation = "10 0 R";
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", cancelable: true }));
    expect(actions.deleteSelectedAnnotation).toHaveBeenCalledOnce();
    for (const tag of ["input", "textarea", "select", "div"]) {
      const input = document.createElement(tag);
      if (tag === "div") input.setAttribute("contenteditable", "true");
      document.body.append(input);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      input.remove();
    }
    state.busy = true;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
    state.busy = false;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", repeat: true }));
    wrapper.getComponent(viewer).vm.$emit("request-text", { page: 0, x: 0, y: 0 });
    await nextTick();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
    expect(actions.deleteSelectedAnnotation).toHaveBeenCalledOnce();
  });

  it("conditionally displays thumbnails and forms", async () => {
    const wrapper = mountApp();
    expect(wrapper.findComponent(ThumbnailsPanel).exists()).toBe(false);
    expect(wrapper.findComponent(FormPanel).exists()).toBe(false);
    loadedState();
    state.showFormsPanel = true;
    state.formFields = [{ name: "Name", type: "text", page: 0, value: "" }];
    await nextTick();
    expect(wrapper.findComponent(ThumbnailsPanel).exists()).toBe(true);
    wrapper.getComponent(FormPanel).vm.$emit("close");
    await nextTick();
    expect(state.showFormsPanel).toBe(false);
  });

  it("routes jumps and fit-width requests to the viewer", async () => {
    loadedState();
    const wrapper = mountApp();
    wrapper.getComponent(Toolbar).vm.$emit("goto-page", 99);
    expect(actions.setCurrentPage).toHaveBeenCalledWith(3);
    expect(scrollToPage).toHaveBeenCalledWith(3);
    wrapper.getComponent(Toolbar).vm.$emit("fit-width");
    expect(fitWidth).toHaveBeenCalledOnce();
    wrapper.getComponent(ThumbnailsPanel).vm.$emit("jump", -1);
    expect(scrollToPage).toHaveBeenLastCalledWith(1);
  });

  it("opens a text prompt and inserts trimmed text at the requested coordinates", async () => {
    const wrapper = mountApp();
    wrapper.getComponent(viewer).vm.$emit("request-text", { page: 1, x: 20, y: 40 });
    await nextTick();
    expect(wrapper.get("h3").text()).toBe("Add text to page 2");
    await wrapper.get("textarea").setValue("  Hello  ");
    await wrapper.get(".modal .size-label input").setValue(24);
    expect(state.textSize).toBe(24);
    await wrapper.get("button.primary").trigger("click");
    await flushPromises();
    expect(actions.placeText).toHaveBeenCalledWith(1, 20, 40, "Hello");
    expect(wrapper.find(".modal").exists()).toBe(false);
  });

  it("does not insert whitespace-only text", async () => {
    const wrapper = mountApp();
    wrapper.getComponent(viewer).vm.$emit("request-text", { page: 0, x: 0, y: 0 });
    await nextTick();
    await wrapper.get("textarea").setValue("   ");
    await wrapper.get("button.primary").trigger("click");
    expect(actions.placeText).not.toHaveBeenCalled();
    expect(wrapper.find(".modal").exists()).toBe(false);
  });

  it("dismisses prompts before cancelling placement and removes its key listener on unmount", async () => {
    const wrapper = mountApp();
    wrapper.getComponent(viewer).vm.$emit("request-text", { page: 0, x: 0, y: 0 });
    await nextTick();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(wrapper.find(".modal").exists()).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(wrapper.find(".modal").exists()).toBe(false);
    expect(actions.cancelPlacement).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(actions.cancelPlacement).toHaveBeenCalledOnce();
    wrapper.unmount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(actions.cancelPlacement).toHaveBeenCalledOnce();
  });

  it("cancels the prompt using the backdrop or cancel button", async () => {
    const wrapper = mountApp();
    for (const selector of [".modal-backdrop", ".modal-actions button"]) {
      wrapper.getComponent(viewer).vm.$emit("request-text", { page: 0, x: 0, y: 0 });
      await nextTick();
      await wrapper.get(selector).trigger("click");
      expect(wrapper.find(".modal").exists()).toBe(false);
    }
    expect(actions.placeText).not.toHaveBeenCalled();
  });
});
