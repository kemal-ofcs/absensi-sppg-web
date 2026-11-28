export type StatTone = "clean" | "sky" | "emerald" | "amber" | "rose";

/** Kembalikan "clean" (netral tenang) saat nilai <= 0, atau warna semantik saat > 0. */
export function nadaStat(
  nilai: number | null | undefined,
  aktif: Exclude<StatTone, "clean">,
): StatTone {
  return (nilai ?? 0) > 0 ? aktif : "clean";
}
