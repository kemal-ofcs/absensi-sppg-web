"use client";

// Berkas HRIS (dokumen karyawan, CV pelamar, sertifikat pelatihan): baca dari
// pemilih berkas sebagai base64 dan buka isinya di tab baru. Aturan berkasnya
// sendiri (MIME, tanda tangan bita, 1 MB) diperiksa backend.

import { MIME_BERKAS } from "@/lib/validations/hris";

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

export function bukaBerkas(b: { mime_type: string; data_base64: string }) {
  const bita = Uint8Array.from(atob(b.data_base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bita], { type: b.mime_type }));
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
