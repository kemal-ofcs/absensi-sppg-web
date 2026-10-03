import { type NextRequest, NextResponse } from "next/server";
import { resolveSetupToken } from "@/lib/server/auth/setup-token";
import { databaseConfigIssue } from "@/lib/server/database-config";
import { getServerDatabase } from "@/lib/server/db";
import { isSameOriginMutation } from "@/lib/server/http/request-security";

export const runtime = "nodejs";

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Apakah database ini sudah punya setidaknya satu akun operator?
 *
 * Dipakai halaman login Web supaya database yang masih kosong tidak menjadi
 * jalan buntu: form login tampil, tidak ada akun untuk dipakai, dan tidak ada
 * petunjuk apa pun harus berbuat apa. Orang yang melihatnya mengira aplikasinya
 * rusak.
 *
 * Endpoint ini BISA dipanggil tanpa login, jadi tiga batas berikut disengaja
 * dan wajib dipertahankan:
 *
 * 1. JAWABANNYA SATU BOOLEAN. Tidak ada jumlah akun, username, atau nama —
 *    pemanggil anonim tidak berhak mengetahui isi tabel operator.
 *
 * 2. HANYA MEMBACA. Ia tidak memanggil `ensureServerDatabaseInitialized` dan
 *    tidak menulis apa pun. Tabel yang belum ada berarti "belum ada akun",
 *    bukan alasan untuk menyiapkan skema dari permintaan tanpa sesi.
 *
 * 3. ENDPOINT INI SENDIRI TIDAK PERNAH MEMBUAT AKUN. Aplikasi Web terbuka ke
 *    jaringan: layar "buat Superadmin pertama" tanpa bukti apa pun berarti
 *    pengunjung pertama mengambil alih seluruh sistem. Pembuatan akun hanya
 *    ada di `POST /api/auth/bootstrap`, yang menuntut token pemasangan dari
 *    `.env` server. `setupEnabled` di bawah hanya memberi tahu halaman login
 *    apakah pintu itu dibuka di server ini, supaya ia menunjuk ke `/setup`
 *    dan bukan ke jalan yang tidak tersedia.
 */
export async function POST(request: NextRequest) {
  if (!isSameOriginMutation(request)) {
    return noStoreJson(
      { sukses: false, pesan: "Origin tidak diizinkan." },
      403,
    );
  }

  const setupEnabled = resolveSetupToken(process.env).state === "ready";

  // Diperiksa SEBELUM database disentuh. "Belum dikonfigurasi" tidak akan pulih
  // sendiri, jadi ia dilaporkan sebagai keadaannya sendiri, terpisah dari
  // `hasOperator: null` di bawah yang berarti "tidak terjangkau saat ini".
  const databaseIssue = databaseConfigIssue(process.env);
  if (databaseIssue !== null) {
    return noStoreJson({
      sukses: true,
      hasOperator: null,
      setupEnabled,
      databaseConfigured: false,
      databaseIssue,
    });
  }

  try {
    const result = await getServerDatabase().execute(
      "SELECT EXISTS(SELECT 1 FROM master_operator) AS ada;",
    );
    const ada = Number(result.rows[0]?.ada ?? 0) === 1;
    return noStoreJson({
      sukses: true,
      hasOperator: ada,
      setupEnabled,
      databaseConfigured: true,
      databaseIssue: null,
    });
  } catch (error) {
    // Dua kegagalan yang WAJIB dibedakan, karena jawabannya berlawanan:
    //
    // - Tabel `master_operator` belum ada: database yang benar-benar baru dan
    //   belum pernah diprovisioning. Itu jawaban yang sah — "belum ada akun" —
    //   jadi `false`, dan halaman login menunjukkan jalan provisioning.
    //
    // - Apa pun selain itu (jaringan putus, token Turso salah, database tak
    //   terjangkau): kita TIDAK TAHU isinya, jadi `null`. Menjawab `false` di
    //   sini akan menyuruh orang memprovisioning database yang sebenarnya sudah
    //   berisi, hanya karena koneksinya sedang bermasalah.
    const pesan = error instanceof Error ? error.message : String(error);
    const tabelBelumAda = /no such table/i.test(pesan);
    return noStoreJson({
      sukses: true,
      hasOperator: tabelBelumAda ? false : null,
      setupEnabled,
      databaseConfigured: true,
      databaseIssue: null,
    });
  }
}
