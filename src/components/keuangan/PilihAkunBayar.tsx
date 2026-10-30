"use client";

import { useEffect, useState } from "react";
import { INPUT, LABEL } from "@/components/inventory/gaya";
import { PilihCari } from "@/components/ui/PilihCari";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { type AkunItem, daftarAkun } from "@/lib/gateways/accounting";
import type { KelompokAkun } from "@/lib/validations/accounting";
import { AKUN_KAS } from "@/lib/validations/loan";

/**
 * Pilihan akun kas/bank untuk uang yang keluar atau masuk (gaji dibayar,
 * kasbon dicairkan atau dilunasi). Dipakai halaman payroll dan Kasbon di
 * Web/Desktop dan Mobile (disalin lewat `filesToCopy`).
 *
 * Pemakai tanpa `accounting.view` tidak bisa membaca bagan akun, jadi untuk
 * mereka akun bawaannya yang dipakai dan pilihan ini cukup memberi tahu itu.
 * `kelompok="Pendapatan"` dipakai halaman tagihan untuk akun pendapatan.
 */
export function PilihAkunBayar({
  id,
  label,
  value,
  onChange,
  kelompok = "Aset",
  bawaan = AKUN_KAS,
  catatanTanpaIzin = "Uangnya dicatat lewat akun Kas di pembukuan.",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (idAkun: string) => void;
  kelompok?: KelompokAkun;
  bawaan?: string;
  catatanTanpaIzin?: string;
}) {
  const { user } = useAuth();
  const bolehLihat = hasPermission(user, "accounting.view");
  const [akun, setAkun] = useState<AkunItem[] | null>(null);
  const [galat, setGalat] = useState<string | null>(null);

  useEffect(() => {
    if (!bolehLihat) return;
    let aktif = true;
    daftarAkun()
      .then((hasil) => {
        if (aktif) {
          setAkun(
            hasil.items.filter(
              (item) => item.kelompok === kelompok && item.is_aktif,
            ),
          );
        }
      })
      .catch((error) => {
        if (aktif) {
          setGalat(
            error instanceof Error
              ? error.message
              : "Daftar akun tidak bisa dimuat.",
          );
        }
      });
    return () => {
      aktif = false;
    };
  }, [bolehLihat, kelompok]);

  if (!bolehLihat) {
    return <p className="text-xs text-slate-400">{catatanTanpaIzin}</p>;
  }

  return (
    <div>
      <label className={LABEL} htmlFor={id}>
        {label}
      </label>
      <PilihCari
        id={id}
        className={INPUT}
        value={value || bawaan}
        disabled={akun === null}
        onChange={(event) => onChange(event.target.value)}
      >
        {akun === null ? (
          <option value={value || bawaan}>Memuat akun...</option>
        ) : (
          akun.map((item) => (
            <option key={item.id_akun} value={item.id_akun}>
              {item.kode} {item.nama}
            </option>
          ))
        )}
      </PilihCari>
      {galat ? <p className="mt-1 text-xs text-rose-100">{galat}</p> : null}
    </div>
  );
}
