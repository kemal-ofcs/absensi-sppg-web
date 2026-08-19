import { z } from "zod";

const eventIdSchema = z.string().regex(/^evt-[a-f0-9]{64}$/);
const clientIdSchema = z.string().regex(/^desktop-[a-f0-9]{64}$/);
const shortText = z.string().max(512);
const longText = z.string().max(8_192);
const assetText = z.string().max(262_144);
const finiteNumber = z.number().finite();
const integer = z.number().int().safe();

const optionalShortText = shortText.nullable().optional();
const optionalLongText = longText.nullable().optional();
const optionalNumber = finiteNumber.nullable().optional();

const employeeDraftFields = {
  jabatan_status: optionalShortText,
  no_hp: optionalShortText,
  lp: optionalShortText,
  id_shift: optionalNumber,
  status_aktif: optionalShortText,
  tanggal_daftar: optionalShortText,
  catatan: optionalLongText,
  jenis_personil: optionalShortText,
  tanggal_mulai_aktif: optionalShortText,
  tanggal_selesai_aktif: optionalShortText,
};

const employeeCreatePayload = z
  .object({
    id_unik: shortText.min(1),
    kode_karyawan: shortText.min(1),
    nama: shortText.min(2),
    divisi: shortText.min(1),
    ...employeeDraftFields,
    token_absensi: shortText.min(1),
    qr_code: longText.min(1),
  })
  .strict();

const employeeUpdatePayload = z
  .object({
    id_unik: optionalShortText,
    kode_karyawan: shortText.min(1),
    nama: shortText.min(2),
    divisi: shortText.min(1),
    ...employeeDraftFields,
  })
  .strict();

const shiftFields = {
  id_shift: optionalNumber,
  local_id_shift: optionalNumber,
  kode_shift: optionalNumber,
  nama_shift: shortText.min(2),
  jam_masuk: shortText.min(1),
  jam_pulang: shortText.min(1),
  awal_absen_menit: optionalNumber,
  batas_masuk_menit: optionalNumber,
  toleransi_masuk_menit: optionalNumber,
  jam_kerja_normal_menit: optionalNumber,
  istirahat_menit: optionalNumber,
  batas_pulang_menit: optionalNumber,
  offset_istirahat_mulai: optionalNumber,
  offset_generate_alfa: optionalNumber,
  buffer_shift_malam_menit: optionalNumber,
  izinkan_multi_sesi: optionalNumber,
};

const shiftCreatePayload = z
  .object({ ...shiftFields, kode_shift: finiteNumber })
  .strict();
const shiftUpdatePayload = z.object(shiftFields).strict();

const scanLogSchema = z
  .object({
    timestamp_scan: shortText.min(1),
    tanggal_kerja: optionalShortText,
    jam_scan: optionalShortText,
    id_karyawan: shortText.min(1),
    nama: optionalShortText,
    divisi: optionalShortText,
    jenis_scan: shortText.min(1),
    status_proses: optionalShortText,
    sumber_data: optionalShortText,
    catatan_sistem: optionalLongText,
    keterangan: optionalLongText,
    menit_terlambat: optionalNumber,
    menit_datang_awal: optionalNumber,
    id_referensi: optionalShortText,
    kode_operator: optionalShortText,
  })
  .strict();

const attendanceSchema = z
  .object({
    tanggal: shortText.min(1),
    id_karyawan: shortText.min(1),
    nama: optionalShortText,
    kelas_divisi: optionalShortText,
    jam_masuk: optionalShortText,
    jam_pulang: optionalShortText,
    status_kehadiran: optionalShortText,
    status_absen: optionalShortText,
    keterangan: optionalLongText,
    sumber: optionalShortText,
    update_terakhir: optionalShortText,
    menit_terlambat: optionalNumber,
    menit_datang_awal: optionalNumber,
    jam_kerja: optionalNumber,
    lembur: optionalNumber,
    jam_kerja_kurang: optionalNumber,
    id_shift: optionalNumber,
    bulan: optionalShortText,
    tahun: optionalNumber,
    id_sesi: shortText.min(1),
    mode_tugas: optionalShortText,
    id_backup: optionalShortText,
    id_karyawan_asal: optionalShortText,
    tanggal_tugas: optionalShortText,
  })
  .strict();

const attendanceScanPayload = z
  .object({
    log: scanLogSchema,
    attendance: attendanceSchema.nullable().optional(),
    attendanceBaseUpdatedAt: optionalShortText,
  })
  .strict();

const correctionSchema = z
  .object({
    id_referensi: shortText.min(1),
    tanggal: optionalShortText,
    id_karyawan: optionalShortText,
    nama: optionalShortText,
    divisi: optionalShortText,
    jenis_koreksi: shortText.min(1),
    jam_koreksi: optionalShortText,
    keterangan_admin: optionalLongText,
    status_proses: optionalShortText,
    timestamp: optionalShortText,
    kode_operator: optionalShortText,
  })
  .strict();

const correctionCreatePayload = z
  .object({
    correction: correctionSchema,
    attendance: attendanceSchema,
    log: scanLogSchema,
    attendanceBaseUpdatedAt: optionalShortText,
  })
  .strict();

const backupSchema = z
  .object({
    id_backup: shortText.min(1),
    tanggal_tugas: optionalShortText,
    id_karyawan_asal: shortText.min(1),
    nama_karyawan_asal: optionalShortText,
    divisi_asal: optionalShortText,
    id_shift_asal: optionalNumber,
    id_karyawan_pengganti: shortText.min(1),
    nama_karyawan_pengganti: optionalShortText,
    divisi_pengganti: optionalShortText,
    id_shift_normal_pengganti: optionalNumber,
    id_shift_backup: optionalNumber,
    alasan_backup: optionalLongText,
    status_tugas: optionalShortText,
    kode_operator: optionalShortText,
    waktu_input: optionalShortText,
    catatan: optionalLongText,
    waktu_dibatalkan: optionalShortText,
    operator_pembatalan: optionalShortText,
  })
  .strict();

const importSchema = z
  .object({
    event_key: shortText.min(1),
    timestamp_input: optionalShortText,
    tanggal: optionalShortText,
    id_unik: optionalShortText,
    nama: optionalShortText,
    divisi: optionalShortText,
    jam_masuk: optionalShortText,
    jam_pulang: optionalShortText,
    status_kehadiran: optionalShortText,
    status_absen: optionalShortText,
    keterangan: optionalLongText,
    status_proses: optionalShortText,
    diproses_pada: optionalShortText,
    pesan_error: optionalLongText,
    kode_operator: optionalShortText,
  })
  .strict();

const eventBase = {
  eventId: eventIdSchema,
  clientId: clientIdSchema,
  entityKey: z.string().min(1).max(160),
  baseRevision: integer.nonnegative().nullable().optional(),
  createdAt: integer.positive(),
};

function eventSchema<Domain extends string, Operation extends string>(
  domain: Domain,
  operation: Operation,
  payload: z.ZodType,
) {
  return z
    .object({
      ...eventBase,
      domain: z.literal(domain),
      operation: z.literal(operation),
      payload,
    })
    .strict();
}

const holidayCreatePayload = z
  .object({
    id_libur: optionalNumber,
    tanggal: shortText.min(1),
    nama_libur: shortText.min(1),
    jenis_libur: optionalShortText,
    keterangan: optionalLongText,
    status_aktif: optionalNumber,
  })
  .strict();

const holidayUpdatePayload = z
  .object({
    id_libur: optionalNumber,
    tanggal: optionalShortText,
    nama_libur: optionalShortText,
    jenis_libur: optionalShortText,
    keterangan: optionalLongText,
    status_aktif: optionalNumber,
  })
  .strict();

const holidayDeletePayload = z
  .object({
    id_libur: optionalNumber,
    tanggal: optionalShortText,
    nama_libur: optionalShortText,
  })
  .strict();

const settingUpsertPayload = z
  .object({
    key: shortText.min(1),
    value: longText,
  })
  .strict();

const companyProfileUpdatePayload = z
  .object({
    id: optionalShortText,
    company_name: shortText.min(1),
    branch_name: optionalShortText,
    logo_url: assetText.nullable().optional(),
    signature_url: assetText.nullable().optional(),
    address: optionalLongText,
    phone: optionalShortText,
    email: optionalShortText,
    website: optionalShortText,
    leader_name: optionalShortText,
    leader_title: optionalShortText,
    leader_nip: optionalShortText,
    card_terms: optionalLongText,
    timezone: optionalShortText,
  })
  .strict();

const idCardTemplateSavePayload = z
  .object({
    id: optionalShortText,
    name: shortText.min(1),
    orientation: z.enum(["portrait", "landscape"]),
    front_bg_url: assetText.nullable().optional(),
    back_bg_url: assetText.nullable().optional(),
    elements_json: longText.min(2),
    is_active: optionalNumber,
  })
  .strict();

export const operationalSyncEventSchema = z.union([
  eventSchema("employee", "create", employeeCreatePayload),
  eventSchema("employee", "update", employeeUpdatePayload),
  eventSchema(
    "employee",
    "status",
    z.object({ status_aktif: z.enum(["Aktif", "Nonaktif"]) }).strict(),
  ),
  eventSchema(
    "employee",
    "token",
    z
      .object({
        token_absensi: shortText.min(1),
        qr_code: longText.min(1),
      })
      .strict(),
  ),
  eventSchema("shift", "create", shiftCreatePayload),
  eventSchema("shift", "update", shiftUpdatePayload),
  eventSchema("shift", "delete", z.object({ id_shift: finiteNumber }).strict()),
  eventSchema("holiday", "create", holidayCreatePayload),
  eventSchema("holiday", "update", holidayUpdatePayload),
  eventSchema("holiday", "delete", holidayDeletePayload),
  eventSchema("setting", "upsert", settingUpsertPayload),
  eventSchema("setting", "update", settingUpsertPayload),
  eventSchema("company-profile", "update", companyProfileUpdatePayload),
  eventSchema("id-card-template", "save", idCardTemplateSavePayload),
  eventSchema("id-card-template", "update", idCardTemplateSavePayload),
  eventSchema("attendance", "scan", attendanceScanPayload),
  eventSchema(
    "attendance",
    "update",
    z
      .object({
        id_sesi: shortText.min(1),
        jam_masuk: optionalShortText,
        jam_pulang: optionalShortText,
        status_kehadiran: optionalShortText,
        status_absen: optionalShortText,
        keterangan: optionalLongText,
      })
      .strict(),
  ),
  eventSchema(
    "attendance",
    "delete",
    z.object({ id_sesi: shortText.min(1) }).strict(),
  ),
  eventSchema(
    "log-scan",
    "delete",
    z
      .object({
        id_log: optionalNumber,
        id_referensi: optionalShortText,
        id_karyawan: optionalShortText,
        tanggal_kerja: optionalShortText,
        timestamp_scan: optionalShortText,
      })
      .strict(),
  ),
  eventSchema("correction", "create", correctionCreatePayload),
  eventSchema(
    "correction",
    "delete",
    z.object({ id_referensi: shortText.min(1) }).strict(),
  ),
  eventSchema("backup", "create", z.object({ backup: backupSchema }).strict()),
  eventSchema(
    "backup",
    "cancel",
    z
      .object({
        id_backup: optionalShortText,
        waktu_dibatalkan: optionalShortText,
        operator_pembatalan: optionalShortText,
      })
      .strict(),
  ),
  eventSchema(
    "offline-import",
    "row",
    z
      .object({
        import: importSchema,
        attendance: attendanceSchema,
        logs: z.array(scanLogSchema).max(4),
        attendanceBaseUpdatedAt: optionalShortText,
      })
      .strict(),
  ),
  eventSchema(
    "offline-import",
    "delete",
    z.object({ event_key: shortText.min(1) }).strict(),
  ),
  eventSchema(
    "id-card",
    "update",
    z
      .object({
        id_unik: optionalShortText,
        idcard_status: z.enum(["Belum", "Berhasil", "Gagal"]),
        tanggal_generate: optionalShortText,
        idcard_last_generate: optionalShortText,
        idcard_pdf_url: assetText.nullable().optional(),
        link_qr_png: assetText.nullable().optional(),
        idcard_catatan: optionalLongText,
      })
      .strict(),
  ),
]);

export interface OperationalSyncEvent {
  eventId: string;
  clientId: string;
  domain: string;
  operation: string;
  entityKey: string;
  payload: Record<string, unknown>;
  baseRevision?: number | null;
  createdAt: number;
}

export const operationalSyncBatchSchema = z
  .object({
    clientId: clientIdSchema,
    events: z.array(operationalSyncEventSchema).min(1).max(50),
  })
  .strict()
  .superRefine((batch, context) => {
    batch.events.forEach((event, index) => {
      if (event.clientId !== batch.clientId) {
        context.addIssue({
          code: "custom",
          message: "Identitas client sinkronisasi berbeda.",
          path: ["events", index, "clientId"],
        });
      }
    });
  });

export function parseOperationalSyncBatch(input: unknown): {
  clientId: string;
  events: OperationalSyncEvent[];
} {
  return operationalSyncBatchSchema.parse(input) as {
    clientId: string;
    events: OperationalSyncEvent[];
  };
}

export function safeParseOperationalSyncEvent(input: unknown) {
  return operationalSyncEventSchema.safeParse(input);
}
