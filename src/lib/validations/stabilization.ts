interface EmployeeDraft {
  divisi: string;
  id_shift: number;
  id_unik: string;
  kode_karyawan: string;
  nama: string;
}

interface ShiftDraft {
  kode_shift: number;
  nama_shift: string;
  jam_masuk: string;
  jam_pulang: string;
  awal_absen_menit?: number;
  batas_masuk_menit?: number;
  toleransi_masuk_menit?: number;
  jam_kerja_normal_menit?: number;
  istirahat_menit?: number;
  batas_pulang_menit?: number;
  offset_istirahat_mulai?: number;
  offset_generate_alfa?: number;
  buffer_shift_malam_menit?: number;
}

export function createEmployeeIdentifiers(uuid: string) {
  const compactUuid = uuid.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (compactUuid.length < 12) {
    throw new Error("UUID tidak valid untuk membuat identitas karyawan.");
  }

  return {
    idUnik: `EMP_${compactUuid.slice(0, 12)}`,
    kodeKaryawan: `K${compactUuid.slice(-8)}`,
  };
}

export function validateEmployeeDraft(data: EmployeeDraft) {
  const errors: Record<string, string> = {};

  if (!data.id_unik.trim()) errors.id_unik = "ID unik wajib diisi.";
  if (!data.kode_karyawan.trim()) {
    errors.kode_karyawan = "Kode karyawan wajib diisi.";
  }
  if (data.nama.trim().length < 2) {
    errors.nama = "Nama karyawan minimal 2 karakter.";
  }
  if (!data.divisi.trim()) errors.divisi = "Divisi wajib diisi.";
  if (!Number.isInteger(data.id_shift) || data.id_shift < 1) {
    errors.id_shift = "Pilih shift kerja yang valid.";
  }

  return errors;
}

export function isValidTime(value: string) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function validateShiftDraft(data: ShiftDraft) {
  const errors: Record<string, string> = {};

  if (!Number.isInteger(data.kode_shift) || data.kode_shift < 1) {
    errors.kode_shift = "Kode shift harus berupa angka positif.";
  }
  if (data.nama_shift.trim().length < 2) {
    errors.nama_shift = "Nama shift minimal 2 karakter.";
  }
  if (!isValidTime(data.jam_masuk)) {
    errors.jam_masuk = "Gunakan format jam 24 jam, misalnya 07:00.";
  }
  if (!isValidTime(data.jam_pulang)) {
    errors.jam_pulang = "Gunakan format jam 24 jam, misalnya 15:00.";
  }
  if (
    isValidTime(data.jam_masuk) &&
    isValidTime(data.jam_pulang) &&
    data.jam_masuk === data.jam_pulang
  ) {
    errors.jam_pulang = "Jam pulang harus berbeda dari jam masuk.";
  }

  const numericRules: Array<
    [
      keyof Pick<
        ShiftDraft,
        | "awal_absen_menit"
        | "batas_masuk_menit"
        | "toleransi_masuk_menit"
        | "jam_kerja_normal_menit"
        | "istirahat_menit"
        | "batas_pulang_menit"
        | "offset_istirahat_mulai"
        | "offset_generate_alfa"
        | "buffer_shift_malam_menit"
      >,
      number,
      number,
      string,
    ]
  > = [
    ["awal_absen_menit", 0, 1440, "Awal Absen"],
    ["batas_masuk_menit", 0, 1440, "Batas Masuk"],
    ["toleransi_masuk_menit", 0, 1440, "Toleransi Terlambat"],
    ["jam_kerja_normal_menit", 1, 1440, "Durasi Kerja Normal"],
    ["istirahat_menit", 0, 1440, "Durasi Istirahat"],
    ["batas_pulang_menit", 0, 1440, "Batas Pulang"],
    ["offset_istirahat_mulai", 0, 1440, "Offset Istirahat Mulai"],
    ["offset_generate_alfa", 0, 1440, "Offset Generate Alfa"],
    ["buffer_shift_malam_menit", 0, 1440, "Buffer Deteksi Shift Malam"],
  ];

  for (const [field, minimum, maximum, label] of numericRules) {
    const value = data[field];
    if (
      value !== undefined &&
      (!Number.isFinite(value) || value < minimum || value > maximum)
    ) {
      errors[field] = `${label} harus antara ${minimum}–${maximum} menit.`;
    }
  }

  return errors;
}

export function firstValidationMessage(errors: Record<string, string>) {
  return Object.values(errors)[0] ?? null;
}
