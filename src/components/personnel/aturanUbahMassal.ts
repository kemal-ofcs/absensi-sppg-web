// Aturan murni bilah "Ubah massal" halaman Karyawan. Ikut disalin ke Mobile
// lewat `filesToCopy` bersama `UbahMassal.tsx`.

export interface OpsiMassal {
  value: string;
  label: string;
}

export interface KolomMassal {
  /** Nama field di draft simpan (`divisi`, `id_shift`, ...). */
  key: string;
  label: string;
  /** Diisi = dropdown; nilai di luar daftar ditolak. */
  opsi?: OpsiMassal[];
  jenis?: "teks" | "tanggal" | "angka";
}

export function validasiNilaiMassal(
  kolom: KolomMassal,
  mentah: string,
): string | null {
  const nilai = mentah.trim();
  if (!nilai) return `${kolom.label} wajib diisi.`;
  if (kolom.opsi && !kolom.opsi.some((opsi) => opsi.value === nilai)) {
    return `Pilihan ${kolom.label} tidak dikenal.`;
  }
  if (kolom.jenis === "angka" && !/^\d+$/.test(nilai)) {
    return `${kolom.label} harus berupa angka bulat.`;
  }
  if (kolom.jenis === "tanggal" && !/^\d{4}-\d{2}-\d{2}$/.test(nilai)) {
    return `${kolom.label} harus berupa tanggal.`;
  }
  return null;
}

/** Draft lengkap satu orang dengan satu field diganti. */
export function terapkanKolomMassal<T extends object>(
  draft: T,
  kolom: KolomMassal,
  mentah: string,
): T {
  const nilai = mentah.trim();
  return {
    ...draft,
    [kolom.key]: kolom.jenis === "angka" ? Number(nilai) : nilai,
  };
}

export function kalimatKonfirmasiMassal(
  kolom: KolomMassal,
  mentah: string,
  nama: string[],
  satuan: string,
): string {
  const nilai = mentah.trim();
  const label =
    kolom.opsi?.find((opsi) => opsi.value === nilai)?.label ?? nilai;
  const contoh =
    nama.slice(0, 3).join(", ") +
    (nama.length > 3 ? `, dan ${nama.length - 3} lainnya` : "");
  return `Ubah ${kolom.label} menjadi "${label}" untuk ${nama.length} ${satuan} (${contoh})?`;
}

/** Kotak "pilih semua" di kepala tabel: semua yang tampil terpilih = lepas semua. */
export function alihkanSemuaTampil(
  terpilih: string[],
  tampil: string[],
): string[] {
  const semua =
    tampil.length > 0 && tampil.every((id) => terpilih.includes(id));
  return semua
    ? terpilih.filter((id) => !tampil.includes(id))
    : [...new Set([...terpilih, ...tampil])];
}

export function alihkanSatu(terpilih: string[], id: string): string[] {
  return terpilih.includes(id)
    ? terpilih.filter((item) => item !== id)
    : [...terpilih, id];
}
