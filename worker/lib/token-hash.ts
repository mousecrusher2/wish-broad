import { bytesToHex } from "./hex";

const textEncoder = new TextEncoder();

/** @throws {Error} `hex` が偶数長の 16 進数文字列でない場合。 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(hex)) {
    throw new Error("Invalid token hash");
  }

  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
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

/**
 * 配信トークンの HMAC-SHA256（鍵は `pepper`）を小文字 16 進数文字列で返す。ストレージには
 * 生のトークンではなくこの値を保存する。
 *
 * @throws {Error} `pepper` が空の場合。
 */
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

/**
 * `token` の HMAC が保存済みの `expectedTokenHash` と一致するか。比較には WebCrypto の
 * verify を使い、バイト比較を自前で実装しない。
 *
 * @throws {Error} `expectedTokenHash` が 16 進数文字列でない場合。
 */
export async function verifyTokenHash(
  pepper: string,
  token: string,
  expectedTokenHash: string,
): Promise<boolean> {
  const pepperKey = await importPepperKey(pepper);
  const expectedHashBytes = hexToBytes(expectedTokenHash.toLowerCase());

  return crypto.subtle.verify(
    "HMAC",
    pepperKey,
    expectedHashBytes,
    textEncoder.encode(token),
  );
}
