"use client";

import { createRoot } from "react-dom/client";
import { TOMBOL_KEDUA, TOMBOL_UTAMA } from "@/components/inventory/gaya";
import { Modal } from "@/components/ui/Modal";

/**
 * Dialog "Apakah data yang dicatat sudah benar?" sebelum data manual disimpan.
 * Dipasang sebagai root sendiri di `body`, karena Modal Mobile tidak memakai
 * portal: bila dirender di dalam formulir ber-Modal, dialog ini terpotong oleh
 * panel induknya. Dipakai Web/Desktop dan Mobile (`filesToCopy`).
 */

export interface BarisKonfirmasi {
  label: string;
  /** Kosong berarti barisnya tidak ditampilkan. */
  nilai: string | null | undefined;
  peringatan?: boolean;
}

function DialogKonfirmasi({
  rincian,
  onSelesai,
}: {
  rincian: BarisKonfirmasi[];
  onSelesai: (lanjut: boolean) => void;
}) {
  const terisi = rincian.filter((baris) => baris.nilai?.trim());
  return (
    <Modal
      isOpen={true}
      onClose={() => onSelesai(false)}
      title="Konfirmasi data"
      titleId="konfirmasi-data-judul"
      hideFooter
    >
      <div className="space-y-4">
        <p className="text-sm font-medium text-slate-200">
          Apakah data yang dicatat sudah benar?
        </p>
        {terisi.length > 0 ? (
          <dl className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950/40 text-sm">
            {terisi.map((baris) => (
              <div
                key={baris.label}
                className="flex justify-between gap-4 px-3 py-2"
              >
                <dt className="shrink-0 text-slate-400">{baris.label}</dt>
                <dd
                  className={`min-w-0 text-right wrap-break-word ${
                    baris.peringatan
                      ? "font-semibold text-rose-300"
                      : "text-slate-100"
                  }`}
                >
                  {baris.nilai}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => onSelesai(false)}
            className={TOMBOL_KEDUA}
          >
            Belum
          </button>
          <button
            type="button"
            onClick={() => onSelesai(true)}
            className={TOMBOL_UTAMA}
          >
            Lanjut
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** `true` bila pengguna memilih Lanjut. */
export function konfirmasiData(
  rincian: BarisKonfirmasi[] = [],
): Promise<boolean> {
  return new Promise((resolve) => {
    const asal = document.activeElement as HTMLElement | null;
    // Fokus dilepas supaya Enter yang sama tidak mengirim formulirnya dua kali
    // dan papan ketik Android tidak menutupi dialog.
    asal?.blur?.();
    const wadah = document.createElement("div");
    document.body.appendChild(wadah);
    const root = createRoot(wadah);

    const selesai = (lanjut: boolean) => {
      window.removeEventListener("keydown", saatEscape, true);
      root.unmount();
      wadah.remove();
      asal?.focus?.();
      resolve(lanjut);
    };
    // Tanpa ini Modal formulir di bawahnya ikut tertutup dan isiannya hilang.
    const saatEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        selesai(false);
      }
    };
    window.addEventListener("keydown", saatEscape, true);
    root.render(<DialogKonfirmasi rincian={rincian} onSelesai={selesai} />);
  });
}
