export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
  convertToPdfPoint(x: number, y: number): number[];
  convertToViewportPoint(x: number, y: number): number[];
}

export type Transform = [number, number, number, number, number, number];
export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** Restrict a value to inclusive bounds, favoring the minimum if the bounds overlap. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Convert client coordinates into clamped, scale-one coordinates on a page surface. */
export function pointerToViewport(
  event: MouseEvent,
  surface: Element,
  viewport: Pick<Viewport, "width" | "height">,
): Point {
  const rect = surface.getBoundingClientRect();
  return {
    x: clamp(((event.clientX - rect.left) * viewport.width) / rect.width, 0, viewport.width),
    y: clamp(((event.clientY - rect.top) * viewport.height) / rect.height, 0, viewport.height),
  };
}

/** Convert a displayed page point into PDF coordinates, including page rotation and crop offsets. */
export function toPdfPoint(viewport: Viewport, point: Point): Point {
  const [x, y] = viewport.convertToPdfPoint(point.x, point.y);
  return { x, y };
}

/** Convert PDF coordinates into scale-one display coordinates. */
export function toViewportPoint(viewport: Viewport, point: Point): Point {
  const [x, y] = viewport.convertToViewportPoint(point.x, point.y);
  return { x, y };
}

/** Return a rectangle's origin, x-edge, y-edge, and opposite corners in row order. */
export function rectCorners({ x, y, width, height }: Rect): [Point, Point, Point, Point] {
  return [
    { x, y },
    { x: x + width, y },
    { x, y: y + height },
    { x: x + width, y: y + height },
  ];
}

/** Bound a nonempty set of points without spreading potentially large freehand strokes onto the stack. */
export function pointBounds(points: readonly Point[]): Rect {
  if (!points.length) throw new Error("Cannot calculate bounds without points.");
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const { x, y } of points) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Resize selected edges without flipping the rectangle or growing a sub-minimum dimension unexpectedly. */
export function resizeRect(rect: Rect, handle: ResizeHandle, point: Point, minSize: number): Rect {
  let left = rect.x,
    right = rect.x + rect.width,
    top = rect.y,
    bottom = rect.y + rect.height;
  if (handle.includes("w")) left = Math.min(right - Math.min(minSize, rect.width), point.x);
  if (handle.includes("e")) right = Math.max(left + Math.min(minSize, rect.width), point.x);
  if (handle.includes("n")) top = Math.min(bottom - Math.min(minSize, rect.height), point.y);
  if (handle.includes("s")) bottom = Math.max(top + Math.min(minSize, rect.height), point.y);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Compare position and dimensions with a tolerance for viewport floating-point rounding. */
export function sameRect(first: Rect, second: Rect): boolean {
  return (["x", "y", "width", "height"] as const).every(
    (key) => Math.abs(first[key] - second[key]) < 0.001,
  );
}

/**
 * Express a displayed rectangle change as a PDF-space affine transform.
 * Conjugating through the viewport keeps moves and resizes aligned on rotated or cropped pages.
 */
export function rectTransform(viewport: Viewport, from: Rect, to: Rect): Transform {
  /** Map one PDF point through the displayed rectangle's scale and translation. */
  function mapPoint(point: Point): Point {
    const display = toViewportPoint(viewport, point);
    return toPdfPoint(viewport, {
      x: to.x + ((display.x - from.x) * to.width) / from.width,
      y: to.y + ((display.y - from.y) * to.height) / from.height,
    });
  }
  const origin = mapPoint({ x: 0, y: 0 });
  const xAxis = mapPoint({ x: 1, y: 0 });
  const yAxis = mapPoint({ x: 0, y: 1 });
  return [
    xAxis.x - origin.x,
    xAxis.y - origin.y,
    yAxis.x - origin.x,
    yAxis.y - origin.y,
    origin.x,
    origin.y,
  ];
}
