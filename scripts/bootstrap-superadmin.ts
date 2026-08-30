import { createClient } from "@libsql/client";
import { initDatabaseSchema } from "../src/lib/db-schema";
import { bootstrapSuperadmin } from "../src/lib/operators/operator-admin";
import { resolveServerDatabaseConfig } from "../src/lib/server/database-config";

const name = process.env.SPPG_SUPERADMIN_NAME?.trim();
const username = process.env.SPPG_SUPERADMIN_USERNAME?.trim();
const password = process.env.SPPG_SUPERADMIN_PASSWORD;
const email = process.env.SPPG_SUPERADMIN_EMAIL?.trim();
const noHp = process.env.SPPG_SUPERADMIN_PHONE?.trim();

if (!name || !username || !password || !email || !noHp) {
  throw new Error(
    "Lengkapi SPPG_SUPERADMIN_NAME, SPPG_SUPERADMIN_USERNAME, SPPG_SUPERADMIN_PASSWORD, " +
      "SPPG_SUPERADMIN_EMAIL, dan SPPG_SUPERADMIN_PHONE sebelum menjalankan bootstrap.",
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
} finally {
  client.close();
}
