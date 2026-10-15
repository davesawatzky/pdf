// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const render = vi.fn(() => ({ promise: Promise.resolve() }));
  const getViewport = vi.fn(({ scale }: { scale: number }) => ({
    width: 300.25 * scale,
    height: 200.75 * scale,
  }));
  const getPage = vi.fn(async () => ({ getViewport, render }));
  const pdf = { getPage };
  const getDocument = vi.fn((_options: { data: Uint8Array }) => ({
    promise: Promise.resolve(pdf),
  }));
  return { render, getViewport, getPage, pdf, getDocument, workerOptions: { workerPort: null } };
});

vi.mock("pdfjs-dist", () => ({
  getDocument: mocks.getDocument,
  GlobalWorkerOptions: mocks.workerOptions,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.getDocument.mockReturnValue({ promise: Promise.resolve(mocks.pdf) });
  mocks.render.mockReturnValue({ promise: Promise.resolve() });
  vi.stubGlobal(
    "Worker",
    vi.fn(
      class {
        constructor(
          public url: URL,
          public options: WorkerOptions,
        ) {}
      },
    ),
  );
});

describe("PDF rendering adapter", () => {
  it("starts one module worker and sends copied bytes to pdf.js", async () => {
    const { loadPdf } = await import("../../src/lib/pdfjs");
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await loadPdf(bytes)).toBe(mocks.pdf);
    await loadPdf(bytes);
    expect(Worker).toHaveBeenCalledOnce();
    expect(Worker).toHaveBeenCalledWith(expect.any(URL), { type: "module" });
    expect(mocks.workerOptions.workerPort).toBeInstanceOf(Worker);
    expect(mocks.getDocument).toHaveBeenCalledWith({ data: bytes });
  });

  it("does not transfer the caller's byte buffer", async () => {
    const { loadPdf } = await import("../../src/lib/pdfjs");
    const bytes = new Uint8Array([1, 2, 3]);
    const getDocument = vi.fn(({ data }: { data: Uint8Array }) => {
      expect(data).not.toBe(bytes);
      expect(data.buffer).not.toBe(bytes.buffer);
      data[0] = 99;
      return { promise: Promise.resolve(mocks.pdf) };
    });
    mocks.getDocument.mockImplementation(getDocument);
    await loadPdf(bytes);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("propagates document loading failures", async () => {
    const { loadPdf } = await import("../../src/lib/pdfjs");
    mocks.getDocument.mockReturnValue({ promise: Promise.reject(new Error("Invalid PDF")) });
    await expect(loadPdf(new Uint8Array())).rejects.toThrow("Invalid PDF");
  });

  it("renders with the requested scale, rounds canvas dimensions, and awaits completion", async () => {
    const { loadPdf, renderPage } = await import("../../src/lib/pdfjs");
    const pdf = await loadPdf(new Uint8Array());
    const canvas = document.createElement("canvas");
    const context = { canvas } as CanvasRenderingContext2D;
    vi.spyOn(canvas, "getContext").mockReturnValue(context);
    let complete: (() => void) | undefined;
    mocks.render.mockReturnValue({
      promise: new Promise<void>((resolve) => {
        complete = resolve;
      }),
    });
    const result = renderPage(pdf, 2, 1.5, canvas);
    await Promise.resolve();
    expect(canvas.width).toBe(451);
    expect(canvas.height).toBe(302);
    expect(mocks.getPage).toHaveBeenCalledWith(2);
    expect(mocks.render).toHaveBeenCalledWith({
      canvas,
      canvasContext: context,
      viewport: { width: 450.375, height: 301.125 },
    });
    if (!complete) throw new Error("Render was not started");
    complete();
    await expect(result).resolves.toEqual({ width: 450.375, height: 301.125 });
  });

  it("reports missing canvas contexts", async () => {
    const { loadPdf, renderPage } = await import("../../src/lib/pdfjs");
    const pdf = await loadPdf(new Uint8Array());
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(null);
    await expect(renderPage(pdf, 1, 1, canvas)).rejects.toThrow("Canvas 2D context unavailable");
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("propagates render failures", async () => {
    const { loadPdf, renderPage } = await import("../../src/lib/pdfjs");
    const pdf = await loadPdf(new Uint8Array());
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue({ canvas } as CanvasRenderingContext2D);
    mocks.render.mockReturnValue({ promise: Promise.reject(new Error("Render failed")) });
    await expect(renderPage(pdf, 1, 1, canvas)).rejects.toThrow("Render failed");
  });

  it("renders thumbnails at the requested width", async () => {
    const { loadPdf, renderThumbnail } = await import("../../src/lib/pdfjs");
    const pdf = await loadPdf(new Uint8Array());
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      {} as CanvasRenderingContext2D,
    );
    const canvas = await renderThumbnail(pdf, 3, 128);
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(canvas.width).toBe(128);
    expect(canvas.height).toBe(Math.ceil((128 / 300.25) * 200.75));
    expect(mocks.getViewport).toHaveBeenCalledWith({ scale: 128 / 300.25 });
  });

  it("returns the scale-one page size", async () => {
    const { loadPdf, pageSizeAtScale1 } = await import("../../src/lib/pdfjs");
    const pdf = await loadPdf(new Uint8Array());
    expect(await pageSizeAtScale1(pdf, 4)).toEqual({ width: 300.25, height: 200.75 });
    expect(mocks.getPage).toHaveBeenCalledWith(4);
    expect(mocks.getViewport).toHaveBeenCalledWith({ scale: 1 });
  });
});
