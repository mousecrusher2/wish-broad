import { bytesToHex, hexToBytes } from "./hex";

const textEncoder = new TextEncoder();

/** @throws {Error} `secret` が空の場合。 */
async function importSigningKey(secret: string): Promise<CryptoKey> {
  if (secret.length === 0) {
    throw new Error("Play session signing key is required");
  }

  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    {
      hash: "SHA-256",
      name: "HMAC",
    },
    false,
    ["sign", "verify"],
  );
}

/** 署名の入力を、区切り文字が値に含まれても別の組と同じにならないよう JSON 配列として符号化する。 */
function encodeSignedFields(sessionId: string, viewerUserId: string) {
  return textEncoder.encode(JSON.stringify([sessionId, viewerUserId]));
}

/**
 * 再生セッション `sessionId` と、それを作った視聴者 `viewerUserId` の組に対する
 * HMAC-SHA256 署名を小文字 16 進数文字列で返す。
 *
 * @throws {Error} `secret` が空の場合。
 */
export async function signPlaySession(
  secret: string,
  sessionId: string,
  viewerUserId: string,
): Promise<string> {
  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encodeSignedFields(sessionId, viewerUserId),
  );

  return bytesToHex(new Uint8Array(signature));
}

/**
 * `signature` が `sessionId` と `viewerUserId` の組への署名か。16 進数として不正な署名は false。
 * 比較には WebCrypto の verify を使い、バイト比較を自前で実装しない。
 *
 * @throws {Error} `secret` が空の場合。
 */
export async function verifyPlaySessionSignature(
  secret: string,
  sessionId: string,
  viewerUserId: string,
  signature: string,
): Promise<boolean> {
  const key = await importSigningKey(secret);
  const signatureBytes = hexToBytes(signature);
  if (signatureBytes === null) {
    return false;
  }

  return crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    encodeSignedFields(sessionId, viewerUserId),
  );
}
