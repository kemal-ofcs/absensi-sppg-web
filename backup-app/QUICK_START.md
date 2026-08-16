# 🚀 Quick Start: Membuat Aplikasi Baru dari Template

Panduan cepat untuk menduplikasi template ini dan membuat aplikasi baru (misalnya **Aplikasi POS Kasir**, **Manajemen Inventori**, **Klinik**, dsb.) dengan arsitektur **Offline-First SQLite Lokal + Turso Cloud Sync**.

---

## 1. Salin Folder Template ke Proyek Baru

Buka terminal di root workspace Anda (misal `E:\Freelance\`), lalu salin folder `backup-app`:

```powershell
# Contoh membuat aplikasi POS baru
Copy-Item -Recurse -Exclude @("node_modules", "target", ".next", ".vercel", "*.db*") -Path "backup-app" -Destination "my-pos-app"

# Masuk ke folder aplikasi baru
cd my-pos-app
```

---

## 2. Sesuaikan Nama & Identitas Aplikasi (1 Menit)

Ubah identitas aplikasi pada file-file berikut:

### a. `package.json`
```json
{
  "name": "my-pos-app",
  "version": "0.1.0"
}
```

### b. `src-tauri/tauri.conf.json`
```json
{
  "productName": "My POS App",
  "identifier": "com.mypos.app"
}
```

### c. `src-tauri/Cargo.toml`
```toml
[package]
name = "my_pos_app"
```

### d. `.env` (Buat dari `.env.example`)
```powershell
cp .env.example .env
```
Isi konfigurasi Turso jika ingin menghubungkan sinkronisasi cloud:
```env
SYNC_DATABASE_URL="libsql://your-project.turso.io"
SYNC_DATABASE_AUTH_TOKEN="your-turso-token"
AUTH_SECRET="random-32-char-secret"
NEXT_PUBLIC_APP_NAME="My POS App"
```

---

## 3. Install Dependencies & Jalankan Aplikasi

```powershell
# Install seluruh dependency
bun install

# 🖥️ Jalankan Mode Desktop (Tauri v2 + SQLite Lokal)
bun run desktop

# 🌐 Atau Jalankan Mode Web Server (Next.js 16 + Cloud Turso)
bun run dev
```

> **Kredensial Default Login**:
> - Email / Username: `admin` / `admin@starter.local`
> - Password: `admin123`

---

## 4. Cara Menambah Tabel Baru dengan Sinkronisasi Otomatis

Untuk menambahkan entitas baru (misal `orders`, `transactions`, `customers`), ikuti **3 langkah mudah**:

### Langkah 1: Tambah Tabel di `src/core/db/schema.ts`
```typescript
export const orders = sqliteTable("orders", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  invoiceNumber: text("invoice_number").notNull().unique(),
  totalAmount: integer("total_amount").notNull().default(0),
  customerName: text("customer_name"),
  ...syncMetadata, // version, hlc, sync_status, created_at, updated_at, deleted_at
});
```

### Langkah 2: Tambahkan CREATE TABLE di `src/core/db/migrations.ts`
Tambahkan DDL query di `createIdentityTables` dan daftarkan ke loop `CREATE INDEX ${table}_sync_queue_idx`.

### Langkah 3: Daftarkan ke `src/lib/sync/registry.ts`
```typescript
const orderSchema = z.object({
  ...commonFields,
  invoice_number: z.string().min(1),
  total_amount: z.number().int().nonnegative(),
  customer_name: z.string().nullable(),
}).strict();

// Masukkan ke SYNC_TABLES
{
  name: "orders",
  columns: ["id", "invoice_number", "total_amount", "customer_name", "version", "hlc", "created_at", "updated_at", "deleted_at"],
  schema: orderSchema,
  sensitiveColumns: [],
}
```

Selesai! Tabel baru Anda kini otomatis:
- Ditulis ke SQLite lokal secara instan (offline).
- Menandai delta `sync_status = 'pending'`.
- Dikirim dan ditarik dari cloud Turso saat tombol **Sync Now** ditekan atau saat background sync berjalan.

---

## 5. Perintah Pengujian & Build Installer

```powershell
# Validasi Kode (Lint + Typecheck + Unit Test)
bun run check

# Build Installer Desktop Windows (MSI / NSIS)
bun run build:desktop
bun tauri build
```
