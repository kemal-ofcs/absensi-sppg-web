import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Penggabung className tunggal untuk seluruh komponen visual.
 * Dibuat sekali di sini agar komponen vendor (Aceternity/Magic UI) tidak
 * menduplikasi helper yang sama di setiap berkas.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
