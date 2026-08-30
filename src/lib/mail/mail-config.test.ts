import { describe, expect, test } from "bun:test";
import { describeMailFailure } from "@/lib/mail/mail-config";

/**
 * Pemetaan kegagalan penyedia email menjadi instruksi yang bisa dikerjakan.
 *
 * Balasan mentah seperti "HTTP 403" benar tetapi tidak memberi tahu apa yang
 * harus dilakukan. Kasus di bawah adalah bentuk balasan Resend dan Brevo yang
 * benar-benar muncul di lapangan.
 */
describe("describeMailFailure", () => {
  test("403 domain belum diverifikasi menunjuk ke menu Domains", () => {
    const hint = describeMailFailure(
      'HTTP 403 dari resend: {"statusCode":403,"message":"The sppg.id domain is not verified. Please verify your domain on https://resend.com/domains","name":"validation_error"}',
    );
    expect(hint).toContain("belum diverifikasi");
    expect(hint).toContain("Domains");
    // Jalan pintas untuk menguji cepat harus ikut disebut.
    expect(hint).toContain("onboarding@resend.dev");
  });

  test("403 mode uji menjelaskan batas alamat tujuan", () => {
    const hint = describeMailFailure(
      'HTTP 403 dari resend: {"message":"You can only send testing emails to your own email address"}',
    );
    expect(hint).toContain("pemilik akun Resend");
  });

  test("403 tanpa penjelasan tetap menyebut dua sebab paling umum", () => {
    const hint = describeMailFailure("HTTP 403 dari resend: ");
    expect(hint).toContain("domain email pengirim belum diverifikasi");
    expect(hint).toContain("kunci API dibatasi");
  });

  test("401 diarahkan ke kunci API, bukan ke domain", () => {
    const hint = describeMailFailure(
      'HTTP 401 dari resend: {"message":"API key is invalid"}',
    );
    expect(hint).toContain("Kunci API ditolak");
    expect(hint).not.toContain("domain");
  });

  test("429 dijelaskan sebagai kuota, bukan kesalahan konfigurasi", () => {
    expect(describeMailFailure("HTTP 429 dari brevo: rate limit")).toContain(
      "Kuota",
    );
  });

  test("kegagalan jaringan dibedakan dari penolakan penyedia", () => {
    // Inilah yang tampil sebagai "tidak ada koneksi internet" padahal internet
    // menyala: penyebabnya DNS/proxy/TLS, bukan kabel terputus.
    const hint = describeMailFailure(
      "Permintaan ke resend gagal: error sending request for url (https://api.resend.com/emails): dns error",
    );
    expect(hint).toContain("DNS");
    // Justru menyatakan secara eksplisit bahwa kunci API BUKAN penyebabnya,
    // supaya orang tidak membuang waktu mengganti kunci yang sudah benar.
    expect(hint).toContain("bukan soal kuota atau kunci API");
  });

  test("422 pada alamat pengirim menunjuk ke kolom email pengirim", () => {
    const hint = describeMailFailure(
      'HTTP 422 dari resend: {"message":"Invalid `from` field"}',
    );
    expect(hint).toContain("email pengirim");
  });

  test("konfigurasi belum lengkap diarahkan ke sakelar pengiriman", () => {
    expect(
      describeMailFailure(
        "Konfigurasi email nonaktif, kunci API kosong, atau email pengirim belum diisi.",
      ),
    ).toContain("aktifkan sakelar");
  });

  test("balasan yang tidak dikenal tidak mengarang saran", () => {
    // Lebih baik diam daripada menyesatkan: balasan mentahnya tetap ditampilkan
    // apa adanya di bawah pesan ini.
    expect(describeMailFailure("HTTP 500 dari resend: internal")).toBe("");
    expect(describeMailFailure("")).toBe("");
  });
});

describe("kegagalan pengirim Brevo", () => {
  test("pengirim belum terdaftar diarahkan ke validasi alamat, bukan ke domain", () => {
    const hint = describeMailFailure(
      'HTTP 400 dari brevo: {"code":"invalid_parameter","message":"Sender email is not valid"}',
    );
    expect(hint).toContain("belum terdaftar");
    expect(hint).toContain("Senders");
    // Justru menegaskan domain TIDAK diperlukan — inilah jalan keluar bagi
    // pemasangan yang tidak punya domain berbayar.
    expect(hint).toContain("TIDAK memerlukan domain");
  });

  test("401 yang menyebut pengirim tidak disalahartikan sebagai kunci API salah", () => {
    const hint = describeMailFailure(
      'HTTP 401 dari brevo: {"message":"Unauthorised sender"}',
    );
    expect(hint).not.toContain("Kunci API ditolak");
    expect(hint).toContain("belum terdaftar");
  });

  test("401 tanpa menyebut pengirim tetap diarahkan ke kunci API", () => {
    expect(
      describeMailFailure('HTTP 401 dari brevo: {"message":"Key not found"}'),
    ).toContain("Kunci API ditolak");
  });
});

describe("penolakan daftar IP Brevo", () => {
  /** Balasan asli yang diterima dari lapangan. */
  const balasanAsli =
    'HTTP 401 dari brevo: {"message":"We have detected you are using an unrecognised IP address 2001:448a:200d:22d9:f99d:f5be:7319:8eb3. If you performed this action make sure to add the new IP address in this link: https://app.brevo.com/security/authorised_ips","code":"unauthorized"}';

  test("tidak disalahartikan sebagai kunci API yang salah", () => {
    const hint = describeMailFailure(balasanAsli);
    // Kesalahan lama: menyuruh menyalin ulang kunci yang sebenarnya sudah benar,
    // sehingga waktu terbuang mengganti kunci berkali-kali.
    expect(hint).not.toContain("Salin ulang kunci");
    expect(hint).toContain("kunci API Anda sendiri sudah benar");
  });

  test("mengarahkan ke pembatasan IP dan menyuruh mematikannya", () => {
    const hint = describeMailFailure(balasanAsli);
    expect(hint).toContain("Authorised IPs");
    expect(hint).toContain("MATIKAN");
  });

  test("menjelaskan kenapa mendaftarkan IP tidak akan menyelesaikan masalah", () => {
    // Alasannya arsitektural: Desktop/Mobile mengirim langsung dari perangkat
    // operator, jadi tidak ada satu IP tetap yang bisa didaftarkan.
    expect(describeMailFailure(balasanAsli)).toContain(
      "berganti setiap pindah jaringan",
    );
  });
});
