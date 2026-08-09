import { db, ensureDbInitialized } from "@/lib/db";

export interface OperatorInput {
  kode_operator: string;
  nama_operator: string;
  username: string;
  password_hash: string;
  role: "Admin" | "Operator" | "Scanner";
  status?: "Aktif" | "Nonaktif";
}

const CACHED_OPERATORS_KEY = "absensi_sppg_cached_operators";

// Default admin seed operator for offline fallback guarantee
const DEFAULT_OFFLINE_ADMIN = {
  id: 1,
  kode_operator: "OP001",
  nama_operator: "Admin Utama",
  username: "admin",
  password_hash: "admin123",
  role: "Admin",
  status: "Aktif",
};

export async function getDaftarOperator() {
  await ensureDbInitialized();

  try {
    const res = await db.execute(
      "SELECT id, kode_operator, nama_operator, username, role, status FROM master_operator ORDER BY id ASC;",
    );
    return res.rows as unknown as Record<string, unknown>[];
  } catch (err) {
    console.warn(
      "Gagal mengambil daftar operator dari cloud/db, menggunakan cache lokal:",
      err,
    );
    return [DEFAULT_OFFLINE_ADMIN];
  }
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

export async function updateOperator(id: number, data: Partial<OperatorInput>) {
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

  // 1. Coba verifikasi via Database (Turso / SQLite)
  try {
    const res = await db.execute({
      sql: "SELECT * FROM master_operator WHERE (username = ? OR kode_operator = ?) AND status = 'Aktif' LIMIT 1;",
      args: [username, username],
    });

    if (res.rows && res.rows.length > 0) {
      const op = res.rows[0] as Record<string, unknown>;
      const storedPass = String(op.password_hash || "");

      if (storedPass === passwordPlain) {
        const sessionOp = {
          id: Number(op.id),
          kode_operator: String(op.kode_operator),
          nama_operator: String(op.nama_operator),
          username: String(op.username),
          role: String(op.role),
          password_hash: storedPass,
        };

        // Cache operator data ke LocalStorage untuk fallback offline mendatang
        saveOperatorToLocalCache(sessionOp);

        return {
          sukses: true,
          pesan: "Login berhasil (Turso Cloud).",
          operator: sessionOp,
        };
      }
      return {
        sukses: false,
        pesan: "Login gagal: Password / PIN salah.",
      };
    }
  } catch (dbError) {
    console.warn(
      "Koneksi cloud/database tidak dapat dijangkau (Mode Offline):",
      dbError,
    );
  }

  // 2. Fallback Mode Offline (LocalStorage & Default Admin) jika database tidak dapat dijangkau
  const offlineMatch = checkOfflineOperatorCache(username, passwordPlain);
  if (offlineMatch) {
    return {
      sukses: true,
      pesan: "Login berhasil (Mode Offline).",
      operator: offlineMatch,
    };
  }

  return {
    sukses: false,
    pesan: "Login gagal: Username atau Password tidak sesuai.",
  };
}

// Save operator to browser local cache for offline mode
function saveOperatorToLocalCache(op: {
  id: number;
  kode_operator: string;
  nama_operator: string;
  username: string;
  role: string;
  password_hash: string;
}) {
  if (typeof window === "undefined") return;
  try {
    const existing = localStorage.getItem(CACHED_OPERATORS_KEY);
    let list: Record<string, unknown>[] = existing ? JSON.parse(existing) : [];
    list = list.filter((item) => item.username !== op.username);
    list.push(op);
    localStorage.setItem(CACHED_OPERATORS_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn("Gagal menyimpan cache operator lokal:", err);
  }
}

// Check offline cache or default admin
function checkOfflineOperatorCache(username: string, passwordPlain: string) {
  // Check default admin seed
  if (
    (username === DEFAULT_OFFLINE_ADMIN.username ||
      username === DEFAULT_OFFLINE_ADMIN.kode_operator) &&
    passwordPlain === DEFAULT_OFFLINE_ADMIN.password_hash
  ) {
    return {
      id: DEFAULT_OFFLINE_ADMIN.id,
      kode_operator: DEFAULT_OFFLINE_ADMIN.kode_operator,
      nama_operator: DEFAULT_OFFLINE_ADMIN.nama_operator,
      username: DEFAULT_OFFLINE_ADMIN.username,
      role: DEFAULT_OFFLINE_ADMIN.role,
    };
  }

  // Check cached list in LocalStorage
  if (typeof window !== "undefined") {
    try {
      const existing = localStorage.getItem(CACHED_OPERATORS_KEY);
      if (existing) {
        const list = JSON.parse(existing) as Record<string, string>[];
        const found = list.find(
          (item) =>
            (item.username === username || item.kode_operator === username) &&
            item.password_hash === passwordPlain,
        );
        if (found) {
          return {
            id: Number(found.id || 1),
            kode_operator: found.kode_operator,
            nama_operator: found.nama_operator,
            username: found.username,
            role: found.role,
          };
        }
      }
    } catch (err) {
      console.warn("Gagal membaca cache operator lokal:", err);
    }
  }

  return null;
}
