/**
 * Bentuk konfigurasi pengirim email, dipakai bersama UI Pengaturan dan server.
 *
 * Modul ini sengaja bebas dari `server-only` dan dari `@libsql/client` supaya
 * bisa diimpor komponen klien. Pembacaan/penulisan barisnya ada di
 * `src/lib/server/mail/mail-store.ts`.
 */

import { BRANDING } from "@/lib/constants/branding";

export const MAIL_PROVIDERS = ["resend", "brevo"] as const;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];

export interface MailConfig {
  provider: MailProvider;
  /**
   * Kunci API TIDAK pernah dikirim balik ke klien. Nilai di sini selalu berupa
   * penanda "sudah terisi" (`hasApiKey`), bukan kuncinya sendiri.
   */
  hasApiKey: boolean;
  senderEmail: string;
  senderName: string;
  /**
   * Basis URL halaman reset, mis. `https://absensi.perusahaan.co.id`. Bila kosong, email
   * hanya memuat kode reset dan operator memasukkannya manual di aplikasi —
   * jalur yang dipakai pemasangan Desktop tanpa aplikasi Web.
   */
  resetBaseUrl: string;
  isActive: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface MailConfigDraft {
  provider: MailProvider;
  /** Kosong berarti "biarkan kunci yang tersimpan apa adanya". */
  apiKey: string;
  senderEmail: string;
  senderName: string;
  resetBaseUrl: string;
  isActive: boolean;
}

export function isMailProvider(value: unknown): value is MailProvider {
  return (
    typeof value === "string" &&
    (MAIL_PROVIDERS as readonly string[]).includes(value)
  );
}

export const MAIL_PROVIDER_LABEL: Record<MailProvider, string> = {
  resend: "Resend (api.resend.com)",
  brevo: "Brevo (api.brevo.com)",
};

/**
 * Syarat alamat pengirim tiap penyedia.
 *
 * Perbedaan ini menentukan apakah pemasangan butuh biaya: Resend mewajibkan
 * domain terverifikasi (harus punya domain sendiri), sedangkan Brevo cukup satu
 * alamat email yang dikonfirmasi lewat tautan. Ditampilkan tepat di sebelah
 * pilihan penyedia supaya tidak ditemukan setelah berjam-jam gagal mengirim.
 */
export const MAIL_PROVIDER_REQUIREMENT: Record<MailProvider, string> = {
  resend:
    "Wajib punya domain sendiri yang diverifikasi lewat record DNS. Tanpa itu hanya bisa mengirim dari onboarding@resend.dev ke alamat pemilik akun Resend saja.",
  brevo:
    "Cukup verifikasi satu alamat email pengirim — termasuk Gmail — lewat tautan konfirmasi. TIDAK perlu punya domain sendiri. Paket gratisnya membatasi jumlah kiriman per hari. Pastikan pembatasan Authorised IPs di Brevo dimatikan, karena email dikirim langsung dari perangkat operator yang IP-nya berganti-ganti.",
};

/**
 * Validasi draft sebelum disimpan. Melempar pesan siap tampil.
 *
 * `requireApiKey` bernilai true ketika belum ada kunci tersimpan: mengaktifkan
 * pengiriman tanpa kunci hanya akan menghasilkan kegagalan diam pada saat
 * seseorang benar-benar membutuhkan link reset.
 */
export function assertMailConfigDraft(
  draft: MailConfigDraft,
  requireApiKey: boolean,
) {
  if (!isMailProvider(draft.provider)) {
    throw new Error("Penyedia email tidak dikenal.");
  }
  if (!draft.isActive) return;
  if (requireApiKey && !draft.apiKey.trim()) {
    throw new Error("Kunci API penyedia email wajib diisi.");
  }
  const sender = draft.senderEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(sender)) {
    throw new Error("Email pengirim wajib diisi dengan format yang valid.");
  }
  if (draft.senderName.trim().length < 2) {
    throw new Error("Nama pengirim minimal 2 karakter.");
  }
  const base = draft.resetBaseUrl.trim();
  if (base && !/^https?:\/\/[^\s]+$/.test(base)) {
    throw new Error(
      "URL halaman reset harus diawali http:// atau https:// tanpa spasi.",
    );
  }
}

/** Menyusun isi email reset. Dipakai server; dipisah agar bisa diuji. */
export function buildResetEmail(input: {
  operatorName: string;
  resetLink: string;
  resetCode: string;
  expiresInMinutes: number;
}) {
  const { operatorName, resetLink, resetCode, expiresInMinutes } = input;
  const action = resetLink
    ? `Buka tautan berikut untuk membuat password baru:\n${resetLink}`
    : `Masukkan kode berikut pada halaman "Lupa Password" di aplikasi:\n${resetCode}`;
  const text = [
    `Halo ${operatorName},`,
    "",
    `Kami menerima permintaan pemulihan password untuk akun ${BRANDING.appDisplayName} Anda.`,
    "Permintaan ini sudah melewati verifikasi wajah pada perangkat pemohon.",
    "",
    action,
    "",
    `Tautan/kode ini berlaku ${expiresInMinutes} menit dan hanya dapat dipakai satu kali.`,
    "Jika Anda tidak merasa mengajukan permintaan ini, abaikan email ini dan segera",
    "laporkan ke Admin — foto pemohon sudah tersimpan sebagai bukti.",
    "",
    BRANDING.appDisplayName,
  ].join("\n");

  const safeName = escapeHtml(operatorName);
  const htmlAction = resetLink
    ? `<p style="margin:24px 0"><a href="${escapeHtml(resetLink)}" style="background:#059669;color:#ffffff;padding:12px 20px;border-radius:12px;text-decoration:none;font-weight:700">Buat Password Baru</a></p>`
    : `<p style="margin:24px 0;font-size:24px;letter-spacing:4px;font-weight:800">${escapeHtml(resetCode)}</p>`;
  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a;line-height:1.6">',
    `<p>Halo <strong>${safeName}</strong>,</p>`,
    `<p>Kami menerima permintaan pemulihan password untuk akun ${escapeHtml(BRANDING.appDisplayName)} Anda. Permintaan ini sudah melewati verifikasi wajah pada perangkat pemohon.</p>`,
    htmlAction,
    `<p>Tautan/kode ini berlaku <strong>${expiresInMinutes} menit</strong> dan hanya dapat dipakai satu kali.</p>`,
    "<p>Jika Anda tidak merasa mengajukan permintaan ini, abaikan email ini dan segera laporkan ke Admin — foto pemohon sudah tersimpan sebagai bukti.</p>",
    `<p>${escapeHtml(BRANDING.appDisplayName)}</p>`,
    "</div>",
  ].join("");

  return {
    subject: `Pemulihan Password ${BRANDING.appDisplayName}`,
    text,
    html,
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Menerjemahkan kegagalan penyedia email menjadi instruksi yang bisa dikerjakan.
 *
 * Balasan mentah penyedia ("HTTP 403 dari resend: {...}") benar tetapi tidak
 * memberi tahu apa yang harus dilakukan. Pemetaan ini hidup di sisi TypeScript
 * saja dan dipakai UI di semua platform — Rust cukup meneruskan balasan mentah,
 * sehingga tidak ada dua salinan aturan yang bisa saling drift.
 */
export function describeMailFailure(detail: string): string {
  const lower = detail.toLowerCase();

  if (lower.includes("permintaan ke") && lower.includes("gagal")) {
    return "Aplikasi tidak berhasil menghubungi server penyedia email. Ini bukan soal kuota atau kunci API — periksa DNS, proxy, atau firewall jaringan Anda.";
  }
  // Brevo punya daftar "Authorised IPs". Bila fitur itu menyala, panggilan API
  // dari IP yang belum terdaftar ditolak 401 — bukan karena kuncinya salah.
  // Dalam arsitektur ini pembatasan IP praktis mustahil dipenuhi: Desktop dan
  // Mobile mengirim email LANGSUNG dari perangkat operator, jadi IP sumbernya
  // adalah jaringan operator itu sendiri dan berubah setiap ganti jaringan.
  if (
    lower.includes("authorised_ip") ||
    lower.includes("authorized_ip") ||
    lower.includes("unrecognised ip") ||
    lower.includes("unrecognized ip") ||
    (lower.includes("ip address") && lower.includes("http 401"))
  ) {
    return "Brevo menolak karena alamat IP perangkat ini belum terdaftar pada Authorised IPs — kunci API Anda sendiri sudah benar. Aplikasi mengirim email langsung dari perangkat operator, sehingga IP-nya berganti setiap pindah jaringan dan tidak mungkin didaftarkan satu per satu. Buka Brevo > Security > Authorised IPs, lalu MATIKAN pembatasan IP tersebut.";
  }
  if (lower.includes("http 401") && !lower.includes("sender")) {
    return "Kunci API ditolak. Salin ulang kunci dari dasbor penyedia — pastikan tidak ada spasi ikut tersalin, dan kuncinya belum dicabut.";
  }
  if (lower.includes("http 429")) {
    return "Kuota pengiriman penyedia sedang penuh. Tunggu beberapa menit lalu coba lagi.";
  }
  if (lower.includes("http 403")) {
    // Dua sebab paling umum pada Resend, dan keduanya butuh tindakan berbeda.
    if (lower.includes("verif")) {
      return "Domain email pengirim belum diverifikasi di Resend. Buka Resend > Domains, tambahkan domain Anda, pasang record DNS-nya sampai berstatus Verified. Untuk uji cepat, isi email pengirim dengan onboarding@resend.dev.";
    }
    if (
      lower.includes("testing email") ||
      lower.includes("own email") ||
      lower.includes("sandbox")
    ) {
      return "Akun Resend masih memakai domain uji, sehingga hanya bisa mengirim ke alamat email pemilik akun Resend itu sendiri. Verifikasi domain Anda untuk mengirim ke alamat lain.";
    }
    return "Penyedia menolak kiriman ini. Dua sebab paling umum: domain email pengirim belum diverifikasi, atau kunci API dibatasi hanya untuk domain tertentu. Periksa keduanya di dasbor penyedia.";
  }
  if (
    lower.includes("http 422") ||
    lower.includes("http 400") ||
    lower.includes("http 401")
  ) {
    const menyebutPengirim = lower.includes("from") || lower.includes("sender");
    const belumTerdaftar =
      lower.includes("not valid") ||
      lower.includes("not found") ||
      lower.includes("not registered") ||
      lower.includes("unauthoris") ||
      lower.includes("unauthoriz") ||
      lower.includes("does not exist");
    if (menyebutPengirim && belumTerdaftar) {
      return "Alamat email pengirim belum terdaftar di penyedia. Pada Brevo: buka Senders, Domains & Dedicated IPs > Senders, tambahkan alamat itu, lalu klik tautan konfirmasi yang dikirim ke alamat tersebut. Cara ini TIDAK memerlukan domain sendiri.";
    }
    if (menyebutPengirim) {
      return "Alamat email pengirim ditolak. Isi dengan satu alamat lengkap yang sudah diverifikasi di penyedia, mis. absensi.perusahaan@gmail.com.";
    }
    return "Isi kiriman ditolak penyedia. Periksa kembali email pengirim dan nama pengirim.";
  }
  if (lower.includes("nonaktif") || lower.includes("kosong")) {
    return "Lengkapi kunci API dan email pengirim, lalu aktifkan sakelar pengiriman sebelum menguji.";
  }
  return "";
}
