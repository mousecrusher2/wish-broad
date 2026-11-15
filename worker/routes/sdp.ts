import type { Context } from "hono";

function isSdpContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }

  return contentType.split(";")[0]?.trim().toLowerCase() === "application/sdp";
}

/**
 * リクエストボディの SDP を読み取る。Content-Type が application/sdp でないか、ボディが
 * 空白だけの場合は、そのまま返すべきエラー応答を返す。
 */
export async function readSdpBody(
  c: Context,
  description: "offer" | "answer",
): Promise<string | Response> {
  if (!isSdpContentType(c.req.header("content-type"))) {
    return c.text("Content-Type must be application/sdp", 415);
  }

  const sdp = await c.req.text();
  if (sdp.trim().length === 0) {
    return c.text(`SDP ${description} is required`, 400);
  }

  return sdp;
}
