"use client";

import Link from "next/link";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  DATABASE_NOT_CONFIGURED_DESCRIPTION,
  DATABASE_NOT_CONFIGURED_TITLE,
  DatabaseNotConfiguredNotice,
} from "@/components/DatabaseNotConfiguredNotice";
import { LicenseBootstrapField } from "@/components/license/LicenseBootstrapField";
import {
  createWebSuperadmin,
  getWebProvisioningStatus,
  type WebProvisioningStatus,
} from "@/lib/gateways/bootstrap";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";

/**
 * Provisioning Superadmin pertama untuk pemasangan Web.
 *
 * Halaman ini terbuka tanpa login, dan itu aman hanya karena server menuntut
 * token pemasangan (`KOS_SETUP_TOKEN`) pada setiap percobaan. Halaman ini tidak
 * memutuskan apa pun: status "boleh dibuat atau tidak" datang dari server, dan
 * server pula yang menolak setelah akun pertama ada.
 */

type View =
  | { kind: "loading" }
  /** Aplikasi Desktop/Mobile: provisioning-nya ada di layar masuk. */
  | { kind: "not-web" }
  /** Alamat database belum diisi di environment server. Tidak pulih sendiri. */
  | { kind: "not-configured"; issue: string | null }
  /** Endpoint status atau database tidak menjawab. */
  | { kind: "unreachable" }
  | { kind: "ready"; status: WebProvisioningStatus };

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400";
const INPUT_CLASS = `bootstrap-form-input min-h-11 min-w-0 rounded-xl border border-white/15 bg-slate-950 px-3 text-sm text-white ${FOCUS_RING}`;
const LABEL_CLASS =
  "bootstrap-form-label grid min-w-0 gap-1.5 text-xs font-bold text-slate-300";
const SECONDARY_BUTTON_CLASS = `bootstrap-btn-cancel inline-flex min-h-11 items-center justify-center rounded-2xl border border-white/15 px-4 text-xs font-bold text-slate-300 hover:border-sky-400/40 hover:text-sky-200 ${FOCUS_RING}`;

function Shell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="bootstrap-panel-root grid min-h-dvh place-items-center bg-slate-950 p-4 text-slate-100 sm:p-6">
      <section className="bootstrap-panel-card w-full max-w-lg rounded-3xl border border-sky-400/20 bg-slate-900/95 p-6 shadow-2xl sm:p-8">
        <h1 className="bootstrap-panel-title text-2xl font-black text-white">
          {title}
        </h1>
        <p className="bootstrap-panel-desc mt-2 text-sm leading-6 text-slate-400">
          {description}
        </p>
        {children}
      </section>
    </main>
  );
}

export default function SetupPage() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [setupToken, setSetupToken] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [noHp, setNoHp] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [license, setLicense] = useState("");
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  /**
   * Kode pemulihan ditahan di layar sampai pengguna menyatakan sudah
   * menyimpannya. Server hanya memegang hash-nya, jadi tidak ada kesempatan
   * kedua untuk membacanya.
   */
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const loadStatus = useCallback(async () => {
    if (isDesktopRuntime()) {
      setView({ kind: "not-web" });
      return;
    }
    setView({ kind: "loading" });
    const status = await getWebProvisioningStatus();
    if (status && !status.databaseConfigured) {
      setView({ kind: "not-configured", issue: status.databaseIssue });
      return;
    }
    setView(
      status === null || status.hasOperator === null
        ? { kind: "unreachable" }
        : { kind: "ready", status },
    );
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    if (password !== confirmation) {
      setFeedback("Ulangi password dengan isi yang sama persis.");
      return;
    }
    isSubmittingRef.current = true;
    setSubmitting(true);
    setFeedback("");
    try {
      const codes = await createWebSuperadmin({
        setupToken,
        namaOperator: name,
        username,
        email,
        noHp,
        password,
        license: license.trim() || undefined,
      });
      setSetupToken("");
      setPassword("");
      setConfirmation("");
      setRecoveryCodes(codes);
    } catch (error: unknown) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "Akun Superadmin belum berhasil dibuat. Coba lagi.",
      );
    } finally {
      isSubmittingRef.current = false;
      setSubmitting(false);
    }
  };

  // Layar kode pemulihan MENGGANTIKAN formulir: ini satu-satunya kesempatan
  // membaca kodenya, jadi tidak ada tombol lain yang mengajak melewatinya.
  if (recoveryCodes) {
    return (
      <main className="bootstrap-panel-root grid min-h-dvh place-items-center bg-slate-950 p-4 text-slate-100 sm:p-6">
        <section className="bootstrap-panel-card w-full max-w-lg rounded-3xl border border-amber-400/30 bg-slate-900/95 p-6 shadow-2xl sm:p-8">
          <h1 className="bootstrap-recovery-title text-2xl font-black text-white">
            Akun dibuat. Simpan kode pemulihannya sekarang
          </h1>
          <p className="bootstrap-recovery-desc mt-2 text-sm leading-6 text-slate-400">
            Tidak ada akun lain yang bisa menyetujui pemulihan Superadmin. Kalau
            passwordnya terlupa, kode di bawah adalah satu-satunya jalan masuk
            pada pemasangan yang tidak bisa mengirim email.
          </p>

          {recoveryCodes.length > 0 ? (
            <ul className="mt-5 grid grid-cols-2 gap-2">
              {recoveryCodes.map((code) => (
                <li
                  key={code}
                  className="bootstrap-recovery-code select-all rounded-xl border border-amber-400/25 bg-amber-400/10 px-3 py-2.5 text-center font-mono text-sm font-black tracking-wider text-amber-100"
                >
                  {code}
                </li>
              ))}
            </ul>
          ) : (
            <p className="bootstrap-recovery-warning mt-5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs leading-5 text-rose-200">
              Server tidak mengembalikan kode pemulihan. Setelah masuk,
              terbitkan kode baru dari Pengaturan, bagian Kode Pemulihan.
            </p>
          )}

          <p className="bootstrap-recovery-warning mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs leading-5 text-rose-200">
            Server hanya menyimpan sidik kode ini, jadi kodenya tidak bisa
            ditampilkan ulang. Setiap kode berlaku sekali. Simpan di tempat yang
            terpisah dari server, misalnya brankas atau lemari arsip terkunci.
          </p>
          <p className="bootstrap-recovery-desc mt-3 text-xs leading-5 text-slate-400">
            Hapus <code className="font-mono font-bold">KOS_SETUP_TOKEN</code>{" "}
            dari berkas .env server setelah ini. Server sudah menolak pembuatan
            Superadmin kedua, dan token yang tidak dipakai lebih aman tidak
            disimpan.
          </p>

          <Link
            href="/login"
            className={`bootstrap-recovery-submit mt-5 flex min-h-11 w-full items-center justify-center rounded-xl bg-amber-400 px-4 text-center text-xs font-black text-slate-950 transition hover:bg-amber-300 ${FOCUS_RING}`}
          >
            Kode sudah saya simpan, buka halaman masuk
          </Link>
        </section>
      </main>
    );
  }

  if (view.kind === "loading") {
    return (
      <Shell
        title="Memeriksa server"
        description="Membaca apakah database ini sudah punya akun."
      >
        <p
          aria-live="polite"
          className="bootstrap-hint-box mt-5 rounded-2xl border border-white/10 bg-slate-950/60 p-4 text-xs leading-5 text-slate-400"
        >
          Menunggu jawaban server...
        </p>
      </Shell>
    );
  }

  if (view.kind === "not-web") {
    return (
      <Shell
        title="Halaman ini untuk versi Web"
        description="Di aplikasi Desktop dan Mobile, pembuatan Superadmin pertama muncul sendiri di layar masuk saat database belum punya akun."
      >
        <Link href="/login" className={`${SECONDARY_BUTTON_CLASS} mt-5 w-full`}>
          Buka halaman masuk
        </Link>
      </Shell>
    );
  }

  if (view.kind === "not-configured") {
    return (
      <Shell
        title={DATABASE_NOT_CONFIGURED_TITLE}
        description={DATABASE_NOT_CONFIGURED_DESCRIPTION}
      >
        <div className="mt-5">
          <DatabaseNotConfiguredNotice
            issue={view.issue}
            onRetry={() => void loadStatus()}
            checking={false}
          />
        </div>
      </Shell>
    );
  }

  if (view.kind === "unreachable") {
    return (
      <Shell
        title="Database tidak menjawab"
        description="Server belum bisa membaca database, jadi belum diketahui apakah akun pertama sudah ada. Provisioning ditahan supaya database yang sudah berisi tidak diprovisioning ulang."
      >
        <p className="bootstrap-hint-box mt-5 rounded-2xl border border-white/10 bg-slate-950/60 p-4 text-xs leading-5 text-slate-400">
          Periksa alamat dan token database di berkas .env server, pastikan
          server database menyala, lalu periksa lagi.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => void loadStatus()}
            className={`bootstrap-btn-submit min-h-11 rounded-2xl bg-sky-400 px-4 text-sm font-black text-slate-950 ${FOCUS_RING}`}
          >
            Periksa lagi
          </button>
          <Link href="/login" className={SECONDARY_BUTTON_CLASS}>
            Buka halaman masuk
          </Link>
        </div>
      </Shell>
    );
  }

  if (view.status.hasOperator) {
    return (
      <Shell
        title="Server ini sudah punya akun"
        description="Superadmin pertama hanya bisa dibuat sekali. Masuk dengan akun yang sudah ada. Akun berikutnya dibuat dari menu Master Operator."
      >
        <Link
          href="/login"
          className={`bootstrap-btn-submit mt-5 flex min-h-11 w-full items-center justify-center rounded-2xl bg-sky-400 px-4 text-sm font-black text-slate-950 ${FOCUS_RING}`}
        >
          Buka halaman masuk
        </Link>
      </Shell>
    );
  }

  if (!view.status.setupEnabled) {
    return (
      <Shell
        title="Provisioning lewat browser belum dibuka"
        description="Database ini belum punya akun, tetapi server belum memasang token pemasangan. Tanpa token itu, siapa pun yang membuka alamat ini lebih dulu bisa mengambil alih sistem, jadi server menutup pintunya."
      >
        <ol className="bootstrap-hint-box mt-5 grid list-decimal gap-2 rounded-2xl border border-white/10 bg-slate-950/60 py-4 pl-8 pr-4 text-xs leading-5 text-slate-400">
          <li>Buka berkas .env di server.</li>
          <li>
            Tambahkan baris{" "}
            <code className="break-all font-mono font-bold">
              KOS_SETUP_TOKEN=
            </code>{" "}
            diikuti minimal 32 karakter acak.
          </li>
          <li>Jalankan ulang server, lalu periksa lagi di halaman ini.</li>
        </ol>
        <p className="bootstrap-panel-desc mt-4 text-xs leading-5 text-slate-400">
          Punya aplikasi Desktop? Sambungkan ke database yang sama. Layar
          provisioning muncul sendiri di sana, dan akun yang dibuat langsung
          bisa dipakai di sini.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => void loadStatus()}
            className={`bootstrap-btn-submit min-h-11 rounded-2xl bg-sky-400 px-4 text-sm font-black text-slate-950 ${FOCUS_RING}`}
          >
            Periksa lagi
          </button>
          <Link href="/login" className={SECONDARY_BUTTON_CLASS}>
            Buka halaman masuk
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      title="Buat Superadmin pertama"
      description="Database ini belum punya akun. Akun yang dibuat di sini memegang seluruh sistem dan hanya bisa dibuat sekali."
    >
      {feedback ? (
        <div
          role="alert"
          className="bootstrap-alert-error mt-4 rounded-xl border border-rose-500/30 bg-rose-950/50 p-3 text-xs leading-5 text-rose-200"
        >
          {feedback}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-5 grid gap-4">
        <label className={LABEL_CLASS}>
          Token pemasangan
          <input
            required
            type="password"
            maxLength={512}
            value={setupToken}
            onChange={(event) => setSetupToken(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className={`${INPUT_CLASS} font-mono`}
          />
          <span className="font-normal leading-5 text-slate-400">
            Nilai KOS_SETUP_TOKEN di berkas .env server. Hanya orang yang
            memasang server yang mengetahuinya.
          </span>
        </label>

        <label className={LABEL_CLASS}>
          Nama lengkap
          <input
            required
            minLength={3}
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
            className={INPUT_CLASS}
          />
        </label>
        <label className={LABEL_CLASS}>
          Username
          <input
            required
            minLength={3}
            maxLength={64}
            pattern="[A-Za-z0-9._\-]+"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            className={INPUT_CLASS}
          />
          <span className="font-normal leading-5 text-slate-400">
            Huruf, angka, titik, garis bawah, atau tanda minus.
          </span>
        </label>

        {/* Kontak wajib: akun ini tidak punya atasan yang bisa memulihkannya,
            dan alur Lupa Password mencari akun lewat email atau nomor HP. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={LABEL_CLASS}>
            Email
            <input
              required
              type="email"
              maxLength={120}
              placeholder="nama@perusahaan.co.id"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              className={INPUT_CLASS}
            />
          </label>
          <label className={LABEL_CLASS}>
            Nomor HP
            <input
              required
              type="tel"
              inputMode="tel"
              maxLength={20}
              placeholder="08xxxxxxxxxx"
              value={noHp}
              onChange={(event) => setNoHp(event.target.value)}
              autoComplete="tel"
              className={INPUT_CLASS}
            />
          </label>
        </div>

        {/* Hanya tampil pada build yang menegakkan lisensi; server menolak
            membuat Superadmin sebelum lisensinya sah untuk server ini. */}
        <LicenseBootstrapField value={license} onChange={setLicense} />

        <label className={LABEL_CLASS}>
          Password
          <input
            required
            minLength={12}
            maxLength={128}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            className={INPUT_CLASS}
          />
          <span className="font-normal leading-5 text-slate-400">
            Minimal 12 karakter, memuat huruf besar, huruf kecil, angka, dan
            simbol, serta tidak memuat username.
          </span>
        </label>
        <label className={LABEL_CLASS}>
          Ulangi password
          <input
            required
            minLength={12}
            maxLength={128}
            type="password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="new-password"
            className={INPUT_CLASS}
          />
        </label>

        <button
          type="submit"
          disabled={submitting}
          className={`bootstrap-btn-submit min-h-12 rounded-2xl bg-sky-400 px-4 text-sm font-black text-slate-950 disabled:opacity-50 ${FOCUS_RING}`}
        >
          {submitting ? "Membuat akun..." : "Buat Superadmin"}
        </button>
      </form>
    </Shell>
  );
}
