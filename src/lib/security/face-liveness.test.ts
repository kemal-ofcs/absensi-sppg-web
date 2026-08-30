import { describe, expect, test } from "bun:test";
import {
  analyzeFrame,
  evaluateChallengeSignals,
  evaluateLivenessSession,
  evaluateSingleChallenge,
  frameDifference,
  LIVENESS_FRAME_HEIGHT,
  LIVENESS_FRAME_WIDTH,
  type LivenessChallenge,
  type LivenessFrame,
  pickLivenessChallenges,
} from "@/lib/security/face-liveness";
import {
  decodeLivenessFrames,
  encodeLivenessFrames,
} from "@/lib/security/liveness-codec";

interface FaceSpec {
  centerX: number;
  centerY: number;
  radiusX: number;
  radiusY: number;
  /** 0 = mata tertutup rapat, 1 = mata terbuka penuh. */
  eyeOpen: number;
  /** Derau halus supaya frame tidak identik seperti foto cetak yang diam. */
  noiseSeed: number;
  /**
   * Pengali kecerahan seluruh frame. Kamera ponsel murah terus menyetel
   * eksposur sendiri, sehingga seluruh gambar menggelap atau menerang antar
   * frame tanpa ada yang bergerak.
   */
  exposure?: number;
}

/**
 * Membuat frame sintetis berisi elips warna kulit dengan dua "mata" gelap.
 *
 * Menguji modul ini dengan foto asli tidak mungkin dilakukan di CI, sementara
 * elips berwarna kulit sudah cukup untuk membuktikan bahwa deteksi kotak wajah,
 * pergeseran titik berat, perubahan ukuran, dan hilangnya piksel gelap pada
 * pita mata benar-benar terbaca oleh algoritmenya.
 */
function renderFace(
  challenge: LivenessChallenge,
  offsetMs: number,
  spec: FaceSpec,
): LivenessFrame {
  const width = LIVENESS_FRAME_WIDTH;
  const height = LIVENESS_FRAME_HEIGHT;
  const rgb = new Uint8Array(width * height * 3);
  let seed = spec.noiseSeed;
  const nextNoise = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return (seed / 4294967296) * 6 - 3;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const dx = (x - spec.centerX * width) / (spec.radiusX * width);
      const dy = (y - spec.centerY * height) / (spec.radiusY * height);
      const inside = dx * dx + dy * dy <= 1;
      const noise = nextNoise();
      if (!inside) {
        // Latar biru keabu-abuan: sengaja jauh dari rentang warna kulit.
        rgb[offset] = 60 + noise;
        rgb[offset + 1] = 70 + noise;
        rgb[offset + 2] = 95 + noise;
        continue;
      }

      const eyeRow = spec.centerY * height - spec.radiusY * height * 0.25;
      const eyeSpan = Math.max(1.2, spec.radiusY * height * 0.16);
      const eyeDx = Math.abs(x - spec.centerX * width);
      const eyeCenterOffset = spec.radiusX * width * 0.42;
      const onEyeBand = Math.abs(y - eyeRow) <= eyeSpan;
      const onEye =
        onEyeBand && Math.abs(eyeDx - eyeCenterOffset) <= eyeSpan * 1.4;

      if (onEye && spec.eyeOpen > 0.35) {
        rgb[offset] = 46 + noise;
        rgb[offset + 1] = 34 + noise;
        rgb[offset + 2] = 30 + noise;
        continue;
      }
      rgb[offset] = 205 + noise;
      rgb[offset + 1] = 148 + noise;
      rgb[offset + 2] = 122 + noise;
    }
  }
  if (spec.exposure !== undefined && spec.exposure !== 1) {
    for (let index = 0; index < rgb.length; index += 1) {
      rgb[index] = Math.max(
        0,
        Math.min(255, Math.round((rgb[index] as number) * spec.exposure)),
      );
    }
  }
  return { challenge, offsetMs, width, height, rgb };
}

function sequence(
  challenge: LivenessChallenge,
  specs: FaceSpec[],
): LivenessFrame[] {
  return specs.map((spec, index) => renderFace(challenge, index * 120, spec));
}

const NEUTRAL: FaceSpec = {
  centerX: 0.5,
  centerY: 0.5,
  radiusX: 0.28,
  radiusY: 0.42,
  eyeOpen: 1,
  noiseSeed: 7,
};

function withSeed(spec: Partial<FaceSpec>, seed: number): FaceSpec {
  return { ...NEUTRAL, ...spec, noiseSeed: seed };
}

describe("analyzeFrame", () => {
  test("menemukan kotak wajah pada elips warna kulit", () => {
    const signals = analyzeFrame(renderFace("KEDIP", 0, NEUTRAL));
    expect(signals.faceDetected).toBe(true);
    expect(signals.centerX).toBeGreaterThan(0.4);
    expect(signals.centerX).toBeLessThan(0.6);
    expect(signals.boxWidth).toBeGreaterThan(0.3);
  });

  test("tidak menemukan wajah pada frame tanpa warna kulit", () => {
    const blank: LivenessFrame = {
      challenge: "KEDIP",
      offsetMs: 0,
      width: LIVENESS_FRAME_WIDTH,
      height: LIVENESS_FRAME_HEIGHT,
      rgb: new Uint8Array(LIVENESS_FRAME_WIDTH * LIVENESS_FRAME_HEIGHT * 3),
    };
    expect(analyzeFrame(blank).faceDetected).toBe(false);
  });

  test("mata tertutup menurunkan eyeOpenness", () => {
    const open = analyzeFrame(renderFace("KEDIP", 0, NEUTRAL));
    const closed = analyzeFrame(
      renderFace("KEDIP", 0, withSeed({ eyeOpen: 0 }, 7)),
    );
    expect(closed.eyeOpenness).toBeLessThan(open.eyeOpenness * 0.7);
  });

  test("wajah yang mendekat memperbesar kotak wajah", () => {
    const near = analyzeFrame(
      renderFace("DEKATKAN_WAJAH", 0, withSeed({ radiusX: 0.4 }, 7)),
    );
    const far = analyzeFrame(renderFace("DEKATKAN_WAJAH", 0, NEUTRAL));
    expect(near.boxWidth).toBeGreaterThan(far.boxWidth * 1.2);
  });
});

describe("frameDifference", () => {
  test("frame identik menghasilkan selisih nol", () => {
    const frame = renderFace("KEDIP", 0, NEUTRAL);
    expect(frameDifference(frame, frame)).toBe(0);
  });

  test("frame berbeda menghasilkan selisih positif", () => {
    const a = renderFace("KEDIP", 0, NEUTRAL);
    const b = renderFace("KEDIP", 120, withSeed({ centerX: 0.62 }, 11));
    expect(frameDifference(a, b)).toBeGreaterThan(0.01);
  });
});

describe("evaluateLivenessSession", () => {
  const blinkFrames = () =>
    sequence("KEDIP", [
      withSeed({}, 3),
      withSeed({}, 19),
      withSeed({ eyeOpen: 0 }, 31),
      withSeed({ eyeOpen: 0 }, 47),
      withSeed({}, 59),
      withSeed({}, 71),
    ]);

  const leftFrames = () =>
    sequence("TENGOK_KIRI", [
      withSeed({}, 83),
      withSeed({ centerX: 0.46 }, 97),
      withSeed({ centerX: 0.4 }, 109),
      withSeed({ centerX: 0.36 }, 127),
      withSeed({ centerX: 0.38 }, 139),
      withSeed({ centerX: 0.44 }, 151),
    ]);

  const nearFrames = () =>
    sequence("DEKATKAN_WAJAH", [
      withSeed({}, 163),
      withSeed({ radiusX: 0.31, radiusY: 0.45 }, 179),
      withSeed({ radiusX: 0.35, radiusY: 0.48 }, 191),
      withSeed({ radiusX: 0.38, radiusY: 0.49 }, 211),
      withSeed({ radiusX: 0.39, radiusY: 0.49 }, 223),
      withSeed({ radiusX: 0.38, radiusY: 0.49 }, 239),
    ]);

  test("meloloskan sesi yang menuruti seluruh tantangan", () => {
    const verdict = evaluateLivenessSession(
      ["KEDIP", "TENGOK_KIRI", "DEKATKAN_WAJAH"],
      [...blinkFrames(), ...leftFrames(), ...nearFrames()],
    );
    expect(verdict.challenges.map((item) => item.passed)).toEqual([
      true,
      true,
      true,
    ]);
    expect(verdict.passed).toBe(true);
    expect(verdict.score).toBeGreaterThanOrEqual(0.7);
  });

  test("menolak foto diam yang tidak bergerak sama sekali", () => {
    const still = renderFace("KEDIP", 0, NEUTRAL);
    const frames = ["KEDIP", "TENGOK_KIRI", "DEKATKAN_WAJAH"].flatMap(
      (challenge) =>
        Array.from({ length: 6 }, (_, index) => ({
          ...still,
          challenge: challenge as LivenessChallenge,
          offsetMs: index * 120,
        })),
    );
    const verdict = evaluateLivenessSession(
      ["KEDIP", "TENGOK_KIRI", "DEKATKAN_WAJAH"],
      frames,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("Tidak ada gerakan alami");
  });

  test("menolak rekaman yang urutan tantangannya tidak sesuai", () => {
    const verdict = evaluateLivenessSession(
      ["TENGOK_KIRI", "KEDIP", "DEKATKAN_WAJAH"],
      [...blinkFrames(), ...leftFrames(), ...nearFrames()],
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("Urutan tantangan");
  });

  test("menolak sesi tanpa wajah", () => {
    const blank = new Uint8Array(
      LIVENESS_FRAME_WIDTH * LIVENESS_FRAME_HEIGHT * 3,
    );
    for (let index = 0; index < blank.length; index += 1) {
      blank[index] = (index * 7) % 40;
    }
    const frames: LivenessFrame[] = Array.from({ length: 18 }, (_, index) => ({
      challenge: (["KEDIP", "TENGOK_KIRI", "DEKATKAN_WAJAH"] as const)[
        Math.floor(index / 6)
      ] as LivenessChallenge,
      offsetMs: index * 120,
      width: LIVENESS_FRAME_WIDTH,
      height: LIVENESS_FRAME_HEIGHT,
      rgb: blank,
    }));
    const verdict = evaluateLivenessSession(
      ["KEDIP", "TENGOK_KIRI", "DEKATKAN_WAJAH"],
      frames,
    );
    expect(verdict.passed).toBe(false);
  });

  test("menolak rekaman yang terlalu pendek", () => {
    const verdict = evaluateLivenessSession(
      ["KEDIP", "TENGOK_KIRI", "DEKATKAN_WAJAH"],
      blinkFrames().slice(0, 4),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("terlalu pendek");
  });

  test("tantangan yang tidak dituruti tetap gagal", () => {
    // Kepala digerakkan ke kanan padahal yang diminta ke kiri.
    const rightFrames = sequence("TENGOK_KIRI", [
      withSeed({}, 251),
      withSeed({ centerX: 0.55 }, 263),
      withSeed({ centerX: 0.6 }, 277),
      withSeed({ centerX: 0.64 }, 281),
      withSeed({ centerX: 0.62 }, 293),
      withSeed({ centerX: 0.56 }, 307),
    ]);
    const verdict = evaluateLivenessSession(
      ["KEDIP", "TENGOK_KIRI", "DEKATKAN_WAJAH"],
      [...blinkFrames(), ...rightFrames, ...nearFrames()],
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.challenges[1]?.passed).toBe(false);
  });
});

describe("deteksi kedipan pada perangkat kelas bawah", () => {
  /**
   * Ini kegagalan nyata yang dilaporkan dari lapangan: pada ponsel kelas bawah
   * tantangan kedip selalu gagal. Penyebabnya bukan penggunanya — eksposur
   * kamera bergeser antar frame, dan sinyal mata yang dulu diukur secara
   * absolut ikut bergeser jauh lebih besar daripada efek kedipannya sendiri.
   * Sinyal sekarang berupa SELISIH pita mata dan pita pipi, sehingga pergeseran
   * eksposur membatalkan diri sendiri.
   */
  test("kedipan tetap terbaca walau eksposur kamera bergeser tiap frame", () => {
    const exposures = [1, 0.78, 1.22, 0.7, 1.3, 0.85];
    const frames = exposures.map((exposure, index) =>
      renderFace("KEDIP", index * 120, {
        ...NEUTRAL,
        noiseSeed: 311 + index * 7,
        exposure,
        // Mata tertutup pada frame ke-3 dan ke-4, tepat ketika eksposur juga
        // sedang berayun paling jauh.
        eyeOpen: index === 2 || index === 3 ? 0 : 1,
      }),
    );
    const verdict = evaluateSingleChallenge("KEDIP", frames);
    expect(verdict.passed).toBe(true);
  });

  test("ayunan eksposur tanpa kedipan TIDAK dianggap kedipan", () => {
    const exposures = [1, 0.72, 1.28, 0.68, 1.32, 0.8];
    const frames = exposures.map((exposure, index) =>
      renderFace("KEDIP", index * 120, {
        ...NEUTRAL,
        noiseSeed: 409 + index * 11,
        exposure,
        eyeOpen: 1,
      }),
    );
    expect(evaluateSingleChallenge("KEDIP", frames).passed).toBe(false);
  });

  test("garis dasar diambil dari median, bukan frame pertama", () => {
    // Frame pertama sengaja dibuat gelap seperti kamera yang belum mengunci
    // eksposur. Dulu frame inilah yang jadi acuan, sehingga kedipan sesudahnya
    // dibandingkan dengan angka yang salah.
    const frames = [
      renderFace("KEDIP", 0, { ...NEUTRAL, noiseSeed: 5, exposure: 0.45 }),
      renderFace("KEDIP", 120, { ...NEUTRAL, noiseSeed: 17 }),
      renderFace("KEDIP", 240, { ...NEUTRAL, noiseSeed: 29 }),
      renderFace("KEDIP", 360, { ...NEUTRAL, noiseSeed: 41, eyeOpen: 0 }),
      renderFace("KEDIP", 480, { ...NEUTRAL, noiseSeed: 53, eyeOpen: 0 }),
      renderFace("KEDIP", 600, { ...NEUTRAL, noiseSeed: 67 }),
      renderFace("KEDIP", 720, { ...NEUTRAL, noiseSeed: 79 }),
    ];
    expect(evaluateSingleChallenge("KEDIP", frames).passed).toBe(true);
  });

  test("wajah tanpa mata terbaca memberi pesan pencahayaan, bukan pesan kedipan", () => {
    // Elips kulit polos tanpa mata gelap sama sekali: pita mata tidak pernah
    // punya piksel gelap, jadi tidak ada yang bisa turun.
    const frames = Array.from({ length: 6 }, (_, index) =>
      renderFace("KEDIP", index * 120, {
        ...NEUTRAL,
        noiseSeed: 601 + index * 13,
        eyeOpen: 0,
      }),
    );
    const verdict = evaluateSingleChallenge("KEDIP", frames);
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("Mata belum terbaca kamera");
  });
});

describe("evaluateSingleChallenge", () => {
  test("menolak rekaman yang terlalu pendek dengan saran yang jelas", () => {
    const frames = [
      renderFace("TENGOK_KIRI", 0, withSeed({}, 3)),
      renderFace("TENGOK_KIRI", 120, withSeed({ centerX: 0.4 }, 19)),
    ];
    const verdict = evaluateSingleChallenge("TENGOK_KIRI", frames);
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("belum cukup panjang");
  });

  test("menilai satu tantangan tanpa peduli tantangan lain", () => {
    // Inti alur bertahap: langkah yang lolos dinilai sendiri, tidak ikut
    // dijatuhkan oleh langkah lain yang belum dikerjakan.
    const frames = [0.5, 0.46, 0.4, 0.36, 0.38, 0.44].map((centerX, index) =>
      renderFace("TENGOK_KIRI", index * 120, withSeed({ centerX }, 83 + index)),
    );
    const verdict = evaluateSingleChallenge("TENGOK_KIRI", frames);
    expect(verdict.challenge).toBe("TENGOK_KIRI");
    expect(verdict.passed).toBe(true);
  });
});

describe("pickLivenessChallenges", () => {
  test("mengembalikan tantangan unik sebanyak yang diminta", () => {
    const picked = pickLivenessChallenges(() => 0.5, 3);
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
  });

  test("urutan berubah mengikuti sumber acak", () => {
    const values = [0.9, 0.1, 0.5, 0.2];
    let index = 0;
    const first = pickLivenessChallenges(
      () => values[index++ % 4] as number,
      3,
    );
    index = 0;
    const second = pickLivenessChallenges(() => 0, 3);
    expect(first).not.toEqual(second);
  });
});

describe("liveness codec", () => {
  test("encode lalu decode mengembalikan frame yang setara", () => {
    const frames = blinkSample();
    const restored = decodeLivenessFrames(encodeLivenessFrames(frames));
    expect(restored).toHaveLength(frames.length);
    expect(Array.from(restored[0]?.rgb ?? [])).toEqual(
      Array.from(frames[0]?.rgb ?? []),
    );
  });

  test("menolak frame dengan ukuran yang salah", () => {
    expect(() =>
      decodeLivenessFrames([
        { challenge: "KEDIP", offsetMs: 0, width: 8, height: 8, rgb: "AAAA" },
      ]),
    ).toThrow("Format rekaman verifikasi tidak valid.");
  });

  test("menolak tantangan yang tidak dikenal", () => {
    expect(() =>
      decodeLivenessFrames([
        {
          challenge: "LOMPAT",
          offsetMs: 0,
          width: LIVENESS_FRAME_WIDTH,
          height: LIVENESS_FRAME_HEIGHT,
          rgb: "AAAA",
        },
      ]),
    ).toThrow("Tantangan verifikasi tidak dikenal.");
  });
});

function blinkSample() {
  return sequence("KEDIP", [
    withSeed({}, 3),
    withSeed({ eyeOpen: 0 }, 31),
    withSeed({}, 59),
  ]);
}

describe("penilaian berkelanjutan pada jendela bergulir", () => {
  /**
   * Inilah perubahan yang menjawab keluhan "selalu gagal": sistem menilai ulang
   * jendela beberapa detik terakhir pada SETIAP frame, bukan sekali di akhir
   * jendela perekaman yang panjangnya tetap.
   *
   * Pada rancangan lama, kedipan yang terjadi sesudah jendela ditutup dianggap
   * tidak pernah ada dan seluruh langkah harus diulang. Uji ini memastikan
   * gerakan yang dilakukan terlambat tetap terbaca.
   */
  const ROLLING = 24;

  function slidingWindows(frames: LivenessFrame[]) {
    const signals = frames.map(analyzeFrame);
    const verdicts: boolean[] = [];
    for (let end = 1; end <= signals.length; end += 1) {
      const start = Math.max(0, end - ROLLING);
      const window = signals.slice(start, end);
      verdicts.push(
        window.length >= 10 && evaluateChallengeSignals("KEDIP", window).passed,
      );
    }
    return verdicts;
  }

  test("kedipan yang dilakukan terlambat tetap terbaca", () => {
    // 18 frame diam dulu — pengguna masih membaca instruksi atau ragu-ragu —
    // baru berkedip. Jendela perekaman tetap 2,6 detik sudah tertutup di sini.
    const frames: LivenessFrame[] = [];
    for (let index = 0; index < 18; index += 1) {
      frames.push(renderFace("KEDIP", index * 110, withSeed({}, 900 + index)));
    }
    frames.push(
      renderFace("KEDIP", 18 * 110, withSeed({ eyeOpen: 0 }, 950)),
      renderFace("KEDIP", 19 * 110, withSeed({ eyeOpen: 0 }, 951)),
      renderFace("KEDIP", 20 * 110, withSeed({}, 952)),
      renderFace("KEDIP", 21 * 110, withSeed({}, 953)),
    );

    const verdicts = slidingWindows(frames);
    // Belum ada kedipan pada 18 frame pertama: tidak boleh lolos lebih awal.
    expect(verdicts.slice(0, 18).some(Boolean)).toBe(false);
    // Setelah kedipan masuk jendela, langkah ini lolos.
    expect(verdicts.at(-1)).toBe(true);
  });

  test("tidak lolos sebelum gerakan benar-benar dilakukan", () => {
    const diam = Array.from({ length: 26 }, (_, index) =>
      renderFace("KEDIP", index * 110, withSeed({}, 700 + index)),
    );
    expect(slidingWindows(diam).some(Boolean)).toBe(false);
  });
});
