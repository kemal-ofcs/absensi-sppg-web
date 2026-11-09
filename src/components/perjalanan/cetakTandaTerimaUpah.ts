import { formatRupiah } from "@/lib/validations/accounting";
import type { PembayaranUpahItem } from "@/lib/validations/driver";
import type { KopSuratJalan } from "./cetakSuratJalan";

/**
 * Tanda terima upah surat jalan A4 (PRD §4.1c, Q-33: tanpa nomor), dicetak
 * lewat dialog cetak browser/WebView2 seperti surat jalan. Pembayaran yang
 * sudah dibatalkan tetap bisa dicetak, dengan tanda DIBATALKAN.
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

const GAYA = `
  @media screen { #${ROOT_ID} { display: none; } }
  @media print {
    @page { size: A4 portrait; margin: 15mm; }
    body > *:not(#${ROOT_ID}) { display: none !important; }
    #${ROOT_ID} { display: block !important; }
  }
  #${ROOT_ID} { color: #000; background: #fff; font-family: "Times New Roman", Times, serif; font-size: 12pt; line-height: 1.4; }
  #${ROOT_ID} .kop { display: flex; gap: 12px; align-items: center; border-bottom: 3px double #000; padding-bottom: 8px; margin-bottom: 16px; }
  #${ROOT_ID} .logo { width: 64px; height: 64px; object-fit: contain; }
  #${ROOT_ID} .nama { font-size: 16pt; font-weight: bold; text-transform: uppercase; }
  #${ROOT_ID} h1 { font-size: 14pt; text-align: center; margin: 0 0 16px; text-decoration: underline; letter-spacing: 2px; }
  #${ROOT_ID} .batal { text-align: center; font-weight: bold; border: 2px solid #000; padding: 4px; margin-bottom: 12px; }
  #${ROOT_ID} .data td { border: none; padding: 1px 6px 1px 0; }
  #${ROOT_ID} table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 11pt; }
  #${ROOT_ID} .rincian th, #${ROOT_ID} .rincian td { border: 1px solid #000; padding: 4px 6px; text-align: left; }
  #${ROOT_ID} .angka { text-align: right !important; }
  #${ROOT_ID} .tanda { display: flex; justify-content: space-between; gap: 16px; margin-top: 32px; page-break-inside: avoid; }
  #${ROOT_ID} .ttd { flex: 1; text-align: center; }
  #${ROOT_ID} .ruang { height: 64px; }
  #${ROOT_ID} .garis { border-top: 1px solid #000; padding-top: 2px; }
`;

export function cetakTandaTerimaUpah(
  bayar: PembayaranUpahItem,
  kop: KopSuratJalan,
): void {
  const baris = bayar.surat_jalan
    .map(
      (s, i) =>
        `<tr><td>${i + 1}</td><td>${esc(tanggalPanjang(s.tanggal))}</td><td>${esc(s.nomor ?? s.id_perjalanan)}</td><td class="angka">${esc(formatRupiah(s.upah))}</td></tr>`,
    )
    .join("");
  const ttd = (peran: string, nama: string | null) =>
    `<div class="ttd"><div>${esc(peran)}</div><div class="ruang"></div><div class="garis">${esc(nama ?? "(.............................)")}</div></div>`;

  document.getElementById(ROOT_ID)?.remove();
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `
    <style>${GAYA}</style>
    <header class="kop">
      ${kop.logo_url ? `<img src="${esc(kop.logo_url)}" alt="" class="logo">` : ""}
      <div class="nama">${esc(kop.company_name || "Nama Perusahaan")}</div>
    </header>
    <h1>TANDA TERIMA UPAH SURAT JALAN</h1>
    ${bayar.alasan_batal === null ? "" : `<div class="batal">DIBATALKAN ${esc(tanggalPanjang(bayar.tanggal_batal))}: ${esc(bayar.alasan_batal)}</div>`}
    <table class="data">
      <tr><td>Tanggal bayar</td><td>: ${esc(tanggalPanjang(bayar.tanggal))}</td></tr>
      <tr><td>Diterima oleh</td><td>: ${esc(bayar.nama_karyawan ?? bayar.id_karyawan)}</td></tr>
      ${bayar.keterangan ? `<tr><td>Keterangan</td><td>: ${esc(bayar.keterangan)}</td></tr>` : ""}
    </table>
    <table class="rincian">
      <thead><tr><th>No</th><th>Tanggal surat jalan</th><th>Nomor surat jalan</th><th class="angka">Upah</th></tr></thead>
      <tbody>${baris}</tbody>
      <tfoot><tr><th colspan="3">Total</th><th class="angka">${esc(formatRupiah(bayar.total))}</th></tr></tfoot>
    </table>
    <div class="tanda">
      ${ttd("Yang menyerahkan", null)}
      ${ttd("Yang menerima", bayar.nama_karyawan)}
    </div>
  `;
  document.body.appendChild(root);
  setTimeout(() => {
    window.focus();
    window.print();
    setTimeout(() => root.remove(), 3000);
  }, 300);
}
