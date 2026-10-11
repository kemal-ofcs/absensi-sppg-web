/**
 * Deteksi wajah + liveness tanpa dependensi, untuk verifikasi "Lupa Password".
 *
 * Kenapa bukan library ML? Aplikasi ini offline-first dan CSP Desktop hanya
 * mengizinkan `ipc:` — memuat model WASM/TFJS berarti membundel berkas beberapa
 * megabyte sekaligus melonggarkan CSP. Modul ini bekerja langsung pada piksel
 * dan tidak menambah satu pun berkas ke bundel.
 *
 * Yang membuatnya tidak sekadar "percaya klien": klien mengirimkan **grid
 * piksel mentah** setiap frame (64x48 RGB), dan server menjalankan ulang fungsi
 * yang persis sama di modul ini untuk menghitung vonisnya sendiri. Nilai
 * liveness yang dikirim klien hanya dipakai untuk umpan balik di layar; yang
 * disimpan dan dipercaya adalah hasil hitungan server. Memalsukannya berarti
 * harus mensintesis rangkaian frame yang benar-benar berperilaku seperti wajah
 * yang menuruti tantangan acak — jauh lebih sulit daripada mengirim
 * `{ "passed": true }`.
 *
 * Batas jujurnya: ini bukan pengenalan wajah dan bukan anti-spoofing tingkat
 * bank. Ia menghalangi foto cetak dan tangkapan layar diam (keduanya gagal
 * tantangan gerak dan uji mikro-gerak), bukan penyerang yang merekam video
 * seseorang menuruti kelima tantangan. Karena itu fotonya tetap disimpan
 * sebagai bukti audit yang bisa diperiksa manusia.
 */

/**
 * Resolusi analisis. 96x72, bukan 64x48.
 *
 * Pada 64x48 kotak wajah hanya setinggi ~20 piksel, sehingga pita mata tinggal
 * ~5 piksel — terlalu sedikit untuk membedakan kedipan dari derau kamera murah.
 * Menaikkan ke 96x72 melipatgandakan piksel pita mata lebih dari dua kali dan
 * itulah satu-satunya cara mendeteksi kedipan tanpa model ML. Payload tetap
 * kecil karena frame hanya dikirim untuk tantangan yang benar-benar lolos.
 */
export const LIVENESS_FRAME_WIDTH = 96;
export const LIVENESS_FRAME_HEIGHT = 72;

/** Ambang lulus keseluruhan sesi. */
export const LIVENESS_MIN_SCORE = 0.7;

/** Jumlah tantangan yang diminta pada satu sesi verifikasi. */
export const LIVENESS_CHALLENGE_COUNT = 3;

export const LIVENESS_CHALLENGES = [
  "KEDIP",
  "TENGOK_KIRI",
  "TENGOK_KANAN",
  "DEKATKAN_WAJAH",
  "JAUHKAN_WAJAH",
] as const;

export type LivenessChallenge = (typeof LIVENESS_CHALLENGES)[number];

export const LIVENESS_CHALLENGE_LABEL: Record<LivenessChallenge, string> = {
  // Satu kedipan, bukan dua. Dua kedipan dalam jendela perekaman yang pendek
  // menggandakan peluang gagal tanpa menambah bukti apa pun — yang dinilai
  // tetap satu penurunan-lalu-pulih pada pita mata.
  KEDIP: "Kedipkan mata satu kali",
  TENGOK_KIRI: "Tengokkan kepala ke kiri",
  TENGOK_KANAN: "Tengokkan kepala ke kanan",
  DEKATKAN_WAJAH: "Dekatkan wajah ke kamera",
  JAUHKAN_WAJAH: "Jauhkan wajah dari kamera",
};

export function isLivenessChallenge(
  value: unknown,
): value is LivenessChallenge {
  return (
    typeof value === "string" &&
    (LIVENESS_CHALLENGES as readonly string[]).includes(value)
  );
}

/** Satu frame mentah: RGB baris-per-baris, panjang = width * height * 3. */
export interface LivenessFrame {
  challenge: LivenessChallenge;
  /** Milidetik sejak frame pertama sesi. Relatif, bukan jam dinding. */
  offsetMs: number;
  width: number;
  height: number;
  rgb: Uint8Array;
}

export interface FrameSignals {
  faceDetected: boolean;
  /** Porsi piksel berwarna kulit terhadap seluruh frame (0..1). */
  coverage: number;
  /** Titik berat kotak wajah, dinormalisasi terhadap lebar/tinggi frame. */
  centerX: number;
  centerY: number;
  boxWidth: number;
  boxHeight: number;
  /**
   * Perkiraan keterbukaan mata (0..1): porsi piksel gelap pada pita mata di
   * sepertiga atas kotak wajah. Mata tertutup menghapus pupil dan bayangan
   * kelopak, sehingga nilainya turun tajam.
   */
  eyeOpenness: number;
  /** Rata-rata luma frame (0..1). */
  brightness: number;
}

export interface ChallengeVerdict {
  challenge: LivenessChallenge;
  passed: boolean;
  score: number;
  reason: string;
}

export interface LivenessVerdict {
  passed: boolean;
  score: number;
  reason: string;
  challenges: ChallengeVerdict[];
  faceRatio: number;
  motion: number;
}

function luma(r: number, g: number, b: number) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Uji warna kulit gabungan RGB + YCbCr.
 *
 * Aturan RGB sendiri terlalu longgar pada dinding kayu/krem; aturan YCbCr
 * sendiri terlalu ketat pada cahaya hangat. Menggabungkan keduanya menahan
 * keduanya sekaligus tanpa perlu model apa pun.
 */
function isSkin(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const rgbRule =
    r > 95 &&
    g > 40 &&
    b > 20 &&
    max - min > 15 &&
    Math.abs(r - g) > 15 &&
    r > g &&
    r > b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const ycbcrRule = cb >= 77 && cb <= 133 && cr >= 133 && cr <= 180;
  return rgbRule && ycbcrRule;
}

function percentile(sorted: number[], ratio: number) {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * ratio)),
  );
  return sorted[index] as number;
}

/**
 * Menghitung sinyal wajah dari satu frame mentah.
 *
 * Kotak wajah diambil dari persentil 8/92 koordinat piksel kulit, bukan min/max
 * mutlak: satu piksel derau di sudut frame tidak boleh melebarkan kotak wajah
 * menjadi seluruh layar dan membuat tantangan "dekatkan wajah" lulus sendiri.
 */
export function analyzeFrame(frame: LivenessFrame): FrameSignals {
  const { width, height, rgb } = frame;
  const empty: FrameSignals = {
    faceDetected: false,
    coverage: 0,
    centerX: 0.5,
    centerY: 0.5,
    boxWidth: 0,
    boxHeight: 0,
    eyeOpenness: 0,
    brightness: 0,
  };
  if (width < 8 || height < 8 || rgb.length < width * height * 3) return empty;

  const xs: number[] = [];
  const ys: number[] = [];
  let brightnessSum = 0;
  let skinCount = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const r = rgb[offset] as number;
      const g = rgb[offset + 1] as number;
      const b = rgb[offset + 2] as number;
      brightnessSum += luma(r, g, b);
      if (isSkin(r, g, b)) {
        skinCount += 1;
        xs.push(x);
        ys.push(y);
      }
    }
  }

  const total = width * height;
  const brightness = brightnessSum / total;
  const coverage = skinCount / total;
  if (skinCount < 24) return { ...empty, brightness };

  xs.sort((left, right) => left - right);
  ys.sort((left, right) => left - right);
  const x0 = percentile(xs, 0.08);
  const x1 = percentile(xs, 0.92);
  const y0 = percentile(ys, 0.08);
  const y1 = percentile(ys, 0.92);
  const boxW = Math.max(1, x1 - x0);
  const boxH = Math.max(1, y1 - y0);
  const aspect = boxH / boxW;

  let faceLumaSum = 0;
  let facePixels = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const offset = (y * width + x) * 3;
      faceLumaSum += luma(
        rgb[offset] as number,
        rgb[offset + 1] as number,
        rgb[offset + 2] as number,
      );
      facePixels += 1;
    }
  }
  const faceLuma = facePixels > 0 ? faceLumaSum / facePixels : brightness;

  // Porsi piksel gelap pada sebuah pita horizontal di dalam kotak wajah.
  // Tepi kiri-kanan dipangkas 12% supaya rambut, telinga, dan latar di pinggir
  // kotak tidak ikut terhitung sebagai "gelap".
  const darkRatio = (topRatio: number, bottomRatio: number) => {
    const top = Math.round(y0 + boxH * topRatio);
    const bottom = Math.round(y0 + boxH * bottomRatio);
    const left = Math.round(x0 + boxW * 0.12);
    const right = Math.round(x1 - boxW * 0.12);
    let dark = 0;
    let count = 0;
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const offset = (y * width + x) * 3;
        const value = luma(
          rgb[offset] as number,
          rgb[offset + 1] as number,
          rgb[offset + 2] as number,
        );
        count += 1;
        if (value < faceLuma * 0.66) dark += 1;
      }
    }
    return count > 0 ? dark / count : 0;
  };

  // Sinyal mata dibaca sebagai SELISIH antara pita mata (20%-46% tinggi wajah)
  // dan pita pipi (58%-85%) yang tidak punya mata.
  //
  // Kamera ponsel murah terus-menerus menyetel eksposur sendiri, sehingga
  // ambang gelap absolut ikut bergeser setiap frame dan penurunan akibat
  // kedipan tenggelam di dalam pergeseran itu. Karena kedua pita bergeser
  // bersama-sama, selisihnya membatalkan efek eksposur dan hanya menyisakan apa
  // yang benar-benar berubah di sekitar mata. Inilah perbaikan tunggal yang
  // paling menentukan pada perangkat kelas bawah.
  const eyeDark = darkRatio(0.2, 0.46);
  const cheekDark = darkRatio(0.58, 0.85);

  return {
    faceDetected:
      coverage >= 0.02 && coverage <= 0.85 && aspect >= 0.42 && aspect <= 2.9,
    coverage,
    centerX: (x0 + x1) / 2 / width,
    centerY: (y0 + y1) / 2 / height,
    boxWidth: boxW / width,
    boxHeight: boxH / height,
    eyeOpenness: Math.max(0, eyeDark - cheekDark),
    brightness,
  };
}

/** Rata-rata selisih luma antar dua frame (0..1). */
export function frameDifference(a: LivenessFrame, b: LivenessFrame) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  const pixels = a.width * a.height;
  if (pixels === 0) return 0;
  let sum = 0;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 3;
    const left = luma(
      a.rgb[offset] as number,
      a.rgb[offset + 1] as number,
      a.rgb[offset + 2] as number,
    );
    const right = luma(
      b.rgb[offset] as number,
      b.rgb[offset + 1] as number,
      b.rgb[offset + 2] as number,
    );
    sum += Math.abs(left - right);
  }
  return sum / pixels;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

/** Median yang tahan pencilan; dipakai untuk garis dasar dan ukuran derau. */
function median(values: readonly number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number);
}

function verdictFor(
  challenge: LivenessChallenge,
  signals: readonly FrameSignals[],
): ChallengeVerdict {
  const usable = signals.filter((signal) => signal.faceDetected);
  if (usable.length < 3) {
    return {
      challenge,
      passed: false,
      score: 0,
      reason: "Wajah tidak terdeteksi cukup lama pada tantangan ini.",
    };
  }
  const baseline = usable[0] as FrameSignals;

  if (challenge === "KEDIP") {
    const openness = usable.map((signal) => signal.eyeOpenness);
    // Garis dasar diambil dari MEDIAN seluruh frame, bukan frame pertama.
    // Frame pertama pada kamera kelas bawah sering masih gelap atau blur karena
    // eksposur belum mengunci; memakainya sebagai acuan membuat kedipan
    // dibandingkan dengan angka yang salah. Kedipan hanya menempati sebagian
    // kecil frame, jadi median tetap mewakili keadaan mata terbuka.
    const baseline = median(openness);
    // Derau diukur dari data itu sendiri (median absolute deviation), lalu
    // ambangnya menyesuaikan. Kamera bersih -> ambang rendah dan kedipan kecil
    // pun terbaca; kamera berderau -> ambang naik supaya derau tidak dianggap
    // kedipan. Ambang relatif dan lantai absolut menjaga keduanya tetap masuk akal.
    const noise = median(openness.map((value) => Math.abs(value - baseline)));
    const threshold = Math.max(0.2 * baseline, 3 * noise, 0.015);

    if (baseline < 0.03) {
      // Pita mata tidak pernah punya piksel gelap sama sekali: yang salah bukan
      // kedipannya, melainkan wajah terlalu gelap, terlalu jauh, atau mata
      // tertutup kacamata/poni. Pesannya harus menunjuk ke sana.
      return {
        challenge,
        passed: false,
        score: 0,
        reason:
          "Mata belum terbaca kamera. Tambah cahaya di depan wajah, lepas kacamata bila memantul, dan dekatkan wajah ke kamera.",
      };
    }

    const minimum = Math.min(...openness);
    const drop = baseline - minimum;
    const recovered = Math.max(...openness.slice(openness.indexOf(minimum)));
    // Mata harus kembali terbuka: penurunan yang tidak pernah pulih berarti
    // wajah bergeser keluar bingkai, bukan berkedip.
    const recovered_enough = recovered >= baseline - threshold * 0.5;
    const passed = drop >= threshold && recovered_enough;
    return {
      challenge,
      passed,
      score: clamp01(drop / Math.max(threshold, 1e-6)) * (passed ? 1 : 0.5),
      reason: passed
        ? "Kedipan terdeteksi."
        : drop >= threshold
          ? "Mata terbaca menutup tetapi tidak terbuka lagi. Tahan wajah tetap di bingkai lalu kedip sekali."
          : "Kedipan belum terbaca. Kedip sekali dengan tegas sambil menatap kamera, jangan menunduk.",
    };
  }

  if (challenge === "TENGOK_KIRI" || challenge === "TENGOK_KANAN") {
    const shifts = usable.map((signal) => signal.centerX - baseline.centerX);
    const extreme =
      challenge === "TENGOK_KIRI" ? Math.min(...shifts) : Math.max(...shifts);
    const magnitude = Math.abs(extreme);
    const correctDirection =
      challenge === "TENGOK_KIRI" ? extreme < 0 : extreme > 0;
    const passed = correctDirection && magnitude >= 0.05;
    return {
      challenge,
      passed,
      score: clamp01(magnitude / 0.05) * (passed ? 1 : 0.4),
      reason: passed
        ? "Gerakan kepala sesuai arah yang diminta."
        : "Gerakan kepala tidak terbaca. Tengokkan kepala lebih jelas.",
    };
  }

  const widths = usable.map((signal) => signal.boxWidth);
  const base = baseline.boxWidth || 1e-6;
  if (challenge === "DEKATKAN_WAJAH") {
    const growth = Math.max(...widths) / base - 1;
    const passed = growth >= 0.18;
    return {
      challenge,
      passed,
      score: clamp01(growth / 0.18) * (passed ? 1 : 0.4),
      reason: passed
        ? "Wajah mendekat sesuai instruksi."
        : "Wajah tidak terlihat mendekat ke kamera.",
    };
  }

  const shrink = 1 - Math.min(...widths) / base;
  const passed = shrink >= 0.15;
  return {
    challenge,
    passed,
    score: clamp01(shrink / 0.15) * (passed ? 1 : 0.4),
    reason: passed
      ? "Wajah menjauh sesuai instruksi."
      : "Wajah tidak terlihat menjauh dari kamera.",
  };
}

/**
 * Frame minimal per tantangan.
 *
 * Perangkat kelas bawah tidak sanggup menghasilkan frame secepat perangkat
 * baru, jadi yang dipatok adalah jendela waktu perekaman, bukan jumlah frame.
 * Angka ini cuma lantai: di bawahnya rangkaian terlalu pendek untuk menilai
 * apa pun dengan jujur.
 */
export const LIVENESS_MIN_FRAMES_PER_CHALLENGE = 5;

/**
 * Menilai satu tantangan saja.
 *
 * Dipakai klien untuk memutuskan boleh-tidaknya lanjut ke tantangan berikutnya,
 * sehingga tantangan yang gagal cukup diulang sendirian alih-alih membatalkan
 * seluruh sesi. Server tetap menilai ulang seluruh rangkaian di akhir memakai
 * fungsi yang sama.
 */
export function evaluateSingleChallenge(
  challenge: LivenessChallenge,
  frames: readonly LivenessFrame[],
): ChallengeVerdict {
  return evaluateChallengeSignals(challenge, frames.map(analyzeFrame));
}

/**
 * Menilai satu tantangan dari sinyal yang SUDAH dihitung.
 *
 * Dipakai perekaman berkelanjutan: setiap frame baru dianalisis sekali lalu
 * dimasukkan ke jendela bergulir, dan penilaiannya dijalankan ulang atas
 * jendela itu pada setiap frame. Tanpa pemisahan ini, menilai ulang berarti
 * menganalisis ulang seluruh frame setiap kali — beban yang tidak sanggup
 * dipikul perangkat kelas bawah, yaitu perangkat yang justru paling
 * membutuhkan penilaian berkelanjutan ini.
 */
export function evaluateChallengeSignals(
  challenge: LivenessChallenge,
  signals: readonly FrameSignals[],
): ChallengeVerdict {
  if (signals.length < LIVENESS_MIN_FRAMES_PER_CHALLENGE) {
    return {
      challenge,
      passed: false,
      score: 0,
      reason: "Rekaman belum cukup panjang untuk dinilai.",
    };
  }
  return verdictFor(challenge, signals);
}

/**
 * Vonis otoritatif satu sesi liveness.
 *
 * Dijalankan di server pada frame mentah yang dikirim klien. Fungsi yang sama
 * dipakai klien hanya untuk umpan balik langsung di layar.
 */
export function evaluateLivenessSession(
  expected: readonly LivenessChallenge[],
  frames: readonly LivenessFrame[],
): LivenessVerdict {
  const fail = (reason: string): LivenessVerdict => ({
    passed: false,
    score: 0,
    reason,
    challenges: [],
    faceRatio: 0,
    motion: 0,
  });

  if (expected.length === 0) return fail("Tantangan liveness tidak tersedia.");
  if (frames.length < expected.length * LIVENESS_MIN_FRAMES_PER_CHALLENGE) {
    return fail("Rekaman verifikasi terlalu pendek. Ulangi proses foto.");
  }
  for (const frame of frames) {
    if (
      frame.width !== LIVENESS_FRAME_WIDTH ||
      frame.height !== LIVENESS_FRAME_HEIGHT ||
      frame.rgb.length !== LIVENESS_FRAME_WIDTH * LIVENESS_FRAME_HEIGHT * 3
    ) {
      return fail("Format rekaman verifikasi tidak valid.");
    }
  }
  // Urutan tantangan pada rekaman wajib sama persis dengan yang diterbitkan
  // server. Tanpa cek ini, klien bisa mengirim ulang rekaman lama untuk
  // tantangan acak yang berbeda.
  const observedOrder: LivenessChallenge[] = [];
  for (const frame of frames) {
    if (observedOrder[observedOrder.length - 1] !== frame.challenge) {
      observedOrder.push(frame.challenge);
    }
  }
  if (
    observedOrder.length !== expected.length ||
    observedOrder.some((challenge, index) => challenge !== expected[index])
  ) {
    return fail("Urutan tantangan tidak sesuai. Ulangi verifikasi.");
  }

  const signals = frames.map(analyzeFrame);
  const faceRatio =
    signals.filter((signal) => signal.faceDetected).length / signals.length;

  let motionSum = 0;
  for (let index = 1; index < frames.length; index += 1) {
    motionSum += frameDifference(
      frames[index - 1] as LivenessFrame,
      frames[index] as LivenessFrame,
    );
  }
  const motion = frames.length > 1 ? motionSum / (frames.length - 1) : 0;

  const challenges = expected.map((challenge) =>
    verdictFor(
      challenge,
      signals.filter((_, index) => frames[index]?.challenge === challenge),
    ),
  );

  if (faceRatio < 0.45) {
    return {
      passed: false,
      score: 0,
      reason:
        "Wajah tidak terdeteksi pada sebagian besar rekaman. Pastikan pencahayaan cukup.",
      challenges,
      faceRatio,
      motion,
    };
  }
  // Foto cetak atau tangkapan layar yang diam menghasilkan mikro-gerak nyaris
  // nol; guncangan ekstrem menandakan kamera diarahkan ke layar bergerak.
  if (motion < 0.004) {
    return {
      passed: false,
      score: 0,
      reason:
        "Tidak ada gerakan alami yang terdeteksi. Verifikasi menolak foto atau layar diam.",
      challenges,
      faceRatio,
      motion,
    };
  }
  if (motion > 0.55) {
    return {
      passed: false,
      score: 0,
      reason: "Gambar terlalu tidak stabil. Tahan perangkat lebih diam.",
      challenges,
      faceRatio,
      motion,
    };
  }

  const failed = challenges.find((verdict) => !verdict.passed);
  const meanScore =
    challenges.reduce((sum, verdict) => sum + verdict.score, 0) /
    challenges.length;
  const score = clamp01(meanScore * 0.75 + faceRatio * 0.25);
  return {
    passed: !failed && score >= LIVENESS_MIN_SCORE,
    score,
    reason: failed
      ? failed.reason
      : score >= LIVENESS_MIN_SCORE
        ? "Verifikasi wajah berhasil."
        : "Kualitas verifikasi belum mencukupi. Ulangi di tempat yang lebih terang.",
    challenges,
    faceRatio,
    motion,
  };
}

/**
 * Memilih urutan tantangan acak. Selalu dipanggil di server: tantangan yang
 * dipilih klien sendiri tidak membuktikan apa pun.
 */
export function pickLivenessChallenges(
  random: () => number = Math.random,
  count = LIVENESS_CHALLENGE_COUNT,
): LivenessChallenge[] {
  const pool = [...LIVENESS_CHALLENGES];
  const picked: LivenessChallenge[] = [];
  const size = Math.min(count, pool.length);
  for (let index = 0; index < size; index += 1) {
    const choice = Math.min(
      pool.length - 1,
      Math.max(0, Math.floor(random() * pool.length)),
    );
    picked.push(pool.splice(choice, 1)[0] as LivenessChallenge);
  }
  return picked;
}
