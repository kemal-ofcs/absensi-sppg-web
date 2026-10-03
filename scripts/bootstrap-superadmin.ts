import { createClient } from "@libsql/client";
import { initDatabaseSchema } from "../src/lib/db-schema";
import { bootstrapSuperadmin } from "../src/lib/operators/operator-admin";
import { resolveServerDatabaseConfig } from "../src/lib/server/database-config";

// Nama lama `SPPG_SUPERADMIN_*` tetap dibaca supaya `.env` yang sudah ada tidak
// perlu disunting; nama `KOS_*` yang menang bila keduanya diisi.
const env = (key: string) =>
  process.env[`KOS_SUPERADMIN_${key}`] ?? process.env[`SPPG_SUPERADMIN_${key}`];

const name = env("NAME")?.trim();
const username = env("USERNAME")?.trim();
const password = env("PASSWORD");
const email = env("EMAIL")?.trim();
const noHp = env("PHONE")?.trim();

if (!name || !username || !password || !email || !noHp) {
  throw new Error(
    "Lengkapi KOS_SUPERADMIN_NAME, KOS_SUPERADMIN_USERNAME, KOS_SUPERADMIN_PASSWORD, " +
      "KOS_SUPERADMIN_EMAIL, dan KOS_SUPERADMIN_PHONE sebelum menjalankan bootstrap.",
  );
}

const config = resolveServerDatabaseConfig(process.env);
const client = createClient(config);
try {
  await initDatabaseSchema(client);
  const result = await bootstrapSuperadmin(client, {
    kodeOperator: "SPD001",
    name,
    username,
    email,
    noHp,
    password,
    status: "Aktif",
  });
  console.log(`Superadmin SPD001 berhasil dibuat dengan ID ${result.id}.`);
  // Database hanya memegang hash-nya: inilah satu-satunya saat kode ini terbaca.
  console.log(
    "\nKode pemulihan password (simpan sekarang, tidak dapat ditampilkan ulang):",
  );
  for (const code of result.recoveryCodes) console.log(`  ${code}`);
} finally {
  client.close();
}
