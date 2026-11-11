import type { KopSurat, SuratPeringatan } from "@/lib/gateways/hr-keluar";

/**
 * Surat peringatan A4 (PRD HRIS §20.3), dicetak lewat dialog cetak
 * browser/WebView2, pola `cetakTandaTerimaUpah`. SP yang dicabut tetap bisa
 * dicetak dengan tanda DICABUT. Hanya Web/Desktop.
 */

const ROOT_ID = "kos-print-root";

function esc(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function tanggalPanjang(tanggal: string | null): string {
  const waktu = new Date(`${tanggal}T00:00:00Z`);
  if (!tanggal || Number.isNaN(waktu.getTime())) return tanggal ?? "";
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(waktu);
}

const TINGKAT: Record<string, string> = {
  SP1: "SURAT PERINGATAN PERTAMA (SP-1)",
  SP2: "SURAT PERINGATAN KEDUA (SP-2)",
  SP3: "SURAT PERINGATAN KETIGA (SP-3)",
};

const GAYA = `
  @media screen { #${ROOT_ID} { display: none; } }
  @media print {
    @page { size: A4 portrait; margin: 20mm; }
    body > *:not(#${ROOT_ID}) { display: none !important; }
    #${ROOT_ID} { display: block !important; }
  }
  #${ROOT_ID} { color: #000; background: #fff; font-family: "Times New Roman", Times, serif; font-size: 12pt; line-height: 1.5; }
  #${ROOT_ID} .kop { display: flex; gap: 12px; align-items: center; border-bottom: 3px double #000; padding-bottom: 8px; margin-bottom: 16px; }
  #${ROOT_ID} .logo { width: 64px; height: 64px; object-fit: contain; }
  #${ROOT_ID} .nama { font-size: 16pt; font-weight: bold; text-transform: uppercase; }
  #${ROOT_ID} .alamat { font-size: 10pt; }
  #${ROOT_ID} h1 { font-size: 14pt; text-align: center; margin: 0; text-decoration: underline; }
  #${ROOT_ID} .nomor { text-align: center; margin: 0 0 16px; }
  #${ROOT_ID} .batal { text-align: center; font-weight: bold; border: 2px solid #000; padding: 4px; margin-bottom: 12px; }
  #${ROOT_ID} .data td { border: none; padding: 1px 6px 1px 0; vertical-align: top; }
  #${ROOT_ID} .isi { white-space: pre-wrap; margin: 4px 0 12px; }
  #${ROOT_ID} .tanda { display: flex; justify-content: space-between; gap: 16px; margin-top: 32px; page-break-inside: avoid; }
  #${ROOT_ID} .ttd { flex: 1; text-align: center; }
  #${ROOT_ID} .ruang { height: 64px; }
  #${ROOT_ID} .garis { border-top: 1px solid #000; padding-top: 2px; }
`;

export function cetakSuratPeringatan(
  sp: SuratPeringatan,
  karyawan: { nama: string; jabatan: string | null; divisi: string | null },
  kop: KopSurat | null,
): void {
  const ttd = (peran: string, nama: string, jabatan: string | null) =>
    `<div class="ttd"><div>${esc(peran)}</div><div class="ruang"></div><div class="garis">${esc(nama)}</div>${jabatan ? `<div>${esc(jabatan)}</div>` : ""}</div>`;

  document.getElementById(ROOT_ID)?.remove();
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `
    <style>${GAYA}</style>
    <header class="kop">
      ${kop?.logo_url ? `<img src="${esc(kop.logo_url)}" alt="" class="logo">` : ""}
      <div>
        <div class="nama">${esc(kop?.company_name || "Nama Perusahaan")}</div>
        ${kop?.address ? `<div class="alamat">${esc(kop.address)}</div>` : ""}
      </div>
    </header>
    <h1>${esc(TINGKAT[sp.tingkat] ?? sp.tingkat)}</h1>
    <p class="nomor">${sp.nomor ? `Nomor: ${esc(sp.nomor)}` : ""}</p>
    ${sp.dicabut_pada ? `<div class="batal">DICABUT: ${esc(sp.alasan_cabut)}</div>` : ""}
    <p>Diberikan kepada:</p>
    <table class="data">
      <tr><td>Nama</td><td>: ${esc(karyawan.nama)}</td></tr>
      <tr><td>Jabatan</td><td>: ${esc(karyawan.jabatan || "-")}</td></tr>
      <tr><td>Divisi</td><td>: ${esc(karyawan.divisi || "-")}</td></tr>
    </table>
    <p>Atas pelanggaran berikut:</p>
    <div class="isi">${esc(sp.pelanggaran)}</div>
    ${sp.harapan ? `<p>Perbaikan yang diminta:</p><div class="isi">${esc(sp.harapan)}</div>` : ""}
    <p>Surat peringatan ini berlaku ${esc(sp.masa_bulan)} bulan, sejak ${esc(tanggalPanjang(sp.tanggal))} sampai dengan ${esc(tanggalPanjang(sp.berlaku_sampai))}.</p>
    <p>${esc(tanggalPanjang(sp.tanggal))}</p>
    <div class="tanda">
      ${ttd("Yang memberikan", sp.penanda_nama, sp.penanda_jabatan)}
      ${ttd("Yang menerima", karyawan.nama, null)}
    </div>
  `;
  document.body.appendChild(root);
  setTimeout(() => {
    window.focus();
    window.print();
    setTimeout(() => root.remove(), 3000);
  }, 300);
}
