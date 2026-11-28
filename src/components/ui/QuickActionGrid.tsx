"use client";

import {
  QuickActionTile,
  type QuickActionTileProps,
} from "@/components/ui/QuickActionTile";
import { type AppArea, canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";

export interface QuickActionItem extends QuickActionTileProps {
  area?: AppArea;
  /** Syarat izin tambahan (mis. `hasPermission`); `false` menyembunyikan kartu. */
  visible?: boolean;
}

interface QuickActionGridProps {
  tiles?: QuickActionItem[];
  className?: string;
  /** Kolom di layar >= 640px; HP selalu 2 kolom supaya label tidak terpotong. */
  kolom?: 2 | 3 | 4;
}

const KOLOM_SM = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
};

const DEFAULT_TILES: QuickActionItem[] = [
  {
    href: "/scanner",
    icon: "scanner",
    title: "Terminal Scanner",
    subtitle: "Pindai QR kartu karyawan",
    area: "scanner",
  },
  {
    href: "/dashboard",
    icon: "dashboard",
    title: "Dashboard & KPI",
    subtitle: "Rekap dan tren kehadiran",
    area: "dashboard",
  },
  {
    href: "/history",
    icon: "clock",
    title: "Riwayat Scan",
    subtitle: "Log scan dan rekap harian",
    area: "history",
  },
  {
    href: "/payroll",
    icon: "document",
    title: "Penggajian",
    subtitle: "Gaji, PPh 21, BPJS",
    area: "payroll",
  },
  {
    href: "/karyawan",
    icon: "user",
    title: "Data Karyawan",
    subtitle: "Personil, shift, token QR",
    area: "karyawan",
  },
  {
    href: "/id-cards",
    icon: "user",
    title: "ID Card",
    subtitle: "Desain dan cetak kartu",
    area: "idcards",
  },
  {
    href: "/shift",
    icon: "clock",
    title: "Shift Kerja",
    subtitle: "Jam masuk dan toleransi",
    area: "shift",
  },
  {
    href: "/holidays",
    icon: "calendar",
    title: "Hari Libur",
    subtitle: "Kalender libur dan cuti bersama",
    area: "holidays",
  },
  {
    href: "/operational",
    icon: "tools",
    title: "Koreksi & Backup",
    subtitle: "Koreksi manual, impor, cadangan",
    area: "operational",
  },
  {
    href: "/operators",
    icon: "users",
    title: "Operator & Hak Akses",
    subtitle: "Akun staf dan izin",
    area: "operators",
  },
  {
    href: "/riwayat-reset-password",
    icon: "lock",
    title: "Reset Password",
    subtitle: "Riwayat permintaan pemulihan",
    area: "password_reset",
  },
  {
    href: "/settings",
    icon: "settings",
    title: "Pengaturan",
    subtitle: "Database, geofence, profil",
    area: "settings",
  },
];

export function QuickActionGrid({
  tiles = DEFAULT_TILES,
  className = "",
  kolom = 4,
}: QuickActionGridProps) {
  const { user } = useAuth();
  const visibleTiles = tiles.filter(
    (tile) =>
      tile.visible !== false && (!tile.area || canAccessArea(user, tile.area)),
  );

  return (
    <section aria-label="Akses Cepat" className={className}>
      <div className={`grid grid-cols-2 gap-2.5 sm:gap-3.5 ${KOLOM_SM[kolom]}`}>
        {visibleTiles.map((tile) => (
          <QuickActionTile key={tile.href} {...tile} />
        ))}
      </div>
    </section>
  );
}
