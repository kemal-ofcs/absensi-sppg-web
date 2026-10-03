import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import crypto from "node:crypto";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";

mock.module("server-only", () => ({}));

const {
  checkInstallableLicense,
  evaluateWebLicense,
  instanceCodeFromId,
  invalidateLicenseCache,
  isWebsiteHost,
  licenseRejection,
  loadLicenseContext,
  parseLicense,
  readOnlyAllows,
  rentalDaysLeft,
  requestHost,
  storeLicense,
} = await import("@/lib/server/license");

/**
 * Kunci uji: seed 32 byte bernilai 0x01, sama dengan `KUNCI_UJI` di alat
 * penerbit (`lisensi/test/format.test.ts`) dan `test_key()` di `license.rs`.
 */
const TEST_KEY = crypto.createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, 1),
  ]),
  format: "der",
  type: "pkcs8",
});
const TEST_PUBLIC_HEX =
  "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";

/** Vektor kembar: WAJIB sama persis dengan penerbit dan `license.rs`. */
const VECTOR_V1 =
  "LIS1.eyJ2IjoxLCJwcm9kdWsiOiJrb3MtYWJzZW5zaS1wZXJ1c2FoYWFuIiwiaWQiOiJMSVMtMjAyNi0wMDAxIiwicGVtZWdhbmciOiJQVCBVamkgVmVrdG9yIiwiamVuaXMiOiJzZXdhIiwidGVyYml0IjoiMjAyNi0wOS0yMyIsInBlbWJhcnVhbl9zYW1wYWkiOiIyMDI3LTA5LTIzIiwiYmVybGFrdV9zYW1wYWkiOiIyMDI3LTA5LTIzIiwicGVyYW5na2F0IjpbIlctMUEyQi0zQzRELTVFNkYtN0E4QiJdLCJrdW5jaV9tb2JpbGUiOmZhbHNlfQ.Lj_wjeQ6wjc2iOTDncDbBoUk6NqjkFggWetWloj38D17zayOFUTnAJRweB0RLsEWzjHbrauo0lp_zpC2_JZNAQ";
const VECTOR_V2 =
  "LIS1.eyJ2IjoxLCJwcm9kdWsiOiJrb3MtYWJzZW5zaS1wZXJ1c2FoYWFuIiwiaWQiOiJMSVMtMjAyNi0wMDAyIiwicGVtZWdhbmciOiJQVCBOdXNhbnRhcmEg4oCUIENhYmFuZyBUaW11ciIsImplbmlzIjoiYmVsaV9wdXR1cyIsInRlcmJpdCI6IjIwMjYtMDktMjMiLCJwZW1iYXJ1YW5fc2FtcGFpIjoiMjAyNy0wOS0yMyIsImJlcmxha3Vfc2FtcGFpIjpudWxsLCJwZXJhbmdrYXQiOltdLCJrdW5jaV9tb2JpbGUiOmZhbHNlfQ.dtKhJorN-g17bzs4Cdnk23XLHVvsvw_tzuV4QSsZfX--MgCc4jqFX5ssGqcFEN9Q8lE02H-aPfT6S_747JpKAw";
const VECTOR_V3 =
  "LIS1.eyJ2IjoxLCJwcm9kdWsiOiJrb3MtYWJzZW5zaS1wZXJ1c2FoYWFuIiwiaWQiOiJMSVMtMjAyNi0wMDAzIiwicGVtZWdhbmciOiJQVCBVamkgV2ViIiwiamVuaXMiOiJiZWxpX3B1dHVzIiwidGVyYml0IjoiMjAyNi0xMC0wMSIsInBlbWJhcnVhbl9zYW1wYWkiOiIyMDI3LTEwLTAxIiwiYmVybGFrdV9zYW1wYWkiOm51bGwsInBlcmFuZ2thdCI6W10sImt1bmNpX21vYmlsZSI6ZmFsc2UsImluc3RhbmNlX3dlYiI6IlMtNEMxRC04OEFBLTAyRjMtN0IxOSIsIndlYnNpdGUiOlsiYWJzZW5zaS5wdC11amkuY28uaWQiXX0.frjI0Y828KRjFd0wIeD_tCNbafejcvguSa7TPaS3knH8pJWzb5npW_ESeb91O0w9AYJIj8Ow75aRDbVOr_olAA";

/** Opsi tes: lisensi di bawah ditandatangani kunci uji, bukan kunci produk. */
const UJI = { publicKeyHex: TEST_PUBLIC_HEX };
const INSTANCE = "S-4C1D-88AA-02F3-7B19";
const DEVICE = "W-1A2B-3C4D-5E6F-7A8B";
const HOST = "absensi.pt-uji.co.id";

const BASE = {
  v: 1,
  produk: "kos-absensi-perusahaan",
  id: "LIS-UJI",
  pemegang: "PT Uji",
  jenis: "beli_putus",
  terbit: "2026-09-23",
  pembaruan_sampai: "2027-09-23",
  berlaku_sampai: null,
  perangkat: [],
  kunci_mobile: false,
} as const;

function sign(payload: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const input = `LIS1.${body}`;
  const signature = crypto
    .sign(null, Buffer.from(input, "utf8"), TEST_KEY)
    .toString("base64url");
  return `${input}.${signature}`;
}

const withChanges = (changes: Record<string, unknown>) =>
  sign({ ...BASE, ...changes });
const reject = (changes: Record<string, unknown>) => () =>
  parseLicense(withChanges(changes), TEST_PUBLIC_HEX);

describe("vektor kembar", () => {
  test("kunci uji sama dengan penerbit", () => {
    const publicHex = crypto
      .createPublicKey(TEST_KEY)
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("hex");
    expect(publicHex).toBe(TEST_PUBLIC_HEX);
    // Ed25519 deterministik: isi yang sama menghasilkan teks yang sama.
    expect(
      sign({
        ...BASE,
        id: "LIS-2026-0003",
        pemegang: "PT Uji Web",
        terbit: "2026-10-01",
        pembaruan_sampai: "2027-10-01",
        instance_web: INSTANCE,
        website: [HOST],
      }),
    ).toBe(VECTOR_V3);
  });

  test("V1, V2, V3 terverifikasi dan terbaca utuh", () => {
    expect(parseLicense(VECTOR_V1, TEST_PUBLIC_HEX)).toEqual({
      id: "LIS-2026-0001",
      holder: "PT Uji Vektor",
      kind: "sewa",
      issued: "2026-09-23",
      updatesUntil: "2027-09-23",
      validUntil: "2027-09-23",
      devices: [DEVICE],
      lockMobile: false,
      webInstance: null,
      websites: [],
    });
    const v2 = parseLicense(VECTOR_V2, TEST_PUBLIC_HEX);
    expect(v2.holder).toBe("PT Nusantara — Cabang Timur");
    expect(v2.validUntil).toBeNull();
    const v3 = parseLicense(VECTOR_V3, TEST_PUBLIC_HEX);
    expect(v3.holder).toBe("PT Uji Web");
    expect(v3.webInstance).toBe(INSTANCE);
    expect(v3.websites).toEqual([HOST]);
  });

  test("spasi dan baris baru di tengah teks dibuang", () => {
    const broken = `  ${VECTOR_V3.slice(0, 120)}\r\n${VECTOR_V3.slice(120, 200)} \t${VECTOR_V3.slice(200)}\n`;
    expect(parseLicense(broken, TEST_PUBLIC_HEX).id).toBe("LIS-2026-0003");
  });

  test("teks yang diubah, kunci lain, dan awalan lain ditolak", () => {
    const [prefix, body, signature] = VECTOR_V1.split(".") as [
      string,
      string,
      string,
    ];
    const tampered = `${prefix}.${body.slice(0, 10)}${body[10] === "A" ? "B" : "A"}${body.slice(11)}.${signature}`;
    expect(() => parseLicense(tampered, TEST_PUBLIC_HEX)).toThrow();
    const otherKey = crypto
      .createPublicKey(
        crypto.createPrivateKey({
          key: Buffer.concat([
            Buffer.from("302e020100300506032b657004220420", "hex"),
            Buffer.alloc(32, 2),
          ]),
          format: "der",
          type: "pkcs8",
        }),
      )
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("hex");
    expect(() => parseLicense(VECTOR_V1, otherKey)).toThrow(
      "Tanda tangan lisensi tidak cocok.",
    );
    expect(() =>
      parseLicense(VECTOR_V1.replace("LIS1", "LIS2"), TEST_PUBLIC_HEX),
    ).toThrow("Teks bukan lisensi LIS1.");
    expect(() =>
      parseLicense(`${prefix}.${body}.${signature}!`, TEST_PUBLIC_HEX),
    ).toThrow("Tanda tangan lisensi rusak.");
  });
});

// Daftar yang sama dengan `payload_rules_match_issuer` di `license.rs`.
describe("aturan isi (cermin validate_payload)", () => {
  test("pesan penolakan sama dengan Rust", () => {
    expect(reject({ maks_perangkat: 9 })).toThrow(
      "Kolom lisensi tidak dikenal: maks_perangkat.",
    );
    expect(reject({ v: 2 })).toThrow("Versi lisensi tidak didukung.");
    expect(reject({ produk: "Absensi" })).toThrow("Kode produk tidak sah.");
    expect(reject({ pemegang: " PT" })).toThrow(
      "Nama pemegang lisensi tidak sah.",
    );
    expect(reject({ pemegang: "A\u0007" })).toThrow(
      "Nama pemegang lisensi tidak sah.",
    );
    expect(reject({ jenis: "gratis" })).toThrow("Jenis lisensi tidak dikenal.");
    expect(reject({ terbit: "2026-02-30" })).toThrow(
      "Tanggal terbit tidak sah.",
    );
    expect(reject({ terbit: "2026-9-23" })).toThrow(
      "Tanggal terbit tidak sah.",
    );
    expect(reject({ pembaruan_sampai: "2026-01-01" })).toThrow(
      "pembaruan_sampai tidak boleh sebelum tanggal terbit.",
    );
    expect(reject({ berlaku_sampai: "2027-01-01" })).toThrow(
      "Lisensi beli_putus tidak punya berlaku_sampai.",
    );
    expect(reject({ jenis: "sewa" })).toThrow(
      "Lisensi sewa wajib punya berlaku_sampai.",
    );
    expect(reject({ perangkat: ["w-1a2b-3c4d-5e6f-7a8b"] })).toThrow(
      "Kode perangkat tidak sah",
    );
    expect(reject({ perangkat: [DEVICE, DEVICE] })).toThrow(
      `Kode perangkat ganda: ${DEVICE}.`,
    );
    expect(reject({ kunci_mobile: "ya" })).toThrow(
      "kunci_mobile harus true atau false.",
    );
    expect(reject({ produk: "produk-lain" })).toThrow(
      "Lisensi ini diterbitkan untuk produk lain (produk-lain).",
    );
    const { berlaku_sampai: _dropped, ...missing } = BASE;
    expect(() => parseLicense(sign(missing), TEST_PUBLIC_HEX)).toThrow();
  });
});

// Daftar yang sama dengan `web_fields_match_issuer` di `license.rs` dan
// `describe("versi Web")` di alat penerbit.
describe("kolom versi Web", () => {
  test("instance saja sudah sah; website opsional", () => {
    const lan = parseLicense(
      withChanges({ instance_web: INSTANCE }),
      TEST_PUBLIC_HEX,
    );
    expect(lan.webInstance).toBe(INSTANCE);
    expect(lan.websites).toEqual([]);
  });

  test("kode instance", () => {
    for (const code of [
      "W-4C1D-88AA-02F3-7B19",
      "s-4c1d-88aa-02f3-7b19",
      null,
    ]) {
      expect(reject({ instance_web: code })).toThrow(
        "Kode instance Web tidak sah.",
      );
    }
    // Kode instance tidak boleh menumpang di daftar perangkat.
    expect(reject({ perangkat: [INSTANCE] })).toThrow(
      "Kode perangkat tidak sah",
    );
  });

  test("daftar website", () => {
    expect(reject({ website: [HOST] })).toThrow(
      "website hanya berlaku bersama instance_web.",
    );
    const withInstance = (website: unknown) =>
      reject({ instance_web: INSTANCE, website });
    expect(withInstance([])).toThrow(
      "Daftar website harus berupa array berisi 1-10 alamat.",
    );
    expect(withInstance(HOST)).toThrow("Daftar website");
    expect(
      withInstance(Array.from({ length: 11 }, (_, i) => `a${i}.sch.id`)),
    ).toThrow("Daftar website");
    expect(withInstance(["a.sch.id", "a.sch.id"])).toThrow(
      "Alamat website ganda: a.sch.id.",
    );
    expect(withInstance(["192.168.1.10"])).toThrow(
      "Alamat website tidak sah: 192.168.1.10.",
    );
  });

  test("alamat website", () => {
    for (const host of [
      "absensi.smk-uji.sch.id",
      "sekolah.id",
      "a1.b2.co",
      "xn--80ak6aa92e.com",
    ]) {
      expect(isWebsiteHost(host)).toBe(true);
    }
    for (const host of [
      "192.168.1.10",
      "localhost",
      "Absensi.Sekolah.id",
      "https://sekolah.id",
      "sekolah.id:3000",
      "sekolah.id/",
      "*.sekolah.id",
      "-a.sekolah.id",
      "a-.sekolah.id",
      "sekolah..id",
      "sekolah.id.",
      "sekolah.123",
      "a.b",
      `${"a".repeat(64)}.id`,
      "",
      42,
      null,
    ]) {
      expect(isWebsiteHost(host)).toBe(false);
    }
  });
});

describe("penilaian untuk server Web", () => {
  const evaluate = (
    text: string | null,
    overrides: Partial<Parameters<typeof evaluateWebLicense>[0]> = {},
  ) =>
    evaluateWebLicense({
      text,
      publicKeyHex: TEST_PUBLIC_HEX,
      instanceCode: INSTANCE,
      host: HOST,
      buildDate: "2026-09-30",
      today: "2026-10-01",
      ...overrides,
    });

  test("tanpa lisensi dan lisensi rusak memblokir", () => {
    expect(evaluate(null).state).toBe("missing");
    expect(evaluate("   ").state).toBe("missing");
    const invalid = evaluate("LIS1.rusak.rusak");
    expect(invalid.state).toBe("invalid");
    expect(invalid.message).toStartWith("Lisensi tidak sah:");
  });

  test("lisensi Desktop saja tidak berlaku di Web", () => {
    const desktopOnly = evaluate(withChanges({ perangkat: [DEVICE] }));
    expect(desktopOnly.state).toBe("device_not_listed");
    expect(desktopOnly.message).toContain("belum mencakup versi Web");
    expect(desktopOnly.message).toContain(INSTANCE);
  });

  test("instance lain ditolak", () => {
    const other = evaluate(
      withChanges({ instance_web: "S-0000-1111-2222-3333" }),
    );
    expect(other.state).toBe("device_not_listed");
    expect(other.message).toContain("tidak terdaftar di lisensi PT Uji");
  });

  test("tanpa daftar website, alamat apa pun diterima (pemasangan LAN)", () => {
    const lan = withChanges({ instance_web: INSTANCE });
    expect(evaluate(lan, { host: "192.168.1.10" }).state).toBe("active");
    expect(evaluate(lan, { host: null }).state).toBe("active");
  });

  test("dengan daftar website, hanya alamat terdaftar yang diterima", () => {
    const online = withChanges({ instance_web: INSTANCE, website: [HOST] });
    expect(evaluate(online).state).toBe("active");
    const other = evaluate(online, { host: "bajakan.example.com" });
    expect(other.state).toBe("device_not_listed");
    expect(other.message).toContain("Alamat bajakan.example.com");
    expect(evaluate(online, { host: null }).state).toBe("device_not_listed");
  });

  test("sewa habis dan versi di luar masa pembaruan: baca-saja", () => {
    const rental = withChanges({
      instance_web: INSTANCE,
      jenis: "sewa",
      berlaku_sampai: "2026-09-30",
    });
    const expired = evaluate(rental);
    expect(expired.state).toBe("read_only");
    expect(expired.readOnlyReason).toBe("expired");
    // Hari terakhir masih berlaku penuh.
    expect(evaluate(rental, { today: "2026-09-30" }).state).toBe("active");

    const oldMaintenance = withChanges({
      instance_web: INSTANCE,
      pembaruan_sampai: "2026-09-29",
    });
    expect(evaluate(oldMaintenance).readOnlyReason).toBe("version_not_covered");
    // Versi yang dibangun sebelum masa pembaruan habis tetap penuh selamanya.
    expect(
      evaluate(oldMaintenance, { buildDate: "2026-09-29", today: "2030-01-01" })
        .state,
    ).toBe("active");
  });
});

describe("pembantu", () => {
  test("izin mode baca-saja sama dengan Rust", () => {
    expect(readOnlyAllows("attendance.view")).toBe(true);
    expect(readOnlyAllows("sync.retry")).toBe(true);
    expect(readOnlyAllows("database_backup.export")).toBe(true);
    expect(readOnlyAllows("attendance.manage")).toBe(false);
    expect(readOnlyAllows("payroll.run")).toBe(false);
  });

  // Vektor yang sama dengan `instance_code_matches_web_server` di `license.rs`.
  test("kode instance diturunkan seperti kode perangkat, berawalan S", () => {
    expect(instanceCodeFromId("web-instance-uji")).toBe(
      "S-D95C-854B-9E1B-0BCF",
    );
  });

  test("sisa sewa: hari terakhir = 1", () => {
    expect(rentalDaysLeft("2026-10-30", "2026-10-01")).toBe(30);
    expect(rentalDaysLeft("2026-10-01", "2026-10-01")).toBe(1);
    expect(rentalDaysLeft("2026-09-30", "2026-10-01")).toBe(0);
  });

  test("host permintaan: tanpa port, huruf kecil, proxy didahulukan", () => {
    const host = (headers: Record<string, string>) =>
      requestHost(new Request("http://x/", { headers }));
    expect(host({ host: "Absensi.Sekolah.id:443" })).toBe("absensi.sekolah.id");
    expect(
      host({ host: "web:3000", "x-forwarded-host": "absensi.sekolah.id" }),
    ).toBe("absensi.sekolah.id");
    expect(host({ host: "192.168.1.10:3000" })).toBe("192.168.1.10");
  });
});

describe("penyimpanan dan gerbang", () => {
  let client: Client;
  const request = (host = "192.168.1.10") =>
    new Request("http://x/", { headers: { host } });

  beforeAll(async () => {
    client = createClient({ url: "file::memory:" });
    await initDatabaseSchema(client);
  });

  beforeEach(async () => {
    await client.execute(
      "DELETE FROM setting_gex_system WHERE key IN ('app_license', 'web_instance_id');",
    );
    invalidateLicenseCache();
    delete process.env.KOS_LICENSE_ENFORCED;
  });

  afterAll(() => {
    delete process.env.KOS_LICENSE_ENFORCED;
    client.close();
  });

  test("kode instance lahir sekali dan tetap sama", async () => {
    const first = await loadLicenseContext(client);
    expect(first.instanceCode).toMatch(
      /^S-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/,
    );
    expect(first.text).toBeNull();
    expect(first.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    invalidateLicenseCache();
    expect((await loadLicenseContext(client)).instanceCode).toBe(
      first.instanceCode,
    );
  });

  test("pembaca tanpa hak tulis tidak melahirkan id instance", async () => {
    // Situs publik membaca database yang sama tetapi tidak pernah menulis ke
    // sana. Tanpa id, kodenya kosong dan lisensi apa pun dinilai tidak
    // tercantum, sampai aplikasi admin dibuka dan melahirkan id-nya.
    const context = await loadLicenseContext(client, { createInstance: false });
    expect(context.instanceCode).toBe("");
    const rows = await client.execute(
      "SELECT COUNT(*) AS total FROM setting_gex_system WHERE key = 'web_instance_id';",
    );
    expect(Number(rows.rows[0]?.total)).toBe(0);
  });

  test("build yang tidak menegakkan lisensi tidak pernah menolak", async () => {
    expect(
      await licenseRejection(client, request(), "attendance.manage"),
    ).toBeNull();
  });

  test("build terkunci menolak tanpa lisensi", async () => {
    process.env.KOS_LICENSE_ENFORCED = "1";
    expect(
      await licenseRejection(client, request(), "attendance.view"),
    ).toContain("belum memiliki lisensi");
    expect(await licenseRejection(client, request(), null)).toContain(
      "belum memiliki lisensi",
    );
  });

  test("lisensi bertanda tangan kunci lain ditolak saat dipasang", async () => {
    // Tanpa opsi tes, pemeriksanya memakai kunci produk; vektor uji
    // ditandatangani kunci uji, jadi ia harus ditolak.
    await expect(
      checkInstallableLicense(client, request(), VECTOR_V3),
    ).rejects.toThrow("Lisensi tidak sah");
  });

  test("lisensi untuk server ini: aktif penuh, lalu baca-saja saat sewa habis", async () => {
    process.env.KOS_LICENSE_ENFORCED = "1";
    const { instanceCode, today } = await loadLicenseContext(client);
    const rejection = (permission: string | null) =>
      licenseRejection(client, request(), permission, UJI);

    await storeLicense(client, withChanges({ instance_web: instanceCode }));
    expect(await rejection("attendance.manage")).toBeNull();

    // Sewa yang berakhir kemarin: melihat dan mengekspor tetap boleh, mengubah
    // tidak. Login (izin kosong) tetap boleh, supaya datanya tidak tersandera.
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    await storeLicense(
      client,
      withChanges({
        instance_web: instanceCode,
        jenis: "sewa",
        terbit: "2020-01-01",
        pembaruan_sampai: "2099-01-01",
        berlaku_sampai: yesterday,
      }),
    );
    expect(await rejection("attendance.view")).toBeNull();
    expect(await rejection("database_backup.export")).toBeNull();
    expect(await rejection(null)).toBeNull();
    expect(await rejection("attendance.manage")).toContain("mode baca-saja");
  });

  test("lisensi yang dikunci ke alamat menolak alamat lain", async () => {
    process.env.KOS_LICENSE_ENFORCED = "1";
    const { instanceCode } = await loadLicenseContext(client);
    await storeLicense(
      client,
      withChanges({ instance_web: instanceCode, website: [HOST] }),
    );
    expect(
      await licenseRejection(client, request(HOST), "attendance.manage", UJI),
    ).toBeNull();
    expect(
      await licenseRejection(
        client,
        request("192.168.1.10"),
        "attendance.view",
        UJI,
      ),
    ).toContain("Alamat 192.168.1.10 tidak tercantum");
  });

  test("hanya lisensi yang aktif penuh untuk server ini yang boleh dipasang", async () => {
    const { instanceCode } = await loadLicenseContext(client);
    const sah = withChanges({ instance_web: instanceCode });
    expect(
      (await checkInstallableLicense(client, request(), sah, UJI)).state,
    ).toBe("active");
    await expect(
      checkInstallableLicense(
        client,
        request(),
        withChanges({ instance_web: "S-0000-1111-2222-3333" }),
        UJI,
      ),
    ).rejects.toThrow("tidak terdaftar di lisensi");
    await expect(
      checkInstallableLicense(client, request(), withChanges({}), UJI),
    ).rejects.toThrow("belum mencakup versi Web");
  });

  test("lisensi tersimpan terbaca lewat konteks setelah cache dibuang", async () => {
    await storeLicense(
      client,
      ` ${VECTOR_V3.slice(0, 50)}\n${VECTOR_V3.slice(50)} `,
    );
    expect((await loadLicenseContext(client)).text).toBe(VECTOR_V3);
  });
});
