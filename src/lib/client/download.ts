"use client";

import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

export interface DownloadResult {
  sukses: boolean;
  cancelled?: boolean;
  path?: string;
  filename?: string;
}

export interface SavePickerOptions {
  description?: string;
  accept?: Record<string, string[]>;
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const parts = dataUrl.split(",");
  const mime = parts[0]?.match(/:(.*?);/)?.[1] || "image/png";
  const binary = atob(parts[1] || "");
  const array = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    array[i] = binary.charCodeAt(i);
  }
  return new Blob([array], { type: mime });
}

export async function saveFileWithPicker(
  dataUrlOrBlob: string | Blob,
  defaultFilename: string,
  options?: SavePickerOptions,
): Promise<DownloadResult> {
  let blob: Blob;
  let dataUrl: string;

  if (typeof dataUrlOrBlob === "string") {
    dataUrl = dataUrlOrBlob;
    if (dataUrlOrBlob.startsWith("data:")) {
      blob = dataUrlToBlob(dataUrlOrBlob);
    } else {
      const res = await fetch(dataUrlOrBlob);
      blob = await res.blob();
    }
  } else {
    blob = dataUrlOrBlob;
    dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // 1. Try Native File System Access API (showSaveFilePicker)
  // This opens the OS file picker allowing user to select folder and customize filename
  if (typeof window !== "undefined" && "showSaveFilePicker" in window) {
    try {
      const ext = defaultFilename.split(".").pop() || "png";
      const mime =
        blob.type ||
        (ext === "png"
          ? "image/png"
          : ext === "xlsx"
            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            : "application/octet-stream");

      const fileHandle = await (
        window as unknown as {
          showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle>;
        }
      ).showSaveFilePicker({
        suggestedName: defaultFilename,
        types: [
          {
            description: options?.description || "File",
            accept: options?.accept || { [mime]: [`.${ext}`] },
          },
        ],
      });

      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();

      return {
        sukses: true,
        filename: fileHandle.name,
        path: fileHandle.name,
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return { sukses: false, cancelled: true };
      }
      console.warn("showSaveFilePicker failed, falling back:", err);
    }
  }

  // 2. Desktop Tauri fallback
  if (isDesktopRuntime()) {
    return await downloadDataUrl(dataUrl, defaultFilename);
  }

  // 3. Web browser fallback
  return await downloadBlob(blob, defaultFilename);
}

export async function downloadDataUrl(
  dataUrl: string,
  filename: string,
): Promise<DownloadResult> {
  if (isDesktopRuntime()) {
    try {
      const res = await invokeDesktop<{
        sukses: boolean;
        path: string;
        filename: string;
      }>("desktop_save_file", {
        filename,
        base64Data: dataUrl,
      });
      return res;
    } catch (err) {
      console.warn("Desktop native save failed, using web fallback:", err);
    }
  }

  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = filename;
  anchor.click();
  return { sukses: true, filename };
}

export async function downloadBlob(
  blob: Blob,
  filename: string,
): Promise<DownloadResult> {
  if (isDesktopRuntime()) {
    try {
      const reader = new FileReader();
      const base64Data = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      return await downloadDataUrl(base64Data, filename);
    } catch (err) {
      console.warn("Desktop native save blob failed, using web fallback:", err);
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return { sukses: true, filename };
}
