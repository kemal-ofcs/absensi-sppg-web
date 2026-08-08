import { db, ensureDbInitialized } from "@/lib/db";

export interface OperatorInput {
  kode_operator: string;
  nama_operator: string;
  username: string;
  password_hash: string;
  role: "Admin" | "Operator" | "Scanner";
  status?: "Aktif" | "Nonaktif";
}

export async function getDaftarOperator() {
  await ensureDbInitialized();

  const res = await db.execute(
    "SELECT id, kode_operator, nama_operator, username, role, status FROM master_operator ORDER BY id ASC;",
  );
  return res.rows as unknown as Record<string, unknown>[];
}

export async function tambahOperator(data: OperatorInput) {
  await ensureDbInitialized();

  const res = await db.execute({
    sql: `
      INSERT INTO master_operator (kode_operator, nama_operator, username, password_hash, role, status)
      VALUES (?, ?, ?, ?, ?, ?);
    `,
    args: [
      data.kode_operator,
      data.nama_operator,
      data.username,
      data.password_hash,
      data.role,
      data.status || "Aktif",
    ],
  });

  return { sukses: true, id: Number(res.lastInsertRowid) };
}

export async function updateOperator(
  id: number,
  data: Partial<OperatorInput>,
) {
  await ensureDbInitialized();

  const updates: string[] = [];
  const args: (string | number | boolean | null)[] = [];

  if (data.nama_operator !== undefined) {
    updates.push("nama_operator = ?");
    args.push(data.nama_operator);
  }
  if (data.username !== undefined) {
    updates.push("username = ?");
    args.push(data.username);
  }
  if (data.password_hash !== undefined) {
    updates.push("password_hash = ?");
    args.push(data.password_hash);
  }
  if (data.role !== undefined) {
    updates.push("role = ?");
    args.push(data.role);
  }
  if (data.status !== undefined) {
    updates.push("status = ?");
    args.push(data.status);
  }

  if (updates.length > 0) {
    args.push(id);
    await db.execute({
      sql: `UPDATE master_operator SET ${updates.join(", ")} WHERE id = ?;`,
      args,
    });
  }

  return { sukses: true };
}

export async function verifikasiLoginOperator(
  username: string,
  passwordPlain: string,
) {
  await ensureDbInitialized();

  const res = await db.execute({
    sql: "SELECT * FROM master_operator WHERE (username = ? OR kode_operator = ?) AND status = 'Aktif' LIMIT 1;",
    args: [username, username],
  });

  if (res.rows.length === 0) {
    return {
      sukses: false,
      pesan: "Login gagal: Username atau Kode Operator tidak ditemukan.",
    };
  }

  const op = res.rows[0] as Record<string, unknown>;
  const storedPass = String(op.password_hash || "");

  // Verifikasi kata sandi / PIN
  if (storedPass !== passwordPlain) {
    return {
      sukses: false,
      pesan: "Login gagal: Password / PIN salah.",
    };
  }

  return {
    sukses: true,
    pesan: "Login berhasil.",
    operator: {
      id: Number(op.id),
      kode_operator: String(op.kode_operator),
      nama_operator: String(op.nama_operator),
      username: String(op.username),
      role: String(op.role),
    },
  };
}
