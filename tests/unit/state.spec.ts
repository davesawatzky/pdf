import { describe, expect, it } from "vite-plus/test";
import { createInitialState } from "../../src/state";
import { annotationTools, isAnnotationTool } from "../../src/lib/annotationTools";

describe("application defaults", () => {
  it("starts in an empty, ready-to-open viewer with metadata-derived colors", () => {
    const state = createInitialState();
    expect(state).toMatchObject({
      bytes: null,
      mode: "view",
      busy: false,
      error: "",
      currentPage: 1,
      pageCount: 0,
      zoom: 1.25,
      selectedAnnotation: null,
      pendingImage: null,
      status: "Open a PDF to get started.",
    });
    for (const tool in annotationTools) {
      if (isAnnotationTool(tool))
        expect(state.annotationColors[tool]).toBe(annotationTools[tool].color);
    }
  });

  it("never shares mutable arrays or color settings between instances", () => {
    const first = createInitialState();
    const second = createInitialState();
    for (const key of ["selected", "annotations", "stickyNotes", "formFields"] as const) {
      expect(first[key]).not.toBe(second[key]);
      expect(second[key]).toEqual([]);
    }
    first.selected.push(2);
    first.annotationColors.draw = "#000000";
    expect(second.selected).toEqual([]);
    expect(second.annotationColors.draw).toBe("#2196f3");
  });

  it.each(["constructor", "__proto__", "toString", "view", "Highlight", ""])(
    "does not treat %s as an annotation tool",
    (mode) => expect(isAnnotationTool(mode)).toBe(false),
  );
});
