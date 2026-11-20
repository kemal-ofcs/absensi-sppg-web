/**
 * `event_key` baris import berhasil yang punya kembaran (tanggal, personil,
 * jam, dan status sama) di daftar yang sama. Kembaran lahir bila dua perangkat
 * mengimpor baris yang sama sebelum sempat sinkron; import ulang di perangkat
 * yang sudah tersinkron memakai ulang `event_key` lama sehingga tidak dobel.
 * Hanya peringatan: pemilik data memilih baris mana yang dihapus.
 */
export function eventImportKembar(
  rows: readonly Record<string, unknown>[],
): Set<string> {
  const perKunci = new Map<string, string[]>();
  for (const row of rows) {
    if (row.status_proses !== "Sudah Diproses") continue;
    const kunci = [
      row.tanggal,
      row.id_unik,
      row.jam_masuk ?? "",
      row.jam_pulang ?? "",
      row.status_kehadiran ?? "",
    ].join("|");
    perKunci.set(kunci, [
      ...(perKunci.get(kunci) ?? []),
      String(row.event_key),
    ]);
  }
  return new Set([...perKunci.values()].filter((k) => k.length > 1).flat());
}
