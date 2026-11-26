import { afterEach, describe, expect, it, mock } from "bun:test";

const invokeDesktop = mock(async (..._args: unknown[]) => ({
  savedToDevice: true,
  fileName: "a.xlsx",
}));
mock.module("@/lib/runtime/desktop-commands", () => ({ invokeDesktop }));

const { saveFileWithPicker } = await import("./download");

const g = globalThis as unknown as { window?: unknown };
const asal = process.env.NEXT_PUBLIC_SPPG_RUNTIME;

function pasangPicker() {
  const ditulis: unknown[] = [];
  const showSaveFilePicker = mock(async (_opsi: unknown) => ({
    name: "dipilih.xlsx",
    createWritable: async () => ({
      write: async (isi: unknown) => void ditulis.push(isi),
      close: async () => {},
    }),
  }));
  return { showSaveFilePicker, ditulis };
}

afterEach(() => {
  process.env.NEXT_PUBLIC_SPPG_RUNTIME = asal;
  delete g.window;
  invokeDesktop.mockClear();
});

describe("saveFileWithPicker", () => {
  it("Desktop memakai dialog Simpan sebagai bila WebView menyediakannya", async () => {
    process.env.NEXT_PUBLIC_SPPG_RUNTIME = "desktop";
    const picker = pasangPicker();
    g.window = { __TAURI_INTERNALS__: {}, ...picker };
    const hasil = await saveFileWithPicker(new Blob(["x"]), "a.xlsx");
    expect(picker.showSaveFilePicker).toHaveBeenCalledTimes(1);
    expect(picker.ditulis).toHaveLength(1);
    expect(invokeDesktop).not.toHaveBeenCalled();
    expect(hasil).toEqual({
      sukses: true,
      filename: "dipilih.xlsx",
      path: "dipilih.xlsx",
    });
  });

  it("Mobile tetap lewat dialog SAF walau showSaveFilePicker ada", async () => {
    process.env.NEXT_PUBLIC_SPPG_RUNTIME = "mobile";
    const picker = pasangPicker();
    g.window = { __TAURI_INTERNALS__: {}, ...picker };
    const hasil = await saveFileWithPicker(
      "data:text/plain;base64,eA==",
      "a.xlsx",
    );
    expect(picker.showSaveFilePicker).not.toHaveBeenCalled();
    expect(invokeDesktop.mock.calls[0]?.[0]).toBe("mobile_save_file_to_device");
    expect(hasil.sukses).toBe(true);
  });
});
