/** 現在時刻の Unix 秒（JWT の数値日時は秒単位）。 */
function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

/** 現在時刻に発行され `durationInSeconds` 秒後に失効する JWT の `iat` と `exp`。 */
export function calcJwtTimestamps(durationInSeconds: number = 60 * 60 * 24): {
  iat: number;
  exp: number;
} {
  const iat = getCurrentTimestamp();
  const exp = iat + durationInSeconds;
  return { iat, exp };
}

export const JWT_DURATION_SECONDS = {
  ONE_HOUR: 60 * 60,
  ONE_DAY: 60 * 60 * 24,
  ONE_WEEK: 60 * 60 * 24 * 7,
  ONE_MONTH: 60 * 60 * 24 * 30,
} satisfies Readonly<{
  ONE_DAY: number;
  ONE_HOUR: number;
  ONE_MONTH: number;
  ONE_WEEK: number;
}>;
