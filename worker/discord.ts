// Discord APIを使用したユーザー認証とギルド管理の関数群

import { DiscordGuildMember } from "./types";

// Discord APIからメンバー情報を取得する関数
export async function getGuildMember(
  accessToken: string,
  guildId: string,
): Promise<DiscordGuildMember> {
  const memberResponse = await fetch(
    `https://discord.com/api/users/@me/guilds/${guildId}/member`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );

  if (!memberResponse.ok) {
    throw new Error(
      `Failed to fetch guild member: ${String(memberResponse.status)}`,
    );
  }

  return await memberResponse.json();
}
