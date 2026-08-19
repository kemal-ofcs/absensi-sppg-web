import "server-only";

import { db, ensureDbInitialized } from "@/lib/db";
import type { IdCardElement, IdCardTemplateConfig } from "@/types/id-card";

export const DEFAULT_ID_CARD_ELEMENTS: IdCardElement[] = [
  {
    id: "el-company-logo",
    type: "company_logo",
    side: "front",
    sourceKey: "company.logo",
    label: "Logo Instansi",
    x: 6,
    y: 8,
    width: 14,
    height: 20,
    fontSize: 14,
    color: "#ffffff",
  },
  {
    id: "el-header-company",
    type: "text",
    side: "front",
    sourceKey: "company.name",
    label: "Nama Instansi",
    x: 22,
    y: 11,
    fontSize: 16,
    fontWeight: "bold",
    color: "#ffffff",
    textAlign: "left",
    isUppercase: true,
  },
  {
    id: "el-header-title",
    type: "static_text",
    side: "front",
    sourceKey: "static_text",
    staticValue: "KARTU IDENTITAS KARYAWAN",
    label: "Judul Kartu",
    x: 22,
    y: 22,
    fontSize: 9,
    fontWeight: "600",
    color: "#38bdf8",
    textAlign: "left",
    isUppercase: true,
  },
  {
    id: "el-emp-name",
    type: "text",
    side: "front",
    sourceKey: "employee.name",
    label: "Nama Karyawan",
    x: 6,
    y: 44,
    fontSize: 18,
    fontWeight: "bold",
    color: "#ffffff",
    textAlign: "left",
    isUppercase: true,
  },
  {
    id: "el-emp-pos",
    type: "text",
    side: "front",
    sourceKey: "employee.position",
    label: "Jabatan / Posisi",
    x: 6,
    y: 56,
    fontSize: 12,
    fontWeight: "600",
    color: "#7dd3fc",
    textAlign: "left",
  },
  {
    id: "el-emp-dept",
    type: "text",
    side: "front",
    sourceKey: "employee.department",
    label: "Divisi / Unit",
    x: 6,
    y: 67,
    fontSize: 11,
    fontWeight: "normal",
    color: "#cbd5e1",
    textAlign: "left",
  },
  {
    id: "el-emp-nik",
    type: "text",
    side: "front",
    sourceKey: "employee.nik",
    label: "NIK / Kode",
    x: 6,
    y: 78,
    fontSize: 10,
    fontWeight: "normal",
    color: "#94a3b8",
    textAlign: "left",
  },
  {
    id: "el-emp-qr",
    type: "qr_code",
    side: "front",
    sourceKey: "employee.qr_token",
    label: "QR Code Token",
    x: 68,
    y: 30,
    width: 26,
    height: 48,
    fontSize: 10,
    color: "#000000",
  },
  {
    id: "el-back-title",
    type: "static_text",
    side: "back",
    sourceKey: "static_text",
    staticValue: "KETENTUAN PENGGUNAAN KARTU",
    label: "Judul Belakang",
    x: 8,
    y: 12,
    fontSize: 12,
    fontWeight: "bold",
    color: "#ffffff",
    textAlign: "left",
    isUppercase: true,
  },
  {
    id: "el-back-terms",
    type: "text",
    side: "back",
    sourceKey: "company.terms",
    label: "Syarat & Ketentuan",
    x: 8,
    y: 24,
    width: 84,
    height: 42,
    fontSize: 8.5,
    fontWeight: "normal",
    color: "#cbd5e1",
    textAlign: "left",
  },
  {
    id: "el-back-sig",
    type: "company_logo",
    side: "back",
    sourceKey: "company.signature",
    label: "Tanda Tangan Pimpinan",
    x: 66,
    y: 68,
    width: 26,
    height: 18,
    fontSize: 10,
    color: "#ffffff",
  },
  {
    id: "el-back-leader",
    type: "static_text",
    side: "back",
    sourceKey: "static_text",
    staticValue: "Pimpinan Instansi",
    label: "Label Pimpinan",
    x: 66,
    y: 88,
    fontSize: 8,
    fontWeight: "600",
    color: "#94a3b8",
    textAlign: "center",
  },
];

export async function getIdCardTemplate(
  id = "default_template",
): Promise<IdCardTemplateConfig> {
  await ensureDbInitialized();

  const res = await db.execute({
    sql: "SELECT * FROM id_card_template WHERE id = ? LIMIT 1;",
    args: [id],
  });

  if (res.rows.length === 0) {
    const now = new Date().toISOString();
    const defaultElementsJson = JSON.stringify(DEFAULT_ID_CARD_ELEMENTS);

    await db.execute({
      sql: `
        INSERT OR IGNORE INTO id_card_template (
          id, name, orientation, front_bg_url, back_bg_url, elements_json, is_active, created_at, updated_at
        ) VALUES (
          ?, 'Template Default SPPG', 'landscape', NULL, NULL, ?, 1, ?, ?
        );
      `,
      args: [id, defaultElementsJson, now, now],
    });

    return {
      id,
      name: "Template Default SPPG",
      orientation: "landscape",
      frontBgUrl: undefined,
      backBgUrl: undefined,
      elements: DEFAULT_ID_CARD_ELEMENTS,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  const row = res.rows[0];
  let parsedElements: IdCardElement[] = DEFAULT_ID_CARD_ELEMENTS;
  try {
    if (typeof row?.elements_json === "string") {
      parsedElements = JSON.parse(row.elements_json);
    }
  } catch {
    parsedElements = DEFAULT_ID_CARD_ELEMENTS;
  }

  return {
    id: String(row?.id || id),
    name: String(row?.name || "Template Default SPPG"),
    orientation: (row?.orientation === "portrait" ? "portrait" : "landscape") as
      | "portrait"
      | "landscape",
    frontBgUrl: row?.front_bg_url ? String(row.front_bg_url) : undefined,
    backBgUrl: row?.back_bg_url ? String(row.back_bg_url) : undefined,
    elements: parsedElements,
    isActive: Boolean(Number(row?.is_active ?? 1)),
    createdAt: row?.created_at ? String(row.created_at) : undefined,
    updatedAt: row?.updated_at ? String(row.updated_at) : undefined,
  };
}

export async function saveIdCardTemplate(
  template: IdCardTemplateConfig,
): Promise<IdCardTemplateConfig> {
  await ensureDbInitialized();

  const now = new Date().toISOString();
  const id = template.id || "default_template";
  const elementsJson = JSON.stringify(template.elements || []);

  await db.execute({
    sql: `
      INSERT INTO id_card_template (
        id, name, orientation, front_bg_url, back_bg_url, elements_json, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        orientation = excluded.orientation,
        front_bg_url = excluded.front_bg_url,
        back_bg_url = excluded.back_bg_url,
        elements_json = excluded.elements_json,
        is_active = excluded.is_active,
        updated_at = excluded.updated_at;
    `,
    args: [
      id,
      template.name || "Template Default SPPG",
      template.orientation || "landscape",
      template.frontBgUrl || null,
      template.backBgUrl || null,
      elementsJson,
      template.isActive ? 1 : 0,
      now,
      now,
    ],
  });

  return getIdCardTemplate(id);
}
