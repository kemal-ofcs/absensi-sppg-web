import type {
  BarisDokumen,
  DokumenInventaris,
  KopPerusahaan,
} from "@/lib/validations/inventory";

/**
 * Berita acara inventaris sebagai HTML A4, dicetak lewat dialog cetak
 * browser/WebView2 ("Simpan sebagai PDF" tersedia di sana). WebView Android
 * tidak punya dialog cetak, jadi pemanggil menyembunyikan tombolnya di Mobile.
 *
 * Huruf serif dipakai karena mengikuti kebiasaan surat resmi, dan
 * warnanya selalu hitam di atas putih apa pun tema aplikasinya.
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
  if (!tanggal) return "";
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

function kop(kopPerusahaan: KopPerusahaan): string {
  const kontak = [
    kopPerusahaan.telepon,
    kopPerusahaan.email,
    kopPerusahaan.website,
  ]
    .filter(Boolean)
    .map(esc)
    .join(" · ");
  return `
    <header class="kop">
      ${kopPerusahaan.logo_url ? `<img src="${esc(kopPerusahaan.logo_url)}" alt="" class="logo">` : ""}
      <div>
        <div class="nama">${esc(kopPerusahaan.nama || "Nama Perusahaan")}</div>
        ${kopPerusahaan.cabang ? `<div>${esc(kopPerusahaan.cabang)}</div>` : ""}
        ${kopPerusahaan.alamat ? `<div class="kecil">${esc(kopPerusahaan.alamat)}</div>` : ""}
        ${kontak ? `<div class="kecil">${kontak}</div>` : ""}
      </div>
    </header>`;
}

function tandaTangan(
  label: string,
  nama: string | null,
  nip?: string | null,
): string {
  return `
    <div class="ttd">
      <div>${esc(label)}</div>
      <div class="ruang"></div>
      <div class="garis">${nama ? esc(nama) : "&nbsp;"}</div>
      ${nip ? `<div class="kecil">NIP ${esc(nip)}</div>` : ""}
    </div>`;
}

function selisih(baris: BarisDokumen): string {
  return baris.tempat_tujuan ? `+${baris.jumlah}` : `-${baris.jumlah}`;
}

function isi(dok: DokumenInventaris): {
  judul: string;
  pembuka: string;
  tabel: string;
  ttd: string;
} {
  const pemilik = esc(dok.kop.nama || "perusahaan");
  const hari = esc(tanggalPanjang(dok.tanggal));
  const kepala = tandaTangan(
    `Mengetahui, ${dok.kop.kepala_jabatan || "Pimpinan"}`,
    dok.kop.kepala_nama ?? null,
    dok.kop.kepala_nip,
  );

  if (dok.jenis === "Serah Terima") {
    return {
      judul: "BERITA ACARA SERAH TERIMA BARANG",
      pembuka: `Pada hari ${hari} telah dilakukan serah terima barang milik ${pemilik} dengan rincian sebagai berikut:`,
      tabel: `
        <thead><tr><th>No</th><th>Nama barang</th><th>Kode</th><th>Jumlah</th><th>Satuan</th><th>Diambil dari</th><th>Keperluan</th></tr></thead>
        <tbody>${dok.baris
          .map(
            (b, i) =>
              `<tr><td>${i + 1}</td><td>${esc(b.nama_barang)}</td><td>${esc(b.kode_barang)}</td><td class="angka">${b.jumlah}</td><td>${esc(b.satuan)}</td><td>${esc(b.tempat_asal)}</td><td>${esc(b.keperluan)}</td></tr>`,
          )
          .join("")}</tbody>`,
      ttd:
        tandaTangan("Yang menyerahkan", null) +
        tandaTangan("Yang menerima", dok.penerima_nama) +
        kepala,
    };
  }

  if (dok.jenis === "Pemusnahan") {
    return {
      judul: "BERITA ACARA PEMUSNAHAN BARANG",
      pembuka: `Pada hari ${hari} telah dilakukan pemusnahan atau penghapusan barang milik ${pemilik} dengan rincian sebagai berikut:`,
      tabel: `
        <thead><tr><th>No</th><th>Nama barang</th><th>Kode</th><th>Jumlah</th><th>Satuan</th><th>Tempat</th><th>Alasan</th><th>Kedaluwarsa</th><th>Catatan</th></tr></thead>
        <tbody>${dok.baris
          .map(
            (b, i) =>
              `<tr><td>${i + 1}</td><td>${esc(b.nama_barang)}</td><td>${esc(b.kode_barang)}</td><td class="angka">${b.jumlah}</td><td>${esc(b.satuan)}</td><td>${esc(b.tempat_asal)}</td><td>${esc(b.alasan)}</td><td>${esc(b.tanggal_expired)}</td><td>${esc(b.catatan)}</td></tr>`,
          )
          .join("")}</tbody>`,
      ttd: tandaTangan("Petugas", null) + tandaTangan("Saksi", null) + kepala,
    };
  }

  const tempat = esc(
    dok.baris[0]?.tempat_asal ?? dok.baris[0]?.tempat_tujuan ?? "",
  );
  return {
    judul: "BERITA ACARA STOCK OPNAME",
    pembuka: `Pada hari ${hari} telah dilakukan penghitungan fisik barang di ${tempat}, ${pemilik}. Selisih antara catatan dan hasil hitung adalah sebagai berikut:`,
    tabel: `
      <thead><tr><th>No</th><th>Nama barang</th><th>Kode</th><th>Kondisi</th><th>Kedaluwarsa</th><th>Selisih</th><th>Satuan</th></tr></thead>
      <tbody>${dok.baris
        .map(
          (b, i) =>
            `<tr><td>${i + 1}</td><td>${esc(b.nama_barang)}</td><td>${esc(b.kode_barang)}</td><td>${esc(b.kondisi_asal ?? b.kondisi_tujuan)}</td><td>${esc(b.tanggal_expired)}</td><td class="angka">${selisih(b)}</td><td>${esc(b.satuan)}</td></tr>`,
        )
        .join("")}</tbody>`,
    ttd: tandaTangan("Petugas pencacah", null) + kepala,
  };
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
  #${ROOT_ID} .kecil { font-size: 10pt; }
  #${ROOT_ID} h1 { font-size: 13pt; text-align: center; margin: 0; text-decoration: underline; }
  #${ROOT_ID} .nomor { text-align: center; margin-bottom: 16px; }
  #${ROOT_ID} table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 10.5pt; }
  #${ROOT_ID} th, #${ROOT_ID} td { border: 1px solid #000; padding: 4px 6px; vertical-align: top; text-align: left; }
  #${ROOT_ID} .angka { text-align: right; }
  #${ROOT_ID} .tanda { display: flex; justify-content: space-between; gap: 16px; margin-top: 32px; page-break-inside: avoid; }
  #${ROOT_ID} .ttd { flex: 1; text-align: center; }
  #${ROOT_ID} .ruang { height: 64px; }
  #${ROOT_ID} .garis { border-top: 1px solid #000; padding-top: 2px; }
`;

export function cetakBeritaAcara(dok: DokumenInventaris): void {
  const bagian = isi(dok);
  document.getElementById(ROOT_ID)?.remove();
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `
    <style>${GAYA}</style>
    ${kop(dok.kop)}
    <h1>${bagian.judul}</h1>
    <div class="nomor">Nomor: ${esc(dok.nomor_dokumen || "-")}</div>
    <p>${bagian.pembuka}</p>
    <table>${bagian.tabel}</table>
    ${dok.terpotong ? "<p>Hanya 500 baris pertama yang dicetak.</p>" : ""}
    <p>Demikian berita acara ini dibuat untuk dipergunakan sebagaimana mestinya.</p>
    <div class="tanda">${bagian.ttd}</div>
  `;
  document.body.appendChild(root);
  // Beri waktu logo selesai dimuat sebelum dialog cetak dibuka.
  setTimeout(() => {
    window.focus();
    window.print();
    setTimeout(() => root.remove(), 3000);
  }, 300);
}

// ── Label QR ────────────────────────────────────────────────────────────────

/** 3 × 8 label 64 × 33 mm per lembar A4 (margin 8 mm, celah 1 mm). */
export const LABEL_PER_LEMBAR = 24;

const GAYA_LABEL = `
  @media screen { #${ROOT_ID} { display: none; } }
  @media print {
    @page { size: A4 portrait; margin: 8mm; }
    body > *:not(#${ROOT_ID}) { display: none !important; }
    #${ROOT_ID} { display: block !important; }
  }
  #${ROOT_ID} { color: #000; background: #fff; font-family: Arial, Helvetica, sans-serif; }
  #${ROOT_ID} .lembar { display: grid; grid-template-columns: repeat(3, 64mm); grid-auto-rows: 33mm; gap: 1mm; break-after: page; }
  #${ROOT_ID} .lembar:last-child { break-after: auto; }
  #${ROOT_ID} .label { box-sizing: border-box; border: 0.2mm dashed #999; padding: 2mm; display: flex; gap: 2mm; align-items: center; overflow: hidden; }
  #${ROOT_ID} .label img { width: 27mm; height: 27mm; flex: none; }
  #${ROOT_ID} .teks { min-width: 0; display: flex; flex-direction: column; gap: 1mm; }
  #${ROOT_ID} .nama { font-size: 9pt; font-weight: bold; line-height: 1.15; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  #${ROOT_ID} .kode { font-size: 8pt; }
  #${ROOT_ID} .pemilik { font-size: 6.5pt; line-height: 1.15; }
`;

/**
 * `qr` sudah berupa data URL PNG per barang (dibuat sekali per barang, bukan
 * per label). Garis putus-putus adalah panduan potong: ukuran kertas stiker
 * di pasaran beragam, jadi tata letaknya tidak mengandalkan potongan pabrik.
 */
export function cetakLabelBarang(
  daftar: {
    nama_barang: string;
    kode_barang: string;
    qr: string;
    jumlah: number;
  }[],
  namaPerusahaan: string | null,
): void {
  const label = daftar.flatMap((item) =>
    Array.from(
      { length: item.jumlah },
      () => `
      <div class="label">
        <img src="${esc(item.qr)}" alt="">
        <div class="teks">
          <div class="nama">${esc(item.nama_barang)}</div>
          <div class="kode">${esc(item.kode_barang)}</div>
          ${namaPerusahaan ? `<div class="pemilik">${esc(namaPerusahaan)}</div>` : ""}
        </div>
      </div>`,
    ),
  );
  const lembar: string[] = [];
  for (let i = 0; i < label.length; i += LABEL_PER_LEMBAR) {
    lembar.push(
      `<div class="lembar">${label.slice(i, i + LABEL_PER_LEMBAR).join("")}</div>`,
    );
  }
  document.getElementById(ROOT_ID)?.remove();
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `<style>${GAYA_LABEL}</style>${lembar.join("")}`;
  document.body.appendChild(root);
  setTimeout(() => {
    window.focus();
    window.print();
    setTimeout(() => root.remove(), 3000);
  }, 300);
}
