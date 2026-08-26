import type { DatabaseCheckResult } from "@/lib/gateways/bootstrap";

export type DatabaseCheckTone = "success" | "warning" | "danger";

export type DatabaseCheckFact = {
  label: string;
  value: string;
};

export type DatabaseCheckSummary = {
  tone: DatabaseCheckTone;
  title: string;
  detail: string;
  /** Form Superadmin boleh dibuka. */
  canCreateSuperadmin: boolean;
  /** Database sudah punya Superadmin aktif; cukup dipakai tanpa membuat akun baru. */
  canUseExisting: boolean;
  /** Skema asing terdeteksi sehingga user wajib mengonfirmasi database benar. */
  requiresConfirmation: boolean;
  facts: DatabaseCheckFact[];
};

const numberFormatter = new Intl.NumberFormat("id-ID");

function formatCount(total: number) {
  return numberFormatter.format(Math.max(0, Math.trunc(total)));
}

function buildFacts(check: DatabaseCheckResult): DatabaseCheckFact[] {
  const facts: DatabaseCheckFact[] = [
    { label: "Origin database", value: check.serverOrigin || "-" },
    {
      label: "Latensi",
      value:
        check.latencyMs === null ? "-" : `${formatCount(check.latencyMs)} ms`,
    },
    {
      label: "Profil perusahaan",
      value: check.companyName ?? "Belum diisi",
    },
    {
      label: "Superadmin aktif",
      value: check.superadminExists
        ? `${formatCount(check.superadminCount)} akun (${check.superadminUsername ?? "-"})`
        : "Belum ada",
    },
    { label: "Operator aktif", value: formatCount(check.operatorCount) },
    { label: "Data karyawan", value: formatCount(check.karyawanCount) },
    { label: "Rekap absensi", value: formatCount(check.attendanceCount) },
    { label: "Tabel terdeteksi", value: formatCount(check.tableCount) },
  ];
  return facts;
}

/**
 * Menerjemahkan hasil pemeriksaan database menjadi verdict yang dipakai
 * layar provisioning Desktop maupun Mobile.
 */
export function summarizeDatabaseCheck(
  check: DatabaseCheckResult,
): DatabaseCheckSummary {
  if (!check.reachable) {
    return {
      tone: "danger",
      title: "Database tidak dapat dihubungi",
      detail:
        check.errorMessage ??
        "Periksa kembali URL database Turso, Auth Token, dan koneksi internet perangkat.",
      canCreateSuperadmin: false,
      canUseExisting: false,
      requiresConfirmation: false,
      facts: check.serverOrigin
        ? [{ label: "Origin database", value: check.serverOrigin }]
        : [],
    };
  }

  const facts = buildFacts(check);

  if (check.superadminExists) {
    return {
      tone: "success",
      title: "Superadmin sudah tersedia di database ini",
      detail: `Akun "${check.superadminUsername ?? "superadmin"}" masih aktif, jadi tidak perlu membuat Superadmin baru. Gunakan database ini lalu login dengan akun tersebut.`,
      canCreateSuperadmin: false,
      canUseExisting: true,
      requiresConfirmation: false,
      facts,
    };
  }

  if (check.emptyDatabase) {
    return {
      tone: "warning",
      title: "Database masih kosong",
      detail:
        "Belum ada tabel sama sekali. Skema Absensi SPPG akan dibuat otomatis saat Superadmin pertama diaktifkan. Pastikan URL ini memang database baru milik Anda.",
      canCreateSuperadmin: true,
      canUseExisting: false,
      requiresConfirmation: false,
      facts,
    };
  }

  if (!check.schemaReady) {
    return {
      tone: "danger",
      title: "Database terhubung, tetapi bukan skema Absensi SPPG",
      detail: `Tabel inti yang hilang: ${check.missingTables.join(", ")}. Besar kemungkinan URL database salah. Periksa ulang sebelum melanjutkan agar database milik aplikasi lain tidak ikut diubah.`,
      canCreateSuperadmin: true,
      canUseExisting: false,
      requiresConfirmation: true,
      facts,
    };
  }

  if (check.bootstrapClaimed) {
    return {
      tone: "danger",
      title: "Klaim bootstrap sudah pernah dipakai",
      detail:
        "Skema Absensi SPPG terdeteksi, namun klaim Superadmin pada database ini sudah pernah digunakan sementara tidak ada Superadmin aktif. Aktifkan kembali akun Superadmin lama, atau gunakan database lain.",
      canCreateSuperadmin: true,
      canUseExisting: false,
      requiresConfirmation: true,
      facts,
    };
  }

  return {
    tone: "success",
    title: "Database Absensi SPPG siap diprovisioning",
    detail:
      "Skema sudah lengkap dan belum memiliki Superadmin aktif. Silakan lanjutkan pembuatan akun Superadmin pertama.",
    canCreateSuperadmin: true,
    canUseExisting: false,
    requiresConfirmation: false,
    facts,
  };
}
