"use client";

import Link from "next/link";
import { redirect, useRouter } from "next/navigation";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { BootstrapPanel } from "@/components/BootstrapPanel";
import {
  DATABASE_NOT_CONFIGURED_DESCRIPTION,
  DATABASE_NOT_CONFIGURED_TITLE,
  DatabaseNotConfiguredNotice,
} from "@/components/DatabaseNotConfiguredNotice";
import { LicenseActivationPanel } from "@/components/license/LicenseActivationPanel";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { Icon } from "@/components/ui/Icon";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { LoginSceneGate } from "@/components/visual/LoginSceneGate";
import { VisualProvider } from "@/components/visual/VisualProvider";
import { BRANDING } from "@/lib/constants/branding";
import { useAuth } from "@/lib/context/AuthContext";
import {
  type BootstrapStatus,
  getBootstrapStatus,
  getWebProvisioningStatus,
  type WebProvisioningStatus,
} from "@/lib/gateways/bootstrap";
import { isLicenseBlocking } from "@/lib/gateways/license";
import { useAppName } from "@/lib/hooks/useAppName";
import { useCompanyName } from "@/lib/hooks/useCompanyName";
import { useHydrated } from "@/lib/hooks/useHydrated";
import { useLicenseStatus } from "@/lib/hooks/useLicenseStatus";
import { useOnlineStatus } from "@/lib/hooks/useOnlineStatus";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import packageJson from "../../../package.json";

/** Hanya username yang diingat, dan hanya bila pengguna mencentangnya. */
const REMEMBER_USERNAME_KEY = "sppg_ingat_username";

/**
 * Hero navy di kiri (atas pada layar sempit) dan panel yang ikut tema.
 * Dipakai juga oleh layar lisensi dan "database belum diatur" supaya semua
 * pintu masuk tampil sama.
 */
function LoginFrame({
  appName,
  companyName,
  children,
}: {
  appName: string;
  companyName: string | null;
  children: React.ReactNode;
}) {
  const hasCompany =
    Boolean(companyName) && companyName !== BRANDING.defaultCompanyName;
  return (
    <main className="login-shell min-h-screen flex items-center justify-center p-4 sm:p-6 lg:p-10 font-sans">
      <div className="login-frame w-full max-w-5xl overflow-hidden rounded-3xl grid lg:grid-cols-[1.1fr_1fr]">
        <section className="login-hero overflow-hidden px-6 py-7 sm:px-10 lg:py-10 flex flex-col lg:min-h-[600px]">
          {/* Konstelasi 3D: hanya dimuat bila perangkat sanggup. */}
          <LoginSceneGate className="pointer-events-none absolute inset-0 -z-10 opacity-70" />
          <div className="flex items-center gap-3">
            <BrandLogo size={48} />
            {hasCompany ? (
              <p className="login-hero-name text-base sm:text-lg font-bold leading-tight">
                {companyName}
              </p>
            ) : null}
          </div>
          <div className="mt-8 lg:my-auto">
            <h1 className="login-hero-title text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight">
              {appName}
            </h1>
            <p className="login-hero-sub mt-2 lg:mt-4 text-sm sm:text-base lg:text-lg">
              Sistem Absensi & Manajemen Operator
            </p>
          </div>
        </section>
        <section className="login-panel flex flex-col px-6 py-7 sm:px-10 lg:py-10">
          {children}
        </section>
      </div>
    </main>
  );
}

export default function LoginPage() {
  const isHydrated = useHydrated();
  const isOnline = useOnlineStatus();
  const appName = useAppName();
  const companyName = useCompanyName();
  const { user, login, isAuthenticated, isLoading: authLoading } = useAuth();
  const router = useRouter();

  const [username, setUsername] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [rememberUsername, setRememberUsername] = useState<boolean>(false);
  // Kolom kode baru muncul setelah server menyatakan password sudah benar dan
  // tinggal kode 2FA-nya. Menampilkannya lebih awal akan membocorkan akun mana
  // yang memakai verifikasi dua langkah.
  const [totpCode, setTotpCode] = useState<string>("");
  const [needsTotp, setNeedsTotp] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [bootstrapStatus, setBootstrapStatus] =
    useState<BootstrapStatus | null>(null);
  // Dibuka manual ketika kredensial database tersimpan tetapi database cloud-nya
  // tidak menjawab — misalnya database Turso lama sudah dihapus. Tanpa pintu
  // ini, layar provisioning tidak pernah muncul lagi dan tidak ada tempat untuk
  // memasukkan URL database baru.
  const [showDatabaseSetup, setShowDatabaseSetup] = useState(false);

  const refreshBootstrapStatus = useCallback(() => {
    void getBootstrapStatus()
      .then((status) => {
        setBootstrapStatus(status);
        if (status?.reachable) setShowDatabaseSetup(false);
      })
      .catch(() => setBootstrapStatus(null));
  }, []);

  useEffect(() => {
    refreshBootstrapStatus();
  }, [refreshBootstrapStatus]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(REMEMBER_USERNAME_KEY);
      if (saved) {
        setUsername(saved);
        setRememberUsername(true);
      }
    } catch {
      // Penyimpanan diblokir: form tetap jalan tanpa username tersimpan.
    }
  }, []);

  // `null` pada build Web yang tidak menegakkan lisensi. Dibaca setelah database siap:
  // database yang belum diprovisioning meminta lisensinya di BootstrapPanel.
  const {
    status: licenseStatus,
    refresh: refreshLicense,
    setStatus: setLicenseStatus,
  } = useLicenseStatus(false);
  // Dibaca ulang setiap status database berubah: perangkat yang baru
  // bergabung ke database berlisensi menemukan lisensinya di sana.
  // Di Web `bootstrapStatus` selalu `null` (database ditentukan `.env`
  // server), jadi lisensinya dibaca langsung.
  useEffect(() => {
    if (bootstrapStatus || !isDesktopRuntime()) void refreshLicense();
  }, [bootstrapStatus, refreshLicense]);
  // Pemasangan baru meminta lisensi SEBELUM provisioning. Perangkat kedua dan
  // seterusnya milik lembaga yang sama melewatinya: lisensi lembaga sudah ada
  // di database yang akan mereka sambungkan.
  const [joiningLicensedDatabase, setJoiningLicensedDatabase] = useState(false);

  // Khusus Web. `hasOperator: false` berarti database belum punya satu akun
  // pun: tanpa petunjuk ini halaman login menjadi jalan buntu, karena form
  // tampil sementara tidak ada akun untuk dipakai. `null` (bukan Web, atau
  // status tidak terbaca) sengaja diam.
  const [webProvisioning, setWebProvisioning] =
    useState<WebProvisioningStatus | null>(null);
  const [checkingProvisioning, setCheckingProvisioning] = useState(false);
  const refreshWebProvisioning = useCallback(async () => {
    setCheckingProvisioning(true);
    try {
      setWebProvisioning(await getWebProvisioningStatus());
    } finally {
      setCheckingProvisioning(false);
    }
  }, []);
  useEffect(() => {
    void refreshWebProvisioning();
  }, [refreshWebProvisioning]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setErrorMsg("Mohon isi Username / Kode Operator dan Password.");
      return;
    }

    setErrorMsg(null);
    setIsSubmitting(true);

    try {
      const res = await login(
        username.trim(),
        password,
        needsTotp ? totpCode : undefined,
      );
      if (res.sukses) {
        try {
          if (rememberUsername) {
            localStorage.setItem(REMEMBER_USERNAME_KEY, username.trim());
          } else {
            localStorage.removeItem(REMEMBER_USERNAME_KEY);
          }
        } catch {
          // Gagal menyimpan username tidak boleh menggagalkan login.
        }
        router.replace("/");
      } else {
        if (res.requiresTotp) setNeedsTotp(true);
        setErrorMsg(res.pesan);
        void refreshLicense();
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Gagal melakukan verifikasi login.";
      setErrorMsg(msg);
      // Login bisa ditolak karena lisensinya (diganti dari perangkat lain, atau
      // perangkat ini dikeluarkan dari daftar); membaca ulang status memunculkan
      // layar aktivasi alih-alih membiarkan form login buntu.
      void refreshLicense();
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isHydrated || authLoading) {
    return (
      <div className="login-shell min-h-screen flex flex-col items-center justify-center p-6 font-sans">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-amber-400 border-t-transparent rounded-full animate-spin"></div>
          <p className="login-muted text-xs animate-pulse">
            Memuat Sistem Otentikasi...
          </p>
        </div>
      </div>
    );
  }

  if (isAuthenticated && user) redirect("/");
  // Form login tidak ditampilkan sama sekali: tanpa database ia tidak bisa
  // dipakai, dan menampilkannya membuat aplikasi tampak rusak.
  if (webProvisioning?.databaseConfigured === false) {
    return (
      <LoginFrame appName={appName} companyName={companyName}>
        <div className="my-auto">
          <h1 className="text-base font-bold text-white">
            {DATABASE_NOT_CONFIGURED_TITLE}
          </h1>
          <p className="mt-1 mb-4 text-xs leading-5 text-slate-400">
            {DATABASE_NOT_CONFIGURED_DESCRIPTION}
          </p>
          <DatabaseNotConfiguredNotice
            issue={webProvisioning.databaseIssue}
            onRetry={() => void refreshWebProvisioning()}
            checking={checkingProvisioning}
          />
        </div>
      </LoginFrame>
    );
  }
  if (
    bootstrapStatus?.required &&
    !joiningLicensedDatabase &&
    licenseStatus &&
    isLicenseBlocking(licenseStatus)
  ) {
    return (
      <LoginFrame appName={appName} companyName={companyName}>
        <div className="my-auto">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-wider text-slate-500">
            Langkah 1 dari 2 · setelah lisensi aktif, lanjut ke pengaturan
            database
          </p>
          <LicenseActivationPanel
            status={licenseStatus}
            onInstalled={setLicenseStatus}
          />
          <button
            type="button"
            onClick={() => setJoiningLicensedDatabase(true)}
            className="mt-3 w-full min-h-10 rounded-xl border border-slate-700 bg-slate-800/80 px-3 text-xs font-bold text-slate-300 transition hover:bg-slate-700"
          >
            Perangkat ini bergabung ke database lembaga yang sudah berlisensi
          </button>
        </div>
      </LoginFrame>
    );
  }
  if (bootstrapStatus?.required) {
    return (
      <BootstrapPanel
        status={bootstrapStatus}
        onCompleted={refreshBootstrapStatus}
      />
    );
  }
  if (bootstrapStatus && showDatabaseSetup) {
    return (
      <BootstrapPanel
        status={bootstrapStatus}
        onCompleted={refreshBootstrapStatus}
        onCancel={() => setShowDatabaseSetup(false)}
      />
    );
  }
  if (licenseStatus && isLicenseBlocking(licenseStatus)) {
    return (
      <LoginFrame appName={appName} companyName={companyName}>
        <div className="my-auto">
          <LicenseActivationPanel
            status={licenseStatus}
            onInstalled={(next) => {
              setLicenseStatus(next);
              setErrorMsg(null);
            }}
          />
          {/* Perangkat yang menunjuk database salah tidak pernah menemukan
              lisensinya; tanpa pintu ini ia terjebak di layar aktivasi. Di Web
              database ditentukan `.env` server, jadi tombolnya tidak ada:
              `bootstrapStatus` di sana selalu `null`. */}
          {bootstrapStatus ? (
            <button
              type="button"
              onClick={() => setShowDatabaseSetup(true)}
              className="mt-3 w-full min-h-10 rounded-xl border border-slate-700 bg-slate-800/80 px-3 text-xs font-bold text-slate-300 transition hover:bg-slate-700"
            >
              Konfigurasi ulang database
            </button>
          ) : null}
        </div>
      </LoginFrame>
    );
  }

  return (
    <LoginFrame appName={appName} companyName={companyName}>
      <VisualProvider />
      <div className="flex items-center justify-end gap-2">
        <span className="login-chip inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium">
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${
              isOnline ? "bg-emerald-400" : "bg-amber-400"
            }`}
          />
          {isOnline ? "Jaringan tersedia" : "Tidak ada jaringan"}
        </span>
        <ThemeToggle variant="compact" />
      </div>

      <div className="my-auto w-full max-w-md mx-auto lg:mx-0 pt-8 space-y-6">
        <div>
          <h2 className="login-heading text-2xl sm:text-3xl font-extrabold tracking-tight">
            Masuk ke Aplikasi
          </h2>
          <p className="login-muted mt-1 text-sm">
            Masukkan username dan kata sandi operator Anda.
          </p>
        </div>

        {/* Database cloud tersimpan tetapi tidak menjawab: tawarkan konfigurasi
            ulang, jangan biarkan pengguna menebak-nebak di form login. */}
        {bootstrapStatus?.configured && !bootstrapStatus.reachable ? (
          <div className="p-3.5 bg-amber-950/50 border border-amber-700/60 rounded-2xl text-amber-100 text-xs space-y-1.5">
            <p className="font-bold text-amber-300">
              Database cloud tidak dapat dihubungi
            </p>
            <p className="text-amber-200/90">
              {bootstrapStatus.message ??
                "Aplikasi ini masih menunjuk database lama."}
            </p>
            <p className="text-amber-200/70">
              Kalau jaringan aktif dan database sudah diganti atau dihapus,
              arahkan aplikasi ke database yang baru. Login offline tetap bisa
              dipakai bila perangkat ini pernah login online sebelumnya.
            </p>
            <button
              type="button"
              onClick={() => setShowDatabaseSetup(true)}
              className="mt-1 w-full min-h-10 rounded-xl border border-amber-600/50 bg-amber-500/10 px-3 text-xs font-bold text-amber-200 hover:bg-amber-500/20 transition"
            >
              Konfigurasi ulang database
            </button>
          </div>
        ) : null}

        {/* Database Web yang belum punya akun. Halaman ini hanya MENUNJUK ke
            jalan provisioning; pembuatan akunnya ada di `/setup`, yang dijaga
            token pemasangan dari `.env` server. Tanpa token itu, pengunjung
            pertama yang membuka URL ini bisa mengklaim seluruh sistem. */}
        {webProvisioning?.hasOperator === false ? (
          <div className="p-3.5 bg-amber-950/50 border border-white/10 rounded-2xl text-amber-100 text-xs space-y-1.5">
            <p className="font-bold text-amber-300">
              Database ini belum punya akun
            </p>
            {webProvisioning.setupEnabled ? (
              <>
                <p>
                  Belum ada akun untuk masuk. Buat Superadmin pertama dengan
                  token pemasangan dari berkas .env server.
                </p>
                <Link
                  href="/setup"
                  className="flex min-h-11 w-full items-center justify-center rounded-xl bg-amber-400 px-3 text-xs font-black text-slate-950 transition hover:bg-amber-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
                >
                  Buat Superadmin pertama
                </Link>
              </>
            ) : (
              <>
                <p>
                  Belum ada akun untuk masuk. Sambungkan aplikasi Desktop ke
                  database yang sama: layar provisioning muncul sendiri di sana,
                  dan akun yang dibuat langsung bisa dipakai di sini.
                </p>
                <p>
                  Tanpa Desktop, isi{" "}
                  <code className="font-mono font-bold text-amber-300">
                    KOS_SETUP_TOKEN
                  </code>{" "}
                  di berkas .env server, lalu ikuti{" "}
                  <Link
                    href="/setup"
                    className="font-bold text-amber-300 underline underline-offset-2"
                  >
                    langkah di halaman provisioning
                  </Link>
                  .
                </p>
              </>
            )}
          </div>
        ) : null}

        {errorMsg && (
          <div
            role="alert"
            className="p-3.5 bg-rose-950/60 border border-rose-800/80 rounded-2xl text-rose-300 text-xs flex items-start gap-2.5 animate-fadeIn"
          >
            <div className="flex-1 font-medium">{errorMsg}</div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="username-input"
              className="login-label mb-1.5 block text-sm font-medium"
            >
              Username / Kode Operator
            </label>
            <div className="login-field flex items-center gap-3 rounded-xl px-4">
              <Icon name="user" className="login-field-icon size-5 shrink-0" />
              <input
                id="username-input"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="username atau kode"
                autoComplete="username"
                className="min-h-12 w-full min-w-0 bg-transparent text-sm outline-none"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="password-input"
              className="login-label mb-1.5 block text-sm font-medium"
            >
              Kata Sandi / PIN
            </label>
            <div className="login-field flex items-center gap-3 rounded-xl pl-4 pr-1">
              <Icon name="lock" className="login-field-icon size-5 shrink-0" />
              <input
                id="password-input"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="kata sandi"
                autoComplete="current-password"
                className="min-h-12 w-full min-w-0 bg-transparent text-sm outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label="Tampilkan kata sandi"
                aria-pressed={showPassword}
                className="login-field-btn grid size-10 shrink-0 place-items-center rounded-lg transition"
              >
                <Icon
                  name={showPassword ? "eye-off" : "eye"}
                  className="size-5"
                />
              </button>
            </div>
          </div>

          {needsTotp ? (
            <div>
              <label
                htmlFor="totp-input"
                className="login-label mb-1.5 block text-sm font-medium"
              >
                Kode Verifikasi 2FA
              </label>
              <div className="login-field rounded-xl px-4">
                <input
                  id="totp-input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={16}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  placeholder="123456 atau kode cadangan"
                  className="min-h-12 w-full min-w-0 bg-transparent text-sm font-mono tracking-[0.3em] outline-none"
                />
              </div>
              <p className="login-muted mt-1.5 text-xs">
                Buka aplikasi autentikator Anda, atau masukkan salah satu kode
                cadangan.
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <label className="login-label inline-flex min-h-10 cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={rememberUsername}
                onChange={(e) => setRememberUsername(e.target.checked)}
                className="login-check size-4"
              />
              Ingat username
            </label>
            <Link
              href="/lupa-password"
              className="login-link rounded text-sm font-semibold"
            >
              Lupa Password?
            </Link>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="login-btn w-full min-h-12 px-4 font-bold text-sm rounded-xl transition active:scale-[0.99] flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? (
              <>
                <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                <span>Memverifikasi Login...</span>
              </>
            ) : (
              <span>Masuk Aplikasi</span>
            )}
          </button>
        </form>
      </div>

      <footer className="login-muted mt-8 text-center text-xs space-y-0.5">
        {licenseStatus?.license ? (
          <p>Berlisensi untuk {licenseStatus.license.holder}</p>
        ) : null}
        <p>
          {appName} v{packageJson.version} • KOS
        </p>
      </footer>
    </LoginFrame>
  );
}
