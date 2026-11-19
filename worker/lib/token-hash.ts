import { bytesToHex, hexToBytes } from "./hex";

const textEncoder = new TextEncoder();

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
  const expectedHashBytes = hexToBytes(expectedTokenHash);
  if (expectedHashBytes === null) {
    throw new Error("Invalid token hash");
  }

  return crypto.subtle.verify(
    "HMAC",
    pepperKey,
    expectedHashBytes,
    textEncoder.encode(token),
  );
}
