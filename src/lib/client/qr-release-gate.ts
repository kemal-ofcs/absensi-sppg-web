/** Lama kartu harus tidak terlihat sebelum QR yang sama boleh memicu lagi. */
export const CARD_RELEASE_MS = 1_500;

/**
 * Penahan QR yang baru selesai diproses dengan foto bukti.
 *
 * Setelah jendela foto ditutup (dibatalkan, ditolak, atau berhasil), kamera
 * pemindai menyala lagi sementara kartunya biasanya masih di depan lensa.
 * Jeda waktu saja tidak cukup: orang yang masih memegang kartunya setelah
 * jedanya habis langsung terjebak di jendela foto lagi. Di sini QR yang sama
 * baru lolos setelah TIDAK terlihat `releaseMs` berturut-turut; setiap kali
 * masih terlihat, hitungannya diulang. QR lain selalu lolos.
 */
export function createQrReleaseGate(releaseMs = CARD_RELEASE_MS) {
  let blocked: string | null = null;
  let lastSeenAt = 0;
  return {
    block(qr: string, now: number) {
      blocked = qr;
      lastSeenAt = now;
    },
    /** Panggil untuk setiap QR yang terbaca kamera. `false` = abaikan. */
    allows(qr: string, now: number): boolean {
      if (qr !== blocked) return true;
      const gone = now - lastSeenAt >= releaseMs;
      lastSeenAt = now;
      if (!gone) return false;
      blocked = null;
      return true;
    },
  };
}
