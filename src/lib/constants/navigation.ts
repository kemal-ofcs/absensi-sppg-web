import type { AppArea } from "@/lib/auth/access";

/**
 * Satu daftar menu untuk sidebar Desktop/Web dan halaman Menu Mobile, supaya
 * modul baru cukup didaftarkan sekali. Nama ikon wajib ada di `Icon` kedua
 * workspace (komponen itu tidak ikut disalin).
 */
export type NavigationIcon =
  | "alert"
  | "box"
  | "calendar"
  | "clock"
  | "dashboard"
  | "document"
  | "eye"
  | "home"
  | "lock"
  | "scanner"
  | "settings"
  | "tools"
  | "user"
  | "users";

export interface NavigationItem {
  area: AppArea;
  href: string;
  icon: NavigationIcon;
  label: string;
  /** Halaman hanya ada di Web/Desktop; Menu Mobile menyembunyikannya. */
  desktopSaja?: boolean;
}

export interface NavigationGroup {
  label: string;
  items: NavigationItem[];
}

export const NAVIGATION_GROUPS: NavigationGroup[] = [
  {
    label: "Absensi",
    items: [
      { area: "home", href: "/", icon: "home", label: "Home" },
      {
        area: "scanner",
        href: "/scanner",
        icon: "scanner",
        label: "QR Scanner",
      },
      {
        area: "dashboard",
        href: "/dashboard",
        icon: "dashboard",
        label: "Dashboard",
      },
      { area: "history", href: "/history", icon: "clock", label: "Riwayat" },
      {
        area: "audit",
        href: "/audit-absensi",
        icon: "alert",
        label: "Audit Absensi",
      },
      {
        area: "attendance_photo",
        href: "/foto-absensi",
        icon: "eye",
        label: "Foto Absensi",
      },
      {
        area: "face_template",
        href: "/wajah",
        icon: "user",
        label: "Pendaftaran Wajah",
      },
      {
        area: "operational",
        href: "/operational",
        icon: "tools",
        label: "Operasional",
      },
    ],
  },
  {
    label: "SDM",
    items: [
      { area: "karyawan", href: "/karyawan", icon: "user", label: "Karyawan" },
      {
        area: "hris",
        href: "/hris",
        icon: "users",
        label: "HRIS",
        desktopSaja: true,
      },
      {
        area: "pengajuan",
        href: "/pengajuan",
        icon: "calendar",
        label: "Cuti & Izin",
      },
      { area: "idcards", href: "/id-cards", icon: "user", label: "ID Card" },
      { area: "shift", href: "/shift", icon: "clock", label: "Shift" },
      {
        area: "holidays",
        href: "/holidays",
        icon: "calendar",
        label: "Hari Libur",
      },
      {
        area: "payroll",
        href: "/payroll",
        icon: "document",
        label: "Penggajian",
      },
      { area: "kasbon", href: "/kasbon", icon: "users", label: "Kasbon" },
    ],
  },
  {
    label: "Perjalanan",
    items: [
      {
        area: "perjalanan",
        href: "/perjalanan",
        icon: "document",
        label: "Surat Jalan",
      },
      {
        area: "driver",
        href: "/driver",
        icon: "scanner",
        label: "Lapor Perjalanan",
      },
    ],
  },
  {
    label: "Keuangan & Aset",
    items: [
      {
        area: "keuangan",
        href: "/keuangan",
        icon: "document",
        label: "Keuangan",
      },
      {
        area: "inventaris",
        href: "/inventaris",
        icon: "box",
        label: "Inventaris",
      },
    ],
  },
  {
    label: "Sistem",
    items: [
      {
        area: "operators",
        href: "/operators",
        icon: "users",
        label: "Operator",
      },
      {
        area: "password_reset",
        href: "/riwayat-reset-password",
        icon: "lock",
        label: "Riwayat Reset",
      },
      {
        area: "settings",
        href: "/settings",
        icon: "settings",
        label: "Pengaturan",
      },
    ],
  },
];

/** Pintasan di halaman Karyawan Mobile: modul yang mengurus data seorang karyawan. */
export const KARYAWAN_SHORTCUT_AREAS: AppArea[] = [
  "idcards",
  "face_template",
  "shift",
  "holidays",
  "payroll",
  "kasbon",
];

export function navigationItemByArea(area: AppArea) {
  for (const group of NAVIGATION_GROUPS) {
    const item = group.items.find((entry) => entry.area === area);
    if (item) return item;
  }
  return undefined;
}
