# Panduan Deployment per Pelanggan

Setiap pembeli memakai satu lingkungan yang terisolasi:

```text
Pelanggan A -> Vercel A -> Turso A -> Installer Desktop A
Pelanggan B -> Vercel B -> Turso B -> Installer Desktop B
```

Jangan memakai satu token, database, atau installer Desktop untuk beberapa pelanggan. Model ini memisahkan biaya server, data, session, RBAC, audit, serta risiko antar pelanggan.

## 1. Siapkan Turso pelanggan

- Buat database baru khusus pelanggan.
- Buat token server baru khusus deployment tersebut.
- Simpan URL dan token di password manager/secret manager operasional.
- Jangan menaruh token pada source, file yang dikirim ke pelanggan, atau variable dengan prefix `NEXT_PUBLIC_`.

## 2. Siapkan Vercel pelanggan

Buat project Vercel terpisah dan isi environment server-only:

```text
TURSO_DATABASE_URL=libsql://database-pelanggan.turso.io
TURSO_AUTH_TOKEN=<token-server-pelanggan>
```

Deploy lalu verifikasi HTTPS, login Web, logout, session, dan halaman Master Operator. Domain preview boleh dipakai untuk pengujian, tetapi installer production sebaiknya memakai domain final pelanggan agar tidak perlu dibuild ulang ketika domain berubah.

## 3. Bootstrap Superadmin

Jalankan bootstrap `SPD001` satu kali dengan credential pelanggan melalui environment lokal yang aman. Setelah berhasil, login sebagai `SPD001`, buat role/operator melalui Master Operator, lalu hapus nilai password bootstrap dari shell atau file lokal yang tidak lagi diperlukan.

Bootstrap dan CRUD keamanan wajib online. Row ID internal database boleh bukan `1`; identifier bisnis yang dipakai tetap `SPD001`.

## 4. Tentukan kebijakan login offline

Pemilik produk/pelanggan harus menyetujui masa berlaku snapshot offline sebelum build. Nilai yang didukung adalah 1-720 jam. Semakin panjang waktunya, semakin lama operator yang telah dinonaktifkan di server mungkin masih dapat memakai snapshot lama pada perangkat yang terus offline.

## 5. Build installer khusus pelanggan

Set environment hanya pada proses build atau CI pelanggan:

```powershell
$env:SPPG_API_BASE_URL='https://domain-pelanggan.example'
$env:SPPG_OFFLINE_AUTH_MAX_AGE_HOURS='<jam-yang-disetujui>'
bun run tauri:build
```

Release build akan gagal jika origin tidak memakai HTTPS, berisi path/kredensial/query, atau masa offline tidak valid. Nilai domain bukan rahasia; token Turso tidak pernah diperlukan oleh Desktop.

## 6. Acceptance test pelanggan

- Web: login, logout, role tanpa akses ditolak, dan Superadmin dapat membuka Master Operator.
- Desktop online pertama: login berhasil dan pesan menyatakan akses offline diperbarui.
- Desktop offline setelah provisioning: login dengan username atau kode operator dan password yang sama berhasil.
- Desktop baru yang belum pernah login online: login offline ditolak.
- Password salah/rate limit saat server tersedia: tidak jatuh ke fallback offline.
- Mode offline: Master Operator dan perubahan role/permission ditolak.
- Installer pelanggan A tidak dapat memakai snapshot atau API pelanggan B.

Sinkronisasi data operasional Karyawan, Shift, Scanner/Absensi, dan Koreksi belum termasuk Fase B3. Uji antrean local-first serta retry dilakukan setelah B4 selesai.

## 7. Operasional dan biaya

Catat per pelanggan: project Vercel, database Turso, pemilik billing, domain final, tanggal rotasi token, kebijakan backup, masa login offline, versi installer, dan tanggal deployment. Rotasi token Turso hanya dilakukan pada Vercel pelanggan terkait; installer Desktop tidak perlu memuat token baru.
