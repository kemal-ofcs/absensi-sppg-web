/**
 * Bentuk data riwayat pengajuan "Lupa Password".
 *
 * Dipisah dari layanan servernya supaya komponen klien dan gateway bisa
 * mengimpor tipe ini tanpa ikut menarik `@libsql/client` atau `server-only`.
 */

export const RESET_HISTORY_STATUSES = [
  "Menunggu Verifikasi",
  "Terkirim",
  "Terpakai",
  "Kedaluwarsa",
  "Dibatalkan",
] as const;

export type ResetHistoryStatus = (typeof RESET_HISTORY_STATUSES)[number];

export function isResetHistoryStatus(
  value: unknown,
): value is ResetHistoryStatus {
  return (
    typeof value === "string" &&
    (RESET_HISTORY_STATUSES as readonly string[]).includes(value)
  );
}

export interface ResetHistoryEntry {
  id: string;
  operatorId: number;
  operatorName: string;
  username: string;
  kodeOperator: string;
  /** Apa yang diketik pemohon pada langkah pencarian akun. */
  identifierUsed: string;
  maskedEmail: string;
  status: ResetHistoryStatus;
  /** 0..1, atau null bila verifikasi wajah belum sempat dinilai. */
  livenessScore: number | null;
  livenessReason: string;
  livenessChallenges: string[];
  deliveryStatus: string;
  deliveryError: string;
  hasPhoto: boolean;
  requestedAt: string;
  verifiedAt: string;
  sentAt: string;
  usedAt: string;
  expiresAt: string;
}

export interface ResetHistoryFilter {
  status?: ResetHistoryStatus | "SEMUA";
  /** Cocokkan nama, username, kode operator, atau identitas yang diketik. */
  search?: string;
  limit?: number;
}

export interface ResetHistoryPhoto {
  mime: string;
  base64: string;
}

export const RESET_HISTORY_DEFAULT_LIMIT = 100;
export const RESET_HISTORY_MAX_LIMIT = 500;

/** Nada badge status untuk UI. Satu peta supaya Web dan Mobile tidak drift. */
export const RESET_HISTORY_STATUS_TONE: Record<
  ResetHistoryStatus,
  "info" | "success" | "warning" | "danger" | "neutral"
> = {
  "Menunggu Verifikasi": "warning",
  Terkirim: "info",
  Terpakai: "success",
  Kedaluwarsa: "neutral",
  Dibatalkan: "danger",
};

export const RESET_HISTORY_STATUS_HINT: Record<ResetHistoryStatus, string> = {
  "Menunggu Verifikasi":
    "Pemohon berhenti sebelum verifikasi wajah selesai. Tidak ada link yang dikirim.",
  Terkirim: "Link reset sudah dikirim ke email pemilik akun dan masih berlaku.",
  Terpakai: "Password berhasil diganti memakai link ini.",
  Kedaluwarsa: "Link tidak dipakai sampai batas waktunya habis.",
  Dibatalkan:
    "Dihentikan sistem: verifikasi wajah gagal, email gagal terkirim, atau pemohon mengajukan permintaan baru.",
};
