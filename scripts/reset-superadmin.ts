import * as readline from "node:readline";
import { createClient } from "@libsql/client";
import {
  hashPassword,
  validatePasswordStrength,
} from "../src/lib/auth/password";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main() {
  console.log("\n========================================================");
  console.log("      ABSENSI SPPG — MANAJEMEN AKUN SUPERADMIN CLOUD    ");
  console.log("========================================================\n");

  let dbUrl = process.env.TURSO_DATABASE_URL?.trim();
  let authToken = process.env.TURSO_AUTH_TOKEN?.trim();

  if (!dbUrl) {
    dbUrl = await ask(
      "Masukkan URL Database Turso (contoh: libsql://db-name.turso.io): ",
    );
  }

  if (!dbUrl) {
    console.error("Error: URL Database Turso wajib diisi.");
    rl.close();
    process.exit(1);
  }

  if (!authToken && !dbUrl.startsWith("file:")) {
    authToken = await ask("Masukkan Auth Token Database Turso: ");
  }

  const client = createClient({
    url: dbUrl,
    authToken: authToken || undefined,
  });

  try {
    console.log("\nMenghubungkan ke database cloud Turso...");
    const operators = await client.execute(
      `SELECT m.id, m.kode_operator, m.nama_operator, m.username, m.role, m.status, 
              COALESCE(r.is_superadmin, 0) as is_superadmin
       FROM master_operator m
       LEFT JOIN app_role r ON m.role_id = r.id;`,
    );

    console.log("\nDaftar Akun Operator yang Terdaftar:");
    console.table(
      operators.rows.map((row) => ({
        ID: row.id,
        Kode: row.kode_operator,
        Nama: row.nama_operator,
        Username: row.username,
        Role: row.role,
        Superadmin: Number(row.is_superadmin) === 1 ? "Ya" : "Bukan",
        Status: row.status,
      })),
    );

    console.log("\nPilih tindakan:");
    console.log("1. Reset Password Akun (Ganti password langsung)");
    console.log(
      "2. Hapus Akun Superadmin (Buka kembali wizard Aktivasi Superadmin di aplikasi)",
    );
    console.log(
      "3. Buka Kunci Login / Reset Rate Limit (Hapus blokir 5x salah password)",
    );
    console.log("4. Keluar");

    const choice = await ask("\nMasukkan pilihan (1/2/3/4): ");

    if (choice === "1") {
      const username = await ask(
        "Masukkan Username akun yang ingin di-reset: ",
      );
      const newPassword = await ask(
        "Masukkan Password baru (min. 12 karakter): ",
      );

      const strengthError = validatePasswordStrength(newPassword);
      if (strengthError) {
        console.error(`\nError: ${strengthError}`);
        return;
      }

      const passwordHash = await hashPassword(newPassword);
      const updateResult = await client.execute({
        sql: "UPDATE master_operator SET password_hash = ?, status = 'Aktif' WHERE username = ?;",
        args: [passwordHash, username],
      });

      if (updateResult.rowsAffected === 0) {
        console.error(`\nAkun dengan username '${username}' tidak ditemukan.`);
      } else {
        await client.execute("DELETE FROM auth_login_rate_limit;");
        console.log(
          `\nSukses: Password untuk user '${username}' berhasil diubah dan rate limit dibersihkan.`,
        );
        console.log(
          "Silakan login kembali di aplikasi menggunakan password baru.",
        );
      }
    } else if (choice === "2") {
      const username = await ask(
        "Masukkan Username Superadmin yang ingin dihapus: ",
      );
      const confirm = await ask(
        `Yakin ingin menghapus Superadmin '${username}'? (y/n): `,
      );

      if (confirm.toLowerCase() === "y") {
        const deleteResult = await client.execute({
          sql: "DELETE FROM master_operator WHERE username = ?;",
          args: [username],
        });

        if (deleteResult.rowsAffected === 0) {
          console.error(`\nAkun '${username}' tidak ditemukan.`);
        } else {
          await client.execute("DELETE FROM auth_login_rate_limit;");
          console.log(`\nSukses: Akun '${username}' berhasil dihapus.`);
          console.log(
            "Saat membuka aplikasi Desktop/Mobile, sistem akan otomatis menampilkan layar 'Aktivasi Superadmin Baru'.",
          );
        }
      } else {
        console.log("\nPenghapusan dibatalkan.");
      }
    } else if (choice === "3") {
      await client.execute("DELETE FROM auth_login_rate_limit;");
      console.log(
        "\nSukses: Seluruh rate limit login berhasil dibersihkan. Anda dapat mencoba login kembali.",
      );
    } else {
      console.log("\nKeluar.");
    }
  } catch (error) {
    console.error("\nTerjadi kesalahan koneksi atau eksekusi database:", error);
  } finally {
    client.close();
    rl.close();
  }
}

main();
