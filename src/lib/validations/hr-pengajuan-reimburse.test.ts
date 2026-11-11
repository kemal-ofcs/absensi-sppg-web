import { describe, expect, test } from "bun:test";
import {
  type BayarReimburse,
  bayarAktifReimburse,
  bentrokPengajuan,
  dibayarGanda,
  type GajiReimburse,
  JENIS_BAWAAN,
  type JenisPengajuan,
  type KeadaanAksi,
  type Keputusan,
  type Klaim,
  kanonikPengajuan,
  kunciBatas,
  lewatBatas,
  modeReimburse,
  nominalBerlaku,
  PESAN_NOMINAL,
  periksaAksi,
  periksaBatalBayarReimburse,
  periksaBayarReimburse,
  periksaJenis,
  periksaReimbursePayroll,
  periksaTanggalBiaya,
  type Ringkas,
  STATUS_BELUM_DIBAYAR,
  STATUS_DIBAYAR,
  STATUS_PROSES_GAJI,
  SUMBER_REIMBURSE,
  SUMBER_UANG,
  statusBayar,
  validasiAturanReimburse,
  validasiBayarReimburse,
  validasiJenis,
  validasiPengajuan,
} from "./hr-pengajuan";

// HRIS fase 4 (v39). Vektor yang sama dengan `fase4_*` di `mod tests`
// `desktop/hr_pengajuan.rs`; teks SQL kembarnya diperiksa `hr-pengajuan.test.ts`.

const gagalDengan = (hasil: { ok: boolean; pesan?: string }) =>
  hasil.ok ? null : (hasil.pesan ?? null);

const bayar = (
  id: string,
  jenis: string,
  idRef: string | null,
): BayarReimburse => ({
  id_bayar: id,
  jenis,
  id_ref: idRef,
  id_karyawan: "K1",
  tanggal: "2026-01-10",
  total: 1,
  keterangan: null,
  dicatat_oleh: "keu",
  created_at: "2026-01-10 00:00:00",
});

const barisBayar = (idBayar: string, idKlaim: string) => ({
  id_baris: `${idBayar}:${idKlaim}`,
  id_bayar: idBayar,
  sumber: "Reimburse",
  id_klaim: idKlaim,
  nominal: 1,
});

const gaji = (
  idRun: string,
  status: string,
  idKlaim: string,
  nominal: number,
): GajiReimburse => ({ id_run: idRun, status, id_klaim: idKlaim, nominal });

describe("hr-pengajuan fase 4: reimbursement", () => {
  test("sidik, bentrok, dan nominal berlaku", () => {
    const isi = {
      id_karyawan: "K1",
      id_jenis: "jns-rmb-transport",
      kelompok: "Reimburse",
      potong_jatah: false,
      dampak_gaji: "Tidak Berpengaruh",
      tanggal_mulai: "2026-01-05",
      tanggal_selesai: "2026-01-05",
      setengah_hari: false,
      alasan: "Taksi",
      nominal: 150_000,
    };
    expect(kanonikPengajuan(isi)).toBe(
      "K1\u001fjns-rmb-transport\u001fReimburse\u001f0\u001fTidak Berpengaruh\u001f2026-01-05\u001f2026-01-05\u001f0\u001fTaksi\u001f150000",
    );
    // Nominal hanya ikut sidik Reimburse: sidik kelompok lain tidak berubah.
    const cuti = { ...isi, kelompok: "Cuti" };
    expect(kanonikPengajuan(cuti)).toBe(
      kanonikPengajuan({ ...cuti, nominal: null }),
    );

    const r = (kelompok: string): Ringkas => ({
      kelompok,
      id_karyawan: "K1",
      id_karyawan_tukar: null,
      tanggal_mulai: "2026-01-05",
      tanggal_selesai: "2026-01-05",
      setengah_hari: false,
      jam_mulai: null,
      jam_selesai: null,
    });
    expect(bentrokPengajuan(r("Reimburse"), r("Cuti"))).toBe(false);
    expect(bentrokPengajuan(r("Lembur"), r("Reimburse"))).toBe(false);
    expect(bentrokPengajuan(r("Reimburse"), r("Reimburse"))).toBe(false);

    const k = (nominal: number | null): Keputusan => ({
      id_keputusan: "a",
      jenis: "Setujui",
      sidik: "s",
      oleh: "keu",
      waktu_perangkat: "2026-01-06 00:00:00",
      diterima_cloud: null,
      nominal_disetujui: nominal,
    });
    expect(nominalBerlaku(100_000, null)).toBe(100_000);
    expect(nominalBerlaku(100_000, k(60_000))).toBe(60_000);
    expect(nominalBerlaku(100_000, k(null))).toBe(100_000);
  });

  test("aksi dengan nominal disetujui", () => {
    const k: KeadaanAksi = {
      status: "Menunggu",
      sudah_diketahui: false,
      pengaju_sendiri: false,
      superadmin: false,
      karyawan_sendiri: false,
      boleh_putus: true,
      reimburse: true,
      nominal: 100_000,
    };
    const salahNominal = "Nominal disetujui harus 1 sampai Rp100.000.";
    expect(gagalDengan(periksaAksi("Setujui", "", null, k))).toBe(salahNominal);
    expect(gagalDengan(periksaAksi("Setujui", "", 0, k))).toBe(salahNominal);
    expect(gagalDengan(periksaAksi("Setujui", "", 100_001, k))).toBe(
      salahNominal,
    );
    expect(gagalDengan(periksaAksi("Setujui", " ", 60_000, k))).toBe(
      "Alasan wajib diisi bila nominal disetujui lebih kecil dari yang diajukan.",
    );
    expect(periksaAksi("Setujui", "Tarif wajar", 60_000, k).ok).toBe(true);
    expect(periksaAksi("Setujui", "", 100_000, k).ok).toBe(true);
    const hanyaSetujui =
      "Nominal disetujui hanya untuk menyetujui reimbursement.";
    expect(gagalDengan(periksaAksi("Tolak", "Tidak sah", 1, k))).toBe(
      hanyaSetujui,
    );
    const cuti = { ...k, reimburse: false };
    expect(gagalDengan(periksaAksi("Setujui", "", 1, cuti))).toBe(hanyaSetujui);
    expect(periksaAksi("Setujui", "", null, cuti).ok).toBe(true);
  });

  test("status bayar dan batas bulanan", () => {
    const pembayaran = [
      bayar("B1", "Bayar", null),
      bayar("B2", "Bayar", null),
      bayar("batal-B2", "Pembatalan", "B2"),
    ];
    const baris = [barisBayar("B1", "a"), barisBayar("B2", "b")];
    const g = [
      gaji("R1", "PAID", "c", 10),
      gaji("R2", "DRAFT", "d", 10),
      gaji("R3", "SUBMITTED", "a", 10),
    ];
    expect(statusBayar("a", pembayaran, baris, g)).toBe(STATUS_DIBAYAR);
    expect(statusBayar("b", pembayaran, baris, g)).toBe(STATUS_BELUM_DIBAYAR);
    expect(statusBayar("c", pembayaran, baris, g)).toBe(STATUS_DIBAYAR);
    expect(statusBayar("d", pembayaran, baris, g)).toBe(STATUS_PROSES_GAJI);
    expect(statusBayar("e", pembayaran, baris, g)).toBe(STATUS_BELUM_DIBAYAR);
    expect(dibayarGanda("a", pembayaran, baris, g)).toBe(true);
    expect(dibayarGanda("c", pembayaran, baris, g)).toBe(false);
    expect(bayarAktifReimburse("a", pembayaran, baris)).toEqual(["B1"]);

    const klaim = [
      ["K1", "J1", "2026-01-05", 300_000],
      ["K1", "J1", "2026-01-20", 250_000],
      ["K1", "J1", "2026-02-01", 100_000],
      ["K2", "J1", "2026-01-05", 500_000],
      ["K1", "J2", "2026-01-05", 999_999],
    ] as const;
    expect([...lewatBatas(klaim, new Map([["J1", 500_000]]))].sort()).toEqual([
      "K1|J1|2026-01",
    ]);
    expect(kunciBatas("K1", "J1", "2026-01-31")).toBe("K1|J1|2026-01");
  });

  test("bayar terpisah dan proses gaji", () => {
    const sah = (d: Record<string, unknown>) =>
      validasiBayarReimburse(d, "2026-01-15");
    expect(gagalDengan(sah({ id_klaim: ["a"] }))).toBe("Pilih karyawan.");
    expect(gagalDengan(sah({ id_karyawan: "K1", id_klaim: [] }))).toBe(
      "Pilih klaim yang dibayar.",
    );
    expect(gagalDengan(sah({ id_karyawan: "K1", id_klaim: ["a", "a"] }))).toBe(
      "Klaim yang sama terpilih dua kali.",
    );
    expect(
      gagalDengan(
        sah({ id_karyawan: "K1", id_klaim: ["a"], tanggal: "2026-01-16" }),
      ),
    ).toBe("Tanggal bayar tidak boleh setelah hari ini.");
    const v = sah({
      id_karyawan: "K1",
      id_klaim: ["a", "uang:K1:2025-01-01"],
      keterangan: " Transfer ",
    });
    if (!v.ok) throw new Error(v.pesan);
    expect([v.nilai.tanggal, v.nilai.keterangan]).toEqual([
      "2026-01-15",
      "Transfer",
    ]);

    const klaimKe = (
      id: string,
      karyawan: string,
      sumber: string,
      nominal: number,
    ): Klaim => ({
      id_klaim: id,
      sumber,
      id_karyawan: karyawan,
      tanggal: "2026-01-05",
      nominal,
      keterangan: "x",
    });
    const klaim = [
      klaimKe("a", "K1", SUMBER_REIMBURSE, 75_000),
      klaimKe("uang:K1:2025-01-01", "K1", SUMBER_UANG, 300_000),
      klaimKe("b", "K2", SUMBER_REIMBURSE, 10),
      klaimKe("d", "K1", SUMBER_REIMBURSE, 20),
    ];
    const g = [gaji("R2", "DRAFT", "d", 20)];
    const dipilih = periksaBayarReimburse(v.nilai, klaim, [], [], g);
    if (!dipilih.ok) throw new Error(dipilih.pesan);
    expect(dipilih.nilai.reduce((n, k) => n + k.nominal, 0)).toBe(375_000);
    const pilih = (ids: string[]) =>
      gagalDengan(
        periksaBayarReimburse({ ...v.nilai, id_klaim: ids }, klaim, [], [], g),
      );
    expect(pilih(["x"])).toBe("Klaim tidak ditemukan atau belum disetujui.");
    expect(pilih(["b"])).toBe("Klaim itu bukan milik karyawan ini.");
    expect(pilih(["d"])).toBe(
      "Klaim tanggal 2026-01-05 berstatus dalam proses gaji.",
    );

    const pembayaran = [
      bayar("B1", "Bayar", null),
      bayar("batal-B1", "Pembatalan", "B1"),
    ];
    expect(gagalDengan(periksaBatalBayarReimburse(pembayaran, "B9"))).toBe(
      "Pembayaran tidak ditemukan.",
    );
    expect(gagalDengan(periksaBatalBayarReimburse(pembayaran, "B1"))).toBe(
      "Pembayaran ini sudah dibatalkan.",
    );
    expect(periksaBatalBayarReimburse(pembayaran.slice(0, 1), "B1").ok).toBe(
      true,
    );

    const paid = [gaji("R1", "PAID", "a", 75_000)];
    const cek = (idRun: string, id: string, n: number) =>
      gagalDengan(
        periksaReimbursePayroll(idRun, [[id, n]], klaim, [], [], paid),
      );
    expect(cek("R1", "a", 75_000)).toBeNull();
    expect(cek("R1", "x", 1)).toBe(
      "Klaim reimbursement x sudah tidak berlaku. Tolak proses gaji ini lalu buat ulang.",
    );
    expect(cek("R1", "uang:K1:2025-01-01", 300_000)).toBe(
      "Klaim reimbursement uang:K1:2025-01-01 sudah tidak berlaku. Tolak proses gaji ini lalu buat ulang.",
    );
    expect(cek("R1", "a", 70_000)).toBe(
      "Nominal klaim reimbursement tanggal 2026-01-05 berubah. Tolak proses gaji ini lalu buat ulang.",
    );
    expect(cek("R9", "a", 75_000)).toBe(
      "Klaim reimbursement tanggal 2026-01-05 sudah dibayar. Tolak proses gaji ini lalu buat ulang.",
    );
  });

  test("jenis, isian, dan aturan reimbursement", () => {
    const j = validasiJenis({
      nama: "Reimburse Parkir",
      kelompok: "Reimburse",
      dampak_gaji: "Dibayar",
      maks_hari: 3,
      boleh_urgent: true,
      izin_pemutus: "reimburse.decide",
      batas_bulanan: 250000,
    });
    if (!j.ok) throw new Error(j.pesan);
    expect([
      j.nilai.dampak_gaji,
      j.nilai.maks_hari,
      j.nilai.boleh_urgent,
      j.nilai.izin_pemutus,
      j.nilai.batas_bulanan,
    ]).toEqual(["Tidak Berpengaruh", null, false, "reimburse.decide", 250_000]);
    const cuti = validasiJenis({
      nama: "Cuti X",
      kelompok: "Cuti",
      dampak_gaji: "Dibayar",
      batas_bulanan: 5,
    });
    if (!cuti.ok) throw new Error(cuti.pesan);
    expect([cuti.nilai.izin_pemutus, cuti.nilai.batas_bulanan]).toEqual([
      "hr.request.decide",
      null,
    ]);
    expect(
      gagalDengan(
        validasiJenis({ nama: "R", kelompok: "Reimburse", batas_bulanan: 0 }),
      ),
    ).toBe("Batas bulanan harus 1 sampai 1.000.000.000 rupiah.");
    expect(
      gagalDengan(
        validasiJenis({
          nama: "R",
          kelompok: "Reimburse",
          izin_pemutus: "trip.pay",
        }),
      ),
    ).toBe("Pemutus pengajuan tidak dikenal.");

    const isian = (lain: Record<string, unknown>) =>
      validasiPengajuan({
        id_karyawan: "K1",
        id_jenis: "j",
        tanggal_mulai: "2026-01-05",
        tanggal_selesai: "2026-01-05",
        alasan: "x",
        ...lain,
      });
    expect(gagalDengan(isian({ nominal: 1.5 }))).toBe(
      "Nominal harus bilangan bulat rupiah.",
    );
    expect(gagalDengan(isian({ nominal: "100" }))).toBe(
      "Nominal harus bilangan bulat rupiah.",
    );
    const jenis: JenisPengajuan = { ...j.nilai, id_jenis: "j" };
    const periksa = (lain: Record<string, unknown>) => {
      const v = isian(lain);
      if (!v.ok) throw new Error(v.pesan);
      return gagalDengan(periksaJenis(v.nilai, jenis));
    };
    expect(periksa({})).toBe(PESAN_NOMINAL);
    expect(periksa({ nominal: 1_000_000_001 })).toBe(PESAN_NOMINAL);
    expect(periksa({ nominal: 5, tanggal_selesai: "2026-01-06" })).toBe(
      "Reimburse diajukan per nota, satu tanggal biaya.",
    );
    expect(periksa({ nominal: 5 })).toBeNull();
    expect(periksa({ nominal: 5, urgent: true })).toBe(
      "Jenis pengajuan ini tidak boleh urgent.",
    );
    expect(periksaTanggalBiaya("2026-01-15", "2026-01-15").ok).toBe(true);
    expect(gagalDengan(periksaTanggalBiaya("2026-01-16", "2026-01-15"))).toBe(
      "Tanggal biaya tidak boleh setelah hari ini.",
    );

    expect([
      modeReimburse(null),
      modeReimburse(" gaji "),
      modeReimburse("x"),
    ]).toEqual(["terpisah", "gaji", "terpisah"]);
    expect(validasiAturanReimburse({})).toEqual({ ok: true, nilai: [] });
    expect(validasiAturanReimburse({ hr_reimburse_bayar: "gaji" })).toEqual({
      ok: true,
      nilai: [["hr_reimburse_bayar", "gaji"]],
    });
    expect(
      gagalDengan(validasiAturanReimburse({ hr_reimburse_bayar: "tunai" })),
    ).toBe("Cara bayar reimbursement harus gaji atau terpisah.");
    const bawaan = JENIS_BAWAAN.filter((x) => x.kelompok === "Reimburse");
    expect(bawaan.length).toBe(5);
    expect(
      bawaan.every(
        (x) =>
          x.izin_pemutus === "reimburse.decide" &&
          x.wajib_dokumen &&
          !x.boleh_urgent,
      ),
    ).toBe(true);
  });
});
