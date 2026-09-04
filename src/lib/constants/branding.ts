/**
 * Konstanta branding terpusat (Single Source of Truth).
 *
 * ATURAN:
 * - `appDisplayName` adalah nama aplikasi yang tidak berubah mengikuti
 *   nama instansi — dipakai di metadata, TOTP issuer, dan email sistem.
 * - `defaultCompanyName` adalah nilai fallback sementara sebelum
 *   `company_profile.company_name` selesai dimuat dari database.
 * - File ini disalin ke mobile via `mobile/scripts/sync-frontend-lib.ts`
 *   melalui direktori `lib/constants`. JANGAN import dari path mobile secara
 *   langsung; selalu edit dari web-desktop sebagai sumber kanonik.
 */
export const BRANDING = {
  /** Nama tetap aplikasi (tidak bergantung pada nama instansi). */
  appDisplayName: "Absensi Perusahaan",
  /** Nama perusahaan/instansi default (sebelum admin mengisi form Pengaturan). */
  defaultCompanyName: "YOUR COMPANY",
  defaultBranchName: "Operations Center",
  defaultAddress: "Your Company Address",
  defaultPhone: "-",
  defaultEmail: "info@yourcompany.com",
  defaultWebsite: "https://yourcompany.com",
  defaultLeaderTitle: "Director",
  defaultLeaderName: "Your Name",
  defaultLeaderNip: "-",
  defaultCardTerms: `1. This card is the official identification of your company's employees/personnel.\n2. Must be carried and scanned (QR scan) every time you arrive and leave work.\n3. It is prohibited to transfer or lend this card to other parties.\n4. If the card is lost or found, please report it immediately to the HR/Operations Department.`,
  defaultTemplateName: "Default ID Card Template",
} as const;

/**
 * Membuat judul aplikasi: "{appName} · {companyName}".
 * Digunakan di <title> halaman dan aria-label navigasi.
 */
export function formatAppTitle(
  companyName?: string | null,
  appName?: string | null,
): string {
  const comp = companyName?.trim() || BRANDING.defaultCompanyName;
  const app = appName?.trim() || BRANDING.appDisplayName;
  return `${app} · ${comp}`;
}

/**
 * Mengambil singkatan nama perusahaan untuk BrandLogo fallback.
 * Contoh: "PT Maju Bersama" => "PMB", "YOUR COMPANY" => "YOUR"
 * Maks 4 karakter.
 */
export function companyInitials(companyName?: string | null): string {
  const name = companyName?.trim() || BRANDING.defaultCompanyName;
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 1) return name.slice(0, 4).toUpperCase();
  return words
    .slice(0, 4)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}
