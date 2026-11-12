"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  findTelegramGroupsGateway,
  getTelegramConfigGateway,
  saveTelegramConfigGateway,
  sendTelegramTestGateway,
} from "@/lib/gateways/telegram";
import {
  BIDANG_KEJADIAN,
  type BidangTelegram,
  type GrupTelegram,
  type KejadianTelegram,
  LABEL_BIDANG,
  LABEL_KEJADIAN,
  TELEGRAM_BIDANG,
  TELEGRAM_KEJADIAN,
  type TelegramConfig,
} from "@/lib/validations/telegram";

const GRUP_KOSONG = Object.fromEntries(
  TELEGRAM_BIDANG.map((bidang) => [bidang, ""]),
) as Record<BidangTelegram, string>;
const KIRIM_MATI = Object.fromEntries(
  TELEGRAM_KEJADIAN.map((kejadian) => [kejadian, false]),
) as Record<KejadianTelegram, boolean>;

function nadaStatus(status: string) {
  if (status === "Terkirim") return "success" as const;
  if (status === "Gagal") return "danger" as const;
  if (status === "Menunggu") return "info" as const;
  return "neutral" as const;
}

function pesanGalat(error: unknown, cadangan: string) {
  return error instanceof Error && error.message ? error.message : cadangan;
}

/**
 * Notifikasi grup Telegram internal. Hanya dirender untuk Superadmin: token
 * bot adalah rahasia. Kartu ini tidak ada di Mobile; perangkat Mobile hanya
 * ikut menjalankan pengirimnya (`AutoTelegramRunner`).
 */
export function NotifikasiTelegramCard() {
  const [config, setConfig] = useState<TelegramConfig | null>(null);
  const [aktif, setAktif] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [grup, setGrup] = useState(GRUP_KOSONG);
  const [kirim, setKirim] = useState(KIRIM_MATI);
  const [ditemukan, setDitemukan] = useState<GrupTelegram[] | null>(null);
  const [sibuk, setSibuk] = useState<string | null>(null);
  const isSubmittingRef = useRef(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  const terapkan = useCallback((value: TelegramConfig) => {
    setConfig(value);
    setAktif(value.aktif);
    setGrup(value.grup);
    setKirim(value.kirim);
    setBotToken("");
  }, []);

  useEffect(() => {
    let batal = false;
    void getTelegramConfigGateway()
      .then((value) => {
        if (!batal) terapkan(value);
      })
      .catch((error) => {
        if (!batal) {
          setFeedback({
            tone: "error",
            text: pesanGalat(error, "Konfigurasi Telegram tidak dapat dimuat."),
          });
        }
      });
    return () => {
      batal = true;
    };
  }, [terapkan]);

  const jalankan = async (
    aksi: string,
    kerja: () => Promise<string | null>,
    cadangan: string,
  ) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setSibuk(aksi);
    setFeedback(null);
    try {
      const sukses = await kerja();
      if (sukses) setFeedback({ tone: "success", text: sukses });
    } catch (error) {
      setFeedback({ tone: "error", text: pesanGalat(error, cadangan) });
    } finally {
      isSubmittingRef.current = false;
      setSibuk(null);
    }
  };

  const simpan = (event: FormEvent) => {
    event.preventDefault();
    void jalankan(
      "simpan",
      async () => {
        terapkan(
          await saveTelegramConfigGateway({ aktif, botToken, grup, kirim }),
        );
        return "Konfigurasi Telegram tersimpan.";
      },
      "Konfigurasi Telegram tidak dapat disimpan.",
    );
  };

  const cariGrup = () =>
    void jalankan(
      "cari",
      async () => {
        const hasil = await findTelegramGroupsGateway(botToken);
        setDitemukan(hasil);
        return null;
      },
      "Grup tidak dapat dicari.",
    );

  const kirimUji = (bidang: BidangTelegram) =>
    void jalankan(
      `uji:${bidang}`,
      async () => {
        await sendTelegramTestGateway({
          bidang,
          chatId: grup[bidang],
          botToken,
        });
        return `Pesan uji terkirim ke grup ${LABEL_BIDANG[bidang]}.`;
      },
      "Pesan uji gagal dikirim.",
    );

  const adaToken = botToken.trim() !== "" || Boolean(config?.tokenTersimpan);

  return (
    <section className="app-panel rounded-3xl p-5 sm:p-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl border border-sky-300/20 bg-sky-300/10 text-sky-200">
            <Icon name="share" className="size-5" />
          </span>
          <div>
            <h2 className="text-base font-black text-white">
              Notifikasi Grup Telegram
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">
              Bot mengirim ringkasan kejadian ke grup internal per bidang. Bot
              hanya mengirim; persetujuan tetap dilakukan di aplikasi. Pesan
              terkirim selama ada aplikasi yang terbuka dan online.
            </p>
          </div>
        </div>
        <StatusBadge tone={config?.aktif ? "success" : "warning"}>
          {config?.aktif ? "Aktif" : "Nonaktif"}
        </StatusBadge>
      </div>

      {feedback ? (
        <p
          role={feedback.tone === "error" ? "alert" : "status"}
          className={`mt-4 rounded-xl border p-3 text-sm ${
            feedback.tone === "success"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-rose-500/30 bg-rose-500/10 text-rose-200"
          }`}
        >
          {feedback.text}
        </p>
      ) : null}

      <form className="mt-5 grid gap-5" onSubmit={simpan}>
        <label className="grid gap-1.5 text-xs font-bold text-slate-300">
          Token bot
          <input
            type="password"
            autoComplete="off"
            value={botToken}
            onChange={(event) => setBotToken(event.target.value)}
            placeholder={
              config?.tokenTersimpan
                ? `Tersimpan (…${config.tokenAkhir}). Isi hanya bila ingin mengganti`
                : "Tempel token dari @BotFather"
            }
            className="app-input"
          />
          <span className="font-normal leading-5 text-slate-500">
            Token tidak pernah ditampilkan kembali dan tidak disalin ke
            perangkat.
          </span>
        </label>

        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={cariGrup}
              disabled={sibuk !== null || !adaToken}
              className="min-h-11 rounded-xl border border-white/15 px-4 text-sm font-bold text-slate-200 disabled:opacity-50"
            >
              {sibuk === "cari" ? "Mencari..." : "Cari grup"}
            </button>
            <span className="text-xs leading-5 text-slate-500">
              Tambahkan bot ke grup, kirim <code>/start</code> di grup, lalu
              tekan Cari grup.
            </span>
          </div>
          {ditemukan !== null ? (
            ditemukan.length === 0 ? (
              <p className="text-xs text-amber-200">
                Belum ada grup yang terlihat bot. Kirim <code>/start</code> di
                grupnya lalu cari lagi.
              </p>
            ) : (
              <ul className="grid gap-2">
                {ditemukan.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 p-3 text-sm text-slate-200"
                  >
                    <span className="min-w-0 flex-1 break-words font-semibold">
                      {item.judul}{" "}
                      <span className="font-mono text-xs text-slate-500">
                        {item.id}
                      </span>
                    </span>
                    {TELEGRAM_BIDANG.map((bidang) => (
                      <button
                        key={bidang}
                        type="button"
                        onClick={() =>
                          setGrup((lama) => ({ ...lama, [bidang]: item.id }))
                        }
                        className="min-h-9 rounded-lg border border-sky-300/25 px-3 text-xs font-bold text-sky-200"
                      >
                        Pakai untuk {LABEL_BIDANG[bidang]}
                      </button>
                    ))}
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {TELEGRAM_BIDANG.map((bidang) => (
            <div key={bidang} className="grid gap-1.5">
              <label
                htmlFor={`telegram-grup-${bidang}`}
                className="text-xs font-bold text-slate-300"
              >
                Grup {LABEL_BIDANG[bidang]}
              </label>
              <div className="flex gap-2">
                <input
                  id={`telegram-grup-${bidang}`}
                  value={grup[bidang]}
                  onChange={(event) =>
                    setGrup((lama) => ({
                      ...lama,
                      [bidang]: event.target.value,
                    }))
                  }
                  placeholder="Belum diatur"
                  inputMode="numeric"
                  className="app-input min-w-0 flex-1 font-mono"
                />
                <button
                  type="button"
                  onClick={() => kirimUji(bidang)}
                  disabled={
                    sibuk !== null || !adaToken || grup[bidang].trim() === ""
                  }
                  className="min-h-11 shrink-0 rounded-xl border border-white/15 px-3 text-xs font-bold text-slate-200 disabled:opacity-50"
                >
                  {sibuk === `uji:${bidang}` ? "Mengirim..." : "Kirim uji"}
                </button>
              </div>
              {bidang === "armada" ? (
                <p className="text-xs text-slate-500">
                  Perbarui aplikasi di semua HP dan komputer lebih dulu. Versi
                  lama membatalkan pesan perjalanan tanpa mengirimnya.
                </p>
              ) : null}
              {bidang === "hrd" ? (
                <p className="text-xs text-slate-500">
                  Setiap anggota grup ini membaca nama, jabatan, jenis dokumen,
                  dan tingkat SP karyawan tanpa pemeriksaan hak akses. Isi hanya
                  dengan grup HRD.
                </p>
              ) : null}
            </div>
          ))}
        </div>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-xs font-bold text-slate-300">
            Kejadian yang dikirim
          </legend>
          {TELEGRAM_KEJADIAN.map((kejadian) => (
            <label
              key={kejadian}
              className="flex items-start gap-3 text-sm text-slate-200"
            >
              <input
                type="checkbox"
                checked={kirim[kejadian]}
                onChange={(event) =>
                  setKirim((lama) => ({
                    ...lama,
                    [kejadian]: event.target.checked,
                  }))
                }
                className="mt-0.5 size-4"
              />
              <span>
                {LABEL_KEJADIAN[kejadian]}
                <span className="block text-xs text-slate-500">
                  Ke grup {LABEL_BIDANG[BIDANG_KEJADIAN[kejadian]]}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="flex items-center gap-3 text-xs font-bold text-slate-300">
          <input
            type="checkbox"
            checked={aktif}
            onChange={(event) => setAktif(event.target.checked)}
            className="size-4"
          />
          Aktifkan notifikasi Telegram
        </label>

        <div>
          <button
            type="submit"
            disabled={sibuk !== null}
            className="min-h-11 rounded-xl bg-emerald-500 px-5 text-sm font-black text-slate-950 disabled:opacity-50"
          >
            {sibuk === "simpan"
              ? "Menyimpan..."
              : "Simpan konfigurasi Telegram"}
          </button>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            Kejadian sebelum notifikasi diaktifkan tidak dikirim.
          </p>
        </div>
      </form>

      {config && config.riwayat.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-xs font-bold text-slate-300">Pesan terakhir</h3>
          <ul className="mt-2 grid gap-2">
            {config.riwayat.map((item) => (
              <li
                key={item.id}
                className="rounded-xl border border-white/10 p-3 text-xs text-slate-300"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone={nadaStatus(item.status)}>
                    {item.status}
                  </StatusBadge>
                  <span className="font-semibold">
                    {LABEL_KEJADIAN[item.kejadian as KejadianTelegram] ??
                      item.kejadian}
                  </span>
                  <span className="text-slate-500">
                    {item.terkirim || item.dibuat}
                  </span>
                </div>
                {item.galat ? (
                  <p className="mt-1 break-words text-rose-200">{item.galat}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
