"use client";

import type { IScannerControls } from "@zxing/browser";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { createQrPng } from "@/lib/client/qr-code";
import { createQrReleaseGate } from "@/lib/client/qr-release-gate";
import type { BarangInventaris } from "@/lib/gateways/inventory";
import {
  formatJumlah,
  isiLabelDus,
  isiLabelInventaris,
  jumlahDariKetikan,
  jumlahLabelDus,
  rencanaLabelDus,
} from "@/lib/validations/inventory";
import { cetakLabelBarang, LABEL_PER_LEMBAR } from "./beritaAcara";
import {
  angka,
  INPUT,
  isianJumlah,
  LABEL,
  pesanGalat,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "./gaya";

/**
 * Label yang sama baru dihitung lagi setelah lepas dari kamera selama ini.
 * Tiga puluh kursi berlabel sama: kamera digeser dari satu kursi ke kursi
 * berikutnya, dan label yang terus terlihat tidak terhitung berulang.
 */
const JEDA_LABEL_MS = 800;
export const MAKS_LABEL_PER_BARANG = 500;
const MAKS_LABEL_TOTAL = 2000;
const ID_KETIK_PINDAI = "inv-pindai-ketik";

/**
 * Pemindai USB mengetik ke elemen yang sedang fokus. Di perangkat sentuh fokus
 * dilewati karena memunculkan papan ketik yang menutupi kamera.
 */
export function fokusKolomPindai() {
  if (window.matchMedia("(pointer: fine)").matches) {
    document.getElementById(ID_KETIK_PINDAI)?.focus();
  }
}

/**
 * Kamera + kolom ketik. Kolom itu juga melayani pemindai QR USB, yang
 * mengetik isinya lalu Enter, jadi komputer tanpa webcam tetap bisa dipakai.
 * Kamera dimatikan saat komponen dilepas (efek tanpa dependensi), bukan dari
 * efek yang bergantung state: pola itu mematikan kamera WebView Android
 * sesaat setelah menyala.
 */
export function PemindaiLabel({
  onPindai,
}: {
  onPindai: (teks: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onPindaiRef = useRef(onPindai);
  onPindaiRef.current = onPindai;
  const [kamera, setKamera] = useState<"memuat" | "aktif" | "gagal">("memuat");
  const [ketik, setKetik] = useState("");

  useEffect(() => {
    let controls: IScannerControls | null = null;
    let dilepas = false;
    const gate = createQrReleaseGate(JEDA_LABEL_MS);
    void (async () => {
      try {
        const { BrowserQRCodeReader } = await import("@zxing/browser");
        const video = videoRef.current;
        if (dilepas || !video) return;
        const reader = new BrowserQRCodeReader(undefined, {
          delayBetweenScanAttempts: 80,
        });
        const hasil = await reader.decodeFromConstraints(
          { audio: false, video: { facingMode: { ideal: "environment" } } },
          video,
          (result) => {
            const teks = result?.getText().trim();
            if (!teks) return;
            const now = Date.now();
            if (!gate.allows(teks, now)) return;
            gate.block(teks, now);
            onPindaiRef.current(teks);
          },
        );
        if (dilepas) {
          hasil.stop();
          return;
        }
        controls = hasil;
        setKamera("aktif");
      } catch {
        if (!dilepas) setKamera("gagal");
      }
    })();
    return () => {
      dilepas = true;
      controls?.stop();
    };
  }, []);

  // Sesudah efek `useDialogFocus` milik Modal, supaya fokus tetap dipulangkan
  // ke tombol pembuka saat dialog ditutup.
  useEffect(() => {
    const jeda = setTimeout(fokusKolomPindai, 0);
    return () => clearTimeout(jeda);
  }, []);

  const kirimKetikan = () => {
    if (!ketik.trim()) return;
    onPindaiRef.current(ketik);
    setKetik("");
  };

  return (
    <div className="space-y-3">
      {kamera === "gagal" ? (
        <p className="p-3 rounded-lg border border-slate-700 text-sm text-slate-300">
          Kamera tidak bisa dibuka. Pakai pemindai QR USB atau ketik kode barang
          di bawah.
        </p>
      ) : (
        <video
          ref={videoRef}
          muted
          playsInline
          aria-label="Pratinjau kamera pemindai label"
          className="w-full aspect-video rounded-lg bg-black object-cover"
        />
      )}
      <div>
        <label htmlFor={ID_KETIK_PINDAI} className={LABEL}>
          Pindai dengan pemindai USB atau ketik kode barang
        </label>
        <div className="flex gap-2">
          <input
            id={ID_KETIK_PINDAI}
            value={ketik}
            onChange={(e) => setKetik(e.target.value)}
            onKeyDown={(e) => {
              // Bukan <form>: dialog ini dirender di dalam formulir opname,
              // dan event submit React merambat melewati portal.
              if (e.key === "Enter") {
                e.preventDefault();
                kirimKetikan();
              }
            }}
            autoComplete="off"
            className={INPUT}
          />
          <button type="button" onClick={kirimKetikan} className={TOMBOL_KEDUA}>
            Cari
          </button>
        </div>
      </div>
    </div>
  );
}

/** Unit yang masih ada (saldo 1). Unit afkir atau hilang tidak dicetak. */
function unitAda(barang: BarangInventaris) {
  return barang.posisi.filter((p) => p.kode_unit !== null && p.saldo > 0);
}

/** `unit` membatasi unit yang dicetak per barang, misalnya unit baru dari satu penerimaan. */
function unitDicetak(
  barang: BarangInventaris,
  unit?: Record<string, string[]>,
) {
  const pilihan = unit?.[barang.id_barang];
  const ada = unitAda(barang);
  return pilihan ? ada.filter((p) => pilihan.includes(p.id_batch ?? "")) : ada;
}

function jumlahBawaan(
  barang: BarangInventaris,
  unit?: Record<string, string[]>,
): string {
  // Barang per unit: tepat satu label per unit, dengan QR unitnya sendiri.
  if (barang.dilacak_unit) return String(unitDicetak(barang, unit).length);
  // Aset: satu label per unit untuk ditempel. Habis Pakai: satu untuk raknya.
  return String(barang.tipe === "Aset" ? Math.max(barang.stok_total, 1) : 1);
}

/** Dus tidak menunjuk batch atau unit, jadi barang jenis itu tidak mendapatkannya. */
function bisaPerDus(barang: BarangInventaris): boolean {
  return !barang.dilacak_unit && !barang.bisa_expired;
}

/** Isian "Per dus" dibaca jadi jumlah tersimpan, atau pesan galatnya. */
function bacaIsianDus(
  barang: BarangInventaris,
  isian: { jumlah: string; isi: string },
): { jumlah: number; isi: number } | string {
  const jumlah = jumlahDariKetikan(isian.jumlah, barang.desimal);
  const isi = jumlahDariKetikan(isian.isi, barang.desimal);
  if (!jumlah || !isi) {
    return `Jumlah barang dan isi per label ${barang.nama_barang} harus angka lebih dari 0.`;
  }
  if (isi > jumlah) {
    return `Isi per label ${barang.nama_barang} tidak boleh melebihi jumlah barangnya.`;
  }
  if (jumlahLabelDus(jumlah, isi) > MAKS_LABEL_PER_BARANG) {
    return `${barang.nama_barang} membutuhkan lebih dari ${MAKS_LABEL_PER_BARANG} label. Besarkan isi per label.`;
  }
  return { jumlah, isi };
}

/** Kode sekali cetak. `getRandomValues` juga ada di Web lewat HTTP biasa. */
function kodeCetakBaru(): string {
  const [acak = 0] = crypto.getRandomValues(new Uint16Array(1));
  return acak.toString(16).toUpperCase().padStart(4, "0");
}

/** Pilih barang dan jumlah label, lalu cetak A4 lewat dialog cetak. */
export function DialogLabel({
  barang,
  namaPerusahaan,
  onClose,
  awal,
  unitTerpilih,
}: {
  barang: BarangInventaris[];
  namaPerusahaan: string | null;
  onClose: () => void;
  /** Barang yang langsung terpilih -> jumlah label. */
  awal?: Record<string, string>;
  /** Unit yang dicetak per barang; tanpa ini semua unit yang masih ada. */
  unitTerpilih?: Record<string, string[]>;
}) {
  // Barang terpilih -> jumlah label (teks isian).
  const [pilihan, setPilihan] = useState<Record<string, string>>(
    () => awal ?? {},
  );
  // Barang yang labelnya "Per dus" -> isiannya (teks berformat Indonesia).
  const [perDus, setPerDus] = useState<
    Record<string, { jumlah: string; isi: string }>
  >({});
  const [galat, setGalat] = useState<string | null>(null);
  const [menyiapkan, setMenyiapkan] = useState(false);

  const terpilih = useMemo(
    () => barang.filter((b) => pilihan[b.id_barang] !== undefined),
    [barang, pilihan],
  );
  const labelBarang = (b: BarangInventaris): number => {
    const isian = perDus[b.id_barang];
    if (!isian) return Number(pilihan[b.id_barang]) || 0;
    const dus = bacaIsianDus(b, isian);
    return typeof dus === "string" ? 0 : jumlahLabelDus(dus.jumlah, dus.isi);
  };
  const total = terpilih.reduce((jumlah, b) => jumlah + labelBarang(b), 0);
  const semua = barang.length > 0 && terpilih.length === barang.length;

  const gantiCara = (b: BarangInventaris, keDus: boolean) => {
    const berikut = { ...perDus };
    if (keDus) {
      // Bawaan satu label untuk seluruh stok; isi per label diketik petugas.
      const stok = b.stok_total > 0 ? angka(b.stok_total, b.desimal) : "";
      berikut[b.id_barang] = { jumlah: stok, isi: stok };
    } else {
      delete berikut[b.id_barang];
    }
    setPerDus(berikut);
  };

  const pilihSemua = (nilai: boolean) => {
    setPilihan(
      nilai
        ? Object.fromEntries(
            barang.map((b) => [b.id_barang, jumlahBawaan(b, unitTerpilih)]),
          )
        : {},
    );
  };

  const cetak = async () => {
    for (const b of terpilih) {
      const isian = perDus[b.id_barang];
      const dus = isian ? bacaIsianDus(b, isian) : null;
      if (typeof dus === "string") {
        setGalat(dus);
        return;
      }
    }
    const tidakSah = terpilih.find((b) => {
      if (b.dilacak_unit || perDus[b.id_barang]) return false;
      const n = Number(pilihan[b.id_barang]);
      return !Number.isInteger(n) || n < 1 || n > MAKS_LABEL_PER_BARANG;
    });
    if (tidakSah) {
      setGalat(
        `Jumlah label ${tidakSah.nama_barang} harus 1 sampai ${MAKS_LABEL_PER_BARANG}.`,
      );
      return;
    }
    if (total > MAKS_LABEL_TOTAL) {
      setGalat(
        `Paling banyak ${MAKS_LABEL_TOTAL} label sekali cetak. Cetak dalam beberapa kali.`,
      );
      return;
    }
    setMenyiapkan(true);
    setGalat(null);
    try {
      const kodeCetak = kodeCetakBaru();
      const labelDus = (
        b: BarangInventaris,
        isian: { jumlah: string; isi: string },
      ) => {
        const dus = bacaIsianDus(b, isian);
        if (typeof dus === "string") throw new Error(dus);
        return rencanaLabelDus(dus.jumlah, dus.isi).map(async (label) => ({
          nama_barang: b.nama_barang,
          kode_barang: b.kode_barang,
          qr: await createQrPng(
            isiLabelDus(b.id_barang, label.isi, kodeCetak, label.nomor),
            256,
          ),
          jumlah: 1,
          isi: `Isi ${formatJumlah(label.isi, b.desimal)} ${b.satuan}`,
          dus: `Box ${label.nomor}/${label.total} · ${kodeCetak}`,
        }));
      };
      const daftar = await Promise.all(
        terpilih.flatMap((b) => {
          const isian = perDus[b.id_barang];
          if (isian) return labelDus(b, isian);
          return b.dilacak_unit
            ? unitDicetak(b, unitTerpilih).map(async (unit) => ({
                nama_barang: b.nama_barang,
                kode_barang: unit.nomor_seri
                  ? `${unit.kode_unit} · SN ${unit.nomor_seri}`
                  : (unit.kode_unit as string),
                qr: await createQrPng(
                  isiLabelInventaris(unit.id_batch as string),
                  256,
                ),
                jumlah: 1,
              }))
            : [
                (async () => ({
                  nama_barang: b.nama_barang,
                  kode_barang: b.kode_barang,
                  qr: await createQrPng(isiLabelInventaris(b.id_barang), 256),
                  jumlah: Number(pilihan[b.id_barang]),
                }))(),
              ];
        }),
      );
      cetakLabelBarang(daftar, namaPerusahaan);
    } catch (error) {
      setGalat(pesanGalat(error, "Label tidak bisa disiapkan."));
    } finally {
      setMenyiapkan(false);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title="Cetak label QR"
      titleId="inv-label-judul"
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-400">
          Satu lembar A4 memuat {LABEL_PER_LEMBAR} label 64 × 33 mm. Saat
          mencetak, pilih skala 100% ("Ukuran sebenarnya") supaya QR tetap
          terbaca. Barang yang dicatat per unit mendapat satu label untuk setiap
          unitnya; barang lain memakai satu QR untuk semua unitnya, atau label
          "Per box" yang langsung terhitung sesuai isinya saat opname.
        </p>
        {barang.length === 0 ? (
          <p className="text-sm text-slate-400">
            Tidak ada barang di daftar. Ubah filter pencarian dulu.
          </p>
        ) : (
          <>
            <label className="flex min-h-11 items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={semua}
                onChange={(e) => pilihSemua(e.target.checked)}
                className="h-4 w-4"
              />
              Pilih semua barang di daftar ({barang.length})
            </label>
            <ul className="max-h-[50vh] overflow-y-auto divide-y divide-slate-800 rounded-xl border border-slate-800">
              {barang.map((b) => {
                const dipilih = pilihan[b.id_barang] !== undefined;
                const isian = perDus[b.id_barang];
                return (
                  <li
                    key={b.id_barang}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                  >
                    <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-sm text-slate-200">
                      <input
                        type="checkbox"
                        checked={dipilih}
                        onChange={(e) => {
                          const berikut = { ...pilihan };
                          if (e.target.checked) {
                            berikut[b.id_barang] = jumlahBawaan(
                              b,
                              unitTerpilih,
                            );
                          } else {
                            delete berikut[b.id_barang];
                          }
                          setPilihan(berikut);
                        }}
                        className="h-4 w-4 shrink-0"
                      />
                      <span className="min-w-0 wrap-break-word">
                        {b.nama_barang}{" "}
                        <span className="text-slate-400">
                          ({b.kode_barang})
                        </span>
                      </span>
                    </label>
                    {dipilih && b.dilacak_unit ? (
                      <span className="text-sm text-slate-400">
                        {pilihan[b.id_barang]} unit
                      </span>
                    ) : dipilih && !isian ? (
                      <input
                        type="number"
                        min={1}
                        max={MAKS_LABEL_PER_BARANG}
                        step={1}
                        inputMode="numeric"
                        aria-label={`Jumlah label ${b.nama_barang}`}
                        value={pilihan[b.id_barang]}
                        onChange={(e) =>
                          setPilihan({
                            ...pilihan,
                            [b.id_barang]: e.target.value,
                          })
                        }
                        className={`${INPUT} w-24`}
                      />
                    ) : null}
                    {dipilih && bisaPerDus(b) ? (
                      <div className="w-full space-y-2">
                        <select
                          aria-label={`Cara label ${b.nama_barang}`}
                          value={isian ? "dus" : "satu"}
                          onChange={(e) =>
                            gantiCara(b, e.target.value === "dus")
                          }
                          className={INPUT}
                        >
                          <option value="satu">Satu QR untuk semua</option>
                          <option value="dus">Per box</option>
                        </select>
                        {isian ? (
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label
                                htmlFor={`inv-dus-jumlah-${b.id_barang}`}
                                className={LABEL}
                              >
                                Jumlah barang ({b.satuan})
                              </label>
                              <input
                                id={`inv-dus-jumlah-${b.id_barang}`}
                                {...isianJumlah(b.desimal)}
                                value={isian.jumlah}
                                onChange={(e) =>
                                  setPerDus({
                                    ...perDus,
                                    [b.id_barang]: {
                                      jumlah: e.target.value,
                                      // Isi yang belum diubah mengikuti jumlahnya.
                                      isi:
                                        isian.isi === isian.jumlah
                                          ? e.target.value
                                          : isian.isi,
                                    },
                                  })
                                }
                                className={INPUT}
                              />
                            </div>
                            <div>
                              <label
                                htmlFor={`inv-dus-isi-${b.id_barang}`}
                                className={LABEL}
                              >
                                Isi per label ({b.satuan})
                              </label>
                              <input
                                id={`inv-dus-isi-${b.id_barang}`}
                                {...isianJumlah(b.desimal)}
                                value={isian.isi}
                                onChange={(e) =>
                                  setPerDus({
                                    ...perDus,
                                    [b.id_barang]: {
                                      ...isian,
                                      isi: e.target.value,
                                    },
                                  })
                                }
                                className={INPUT}
                              />
                            </div>
                            <p className="col-span-2 text-xs text-slate-400">
                              {labelBarang(b)} label
                            </p>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {galat ? (
          <p role="alert" className="text-sm text-rose-200">
            {galat}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-sm text-slate-400">
            {total} label, {Math.ceil(total / LABEL_PER_LEMBAR)} lembar
          </span>
          <button type="button" onClick={onClose} className={TOMBOL_KEDUA}>
            Batal
          </button>
          <button
            type="button"
            onClick={() => void cetak()}
            disabled={menyiapkan || total === 0}
            className={TOMBOL_UTAMA}
          >
            {menyiapkan ? "Menyiapkan..." : "Cetak label"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
