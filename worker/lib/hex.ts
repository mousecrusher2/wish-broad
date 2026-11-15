/** バイト列を 1 バイトあたり 2 文字の小文字 16 進数文字列にエンコードする。 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** 暗号論的に安全なランダムバイト列 `byteLength` バイト分を小文字 16 進数文字列で返す。 */
export function createRandomHex(byteLength: number): string {
  const randomBytes = new Uint8Array(byteLength);
  crypto.getRandomValues(randomBytes);
  return bytesToHex(randomBytes);
}
