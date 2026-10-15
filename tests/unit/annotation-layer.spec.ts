// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { nextTick } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import AnnotationLayer from "../../src/components/AnnotationLayer.vue";
import { state } from "../../src/store";
import { createInitialState } from "../../src/state";

const actions = vi.hoisted(() => ({
  getPdfDoc: vi.fn(() => ({ id: "pdf" })),
  addPageAnnotation: vi.fn(),
  editStickyNote: vi.fn(),
  selectAnnotation: vi.fn((_id: string | null) => {}),
  transformPageAnnotation: vi.fn(),
}));
const geometry = vi.hoisted(() => ({
  width: 300,
  height: 200,
  convertToPdfPoint: vi.fn((x: number, y: number) => [x, 200 - y]),
  convertToViewportPoint: vi.fn((x: number, y: number) => [x, 200 - y]),
}));
const rendering = vi.hoisted(() => ({ pageViewportAtScale1: vi.fn() }));
vi.mock("../../src/lib/pdfjs", () => rendering);
vi.mock("../../src/store", async () => {
  const { reactive } = await import("vue");
  const { createInitialState } = await import("../../src/state");
  return {
    ...actions,
    state: reactive(createInitialState()),
  };
});

enableAutoUnmount(afterEach);
beforeEach(() => {
  Object.assign(state, createInitialState(), { zoom: 1, mode: "highlight" });
  geometry.width = 300;
  geometry.height = 200;
  geometry.convertToPdfPoint.mockImplementation((x, y) => [x, 200 - y]);
  geometry.convertToViewportPoint.mockImplementation((x, y) => [x, 200 - y]);
  rendering.pageViewportAtScale1.mockResolvedValue(geometry);
  actions.addPageAnnotation.mockResolvedValue(true);
  actions.editStickyNote.mockResolvedValue(true);
  actions.transformPageAnnotation.mockResolvedValue(true);
  actions.selectAnnotation.mockImplementation((id) => {
    state.selectedAnnotation = id;
  });
});

/** Mount page two with known pointer bounds and capture spies for both annotation surfaces. */
async function mountLayer() {
  const wrapper = mount(AnnotationLayer, { props: { page: 2 } });
  await flushPromises();
  const svg = wrapper.get<SVGSVGElement>(".annotation-surface");
  const capture = vi.fn();
  const release = vi.fn();
  svg.element.setPointerCapture = capture;
  svg.element.releasePointerCapture = release;
  vi.spyOn(svg.element, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 600, 400));
  const selectionSvg = wrapper.get<SVGSVGElement>(".annotation-selection-surface");
  selectionSvg.element.setPointerCapture = vi.fn();
  selectionSvg.element.releasePointerCapture = vi.fn();
  vi.spyOn(selectionSvg.element, "getBoundingClientRect").mockReturnValue(
    new DOMRect(10, 20, 600, 400),
  );
  return { wrapper, svg, capture, release, selectionSvg };
}

describe("annotation pointer interactions", () => {
  it.each(["highlight", "underline"] as const)(
    "previews and commits %s drags at any zoom",
    async (tool) => {
      state.mode = tool;
      state.zoom = 2;
      const { wrapper, svg, capture, release } = await mountLayer();
      await svg.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 210, clientY: 120 });
      await svg.trigger("pointermove", { pointerId: 1, clientX: 50, clientY: 80 });
      expect(wrapper.find(tool === "highlight" ? "rect" : "line").exists()).toBe(true);
      await svg.trigger("pointerup", { pointerId: 1, clientX: 50, clientY: 80 });
      expect(actions.addPageAnnotation).toHaveBeenCalledWith(1, {
        type: tool,
        color: state.annotationColors[tool],
        points: [
          { x: 20, y: 170 },
          { x: 100, y: 170 },
          { x: 20, y: 150 },
          { x: 100, y: 150 },
        ],
      });
      expect(wrapper.find("rect").exists()).toBe(false);
      expect(capture).toHaveBeenCalledWith(1);
      expect(release).toHaveBeenCalledWith(1);
    },
  );

  it("uses the PDF viewport transform for rotated and cropped pages", async () => {
    geometry.width = 200;
    geometry.height = 300;
    geometry.convertToPdfPoint.mockImplementation((x, y) => [y + 50, x + 100]);
    const { svg } = await mountLayer();
    await svg.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 10, clientY: 20 });
    await svg.trigger("pointerup", { pointerId: 1, clientX: 310, clientY: 220 });
    expect(actions.addPageAnnotation).toHaveBeenCalledWith(1, {
      type: "highlight",
      color: "#fff176",
      points: [
        { x: 50, y: 100 },
        { x: 50, y: 200 },
        { x: 200, y: 100 },
        { x: 200, y: 200 },
      ],
    });
  });

  it("previews freehand drawing, captures all points, and clamps outside-page drags", async () => {
    state.mode = "draw";
    const { wrapper, svg } = await mountLayer();
    await svg.trigger("pointerdown", { button: 0, pointerId: 7, clientX: 30, clientY: 40 });
    await svg.trigger("pointermove", { pointerId: 99, clientX: 100, clientY: 100 });
    await svg.trigger("pointermove", { pointerId: 7, clientX: 90, clientY: 100 });
    expect(wrapper.get("polyline").attributes("points")).toBe("10,10 40,40");
    await svg.trigger("pointerup", { pointerId: 7, clientX: 9999, clientY: -100 });
    expect(actions.addPageAnnotation).toHaveBeenCalledWith(1, {
      type: "draw",
      color: "#2196f3",
      points: [
        { x: 10, y: 190 },
        { x: 40, y: 160 },
        { x: 300, y: 200 },
      ],
    });
  });

  it.each(["highlight", "draw"] as const)("ignores accidental clicks for %s", async (tool) => {
    state.mode = tool;
    const { svg } = await mountLayer();
    await svg.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 30, clientY: 40 });
    await svg.trigger("pointerup", { pointerId: 1, clientX: 30, clientY: 40 });
    expect(actions.addPageAnnotation).not.toHaveBeenCalled();
  });

  it("ignores right clicks, busy operations, view mode, and other pointers", async () => {
    const { svg } = await mountLayer();
    await svg.trigger("pointerdown", { button: 2, pointerId: 1, clientX: 30, clientY: 40 });
    state.busy = true;
    await svg.trigger("pointerdown", { button: 0, pointerId: 1 });
    state.busy = false;
    state.mode = "view";
    await nextTick();
    expect(svg.classes()).not.toContain("active");
    await svg.trigger("pointerdown", { button: 0, pointerId: 1 });
    await svg.trigger("pointerup", { pointerId: 1 });
    expect(actions.addPageAnnotation).not.toHaveBeenCalled();
  });

  it.each(["pointercancel", "lostpointercapture"])("discards strokes on %s", async (event) => {
    const { wrapper, svg } = await mountLayer();
    await svg.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 30, clientY: 40 });
    await svg.trigger("pointermove", { pointerId: 1, clientX: 90, clientY: 100 });
    await svg.trigger(event);
    await svg.trigger("pointerup", { pointerId: 1, clientX: 90, clientY: 100 });
    expect(wrapper.find("rect").exists()).toBe(false);
    expect(actions.addPageAnnotation).not.toHaveBeenCalled();
  });

  it("discards in-progress gestures on zoom and tool changes", async () => {
    const { wrapper, svg } = await mountLayer();
    for (const change of [
      () => state.zoom++,
      () => {
        state.mode = "draw";
      },
    ]) {
      await svg.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 30, clientY: 40 });
      await svg.trigger("pointermove", { pointerId: 1, clientX: 90, clientY: 100 });
      change();
      await nextTick();
      expect(wrapper.find("rect").exists()).toBe(false);
    }
    expect(actions.addPageAnnotation).not.toHaveBeenCalled();
  });
});

describe("sticky note editor", () => {
  it("creates notes with editable text and a color without saving cancelled drafts", async () => {
    state.mode = "sticky-note";
    const { wrapper, svg } = await mountLayer();
    await svg.trigger("pointerdown", { button: 0, clientX: 90, clientY: 100 });
    expect(wrapper.get('button[type="submit"]').attributes("disabled")).toBeDefined();
    await wrapper.get("textarea").setValue("A comment");
    await wrapper.get('input[type="color"]').setValue("#ff8800");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(actions.addPageAnnotation).toHaveBeenCalledWith(1, {
      type: "sticky-note",
      point: { x: 40, y: 160 },
      text: "A comment",
      color: "#ff8800",
    });
    expect(wrapper.find("form").exists()).toBe(false);
    await svg.trigger("pointerdown", { button: 0, clientX: 90, clientY: 100 });
    await wrapper.get('button[type="button"]').trigger("click");
    expect(wrapper.find("form").exists()).toBe(false);
    expect(actions.addPageAnnotation).toHaveBeenCalledOnce();
  });

  it("displays and edits saved notes on their own page", async () => {
    state.mode = "view";
    state.stickyNotes = [
      { id: "1 0 R", page: 1, point: { x: 40, y: 160 }, text: "Existing", color: "#ff8800" },
      { id: "2 0 R", page: 0, point: { x: 0, y: 0 }, text: "Other page", color: "#ffffff" },
    ];
    state.annotations = state.stickyNotes.map((note) => ({
      id: note.id,
      page: note.page,
      type: "sticky-note",
      paths: [],
      rect: { x: note.point.x, y: note.point.y - 22, width: 22, height: 22 },
    }));
    const { wrapper } = await mountLayer();
    expect(wrapper.findAll(".note-icon")).toHaveLength(1);
    expect(wrapper.get(".note-icon").attributes("style")).toContain("left: 13.333333333333334%");
    await wrapper.get(".note-icon").trigger("dblclick");
    expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe("Existing");
    await wrapper.get("textarea").setValue("Edited");
    await wrapper.get('input[type="color"]').setValue("#2196f3");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(actions.editStickyNote).toHaveBeenCalledWith("1 0 R", "Edited", "#2196f3");
    expect(actions.addPageAnnotation).not.toHaveBeenCalled();
  });

  it("retains a failed draft so the user can retry", async () => {
    state.mode = "sticky-note";
    actions.addPageAnnotation.mockResolvedValue(false);
    const { wrapper, svg } = await mountLayer();
    await svg.trigger("pointerdown", { button: 0, clientX: 90, clientY: 100 });
    await wrapper.get("textarea").setValue("Keep me");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe("Keep me");
  });

  it("dismisses drafts with Escape or when a different document is opened", async () => {
    state.mode = "sticky-note";
    const { wrapper, svg } = await mountLayer();
    await svg.trigger("pointerdown", { button: 0, clientX: 90, clientY: 100 });
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    expect(wrapper.find("form").exists()).toBe(true);
    await wrapper.get("textarea").trigger("keydown", { key: "Escape" });
    expect(wrapper.find("form").exists()).toBe(false);
    await svg.trigger("pointerdown", { button: 0, clientX: 90, clientY: 100 });
    state.version++;
    await flushPromises();
    expect(wrapper.find("form").exists()).toBe(false);
    expect(actions.addPageAnnotation).not.toHaveBeenCalled();
  });
});

describe("annotation geometry loading", () => {
  it("reports geometry errors", async () => {
    rendering.pageViewportAtScale1.mockRejectedValueOnce(new Error("Page failed"));
    const wrapper = mount(AnnotationLayer, { props: { page: 1 } });
    await flushPromises();
    expect(state.error).toBe("Page failed");
    expect(wrapper.find("svg").exists()).toBe(false);
  });

  it("ignores geometry loads superseded by a document change", async () => {
    let complete: ((value: typeof geometry) => void) | undefined;
    rendering.pageViewportAtScale1.mockImplementationOnce(
      () =>
        new Promise<typeof geometry>((resolve) => {
          complete = resolve;
        }),
    );
    const wrapper = mount(AnnotationLayer, { props: { page: 1 } });
    state.version++;
    await flushPromises();
    if (!complete) throw new Error("Geometry did not start");
    complete({ ...geometry, width: 900 });
    await flushPromises();
    expect(wrapper.get(".annotation-surface").attributes("viewBox")).toBe("0 0 300 200");
  });
});

describe("selecting, moving, and resizing annotations", () => {
  function mark(type: "highlight" | "underline" | "draw" = "highlight"): void {
    state.mode = "view";
    state.annotations = [
      {
        id: "10 0 R",
        page: 1,
        type,
        rect: { x: 20, y: 100, width: 100, height: 20 },
        paths: [
          [
            { x: 20, y: 120 },
            { x: 120, y: 120 },
            { x: 20, y: 100 },
            { x: 120, y: 100 },
          ],
        ],
      },
    ];
  }

  it.each(["highlight", "underline", "draw"] as const)(
    "selects a %s on first click without moving it",
    async (type) => {
      mark(type);
      const { wrapper, selectionSvg } = await mountLayer();
      const hit = wrapper.get(".annotation-hit");
      await hit.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 150, clientY: 200 });
      await selectionSvg.trigger("pointerup", { pointerId: 1, clientX: 190, clientY: 220 });
      expect(state.selectedAnnotation).toBe("10 0 R");
      expect(wrapper.find(".annotation-selection-box").exists()).toBe(true);
      expect(wrapper.findAll(".resize-handle")).toHaveLength(8);
      expect(hit.attributes("style")).toContain("cursor: grab");
      expect(actions.transformPageAnnotation).not.toHaveBeenCalled();
    },
  );

  it("drags an already-selected annotation using viewport coordinates", async () => {
    mark();
    state.selectedAnnotation = "10 0 R";
    const { wrapper, selectionSvg } = await mountLayer();
    await wrapper.get(".selection-outline").trigger("pointerdown", {
      button: 0,
      pointerId: 1,
      clientX: 150,
      clientY: 200,
    });
    await selectionSvg.trigger("pointermove", { pointerId: 1, clientX: 190, clientY: 220 });
    expect(wrapper.get(".selection-outline").attributes("x")).toBe("40");
    expect(wrapper.get(".annotation-selection").classes()).toContain("dragging");
    await selectionSvg.trigger("pointerup", { pointerId: 1, clientX: 190, clientY: 220 });
    expect(actions.transformPageAnnotation).toHaveBeenCalledWith("10 0 R", [1, 0, 0, 1, 20, -10]);
  });

  it("resizes using a handle without losing alignment or changing the selected annotation", async () => {
    mark();
    state.selectedAnnotation = "10 0 R";
    const { wrapper, selectionSvg } = await mountLayer();
    await wrapper.get('[data-handle="se"]').trigger("pointerdown", {
      button: 0,
      pointerId: 1,
      clientX: 250,
      clientY: 220,
    });
    await selectionSvg.trigger("pointerup", { pointerId: 1, clientX: 350, clientY: 260 });
    expect(actions.transformPageAnnotation).toHaveBeenCalledWith(
      "10 0 R",
      [1.5, 0, 0, 2, -10, -120],
    );
    expect(state.selectedAnnotation).toBe("10 0 R");
  });

  it.each(["nw", "n", "ne", "e", "se", "s", "sw", "w"])(
    "keeps a positive size when resizing with %s",
    async (handle) => {
      mark();
      state.selectedAnnotation = "10 0 R";
      const { wrapper, selectionSvg } = await mountLayer();
      await wrapper.get(`[data-handle="${handle}"]`).trigger("pointerdown", {
        button: 0,
        pointerId: 1,
        clientX: 150,
        clientY: 200,
      });
      await selectionSvg.trigger("pointerup", { pointerId: 1, clientX: 10, clientY: 20 });
      const matrix = actions.transformPageAnnotation.mock.calls[0]?.[1];
      expect(matrix).toBeDefined();
      expect(matrix[0]).toBeGreaterThan(0);
      expect(matrix[3]).toBeGreaterThan(0);
      expect(matrix.every(Number.isFinite)).toBe(true);
    },
  );

  it("does not edit on a stationary drag or pointer cancellation", async () => {
    mark();
    state.selectedAnnotation = "10 0 R";
    const { wrapper, selectionSvg } = await mountLayer();
    const outline = wrapper.get(".selection-outline");
    await outline.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 150, clientY: 200 });
    await selectionSvg.trigger("pointerup", { pointerId: 1, clientX: 150, clientY: 200 });
    for (const event of ["pointercancel", "lostpointercapture"]) {
      await outline.trigger("pointerdown", {
        button: 0,
        pointerId: 1,
        clientX: 150,
        clientY: 200,
      });
      await selectionSvg.trigger("pointermove", { pointerId: 1, clientX: 190, clientY: 220 });
      selectionSvg.element.dispatchEvent(new PointerEvent(event, { bubbles: true, pointerId: 1 }));
      await nextTick();
      await selectionSvg.trigger("pointerup", { pointerId: 1, clientX: 190, clientY: 220 });
    }
    expect(actions.transformPageAnnotation).not.toHaveBeenCalled();
  });

  it("converts movement correctly on rotated/cropped pages at different zoom levels", async () => {
    mark();
    state.zoom = 2;
    state.selectedAnnotation = "10 0 R";
    geometry.width = 200;
    geometry.height = 300;
    geometry.convertToViewportPoint.mockImplementation((x, y) => [y - 50, x - 100]);
    geometry.convertToPdfPoint.mockImplementation((x, y) => [y + 100, x + 50]);
    state.annotations[0].rect = { x: 140, y: 90, width: 20, height: 100 };
    const { wrapper, selectionSvg } = await mountLayer();
    await wrapper.get(".selection-outline").trigger("pointerdown", {
      button: 0,
      pointerId: 1,
      clientX: 150,
      clientY: 100,
    });
    await selectionSvg.trigger("pointerup", { pointerId: 1, clientX: 180, clientY: 140 });
    expect(actions.transformPageAnnotation).toHaveBeenCalledWith("10 0 R", [
      1,
      0,
      0,
      1,
      30,
      expect.closeTo(10, 8),
    ]);
  });

  it("enables Ctrl/Cmd selection during creation without adding another mark", async () => {
    mark();
    state.mode = "highlight";
    const { wrapper, svg } = await mountLayer();
    const hit = wrapper.get(".annotation-hit");
    expect(hit.attributes("style")).toContain("pointer-events: none");
    for (const modifier of ["ctrlKey", "metaKey"]) {
      window.dispatchEvent(new KeyboardEvent("keydown", { [modifier]: true }));
      await nextTick();
      expect(hit.attributes("style")).toContain("pointer-events: all");
      window.dispatchEvent(new KeyboardEvent("keyup"));
      await nextTick();
    }
    await svg.trigger("pointerdown", { button: 0, ctrlKey: true, clientX: 90, clientY: 100 });
    expect(wrapper.find("rect").exists()).toBe(false);
    expect(actions.addPageAnnotation).not.toHaveBeenCalled();
  });

  it("selects and moves notes without resize handles, and keeps editing available", async () => {
    state.mode = "view";
    state.stickyNotes = [
      { id: "10 0 R", page: 1, point: { x: 40, y: 160 }, text: "Note", color: "#fff176" },
    ];
    state.annotations = [
      {
        id: "10 0 R",
        page: 1,
        type: "sticky-note",
        paths: [],
        rect: { x: 40, y: 138, width: 22, height: 22 },
      },
    ];
    const { wrapper, selectionSvg } = await mountLayer();
    const note = wrapper.get(".note-icon");
    await note.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 90, clientY: 100 });
    expect(wrapper.find("form").exists()).toBe(false);
    expect(wrapper.find(".annotation-selection-box").exists()).toBe(true);
    expect(wrapper.findAll(".resize-handle")).toHaveLength(0);
    await note.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 90, clientY: 100 });
    await selectionSvg.trigger("pointerup", { pointerId: 1, clientX: 130, clientY: 120 });
    expect(actions.transformPageAnnotation).toHaveBeenCalledWith("10 0 R", [1, 0, 0, 1, 20, -10]);
    await wrapper.get(".edit-note-button").trigger("click");
    expect(wrapper.find("form").exists()).toBe(true);
  });

  it("abandons drags when selection is cleared or the window loses focus", async () => {
    mark();
    state.selectedAnnotation = "10 0 R";
    const { wrapper, selectionSvg } = await mountLayer();
    await wrapper.get(".selection-outline").trigger("pointerdown", {
      button: 0,
      pointerId: 1,
      clientX: 150,
      clientY: 200,
    });
    window.dispatchEvent(new Event("blur"));
    await selectionSvg.trigger("pointerup", { pointerId: 1, clientX: 190, clientY: 220 });
    expect(actions.transformPageAnnotation).not.toHaveBeenCalled();
    state.selectedAnnotation = null;
    await nextTick();
    expect(wrapper.find(".annotation-selection-box").exists()).toBe(false);
  });
});
