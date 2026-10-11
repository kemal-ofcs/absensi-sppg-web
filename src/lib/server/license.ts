import "server-only";

import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import type { Client } from "@libsql/client";
import type {
  LicenseKind,
  LicensePayload,
  LicenseReadOnlyReason,
  LicenseState,
  LicenseStatus,
} from "@/lib/license/types";

/**
 * Lisensi offline Ed25519 (format `LIS1`) untuk versi Web self-hosted.
 *
 * Cermin `desktop/license.rs`: format, aturan isi, dan pesannya WAJIB sama, dan
 * ketiganya (alat penerbit, Rust, berkas ini) diuji dengan vektor yang sama
 * (`VECTOR_V1`..`VECTOR_V3`, dibuat `tandaTangani` alat penerbit dengan kunci uji). Lisensinya juga sama: satu teks di kunci
 * `app_license` tabel `setting_gex_system`, dipasang sekali per lembaga.
 *
 * Yang berbeda hanya IDENTITAS yang diikat. Desktop mengikat ke perangkat;
 * server Web tidak punya perangkat yang stabil (kontainer bisa dibuat ulang
 * kapan saja), jadi yang diikat adalah database-nya: sebuah id acak yang lahir
 * sekali di database itu, lalu di-hash menjadi kode berawalan `S`. Lisensi
 * wajib mencantumkan kode itu di `instance_web`. `website` adalah kunci
 * tambahan untuk pemasangan yang terbuka ke internet; pemasangan jaringan lokal
 * tidak memakainya, karena mewajibkan domain berarti mewajibkan lembaga online.
 *
 * Batasnya perlu diketahui: server ini berjalan di mesin milik pembeli. Tanda
 * tangan mencegah lisensi DIPALSUKAN; ia tidak mencegah pemeriksaannya DIBUANG
 * oleh orang yang menambal kode terkompilasi, dan pembeli yang menyalin seluruh
 * database ke server kedua ikut membawa id-nya.
 *
 * Berkas ini tidak mengimpor gateway, RBAC, maupun `initDatabaseSchema`:
 * pembungkus yang melempar `AuthorizationError` tinggal di
 * `server/auth/authorize.ts`.
 */

export const LICENSE_PRODUCT = "kos-absensi-perusahaan";
export const LICENSE_SETTING_KEY = "app_license";
/** Id acak pemasangan ini. Kode instance diturunkan darinya, tidak disimpan. */
export const WEB_INSTANCE_SETTING_KEY = "web_instance_id";
export const LICENSE_ISSUER = "Kemal Office Studio";

/** Sama dengan `PRODUCT_PUBLIC_KEY_HEX` di `license.rs`. Aman dibagikan. */
const PRODUCT_PUBLIC_KEY_HEX =
  "cc2865415a6c7e3bf9ccf647b4ffcd01f6f0abc0ef036f08366e936e00bc731f";

const LICENSE_PREFIX = "LIS1";
const MAX_LICENSE_TEXT = 16_384;
const MAX_DEVICES = 200;
const MAX_HOLDER_CHARS = 120;
const MAX_WEBSITES = 10;
const LICENSE_KINDS: readonly string[] = ["beli_putus", "sewa"];
const LICENSE_KEYS: readonly string[] = [
  "v",
  "produk",
  "id",
  "pemegang",
  "jenis",
  "terbit",
  "pembaruan_sampai",
  "berlaku_sampai",
  "perangkat",
  "kunci_mobile",
  "instance_web",
  "website",
];

/** Sama dengan `READ_ONLY_EXTRA_PERMISSIONS` di `license.rs`. */
const READ_ONLY_EXTRA_PERMISSIONS: readonly string[] = [
  "sync.retry",
  "database_backup.export",
];

const DEVICE_CODE_PATTERN =
  /^[WLAM]-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;
const INSTANCE_CODE_PATTERN =
  /^S-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Apakah build ini menegakkan lisensi. Nilainya ditanam saat BUILD lewat `env`
 * di `next.config.ts`, bukan dibaca dari `.env` server: sakelar yang dibaca saat
 * jalan bisa dimatikan pembeli dengan satu baris. Image pembeli dibangun dengan
 * nilai 1; deployment milik pemilik aplikasi tidak.
 */
export function isLicenseEnforced() {
  return process.env.KOS_LICENSE_ENFORCED === "1";
}

/** Tanggal build (WIB), ditanam `next.config.ts`. Padanan `BUILD_DATE` Rust. */
export function licenseBuildDate() {
  return process.env.KOS_BUILD_DATE ?? "";
}

export interface LicenseEvaluation {
  state: LicenseState;
  readOnlyReason: LicenseReadOnlyReason | null;
  message: string | null;
  license: LicensePayload | null;
}

/** `YYYY-MM-DD` persis dan tanggal yang benar-benar ada. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

/** Cermin `alamatWebsiteSah` (penerbit) dan `is_website_host` (Rust). */
export function isWebsiteHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 4 || value.length > 253) {
    return false;
  }
  const labels = value.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) return false;
    if (!/^[a-z0-9-]+$/.test(label)) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
  }
  return /[a-z]/.test(labels[labels.length - 1] ?? "");
}

/**
 * Cermin `validasiLisensi` (penerbit) dan `validate_payload` (Rust): urutan
 * pemeriksaan dan pesannya sama.
 */
export function validateLicensePayload(value: unknown): {
  product: string;
  license: LicensePayload;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Isi lisensi harus berupa objek JSON.");
  }
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!LICENSE_KEYS.includes(key)) {
      throw new Error(`Kolom lisensi tidak dikenal: ${key}.`);
    }
  }
  if (object.v !== 1) throw new Error("Versi lisensi tidak didukung.");
  const product = object.produk;
  if (
    typeof product !== "string" ||
    !/^[a-z0-9][a-z0-9-]{1,39}$/.test(product)
  ) {
    throw new Error("Kode produk tidak sah.");
  }
  const id = object.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,40}$/.test(id)) {
    throw new Error("ID lisensi tidak sah.");
  }
  const holder = object.pemegang;
  if (
    typeof holder !== "string" ||
    holder.length === 0 ||
    holder.trim() !== holder ||
    [...holder].length > MAX_HOLDER_CHARS ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: justru itu yang ditolak
    /[\u0000-\u001f\u007f]/.test(holder)
  ) {
    throw new Error("Nama pemegang lisensi tidak sah.");
  }
  const kind = object.jenis;
  if (typeof kind !== "string" || !LICENSE_KINDS.includes(kind)) {
    throw new Error("Jenis lisensi tidak dikenal.");
  }
  const issued = object.terbit;
  if (!isCalendarDate(issued)) throw new Error("Tanggal terbit tidak sah.");
  const updatesUntil = object.pembaruan_sampai;
  if (!isCalendarDate(updatesUntil)) {
    throw new Error("Tanggal pembaruan_sampai tidak sah.");
  }
  if (updatesUntil < issued) {
    throw new Error("pembaruan_sampai tidak boleh sebelum tanggal terbit.");
  }
  let validUntil: string | null = null;
  if (kind === "beli_putus") {
    if (object.berlaku_sampai !== null) {
      throw new Error("Lisensi beli_putus tidak punya berlaku_sampai.");
    }
  } else {
    if (!isCalendarDate(object.berlaku_sampai)) {
      throw new Error("Lisensi sewa wajib punya berlaku_sampai.");
    }
    if (object.berlaku_sampai < issued) {
      throw new Error("berlaku_sampai tidak boleh sebelum tanggal terbit.");
    }
    validUntil = object.berlaku_sampai;
  }
  const devices = object.perangkat;
  if (!Array.isArray(devices) || devices.length > MAX_DEVICES) {
    throw new Error(
      `Daftar perangkat harus berupa array berisi maksimal ${MAX_DEVICES} kode.`,
    );
  }
  const codes: string[] = [];
  for (const device of devices) {
    if (typeof device !== "string" || !DEVICE_CODE_PATTERN.test(device)) {
      throw new Error(`Kode perangkat tidak sah: ${String(device)}.`);
    }
    if (codes.includes(device)) {
      throw new Error(`Kode perangkat ganda: ${device}.`);
    }
    codes.push(device);
  }
  if (typeof object.kunci_mobile !== "boolean") {
    throw new Error("kunci_mobile harus true atau false.");
  }
  let webInstance: string | null = null;
  if ("instance_web" in object) {
    if (
      typeof object.instance_web !== "string" ||
      !INSTANCE_CODE_PATTERN.test(object.instance_web)
    ) {
      throw new Error("Kode instance Web tidak sah.");
    }
    webInstance = object.instance_web;
  }
  const websites: string[] = [];
  if ("website" in object) {
    if (webInstance === null) {
      throw new Error("website hanya berlaku bersama instance_web.");
    }
    const entries = object.website;
    if (
      !Array.isArray(entries) ||
      entries.length < 1 ||
      entries.length > MAX_WEBSITES
    ) {
      throw new Error(
        `Daftar website harus berupa array berisi 1-${MAX_WEBSITES} alamat.`,
      );
    }
    for (const entry of entries) {
      if (!isWebsiteHost(entry)) {
        throw new Error(`Alamat website tidak sah: ${String(entry)}.`);
      }
      if (websites.includes(entry)) {
        throw new Error(`Alamat website ganda: ${entry}.`);
      }
      websites.push(entry);
    }
  }
  return {
    product,
    license: {
      id,
      holder,
      kind: kind as LicenseKind,
      issued,
      updatesUntil,
      validUntil,
      devices: codes,
      lockMobile: object.kunci_mobile,
      webInstance,
      websites,
    },
  };
}

/** Cermin `compact_license_text`: buang SEMUA spasi, tab, dan baris baru. */
export function compactLicenseText(text: string) {
  return text.replace(/\s+/g, "");
}

/**
 * Verifikasi tanda tangan lalu validasi isi. Tanda tangan dihitung atas byte
 * `LIS1.<payload>` persis seperti tertulis, jadi JSON-nya tidak pernah disusun
 * ulang. Cermin `parse_license`.
 */
export function parseLicense(
  rawText: string,
  publicKeyHex: string,
  expectedProduct = LICENSE_PRODUCT,
): LicensePayload {
  if (rawText.length > MAX_LICENSE_TEXT * 4) {
    throw new Error("Teks lisensi terlalu panjang.");
  }
  const text = compactLicenseText(rawText);
  if (text.length > MAX_LICENSE_TEXT) {
    throw new Error("Teks lisensi terlalu panjang.");
  }
  const parts = text.split(".");
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) {
    throw new Error("Teks bukan lisensi LIS1.");
  }
  const [prefix, body, signature] = parts as [string, string, string];
  // `Buffer.from(..., "base64url")` tidak pernah menolak: karakter asing ia
  // lewati diam-diam. Rust menolaknya, jadi di sini diperiksa lebih dulu.
  if (!BASE64URL_PATTERN.test(signature)) {
    throw new Error("Tanda tangan lisensi rusak.");
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(publicKeyHex, "hex"),
    ]),
    format: "der",
    type: "spki",
  });
  let verified = false;
  try {
    verified = verify(
      null,
      Buffer.from(`${prefix}.${body}`, "utf8"),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    verified = false;
  }
  if (!verified) throw new Error("Tanda tangan lisensi tidak cocok.");
  let value: unknown;
  try {
    if (!BASE64URL_PATTERN.test(body)) throw new Error("rusak");
    value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("Isi lisensi rusak.");
  }
  const { product, license } = validateLicensePayload(value);
  if (product !== expectedProduct) {
    throw new Error(`Lisensi ini diterbitkan untuk produk lain (${product}).`);
  }
  return license;
}

function expiredMessage(until: string) {
  return `Masa berlaku lisensi berakhir pada ${until}. Aplikasi berjalan dalam mode baca-saja: data tetap bisa dilihat, diekspor, dan disinkronkan. Aktifkan lisensi baru untuk kembali mengubah data.`;
}

function versionMessage(updatesUntil: string, buildDate: string) {
  return `Versi aplikasi ini (build ${buildDate}) lebih baru dari masa pembaruan lisensi (sampai ${updatesUntil}). Aplikasi berjalan dalam mode baca-saja. Perpanjang paket pembaruan, atau pasang kembali versi yang dirilis sebelum tanggal itu.`;
}

/**
 * Nilai sebuah lisensi untuk server ini. Padanan `evaluate` di Rust, dengan
 * kode instance dan alamat sebagai pengganti kode perangkat.
 *
 * Tiga penolakan "pemasangan ini tidak tercantum" memakai status yang sama
 * dengan Desktop (`device_not_listed`), supaya layar aktivasi yang sudah ada
 * menanganinya tanpa cabang baru.
 */
export function evaluateWebLicense(input: {
  text: string | null;
  publicKeyHex: string;
  instanceCode: string;
  /** Host permintaan tanpa port; `null` bila tidak terbaca. */
  host: string | null;
  buildDate: string;
  today: string;
}): LicenseEvaluation {
  const blocked = (
    state: LicenseState,
    message: string,
    license: LicensePayload | null = null,
  ): LicenseEvaluation => ({ state, readOnlyReason: null, message, license });

  const text = input.text?.trim() ?? "";
  if (!text) {
    return blocked(
      "missing",
      `Server ini belum memiliki lisensi. Kirim kode server di bawah kepada ${LICENSE_ISSUER} untuk mendapatkannya.`,
    );
  }
  let license: LicensePayload;
  try {
    license = parseLicense(text, input.publicKeyHex);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return blocked("invalid", `Lisensi tidak sah: ${reason}`);
  }
  if (license.webInstance === null) {
    return blocked(
      "device_not_listed",
      `Lisensi ${license.holder} belum mencakup versi Web. Kirim kode server ini (${input.instanceCode}) kepada ${LICENSE_ISSUER} untuk ditambahkan.`,
      license,
    );
  }
  if (license.webInstance !== input.instanceCode) {
    return blocked(
      "device_not_listed",
      `Server ini (${input.instanceCode}) tidak terdaftar di lisensi ${license.holder}. Kirim kode server ini kepada ${LICENSE_ISSUER} untuk ditambahkan.`,
      license,
    );
  }
  if (
    license.websites.length > 0 &&
    (input.host === null || !license.websites.includes(input.host))
  ) {
    return blocked(
      "device_not_listed",
      `Alamat ${input.host ?? "ini"} tidak tercantum di lisensi ${license.holder}. Buka aplikasi lewat alamat yang terdaftar, atau minta ${LICENSE_ISSUER} menambahkan alamat ini.`,
      license,
    );
  }
  if (license.validUntil !== null && input.today > license.validUntil) {
    return {
      state: "read_only",
      readOnlyReason: "expired",
      message: expiredMessage(license.validUntil),
      license,
    };
  }
  if (input.buildDate > license.updatesUntil) {
    return {
      state: "read_only",
      readOnlyReason: "version_not_covered",
      message: versionMessage(license.updatesUntil, input.buildDate),
      license,
    };
  }
  return { state: "active", readOnlyReason: null, message: null, license };
}

/** Cermin `read_only_allows`. */
export function readOnlyAllows(permission: string) {
  return (
    permission.endsWith(".view") ||
    READ_ONLY_EXTRA_PERMISSIONS.includes(permission)
  );
}

/**
 * Cermin `device_code` di Rust dengan awalan `S`: 16 hex pertama SHA-256 id
 * mentah. Nama produk ikut di-hash supaya id yang sama memberi kode berbeda
 * untuk tiap aplikasi milik penerbit yang sama.
 */
export function instanceCodeFromId(rawId: string) {
  const hex = createHash("sha256")
    .update(`lisensi-perangkat-v1:${LICENSE_PRODUCT}:${rawId}`, "utf8")
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return `S-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

/** Cermin `rental_days_left`: hari terakhir sewa = 1, sewa yang lewat = 0. */
export function rentalDaysLeft(validUntil: string, today: string) {
  const day = (value: string) => Date.parse(`${value}T00:00:00Z`) / 86_400_000;
  return Math.max(0, Math.round(day(validUntil) - day(today)) + 1);
}

/**
 * Host yang dipakai pengguna, dengan aturan yang SAMA dengan pemeriksaan
 * same-origin (`isSameOriginRequest`): `x-forwarded-host` bila ada, selain itu
 * `host`. Memakai sumber yang sama berarti proxy yang memalsukan host supaya
 * cocok dengan lisensi sekaligus mematahkan pemeriksaan same-origin, karena
 * browser tetap mengirim Origin yang sebenarnya.
 */
export function requestHost(request: Request): string | null {
  const forwarded = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const raw = forwarded || request.headers.get("host") || "";
  const host = raw.replace(/:\d+$/, "").toLowerCase();
  return host || null;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

interface LicenseContext {
  text: string | null;
  /** Kosong bila id instance belum ada dan pemanggil tidak boleh membuatnya. */
  instanceCode: string;
  today: string;
}

export interface LicenseReadOptions {
  /**
   * `false` untuk pembaca yang tidak boleh menulis ke database, yaitu situs
   * publik. Tanpa id instance, lisensi apa pun dinilai "tidak tercantum":
   * id-nya baru lahir saat aplikasi admin dibuka pertama kali.
   */
  createInstance?: boolean;
  /**
   * Hanya diisi oleh tes, yang menandatangani lisensinya dengan kunci uji;
   * kunci privat produk tidak pernah ada di repo ini.
   */
  publicKeyHex?: string;
}

/** Lisensi jarang berubah; satu pembacaan cukup untuk banyak permintaan. */
const CONTEXT_TTL_MS = 30_000;
let cachedContext: {
  at: number;
  client: Client;
  value: LicenseContext;
} | null = null;

export function invalidateLicenseCache() {
  cachedContext = null;
}

async function readContextRow(client: Client) {
  const result = await client.execute({
    // Tanggal dari jam DATABASE dan dalam WIB, sama seperti seluruh tanggal
    // operasional aplikasi; jam proses server bisa berbeda zona.
    sql: `SELECT
        (SELECT value FROM setting_gex_system WHERE key = ?) AS license_text,
        (SELECT value FROM setting_gex_system WHERE key = ?) AS instance_id,
        date('now', '+7 hours') AS today;`,
    args: [LICENSE_SETTING_KEY, WEB_INSTANCE_SETTING_KEY],
  });
  const row = result.rows[0];
  return {
    text: row?.license_text == null ? null : String(row.license_text),
    instanceId: row?.instance_id == null ? "" : String(row.instance_id).trim(),
    today: String(row?.today ?? ""),
  };
}

/**
 * Lisensi tersimpan, kode instance, dan tanggal hari ini.
 *
 * Id instance lahir di sini pada pembacaan pertama. `DO NOTHING` membuat dua
 * permintaan pertama yang bersamaan berakhir dengan id yang sama: yang kalah
 * membaca ulang milik yang menang.
 */
export async function loadLicenseContext(
  client: Client,
  options: LicenseReadOptions = {},
): Promise<LicenseContext> {
  const now = Date.now();
  if (
    cachedContext &&
    cachedContext.client === client &&
    now - cachedContext.at < CONTEXT_TTL_MS
  ) {
    return cachedContext.value;
  }
  let row = await readContextRow(client);
  if (!row.instanceId && options.createInstance !== false) {
    await client.execute({
      sql: "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING;",
      args: [WEB_INSTANCE_SETTING_KEY, randomBytes(16).toString("hex")],
    });
    row = await readContextRow(client);
  }
  const value = {
    text: row.text,
    instanceCode: row.instanceId ? instanceCodeFromId(row.instanceId) : "",
    today: row.today,
  };
  cachedContext = { at: now, client, value };
  return value;
}

export function toLicenseStatus(
  evaluation: LicenseEvaluation,
  context: LicenseContext,
): LicenseStatus {
  return {
    state: evaluation.state,
    readOnlyReason: evaluation.readOnlyReason,
    message: evaluation.message,
    license: evaluation.license,
    daysLeft: evaluation.license?.validUntil
      ? rentalDaysLeft(evaluation.license.validUntil, context.today)
      : null,
    deviceCode: context.instanceCode,
    deviceBound: true,
    buildDate: licenseBuildDate(),
  };
}

export async function resolveWebLicense(
  client: Client,
  request: Request,
  options: LicenseReadOptions = {},
) {
  const context = await loadLicenseContext(client, options);
  const evaluation = evaluateWebLicense({
    text: context.text,
    publicKeyHex: options.publicKeyHex ?? PRODUCT_PUBLIC_KEY_HEX,
    instanceCode: context.instanceCode,
    host: requestHost(request),
    buildDate: licenseBuildDate(),
    today: context.today,
  });
  return { evaluation, context };
}

/**
 * Alasan lisensi menolak satu permintaan, atau `null` bila boleh lanjut.
 * `permission` kosong berarti tindakan tanpa izin tertentu (login, mengamankan
 * akun sendiri): cukup lisensinya tidak memblokir. Padanan `gate_login` +
 * `enforce_any` di Rust.
 *
 * Selalu `null` pada build yang tidak menegakkan lisensi, tanpa menyentuh
 * database.
 */
export async function licenseRejection(
  client: Client,
  request: Request,
  permission: string | null,
  options: LicenseReadOptions = {},
): Promise<string | null> {
  if (!isLicenseEnforced()) return null;
  const { evaluation } = await resolveWebLicense(client, request, options);
  if (evaluation.state === "active") return null;
  if (evaluation.state !== "read_only") {
    return evaluation.message ?? "Lisensi tidak sah.";
  }
  if (permission !== null && !readOnlyAllows(permission)) {
    return evaluation.message ?? "Lisensi berada dalam mode baca-saja.";
  }
  return null;
}

/**
 * Periksa teks lisensi yang akan dipasang. Hanya lisensi yang AKTIF penuh
 * untuk pemasangan ini yang diterima, supaya tidak ada yang mengunci dirinya
 * keluar dengan memasang lisensi yang tidak mencantumkan servernya. Cermin
 * `check_installable`.
 */
export async function checkInstallableLicense(
  client: Client,
  request: Request,
  text: string,
  options: LicenseReadOptions = {},
) {
  const context = await loadLicenseContext(client, options);
  const evaluation = evaluateWebLicense({
    text: compactLicenseText(text),
    publicKeyHex: options.publicKeyHex ?? PRODUCT_PUBLIC_KEY_HEX,
    instanceCode: context.instanceCode,
    host: requestHost(request),
    buildDate: licenseBuildDate(),
    today: context.today,
  });
  if (evaluation.state !== "active") {
    throw new Error(evaluation.message ?? "Lisensi tidak sah.");
  }
  return evaluation;
}

export async function storeLicense(client: Client, text: string) {
  await client.execute({
    sql: "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
    args: [LICENSE_SETTING_KEY, compactLicenseText(text)],
  });
  invalidateLicenseCache();
}
