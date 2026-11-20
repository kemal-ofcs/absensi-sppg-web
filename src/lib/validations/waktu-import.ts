// Kembar `periksa_waktu_import` di `administration.rs`; vektornya sama di
// `waktu-import.test.ts` dan `waktu_import_vektor_kembar`.

/**
 * Baris Hadir yang tanggal atau jam masuknya belum terjadi ditolak. Kasus
 * nyatanya shift malam yang diimpor pagi hari dengan tanggal pagi itu: sesi
 * terbuka bertanggal hari ini tidak pernah cocok dengan scan pulang (tanggal
 * kerjanya kemarin), sehingga scan pulang dinilai sebagai scan masuk yang
 * terlambat dan ditolak. `jamMasuk` dan `jamSekarang` berformat HH:mm[:ss]
 * dua digit (sudah lolos `TIME`), jadi dibandingkan sebagai teks.
 */
export function periksaWaktuImport(
  tanggal: string,
  jamMasuk: string,
  hariIni: string,
  jamSekarang: string,
): string | null {
  if (tanggal > hariIni) {
    return `Tanggal ${tanggal} belum terjadi; absensi berjam hanya boleh untuk hari ini atau sebelumnya.`;
  }
  const masuk = jamMasuk.slice(0, 5);
  if (tanggal === hariIni && masuk && masuk > jamSekarang) {
    return `Jam masuk ${masuk} pada ${tanggal} belum terjadi. Untuk shift malam, isi tanggal hari shift dimulai.`;
  }
  return null;
}
