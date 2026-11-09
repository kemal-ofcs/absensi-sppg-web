import type {
  MasterPerjalanan,
  RincianPerjalanan,
} from "@/lib/validations/driver";
import { beratKg } from "./tampilan";

/**
 * Surat jalan A4, dicetak lewat dialog cetak browser/WebView2 (pola
 * `beritaAcara.ts`). Dibawa driver dan ditunjukkan di tempat muat dan
 * bongkar, jadi isinya hanya yang perlu dibaca di sana: tanpa tarif/upah.
 */

const ROOT_ID = "kos-print-root";

function esc(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function tanggalPanjang(tanggal: string): string {
  const waktu = new Date(`${tanggal}T00:00:00Z`);
  if (Number.isNaN(waktu.getTime())) return tanggal;
  return new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
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
  #${ROOT_ID} h1 { font-size: 14pt; text-align: center; margin: 0; text-decoration: underline; letter-spacing: 2px; }
  #${ROOT_ID} .nomor { text-align: center; margin-bottom: 16px; }
  #${ROOT_ID} .data td { border: none; padding: 1px 6px 1px 0; }
  #${ROOT_ID} table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 10.5pt; }
  #${ROOT_ID} .muatan th, #${ROOT_ID} .muatan td { border: 1px solid #000; padding: 4px 6px; vertical-align: top; text-align: left; }
  #${ROOT_ID} .angka { text-align: right !important; }
  #${ROOT_ID} .tanda { display: flex; justify-content: space-between; gap: 16px; margin-top: 32px; page-break-inside: avoid; }
  #${ROOT_ID} .ttd { flex: 1; text-align: center; }
  #${ROOT_ID} .ruang { height: 64px; }
  #${ROOT_ID} .garis { border-top: 1px solid #000; padding-top: 2px; }
`;

export interface KopSuratJalan {
  company_name: string | null;
  logo_url: string | null;
}

export function cetakSuratJalan(
  rincian: RincianPerjalanan,
  master: MasterPerjalanan,
  kop: KopSuratJalan,
): void {
  const { item, muatan } = rincian;
  const jenis = master.jenis.find((j) => j.id_jenis === item.id_jenis)?.nama;
  const baris = muatan
    .map(
      (m, i) =>
        `<tr><td>${i + 1}</td><td>${esc(m.tempat_muat)}</td><td>${esc(m.nama_barang)}</td><td>${esc(m.jenis_barang)}</td><td class="angka">${esc(m.qty)}</td><td>${esc(m.satuan)}</td><td class="angka">${m.berat_kg_x100 == null ? "" : esc(beratKg(m.berat_kg_x100))}</td><td>${esc(m.tempat_bongkar)}</td></tr>`,
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
    <h1>SURAT JALAN</h1>
    <div class="nomor">Nomor: ${esc(item.nomor)}</div>
    <table class="data">
      <tr><td>Tanggal</td><td>: ${esc(tanggalPanjang(item.tanggal))}</td></tr>
      <tr><td>Driver</td><td>: ${esc(item.nama_karyawan ?? item.id_karyawan)}</td></tr>
      <tr><td>Kendaraan</td><td>: ${esc([jenis, item.identitas_kendaraan].filter(Boolean).join(" · "))}</td></tr>
      <tr><td>Tujuan</td><td>: ${esc(item.nama_kategori)}</td></tr>
      ${item.catatan ? `<tr><td>Catatan</td><td>: ${esc(item.catatan)}</td></tr>` : ""}
    </table>
    <table class="muatan">
      <thead><tr><th>No</th><th>Tempat muat</th><th>Barang</th><th>Jenis</th><th class="angka">Jumlah</th><th>Satuan</th><th class="angka">Berat</th><th>Tempat bongkar</th></tr></thead>
      <tbody>${baris}</tbody>
    </table>
    <div class="tanda">
      ${ttd("Pengirim", null)}
      ${ttd("Driver", item.nama_karyawan)}
      ${ttd("Penerima", null)}
    </div>
  `;
  document.body.appendChild(root);
  // Beri waktu logo selesai dimuat sebelum dialog cetak dibuka.
  setTimeout(() => {
    window.focus();
    window.print();
    setTimeout(() => root.remove(), 3000);
  }, 300);
}
