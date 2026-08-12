"use client";

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Gambar QR gagal dimuat."));
    image.src = src;
  });
}

export async function createIdCardPng(
  row: Record<string, unknown>,
  qrPng: string,
) {
  const canvas = document.createElement("canvas");
  canvas.width = 1011;
  canvas.height = 638;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas tidak tersedia.");
  const gradient = context.createLinearGradient(
    0,
    0,
    canvas.width,
    canvas.height,
  );
  gradient.addColorStop(0, "#020617");
  gradient.addColorStop(1, "#075985");
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#38bdf8";
  context.fillRect(0, 0, 22, canvas.height);
  context.fillStyle = "#ffffff";
  context.font = "bold 42px Arial";
  context.fillText("KARTU KARYAWAN", 70, 92);
  context.fillStyle = "#7dd3fc";
  context.font = "bold 24px Arial";
  context.fillText("ABSENSI SPPG", 72, 130);
  context.fillStyle = "#ffffff";
  context.font = "bold 48px Arial";
  context.fillText(String(row.nama || "Karyawan").slice(0, 27), 72, 260);
  context.fillStyle = "#cbd5e1";
  context.font = "28px Arial";
  context.fillText(String(row.divisi || "-"), 72, 316);
  context.fillText(`ID: ${String(row.id_unik || "-")}`, 72, 382);
  context.fillText(`Kode: ${String(row.kode_karyawan || "-")}`, 72, 428);
  context.font = "22px Arial";
  context.fillStyle = "#94a3b8";
  context.fillText("Kartu ini digunakan untuk absensi QR resmi.", 72, 548);
  const qr = await loadImage(qrPng);
  context.fillStyle = "#ffffff";
  context.fillRect(692, 132, 256, 256);
  context.drawImage(qr, 704, 144, 232, 232);
  context.fillStyle = "#bae6fd";
  context.font = "bold 21px Arial";
  context.textAlign = "center";
  context.fillText("PINDAI UNTUK ABSENSI", 820, 430);
  return canvas.toDataURL("image/png");
}
