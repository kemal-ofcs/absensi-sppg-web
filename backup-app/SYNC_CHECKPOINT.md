# Checkpoint Sinkronisasi Template

Checkpoint ini menjelaskan kontrak sinkronisasi yang harus dipertahankan ketika
`backup-app` dipakai sebagai dasar produk baru.

## Jalur data

- Web menggunakan database Turso sebagai source of truth.
- Desktop selalu menulis ke SQLite lokal terlebih dahulu.
- Setiap mutasi Desktop menaikkan `version` dan HLC, memperbarui `updated_at`,
  lalu mengubah `sync_status` menjadi `pending` dalam transaksi yang sama.
- Embedded server Desktop mengirim baris `pending`/`error`, kemudian menarik
  delta cloud dengan cursor komposit `(updated_at, id)` per tabel.
- Soft delete memakai `deleted_at`; jangan menghapus tombstone sebelum seluruh
  device melewati masa retensi yang ditetapkan produk.

## Jaminan kegagalan

- Record push yang gagal ditandai `error` dan dicoba ulang pada sync berikutnya.
- Kegagalan satu record membuat status run `error`, bukan keberhasilan palsu.
- Record pull yang gagal menghentikan tabel sebelum cursor maju. Setelah data
  cloud diperbaiki, record yang sama akan dibaca ulang dan data setelahnya tidak
  hilang.
- Konflik versi/HLC dicatat ke `sync_conflicts` sebelum pemenang diterapkan.
- Panel Desktop menampilkan antrean `pending` dan `failed` per tabel terdaftar.

## Menambah tabel produk

Sebuah tabel belum dianggap tersinkron hanya karena sudah ada di schema.
Lakukan seluruh langkah berikut:

1. Tambahkan kolom `id`, `version`, `hlc`, `created_at`, `updated_at`,
   `deleted_at`, dan `sync_status` pada schema serta migration.
2. Tambahkan index `(sync_status, updated_at, id)`.
3. Daftarkan kolom dan schema Zod yang ketat di
   `src/lib/sync/registry.ts`.
4. Gunakan helper mutasi di `src/lib/sync/mutation.ts`; jangan mengubah record
   lokal tanpa menaikkan metadata sinkronisasi.
5. Gunakan ID stabil lintas device. Untuk data ber-unique key, tentukan aturan
   rekonsiliasi identitas domain sebelum mengizinkan create offline bersamaan.
6. Tambahkan tes push, pull, tombstone, konflik, retry, dan dua record dengan
   `updated_at` sama.
7. Pastikan panel status menampilkan tabel tersebut sebelum rilis.

## Batas keamanan

Mode bawaan template adalah direct Turso untuk perangkat organisasi yang
dipercaya. Token berada di OS keyring dan tidak pernah dikirim ke WebView atau
variabel `NEXT_PUBLIC_*`, tetapi administrator lokal tetap dapat menguasai
perangkat.

Untuk SaaS publik, perangkat pelanggan yang tidak dipercaya, atau multi-tenant,
jangan memakai direct Turso. Ganti transport dengan hosted sync gateway yang
memvalidasi device, tenant, izin, schema payload, dan idempotency key. Token
database hanya boleh berada di gateway. Penyimpanan token di keyring tidak
mengubah batas kepercayaan tersebut.

## Verifikasi minimum

1. Tambah atau ubah satu record pada Desktop saat offline.
2. Pastikan status tabel menjadi `pending`.
3. Jalankan full sync setelah online dan pastikan `pending = 0`, `failed = 0`.
4. Pastikan record muncul di Web.
5. Ubah record yang sama di Web, sync kembali, dan pastikan SQLite menerima
   versi terbaru.
6. Uji tombstone, konflik, serta retry tanpa menghapus database lokal atau
   mereset cursor.

