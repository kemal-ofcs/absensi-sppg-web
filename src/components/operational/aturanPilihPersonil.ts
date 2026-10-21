// Aturan murni pemilih karyawan halaman Operasional. Ikut disalin ke Mobile
// lewat `filesToCopy` bersama `PilihPersonil.tsx`.

/** Koreksi dikirim satu per satu, jadi satu simpan dibatasi supaya tetap cepat. */
export const BATAS_KOREKSI_MASSAL = 50;
/** Sama dengan batas baris route `/api/offline-import`. */
export const BATAS_IMPORT_MASSAL = 500;

export function saringPersonil(
  daftar: Record<string, unknown>[],
  kata: string,
): Record<string, unknown>[] {
  const cari = kata.trim().toLowerCase();
  if (!cari) return [];
  return daftar.filter((row) =>
    [row.nama, row.id_unik, row.kode_karyawan, row.divisi].some((nilai) =>
      String(nilai ?? "")
        .toLowerCase()
        .includes(cari),
    ),
  );
}

/** Menambah id tanpa duplikat, berhenti di `batas`. */
export function tambahTerpilih(
  terpilih: string[],
  tambahan: string[],
  batas: number,
): { hasil: string[]; terpotong: number } {
  const hasil = [...terpilih];
  let terpotong = 0;
  for (const id of tambahan) {
    if (hasil.includes(id)) continue;
    if (hasil.length >= batas) {
      terpotong++;
      continue;
    }
    hasil.push(id);
  }
  return { hasil, terpotong };
}

export interface HasilBerurutan {
  berhasil: string[];
  gagal: { id: string; pesan: string }[];
}

/**
 * Menjalankan `aksi` untuk setiap id secara berurutan. Satu kegagalan tidak
 * menghentikan sisanya; pesannya dikumpulkan untuk ringkasan.
 */
export async function jalankanBerurutan(
  ids: string[],
  aksi: (id: string) => Promise<{ sukses: boolean; pesan: string }>,
  onProgres?: (selesai: number) => void,
): Promise<HasilBerurutan> {
  const hasil: HasilBerurutan = { berhasil: [], gagal: [] };
  for (const id of ids) {
    try {
      const respons = await aksi(id);
      if (respons.sukses) hasil.berhasil.push(id);
      else hasil.gagal.push({ id, pesan: respons.pesan });
    } catch (error) {
      hasil.gagal.push({
        id,
        pesan: error instanceof Error ? error.message : "Gagal diproses.",
      });
    }
    onProgres?.(hasil.berhasil.length + hasil.gagal.length);
  }
  return hasil;
}

/** "18 berhasil, 2 gagal: Budi (alasan); Ani (alasan)" */
export function ringkasHasil(
  hasil: HasilBerurutan,
  namaDari: (id: string) => string,
): string {
  const dasar = `${hasil.berhasil.length} berhasil, ${hasil.gagal.length} gagal`;
  if (hasil.gagal.length === 0) return `${dasar}.`;
  const rincian = hasil.gagal
    .map((item) => `${namaDari(item.id)} (${item.pesan})`)
    .join("; ");
  return `${dasar}: ${rincian}`;
}
