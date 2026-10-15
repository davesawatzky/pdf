// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { baseName, pickImage, pickPdf, savePdf, writePdfTo } from "../../src/lib/files";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(), writeFile: vi.fn() }));

const bytes = new Uint8Array([1, 2, 3]);

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(open).mockResolvedValue(null);
  vi.mocked(save).mockResolvedValue(null);
  vi.mocked(readFile).mockResolvedValue(bytes);
  vi.mocked(writeFile).mockResolvedValue();
});

afterEach(() => vi.useRealTimers());

describe("baseName", () => {
  it.each([
    ["/home/user/document.pdf", "document.pdf"],
    ["C:\\Users\\user\\document.pdf", "document.pdf"],
    ["mixed\\path/document.pdf", "document.pdf"],
    ["document.pdf", "document.pdf"],
    ["", ""],
    ["/folder/", ""],
  ])("extracts the name from %s", (path, name) => {
    expect(baseName(path)).toBe(name);
  });
});

describe("native file operations", () => {
  it.each([
    [pickPdf, ["pdf"], "PDF documents"],
    [pickImage, ["png", "jpg", "jpeg"], "Images"],
  ] as const)("picks files with the appropriate filter", async (pick, extensions, name) => {
    vi.mocked(open).mockResolvedValue("C:\\docs\\chosen.pdf");
    expect(await pick()).toEqual({ name: "chosen.pdf", path: "C:\\docs\\chosen.pdf", bytes });
    expect(open).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name, extensions }],
    });
    expect(readFile).toHaveBeenCalledWith("C:\\docs\\chosen.pdf");
  });

  it.each([pickPdf, pickImage])(
    "returns null when the native picker is cancelled",
    async (pick) => {
      expect(await pick()).toBeNull();
      expect(readFile).not.toHaveBeenCalled();
    },
  );

  it("propagates dialog and read failures", async () => {
    vi.mocked(open).mockRejectedValueOnce(new Error("Dialog failed"));
    await expect(pickPdf()).rejects.toThrow("Dialog failed");
    vi.mocked(open).mockResolvedValue("/missing.pdf");
    vi.mocked(readFile).mockRejectedValueOnce(new Error("Read failed"));
    await expect(pickPdf()).rejects.toThrow("Read failed");
  });

  it("rejects an unexpected multi-file response instead of casting it to a path", async () => {
    vi.mocked(open).mockResolvedValue(["/one.pdf", "/two.pdf"]);
    await expect(pickPdf()).rejects.toThrow("Expected a single file path");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("writes to the chosen save path", async () => {
    vi.mocked(save).mockResolvedValue("/docs/new.pdf");
    expect(await savePdf(bytes, "original.pdf")).toBe("/docs/new.pdf");
    expect(save).toHaveBeenCalledWith({
      defaultPath: "original.pdf",
      filters: [{ name: "PDF documents", extensions: ["pdf"] }],
    });
    expect(writeFile).toHaveBeenCalledWith("/docs/new.pdf", bytes);
  });

  it("does not write when Save As is cancelled", async () => {
    expect(await savePdf(bytes, "document.pdf")).toBeNull();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writes directly to an existing path without a dialog", async () => {
    await writePdfTo("/docs/original.pdf", bytes);
    expect(writeFile).toHaveBeenCalledWith("/docs/original.pdf", bytes);
    expect(save).not.toHaveBeenCalled();
  });

  it("propagates write failures", async () => {
    vi.mocked(writeFile).mockRejectedValue(new Error("Disk full"));
    await expect(writePdfTo("/original.pdf", bytes)).rejects.toThrow("Disk full");
    vi.mocked(save).mockResolvedValue("/new.pdf");
    await expect(savePdf(bytes, "new.pdf")).rejects.toThrow("Disk full");
  });
});

describe("browser file operations", () => {
  beforeEach(() => vi.mocked(isTauri).mockReturnValue(false));

  it.each([
    [pickPdf, "application/pdf,.pdf"],
    [pickImage, "image/png,image/jpeg,.png,.jpg,.jpeg"],
  ] as const)("reads a browser file with the appropriate accept filter", async (pick, accept) => {
    const file = new File([bytes], "chosen.pdf");
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
      this: HTMLInputElement,
    ) {
      expect(this.type).toBe("file");
      expect(this.accept).toBe(accept);
      Object.defineProperty(this, "files", { value: [file] });
      this.dispatchEvent(new Event("change"));
    });
    expect(await pick()).toEqual({ name: "chosen.pdf", bytes });
    expect(open).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each(["cancel", "change"])("handles a browser %s event without a file", async (event) => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
      this: HTMLInputElement,
    ) {
      this.dispatchEvent(new Event(event));
    });
    expect(await pickPdf()).toBeNull();
    expect(await pickImage()).toBeNull();
  });

  it("downloads a PDF and revokes its object URL after five seconds", async () => {
    vi.useFakeTimers();
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pdf");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.href).toBe("blob:pdf");
      expect(this.download).toBe("download.pdf");
    });
    expect(await savePdf(bytes, "download.pdf")).toBeNull();
    const blob = createUrl.mock.calls[0][0];
    expect(blob).toBeInstanceOf(Blob);
    if (!(blob instanceof Blob)) throw new Error("Expected a PDF Blob");
    expect(blob.type).toBe("application/pdf");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(click).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(4999);
    expect(revokeUrl).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeUrl).toHaveBeenCalledWith("blob:pdf");
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("rejects direct writes outside Tauri", async () => {
    await expect(writePdfTo("/file.pdf", bytes)).rejects.toThrow(
      "Direct writes are only available in the desktop app.",
    );
    expect(writeFile).not.toHaveBeenCalled();
  });
});
