/** バイト列を 1 バイトあたり 2 文字の小文字 16 進数文字列にエンコードする。 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** 偶数長の 16 進数文字列（大文字小文字を問わない）をバイト列にデコードする。不正な文字列なら null。 */
export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(hex)) {
    return null;
  }

  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

/** 暗号論的に安全なランダムバイト列 `byteLength` バイト分を小文字 16 進数文字列で返す。 */
export function createRandomHex(byteLength: number): string {
  const randomBytes = new Uint8Array(byteLength);
  crypto.getRandomValues(randomBytes);
  return bytesToHex(randomBytes);
}
