/** Encodes bytes as lowercase hexadecimal, two characters per byte. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Returns `byteLength` cryptographically random bytes as lowercase hex. */
export function createRandomHex(byteLength: number): string {
  const randomBytes = new Uint8Array(byteLength);
  crypto.getRandomValues(randomBytes);
  return bytesToHex(randomBytes);
}
