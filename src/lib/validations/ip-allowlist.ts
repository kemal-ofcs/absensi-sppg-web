/**
 * Daftar IP jaringan absensi.
 *
 * Modul ini adalah cermin TypeScript dari `normalize_ip_entry`,
 * `parse_ip_allowlist`, dan `ip_matches_allowlist` di
 * `src-tauri/src/desktop/scanner.rs`. Keduanya diuji dengan vektor yang sama
 * (`ip-allowlist.test.ts` dan modul test di `scanner.rs`) karena keduanya
 * menilai daftar yang sama persis: satu daftar disimpan di `setting_gex_system`
 * lalu dibaca Web (server) maupun Desktop/Mobile (Rust). Kalau keduanya menilai
 * berbeda, satu terminal akan menerima scan yang ditolak terminal lain tanpa
 * pesan apa pun yang menjelaskan.
 *
 * Alamat direpresentasikan sebagai deret byte (4 byte untuk IPv4, 16 byte untuk
 * IPv6), bukan BigInt: target TypeScript proyek ini ES2017 dan literal BigInt
 * belum tersedia di sana. Deret byte juga membuat perbandingan prefix CIDR
 * menjadi operasi byte biasa yang sama persis dengan sisi Rust.
 *
 * Sengaja tanpa dependensi: paket parser IP mana pun harus ikut terbundel ke
 * APK offline-first, dan aturannya cukup sederhana untuk dieja sendiri.
 */

/** Kunci `setting_gex_system` tempat daftar ini disimpan (dan ikut sinkronisasi). */
export const IP_ALLOWLIST_SETTING_KEY = "scan_ip_allowlist";

/** Jumlah entri maksimum; menahan satu setting membengkak tanpa batas. */
export const MAX_IP_ALLOWLIST_ENTRIES = 200;

export interface ParsedIpAddress {
  family: 4 | 6;
  /** 4 byte untuk IPv4, 16 byte untuk IPv6. */
  bytes: number[];
}

function parseIpv4Bytes(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    // Rust menolak angka berawalan nol ("01.2.3.4"); disamakan supaya sebuah
    // entri tidak diterima di satu platform lalu ditolak di platform lain.
    if (part.length > 1 && part.startsWith("0")) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    bytes.push(octet);
  }
  return bytes;
}

function parseIpv6Groups(text: string): number[] | null {
  if (text === "") return [];
  const parts = text.split(":");
  const groups: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] as string;
    if (part.includes(".")) {
      // Bentuk campuran "::ffff:192.168.1.1" hanya sah pada kelompok terakhir.
      if (index !== parts.length - 1) return null;
      const embedded = parseIpv4Bytes(part);
      if (!embedded) return null;
      groups.push(
        ((embedded[0] as number) << 8) | (embedded[1] as number),
        ((embedded[2] as number) << 8) | (embedded[3] as number),
      );
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function parseIpv6Bytes(value: string): number[] | null {
  // Alamat berzona ("fe80::1%eth0") bukan alamat yang bisa dibandingkan lintas
  // perangkat, jadi ditolak seperti di Rust.
  if (value.includes("%")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;

  let groups: number[];
  if (halves.length === 1) {
    const parsed = parseIpv6Groups(halves[0] as string);
    if (!parsed || parsed.length !== 8) return null;
    groups = parsed;
  } else {
    const head = parseIpv6Groups(halves[0] as string);
    const tail = parseIpv6Groups(halves[1] as string);
    if (!head || !tail) return null;
    // "::" harus mewakili MINIMAL satu kelompok nol.
    if (head.length + tail.length > 7) return null;
    groups = [
      ...head,
      ...new Array<number>(8 - head.length - tail.length).fill(0),
      ...tail,
    ];
  }

  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}

export function parseIpAddress(raw: string): ParsedIpAddress | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.includes(":")) {
    const bytes = parseIpv6Bytes(value);
    return bytes ? { family: 6, bytes } : null;
  }
  const bytes = parseIpv4Bytes(value);
  return bytes ? { family: 4, bytes } : null;
}

function formatIpv4(bytes: readonly number[]) {
  return bytes.join(".");
}

/** Bentuk ringkas RFC 5952 — sama dengan `Ipv6Addr::to_string()` di Rust. */
function formatIpv6(bytes: readonly number[]) {
  const groups: number[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(((bytes[index] as number) << 8) | (bytes[index + 1] as number));
  }
  // Tiga bentuk khusus di bawah ditulis persis seperti `Ipv6Addr::to_string()`
  // di Rust std. Alamat IPv4-compatible ("::c0a8:101") justru TIDAK dipendekkan
  // menjadi "::192.168.1.1" oleh Rust modern, jadi ia sengaja dibiarkan lewat
  // jalur kompresi biasa di bawah.
  if (groups.every((group) => group === 0)) return "::";
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return "::1";
  }
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    return `::ffff:${formatIpv4(bytes.slice(12))}`;
  }

  let bestStart = -1;
  let bestLength = 0;
  let currentStart = -1;
  let currentLength = 0;
  for (let index = 0; index < groups.length; index += 1) {
    if (groups[index] === 0) {
      if (currentStart < 0) currentStart = index;
      currentLength += 1;
      if (currentLength > bestLength) {
        bestStart = currentStart;
        bestLength = currentLength;
      }
      continue;
    }
    currentStart = -1;
    currentLength = 0;
  }
  // Satu kelompok nol tidak dipersingkat, mengikuti aturan RFC 5952.
  if (bestLength < 2) {
    return groups.map((group) => group.toString(16)).join(":");
  }
  const head = groups.slice(0, bestStart).map((group) => group.toString(16));
  const tail = groups
    .slice(bestStart + bestLength)
    .map((group) => group.toString(16));
  return `${head.join(":")}::${tail.join(":")}`;
}

function formatIpAddress(address: ParsedIpAddress) {
  return address.family === 4
    ? formatIpv4(address.bytes)
    : formatIpv6(address.bytes);
}

/**
 * Normalisasi satu entri: alamat tunggal, atau blok CIDR `alamat/prefix`.
 *
 * Mengembalikan `null` untuk entri tidak valid. Entri sampah yang lolos akan
 * membuat daftar diam-diam memblokir semua orang, jadi ia dibuang saat disimpan.
 */
export function normalizeIpEntry(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const slash = value.indexOf("/");
  if (slash < 0) {
    const address = parseIpAddress(value);
    return address ? formatIpAddress(address) : null;
  }
  const address = parseIpAddress(value.slice(0, slash));
  const prefix = value.slice(slash + 1).trim();
  if (!address || !/^\d{1,3}$/.test(prefix)) return null;
  const bits = Number(prefix);
  const maxBits = address.family === 4 ? 32 : 128;
  if (bits > maxBits) return null;
  return `${formatIpAddress(address)}/${bits}`;
}

/** Baca daftar dari nilai setting: JSON array, atau teks dipisah koma/baris. */
export function parseIpAllowlist(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const entries: string[] = [];
  const push = (candidate: string) => {
    const entry = normalizeIpEntry(candidate);
    if (entry && !entries.includes(entry)) entries.push(entry);
  };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === "string") push(item);
      }
      return entries;
    }
  } catch {
    // Bukan JSON: jatuh ke bentuk teks bebas di bawah.
  }
  for (const candidate of raw.split(/[,;\n]/)) push(candidate);
  return entries;
}

export function serializeIpAllowlist(entries: readonly string[]): string {
  const normalized: string[] = [];
  for (const entry of entries) {
    const value = normalizeIpEntry(entry);
    if (value && !normalized.includes(value)) normalized.push(value);
  }
  return JSON.stringify(normalized.slice(0, MAX_IP_ALLOWLIST_ENTRIES));
}

function samePrefix(
  network: readonly number[],
  candidate: readonly number[],
  bits: number,
) {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (network[index] !== candidate[index]) return false;
  }
  const remainder = bits % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (
    ((network[fullBytes] as number) & mask) ===
    ((candidate[fullBytes] as number) & mask)
  );
}

function matchesEntry(address: ParsedIpAddress, entry: string): boolean {
  const slash = entry.indexOf("/");
  if (slash < 0) {
    const other = parseIpAddress(entry);
    return (
      other !== null &&
      other.family === address.family &&
      samePrefix(other.bytes, address.bytes, other.bytes.length * 8)
    );
  }
  const network = parseIpAddress(entry.slice(0, slash));
  const bits = Number(entry.slice(slash + 1));
  if (!network || !Number.isInteger(bits) || bits < 0) return false;
  if (network.family !== address.family) return false;
  if (bits > network.bytes.length * 8) return false;
  return samePrefix(network.bytes, address.bytes, bits);
}

/** Apakah salah satu alamat yang terdeteksi cocok dengan daftar yang diizinkan. */
export function ipMatchesAllowlist(
  addresses: readonly string[],
  entries: readonly string[],
): boolean {
  const parsed = addresses
    .map(parseIpAddress)
    .filter((address): address is ParsedIpAddress => address !== null);
  if (parsed.length === 0 || entries.length === 0) return false;
  return parsed.some((address) =>
    entries.some((entry) => matchesEntry(address, entry)),
  );
}

/** Pesan kesalahan per entri untuk formulir Pengaturan. */
export function validateIpAllowlistEntries(
  entries: readonly string[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (entries.length > MAX_IP_ALLOWLIST_ENTRIES) {
    errors.entries = `Maksimal ${MAX_IP_ALLOWLIST_ENTRIES} entri IP.`;
  }
  for (const [index, entry] of entries.entries()) {
    if (!entry.trim()) {
      errors[`entry-${index}`] = "Entri IP tidak boleh kosong.";
      continue;
    }
    if (!normalizeIpEntry(entry)) {
      errors[`entry-${index}`] =
        "Format IP tidak valid. Contoh: 192.168.1.20 atau 192.168.1.0/24.";
    }
  }
  return errors;
}
