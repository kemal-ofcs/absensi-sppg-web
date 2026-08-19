# Panduan Deployment & Distribusi Customer — Web & Desktop Absensi SPPG

Dokumen ini adalah panduan resmi penyiapan lingkungan server (*Web Cloud*) dan pembuatan installer (*Desktop Client*) khusus untuk **setiap customer/pembeli aplikasi**.

---

## 1. Prinsip Isolasi & Keamanan Data (Tenant Isolation)

Setiap customer/organisasi wajib memiliki lingkungan yang terisolasi 100%:

```text
┌────────────────────────┐      ┌────────────────────────┐
│  CUSTOMER A (PT ABC)   │      │  CUSTOMER B (CV XYZ)   │
├────────────────────────┤      ├────────────────────────┤
│ • Vercel: sppg-abc.app │      │ • Vercel: sppg-xyz.app │
│ • Turso DB: db-abc     │      │ • Turso DB: db-xyz     │
│ • Installer Desktop A  │      │ • Installer Desktop B  │
└────────────────────────┘      └────────────────────────┘
```

> [!CAUTION]
> **JANGAN PERNAH** menggabungkan token database, secret credentials, atau installer client antar customer yang berbeda. Pemisahan ini mencegah kebocoran data karyawan, audit log, sesi login offline, serta risiko operasional.

---

## 2. Persiapan Database Turso (Cloud LibSQL)

Setiap customer memerlukan satu database Turso mandiri.

### 2.1 Pembuatan Database via Turso CLI / Web Console

```powershell
# 1. Login ke akun Turso Anda
turso auth login

# 2. Buat database baru khusus customer (contoh: sppg-pt-abc)
turso db create sppg-pt-abc --location sin

# 3. Tampilkan URL database
turso db show sppg-pt-abc --url
# Contoh output: libsql://sppg-pt-abc-youruser.turso.io

# 4. Buat auth token permanen untuk server
turso db tokens create sppg-pt-abc
# Simpan token panjang ini dengan aman di password manager
```

---

## 3. Deployment Server Backend / Web Admin ke Vercel

Backend Next.js 16 bertindak sebagai server API pusat, Dashboard Web Superadmin/Admin, serta Master Data Management.

### 3.1 Konfigurasi Environment Variable di Vercel

Pada project dashboard Vercel customer baru, tambahkan Environment Variables (**HANYA SERVER-SIDE, tanpa prefix NEXT_PUBLIC_**):

| Nama Variable | Contoh Nilai | Keterangan |
| :--- | :--- | :--- |
| `TURSO_DATABASE_URL` | `libsql://sppg-pt-abc-youruser.turso.io` | URL database Turso customer |
| `TURSO_AUTH_TOKEN` | `eyJhbGciOi...` | Auth token server Turso |
| `NODE_ENV` | `production` | Mode produksi |

### 3.2 Deploy & Verifikasi Domain

1. Hubungkan repository ke project Vercel.
2. Build Settings: Root Directory `web-desktop`, Framework Preset: `Next.js`.
3. Deploy project dan pasang Custom Domain customer (contoh: `https://absensi.pt-abc.com` atau subdomain Vercel `https://sppg-pt-abc.vercel.app`).
4. Pastikan SSL/HTTPS aktif dengan sempurna.

---

## 4. Inisialisasi Database & Bootstrap Akun Superadmin Pertama

Setelah database dan server cloud siap, inisialisasi skema tabel dan buat akun **Superadmin Master** (`SPD001`) via CLI lokal developer.

### 4.1 Eksekusi Skrip Bootstrap

Buka terminal di folder `web-desktop/`:

```powershell
cd e:\Freelance\absensi-sppg-app\web-desktop

# 1. Set environment sementara di terminal
$env:TURSO_DATABASE_URL="libsql://sppg-pt-abc-youruser.turso.io"
$env:TURSO_AUTH_TOKEN="<token-turso-customer>"
$env:SPPG_SUPERADMIN_NAME="Superadmin PT ABC"
$env:SPPG_SUPERADMIN_USERNAME="superadmin"
$env:SPPG_SUPERADMIN_PASSWORD="PasswordKuatSuperadmin2026!"

# 2. Jalankan migrasi & bootstrap
bun run bootstrap:superadmin
```

Output sukses:
```text
✓ Schema database berhasil diinisialisasi (zero schema drift).
✓ Superadmin SPD001 berhasil dibuat dengan ID 1.
```

> [!IMPORTANT]
> Segera bersihkan environment variable password dari terminal PowerShell dengan menutup terminal atau menjalankan `$env:SPPG_SUPERADMIN_PASSWORD=""`.

---

## 5. Build Installer Desktop Client (Tauri v2 Windows)

Desktop client dirancang khusus untuk laptop/PC operasional kantor/front desk yang mendukung **mode offline-first** dan scanning barcode USB/Webcam.

### 5.1 Tentukan Kebijakan Offline Session

Diskusikan dengan customer mengenai masa berlaku login offline:
- Nilai rekomendasi: `720` jam (30 hari).
- Nilai yang didukung: `1` s/d `720` jam.

### 5.2 Jalankan Build Release Desktop

```powershell
cd e:\Freelance\absensi-sppg-app\web-desktop

# Set konfigurasi build terikat ke origin server customer
$env:SPPG_API_BASE_URL="https://absensi.pt-abc.com"
$env:SPPG_OFFLINE_AUTH_MAX_AGE_HOURS="720"

# Build static frontend & compile Tauri Rust binary
bun run tauri:build
```

Hasil file installer berada di:
`web-desktop/src-tauri/target/release/bundle/msi/Absensi SPPG_0.1.0_x64_en-US.msi`
atau
`web-desktop/src-tauri/target/release/bundle/nsis/Absensi SPPG_0.1.0_x64-setup.exe`

> [!NOTE]
> `SPPG_API_BASE_URL` wajib berupa URL HTTPS valid tanpa trailing slash. Token database `TURSO_AUTH_TOKEN` **TIDAK PERNAH** dimasukkan ke dalam build Desktop.

---

## 6. Acceptance Test & Checklist Serah Terima (Web & Desktop)

Lakukan pengujian berikut sebelum mengirimkan paket ke customer:

| No | Komponen | Pengujian | Target Hasil |
| :---: | :--- | :--- | :--- |
| 1 | **Web Admin** | Buka URL HTTPS di browser | Halaman login tampil bersih, aman (HTTPS hijau) |
| 2 | **Web Login** | Login dengan akun `superadmin` | Masuk ke Dashboard, cookie session HttpOnly terpasang |
| 3 | **Web Setup** | Buka menu *Pengaturan* | Upload Logo Instansi & Input Titik GPS Kantor berhasil tersimpan |
| 4 | **Web Shift** | Buka menu *Data Shift* | Buat Shift Pagi, Siang, dan Malam (lintas hari) |
| 5 | **Web Karyawan** | Buka menu *Data Karyawan* | Tambah karyawan baru & Generate Token QR |
| 6 | **Desktop Install** | Install `.msi` / `.exe` di PC pengujian | Aplikasi terinstall rapi dan terbuka tanpa error |
| 7 | **Desktop Online** | Login pertama kali saat terhubung internet | Berhasil login, snapshot offline ter-download ke SQLite lokal |
| 8 | **Desktop Offline** | Putuskan koneksi internet (Airplane mode), buka aplikasi & login | Berhasil login via Vault offline (AES-256-GCM + Argon2id) |
| 9 | **Desktop Scan** | Lakukan scan QR karyawan saat offline | Absensi tersimpan di SQLite lokal dan antrean Outbox bertambah |
| 10 | **Desktop Sync** | Hubungkan kembali internet | Data absensi offline otomatis tersinkron ke cloud server |

---

## 7. Paket Serah Terima ke Customer

Kirimkan file dan informasi berikut kepada customer:
1. **URL Web Portal**: `https://absensi.pt-abc.com`
2. **Kredensial Superadmin Awal**: Username & Password sementara (minta customer langsung mengganti password).
3. **File Installer Desktop**: `Absensi SPPG_0.1.0_x64-setup.exe`
4. **Buku Manual Panduan Operasional**: `PANDUAN_LENGKAP_APLIKASI_SPPG.md`
