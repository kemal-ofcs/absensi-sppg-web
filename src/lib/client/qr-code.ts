"use client";

import QRCode from "qrcode";

export function employeeQrPayload(row: Record<string, unknown>) {
  const storedPayload = String(row.qr_code || "").trim();
  if (storedPayload) return storedPayload;
  const id = String(row.id_unik || "").trim();
  const token = String(row.token_absensi || "").trim();
  return id && token ? `${id}|${token}` : "";
}

export function createQrPng(payload: string, width = 512) {
  if (!payload.trim()) throw new Error("Payload QR tidak tersedia.");
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: "H",
    margin: 2,
    width,
    color: { dark: "#020617", light: "#ffffff" },
  });
}
