"use client";

// Berkas HRIS (dokumen karyawan, CV pelamar, sertifikat pelatihan, lampiran
// pengajuan): baca dari pemilih berkas sebagai base64 dan buka isinya. Aturan
// berkasnya sendiri (MIME, tanda tangan bita, 1 MB) diperiksa backend.

import { createRoot } from "react-dom/client";
import { Modal } from "@/components/ui/Modal";
import { saveFileWithPicker } from "@/lib/client/download";
import { optimizeImageFile } from "@/lib/client/image-optimizer";
import { isMobileRuntime } from "@/lib/runtime/app-runtime";
import { MAKS_BERKAS_BASE64, MIME_BERKAS } from "@/lib/validations/hris";

export function bacaBase64(berkas: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const pembaca = new FileReader();
    pembaca.onload = () => resolve(String(pembaca.result).split(",")[1] ?? "");
    pembaca.onerror = () => reject(new Error("Berkas tidak terbaca."));
    pembaca.readAsDataURL(berkas);
  });
}

export const mimeBerkasSah = (berkas: File) =>
  (MIME_BERKAS as readonly string[]).includes(berkas.type);

export const PESAN_MIME_BERKAS =
  "Jenis berkas harus JPEG, PNG, WEBP, atau PDF.";

const MAKS_BITA = Math.floor(MAKS_BERKAS_BASE64 / 4) * 3;
const SISI_FOTO = 2000;
/** Percobaan kedua bermutu lebih rendah bila yang pertama masih > 1 MB. */
const MUTU_FOTO = [0.85, 0.7] as const;

export interface BerkasSiap {
  nama_berkas: string;
  mime_type: string;
  data_base64: string;
}

/**
 * Isi berkas untuk diunggah. Gambar > 1 MB (foto kamera HP) diperkecil ke
 * JPEG sisi terpanjang 2000 px (Q-130); PDF dan berkas kecil apa adanya, jadi
 * PDF > 1 MB tetap ditolak backend.
 */
export async function siapkanBerkas(berkas: File): Promise<BerkasSiap> {
  const gambar = mimeBerkasSah(berkas) && berkas.type.startsWith("image/");
  if (!gambar || berkas.size <= MAKS_BITA) {
    return {
      nama_berkas: berkas.name,
      mime_type: berkas.type,
      data_base64: await bacaBase64(berkas),
    };
  }
  let data = "";
  for (const quality of MUTU_FOTO) {
    const hasil = await optimizeImageFile(berkas, {
      maxWidth: SISI_FOTO,
      maxHeight: SISI_FOTO,
      quality,
      mimeType: "image/jpeg",
      fit: "shrink",
    });
    data = hasil.dataUrl.split(",")[1] ?? "";
    if (data.length <= MAKS_BERKAS_BASE64) break;
  }
  return {
    nama_berkas: `${berkas.name.replace(/\.[^.]*$/, "")}.jpg`,
    mime_type: "image/jpeg",
    data_base64: data,
  };
}

/**
 * Web/Desktop: tab baru. Mobile (Q-129): gambar dipratinjau di dialog tanpa
 * salinan di HP, PDF diserahkan ke dialog simpan SAF karena WebView tidak
 * membuka jendela baru. Mengembalikan kalimat untuk ditampilkan pemanggil.
 */
export async function bukaBerkas(b: {
  nama_berkas?: string | null;
  mime_type: string;
  data_base64: string;
}): Promise<string | null> {
  if (isMobileRuntime()) {
    const dataUrl = `data:${b.mime_type};base64,${b.data_base64}`;
    if (b.mime_type.startsWith("image/")) {
      pratinjauGambar(dataUrl, b.nama_berkas || "Berkas");
      return null;
    }
    const nama = b.nama_berkas || "berkas";
    const hasil = await saveFileWithPicker(
      dataUrl,
      /\.pdf$/i.test(nama) ? nama : `${nama}.pdf`,
    );
    if (hasil.sukses) {
      return "Salinan berkas tersimpan di folder yang dipilih. Buka dari aplikasi berkas HP.";
    }
    return hasil.cancelled ? null : "Berkas gagal disimpan.";
  }
  const bita = Uint8Array.from(atob(b.data_base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bita], { type: b.mime_type }));
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return null;
}

/** Root sendiri di `body`, pola `konfirmasiData`. */
function pratinjauGambar(dataUrl: string, nama: string) {
  const wadah = document.createElement("div");
  document.body.appendChild(wadah);
  const root = createRoot(wadah);
  const tutup = () => {
    window.removeEventListener("keydown", saatEscape, true);
    root.unmount();
    wadah.remove();
  };
  // Tanpa ini Modal di bawahnya ikut tertutup.
  const saatEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopImmediatePropagation();
      tutup();
    }
  };
  window.addEventListener("keydown", saatEscape, true);
  root.render(
    <Modal isOpen onClose={tutup} title={nama} titleId="pratinjau-berkas-judul">
      {/* biome-ignore lint/performance/noImgElement: data URL dari database, bukan aset Next */}
      <img
        src={dataUrl}
        alt={nama}
        className="mx-auto max-h-[70vh] w-auto max-w-full object-contain"
      />
    </Modal>,
  );
}
