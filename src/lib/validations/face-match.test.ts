import { describe, expect, test } from "bun:test";
import {
  decodeFaceVector,
  FACE_MODEL_ID,
  FACE_VECTOR_DIM,
  faceScanRejected,
  faceSimilarity,
  faceVerdict,
  normalizeFaceMode,
  normalizeFaceThreshold,
  quantizeFaceVector,
  validateFaceTemplate,
} from "./face-match";

// Vektor kembar dengan `face_match::tests` di Rust. Ubah satu, ubah keduanya.
const a = Array.from({ length: 1024 }, (_, i) => ((i * 37) % 251) - 125);
const b = Array.from({ length: 1024 }, (_, i) => ((i * 53) % 241) - 120);
const c = a.map((v, i) => v + ((i % 7) - 3) * 5);

function q(values: number[]) {
  const encoded = quantizeFaceVector(values);
  if (!encoded) throw new Error("vektor uji tidak valid");
  return encoded;
}

describe("face-match (vektor kembar dengan face_match.rs)", () => {
  test("kuantisasi int8", () => {
    const encoded = q(a);
    expect(encoded.length).toBe(1368);
    expect(encoded.slice(0, 24)).toBe("gafM8hc9Y4mv1PofRWuRt9wC");
    expect(Array.from(decodeFaceVector(encoded)?.slice(0, 6) ?? [])).toEqual([
      -127, -89, -52, -14, 23, 61,
    ]);
    expect(Array.from(decodeFaceVector(q(c))?.slice(0, 6) ?? [])).toEqual([
      -127, -89, -51, -13, 25, 64,
    ]);
  });

  test("vektor tidak sah ditolak", () => {
    expect(quantizeFaceVector([1, 2, 3])).toBeNull();
    expect(quantizeFaceVector(new Array(FACE_VECTOR_DIM).fill(0))).toBeNull();
    expect(
      quantizeFaceVector([
        Number.NaN,
        ...new Array(FACE_VECTOR_DIM - 1).fill(1),
      ]),
    ).toBeNull();
    expect(decodeFaceVector("AAAA")).toBeNull();
    expect(decodeFaceVector("bukan base64!")).toBeNull();
  });

  test("kemiripan", () => {
    const [da, db, dc] = [a, b, c].map((v) => decodeFaceVector(q(v)));
    if (!da || !db || !dc) throw new Error("decode gagal");
    expect(faceSimilarity(da, da)).toBe(1);
    expect(faceSimilarity(da, dc)).toBe(0.9906);
    expect(faceSimilarity(da, db)).toBe(0.0118);
  });

  test("vonis", () => {
    const ref = { model: FACE_MODEL_ID, vektor: q(a) };
    expect(
      faceVerdict({ model: FACE_MODEL_ID, vektor: q(c) }, ref, 0.55),
    ).toEqual({ vonis: "Cocok", skor: 0.9906 });
    expect(
      faceVerdict({ model: FACE_MODEL_ID, vektor: q(b) }, ref, 0.55),
    ).toEqual({ vonis: "Tidak Cocok", skor: 0.0118 });
    expect(
      faceVerdict({ model: FACE_MODEL_ID, vektor: q(c) }, null, 0.55),
    ).toEqual({ vonis: "Belum Terdaftar", skor: null });
    expect(
      faceVerdict(
        { model: FACE_MODEL_ID, vektor: q(c) },
        { model: "model-lain", vektor: q(a) },
        0.55,
      ),
    ).toEqual({ vonis: "Belum Terdaftar", skor: null });
    expect(faceVerdict(null, ref, 0.55)).toEqual({
      vonis: "Tidak Diperiksa",
      skor: null,
    });
    expect(
      faceVerdict({ model: "model-lain", vektor: q(c) }, ref, 0.55),
    ).toEqual({ vonis: "Tidak Diperiksa", skor: null });
  });

  test("hanya Tidak Cocok pada mode tolak yang menolak", () => {
    expect(faceScanRejected("tolak", "Tidak Cocok")).toBe(true);
    expect(faceScanRejected("pantau", "Tidak Cocok")).toBe(false);
    expect(faceScanRejected("tolak", "Belum Terdaftar")).toBe(false);
    expect(faceScanRejected("tolak", "Tidak Diperiksa")).toBe(false);
  });

  test("normalisasi setting", () => {
    expect(normalizeFaceThreshold("0.6")).toBe(0.6);
    expect(normalizeFaceThreshold(0.3)).toBe(0.3);
    expect(normalizeFaceThreshold("0.29")).toBeNull();
    expect(normalizeFaceThreshold("0.96")).toBeNull();
    expect(normalizeFaceThreshold("")).toBeNull();
    expect(normalizeFaceThreshold("abc")).toBeNull();
    expect(normalizeFaceMode(" Tolak ")).toBe("tolak");
    expect(normalizeFaceMode("pantau")).toBe("pantau");
    expect(normalizeFaceMode("blokir")).toBeNull();
  });

  // Kembar dengan `validate_template` (lewat `template_tidak_sah_tidak_sampai_cloud`).
  test("validasi template", () => {
    const sah = {
      idUnik: "P-1",
      model: FACE_MODEL_ID,
      vektor: q(a),
      jumlahSampel: 3,
      sumber: "kamera" as const,
    };
    expect(validateFaceTemplate(sah)).toBeNull();
    expect(validateFaceTemplate({ ...sah, idUnik: " " })).toBe(
      "Karyawan wajib dipilih.",
    );
    expect(validateFaceTemplate({ ...sah, vektor: "AAAA" })).toBe(
      "Data wajah tidak valid.",
    );
    expect(validateFaceTemplate({ ...sah, jumlahSampel: 21 })).toBe(
      "Jumlah sampel wajah tidak valid.",
    );
    expect(
      validateFaceTemplate({
        ...sah,
        sumber: "upload" as unknown as "kamera",
      }),
    ).toBe("Sumber pendaftaran wajah tidak dikenal.");
  });
});
