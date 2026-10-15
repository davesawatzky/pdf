// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vite-plus/test";
import {
  clamp,
  pointBounds,
  pointerToViewport,
  rectCorners,
  rectTransform,
  resizeRect,
  sameRect,
  toPdfPoint,
  toViewportPoint,
} from "../../src/lib/geometry";
import type { ResizeHandle, Viewport } from "../../src/lib/geometry";

const viewports = [
  {
    rotation: 0,
    width: 300,
    height: 200,
    convertToPdfPoint: (x: number, y: number) => [x + 50, 300 - y],
    convertToViewportPoint: (x: number, y: number) => [x - 50, 300 - y],
  },
  {
    rotation: 90,
    width: 200,
    height: 300,
    convertToPdfPoint: (x: number, y: number) => [y + 50, x + 100],
    convertToViewportPoint: (x: number, y: number) => [y - 100, x - 50],
  },
  {
    rotation: 180,
    width: 300,
    height: 200,
    convertToPdfPoint: (x: number, y: number) => [350 - x, y + 100],
    convertToViewportPoint: (x: number, y: number) => [350 - x, y - 100],
  },
  {
    rotation: 270,
    width: 200,
    height: 300,
    convertToPdfPoint: (x: number, y: number) => [350 - y, 300 - x],
    convertToViewportPoint: (x: number, y: number) => [300 - y, 350 - x],
  },
] satisfies (Viewport & { rotation: number })[];

describe("page geometry", () => {
  it.each([
    [-1, 0, 10, 0],
    [5, 0, 10, 5],
    [20, 0, 10, 10],
    [5, 4, 2, 4],
  ])("clamps %s between %s and %s to %s", (value, min, max, expected) => {
    expect(clamp(value, min, max)).toBe(expected);
  });

  it("maps client coordinates through actual surface bounds and clamps out-of-page pointers", () => {
    const surface = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 600, 400));
    expect(
      pointerToViewport(
        new MouseEvent("pointermove", { clientX: 310, clientY: 120 }),
        surface,
        viewports[0],
      ),
    ).toEqual({ x: 150, y: 50 });
    expect(
      pointerToViewport(
        new MouseEvent("pointermove", { clientX: -100, clientY: 900 }),
        surface,
        viewports[0],
      ),
    ).toEqual({ x: 0, y: 200 });
  });

  it("bounds unordered and single points, preserving zero-width paths", () => {
    expect(
      pointBounds([
        { x: 30, y: -5 },
        { x: -10, y: 40 },
        { x: 20, y: 0 },
      ]),
    ).toEqual({ x: -10, y: -5, width: 40, height: 45 });
    expect(pointBounds([{ x: 2, y: 3 }])).toEqual({ x: 2, y: 3, width: 0, height: 0 });
    expect(() => pointBounds([])).toThrow("without points");
  });

  it("handles long freehand paths without argument-spread limits", () => {
    const points = Array.from({ length: 150_000 }, (_, x) => ({ x, y: -x }));
    expect(pointBounds(points)).toEqual({ x: 0, y: -149_999, width: 149_999, height: 149_999 });
  });

  it("returns corners in row order for annotation quadrilaterals", () => {
    expect(rectCorners({ x: 10, y: 20, width: 30, height: 40 })).toEqual([
      { x: 10, y: 20 },
      { x: 40, y: 20 },
      { x: 10, y: 60 },
      { x: 40, y: 60 },
    ]);
  });

  it.each([
    ["nw", { x: 5, y: 8, width: 35, height: 32 }],
    ["n", { x: 10, y: 8, width: 30, height: 32 }],
    ["ne", { x: 10, y: 8, width: 4, height: 32 }],
    ["e", { x: 10, y: 20, width: 4, height: 20 }],
    ["se", { x: 10, y: 20, width: 4, height: 4 }],
    ["s", { x: 10, y: 20, width: 30, height: 4 }],
    ["sw", { x: 5, y: 20, width: 35, height: 4 }],
    ["w", { x: 5, y: 20, width: 35, height: 20 }],
  ] satisfies [ResizeHandle, object][])(
    "resizes the %s handle without flipping",
    (handle, expected) => {
      expect(
        resizeRect({ x: 10, y: 20, width: 30, height: 20 }, handle, { x: 5, y: 8 }, 4),
      ).toEqual(expected);
    },
  );

  it("does not grow a tiny annotation solely to enforce a minimum resize size", () => {
    const rect = { x: 10, y: 20, width: 1, height: 2 };
    expect(resizeRect(rect, "nw", { x: 100, y: 100 }, 4)).toEqual(rect);
    expect(resizeRect(rect, "se", { x: -100, y: -100 }, 4)).toEqual(rect);
  });

  it("ignores only sub-tolerance rectangle changes", () => {
    const rect = { x: 10, y: 20, width: 30, height: 40 };
    expect(sameRect(rect, { ...rect, x: 10.0005 })).toBe(true);
    for (const key of ["x", "y", "width", "height"] as const)
      expect(sameRect(rect, { ...rect, [key]: rect[key] + 0.002 })).toBe(false);
  });

  describe.each(viewports)("cropped page at $rotation degrees", (viewport) => {
    it("converts display and PDF coordinates without losing crop offsets", () => {
      const point = { x: 20, y: 40 };
      expect(toViewportPoint(viewport, toPdfPoint(viewport, point))).toEqual(point);
    });

    it.each([
      [
        { x: 30, y: 40, width: 80, height: 50 },
        [
          [30, 40],
          [110, 40],
          [30, 90],
          [110, 90],
        ],
      ],
      [
        { x: 30, y: 40, width: 120, height: 25 },
        [
          [30, 40],
          [150, 40],
          [30, 65],
          [150, 65],
        ],
      ],
    ])("maps a displayed move or resize into PDF-space geometry", (to, expected) => {
      const from = { x: 10, y: 20, width: 80, height: 50 };
      const [a, b, c, d, e, f] = rectTransform(viewport, from, to);
      expect(Math.abs(b)).toBeLessThan(1e-8);
      expect(Math.abs(c)).toBeLessThan(1e-8);
      for (const [index, corner] of rectCorners(from).entries()) {
        const point = toPdfPoint(viewport, corner);
        const displayed = toViewportPoint(viewport, {
          x: a * point.x + c * point.y + e,
          y: b * point.x + d * point.y + f,
        });
        expect(displayed.x).toBeCloseTo(expected[index][0]);
        expect(displayed.y).toBeCloseTo(expected[index][1]);
      }
    });
  });
});
