const textEncoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(hex)) {
    throw new Error("Invalid token hash");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const byteOffset = index * 2;
    bytes[index] = Number.parseInt(hex.slice(byteOffset, byteOffset + 2), 16);
  }

  return bytes;
}

async function importPepperKey(pepper: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(pepper),
    {
      hash: "SHA-256",
      name: "HMAC",
    },
    false,
    ["sign", "verify"],
  );
}

export async function hashTokenWithPepper(
  pepper: string,
  token: string,
): Promise<string> {
  if (pepper.length === 0) {
    throw new Error("Token pepper is required");
  }

  const pepperKey = await importPepperKey(pepper);
  const digest = await crypto.subtle.sign(
    "HMAC",
    pepperKey,
    textEncoder.encode(token),
  );

  return bytesToHex(new Uint8Array(digest));
}

export async function verifyTokenHash(
  pepper: string,
  token: string,
  expectedTokenHash: string,
): Promise<boolean> {
  // Live tokens are stored as HMAC(token, LIVE_TOKEN_PEPPER), never as raw
  // bearer tokens. WebCrypto verify avoids reimplementing byte comparison.
  const pepperKey = await importPepperKey(pepper);
  const expectedHashBytes = hexToBytes(expectedTokenHash.toLowerCase());

  return crypto.subtle.verify(
    "HMAC",
    pepperKey,
    expectedHashBytes,
    textEncoder.encode(token),
  );
}
