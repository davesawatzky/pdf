/**
 * File pick/save operations. Uses Tauri's native dialogs + fs plugin when
 * running inside the desktop shell; falls back to plain browser APIs so the
 * UI can also be developed with `vp run dev`.
 */
import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";

export interface PickedFile {
  name: string;
  path?: string; // only present in the Tauri environment
  bytes: Uint8Array;
}

/** Filesystem basename of an OS path (handles both / and \ separators). */
export function baseName(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator >= 0 ? path.slice(separator + 1) : path;
}

/** Pick one browser file, resolving to null when the user cancels. */
function pickInBrowser(accept: string): Promise<File | null> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  return new Promise((resolve) => {
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Read a selected file through the native adapter or browser; propagate dialog and read failures. */
async function pickFile(
  extensions: string[],
  label: string,
  accept: string,
): Promise<PickedFile | null> {
  if (!isTauri()) {
    const file = await pickInBrowser(accept);
    return file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null;
  }
  const result = await open({ multiple: false, filters: [{ name: label, extensions }] });
  if (!result) return null;
  if (typeof result !== "string")
    throw new Error("Expected a single file path from the open dialog.");
  const path = result;
  const bytes = await readFile(path);
  return { name: baseName(path), path, bytes };
}

/** Pick and read a PDF using the current environment's file dialog. */
export async function pickPdf(): Promise<PickedFile | null> {
  return pickFile(["pdf"], "PDF documents", "application/pdf,.pdf");
}

/** Pick and read a PNG or JPEG using the current environment's file dialog. */
export async function pickImage(): Promise<PickedFile | null> {
  return pickFile(["png", "jpg", "jpeg"], "Images", "image/png,image/jpeg,.png,.jpg,.jpeg");
}

/** Save bytes via a native "Save As" dialog. Returns the chosen path (Tauri) or null. */
export async function savePdf(bytes: Uint8Array, defaultName: string): Promise<string | null> {
  if (isTauri()) {
    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: "PDF documents", extensions: ["pdf"] }],
    });
    if (!path) return null;
    await writeFile(path, bytes);
    return path;
  }
  // Browser fallback: trigger a download. (slice() copies into a fresh ArrayBuffer,
  // which satisfies the BlobPart typing under newer TS lib definitions.)
  const blob = new Blob([bytes.slice().buffer], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return null;
}

/** Write bytes directly to an existing path (no dialog). Tauri only. */
export async function writePdfTo(path: string, bytes: Uint8Array): Promise<void> {
  if (!isTauri()) throw new Error("Direct writes are only available in the desktop app.");
  await writeFile(path, bytes);
}
