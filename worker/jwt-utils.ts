// JWT関連のユーティリティ関数

// 現在のUnixタイムスタンプを取得
export function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

// 指定した秒数後のUnixタイムスタンプを取得
export function getExpirationTimestamp(durationInSeconds: number): number {
  return getCurrentTimestamp() + durationInSeconds;
}

// JWT用のiat（issued at）とexp（expiration）を計算
export function calculateJwtTimestamps(durationInSeconds: number = 60 * 60 * 24): { iat: number; exp: number } {
  const iat = getCurrentTimestamp();
  const exp = iat + durationInSeconds;
  return { iat, exp };
}

// よく使用される期間の定数
export const JWT_DURATION_SECONDS = {
  ONE_HOUR: 60 * 60,
  ONE_DAY: 60 * 60 * 24,
  ONE_WEEK: 60 * 60 * 24 * 7,
  ONE_MONTH: 60 * 60 * 24 * 30,
} as const;
