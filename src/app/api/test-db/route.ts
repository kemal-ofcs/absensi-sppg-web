// File ini tidak diperlukan karena aplikasi menggunakan mode Next.js output: export (Tauri Desktop App).
// Seluruh query database SQLite dipanggil langsung melalui modul client-side service (src/lib/test-db.ts).
export const dynamic = "force-static";
export function GET() {
  return new Response("Static export mode");
}
