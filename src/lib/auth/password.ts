const PASSWORD_SCHEME = "pbkdf2-sha256";
const PASSWORD_ITERATIONS = 600_000;
const KEY_LENGTH_BYTES = 32;

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function derivePassword(
  password: string,
  salt: Uint8Array,
  iterations: number,
) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new Uint8Array(salt).buffer,
      iterations,
    },
    material,
    KEY_LENGTH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function validatePasswordStrength(password: string) {
  if (password.length < 12) return "Password minimal 12 karakter.";
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
    return "Password harus memiliki huruf kecil dan huruf besar.";
  }
  if (!/\d/.test(password)) return "Password harus memiliki angka.";
  return null;
}

async function hashPasswordValue(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  return [
    PASSWORD_SCHEME,
    PASSWORD_ITERATIONS,
    bytesToBase64(salt),
    bytesToBase64(hash),
  ].join("$");
}

export async function hashPassword(password: string) {
  const strengthError = validatePasswordStrength(password);
  if (strengthError) throw new Error(strengthError);
  return hashPasswordValue(password);
}

// Hanya untuk password legacy yang sudah berhasil diverifikasi. Kebijakan
// kekuatan tetap berlaku pada pembuatan atau perubahan password baru.
export function hashVerifiedPasswordForUpgrade(password: string) {
  return hashPasswordValue(password);
}

export async function verifyPassword(password: string, storedValue: string) {
  const [scheme, iterationsRaw, saltRaw, hashRaw] = storedValue.split("$");
  if (scheme !== PASSWORD_SCHEME || !iterationsRaw || !saltRaw || !hashRaw) {
    return {
      valid: storedValue === password,
      needsUpgrade: storedValue === password,
    };
  }

  const iterations = Number(iterationsRaw);
  if (!Number.isSafeInteger(iterations) || iterations < 100_000) {
    return { valid: false, needsUpgrade: false };
  }

  try {
    const actual = await derivePassword(
      password,
      base64ToBytes(saltRaw),
      iterations,
    );
    const valid = constantTimeEqual(actual, base64ToBytes(hashRaw));
    return { valid, needsUpgrade: valid && iterations < PASSWORD_ITERATIONS };
  } catch {
    return { valid: false, needsUpgrade: false };
  }
}
