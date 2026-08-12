export function hitungJarakHaversine(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const earthRadiusMeters = 6_371_000;
  const latitudeDelta = ((lat2 - lat1) * Math.PI) / 180;
  const longitudeDelta = ((lon2 - lon1) * Math.PI) / 180;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(longitudeDelta / 2) ** 2;
  const angularDistance =
    2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  return Math.round(earthRadiusMeters * angularDistance);
}

export function parseQrToken(qrText: string): {
  valid: boolean;
  pesan: string;
  idUnik: string;
  token: string;
} {
  if (!qrText || typeof qrText !== "string") {
    return {
      valid: false,
      pesan: "QR kosong atau tidak terbaca.",
      idUnik: "",
      token: "",
    };
  }

  const parts = qrText.trim().split("|");
  if (parts.length !== 2) {
    return {
      valid: false,
      pesan: "Format QR tidak valid. Format harus: ID_Unik|Token.",
      idUnik: "",
      token: "",
    };
  }

  const idUnik = parts[0].trim();
  const token = parts[1].trim();
  if (!idUnik || !token) {
    return {
      valid: false,
      pesan: "ID_Unik atau Token kosong di dalam QR.",
      idUnik: "",
      token: "",
    };
  }

  return { valid: true, pesan: "QR Valid.", idUnik, token };
}
