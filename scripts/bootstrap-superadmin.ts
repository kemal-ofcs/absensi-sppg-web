import { bootstrapSuperadmin } from "../src/lib/services/operator";

const name = process.env.SPPG_SUPERADMIN_NAME?.trim();
const username = process.env.SPPG_SUPERADMIN_USERNAME?.trim();
const password = process.env.SPPG_SUPERADMIN_PASSWORD;

if (!name || !username || !password) {
  throw new Error(
    "Lengkapi SPPG_SUPERADMIN_NAME, SPPG_SUPERADMIN_USERNAME, dan SPPG_SUPERADMIN_PASSWORD sebelum menjalankan bootstrap.",
  );
}

const result = await bootstrapSuperadmin({
  kodeOperator: "SPD001",
  name,
  username,
  password,
  status: "Aktif",
});

console.log(`Superadmin SPD001 berhasil dibuat dengan ID ${result.id}.`);
