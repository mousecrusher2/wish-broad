import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    restoreMocks: true,
    projects: [
      {
        extends: true,
        plugins: [
          // Worker のテストは本番と同じ workerd 上で実行し、wrangler.jsonc の
          // LiveState Durable Object（SQLite ストレージとアラームを含む）をそのまま使う。
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              // wrangler.jsonc が要求するシークレットのテスト用の値。ローカルの
              // .dev.vars より優先されるため、テストは開発用の設定に左右されない。
              bindings: {
                AUTHORIZED_GUILD_ID: "guild-1",
                CALLS_APP_ID: "calls-app-id",
                CALLS_APP_SECRET: "calls-app-secret",
                DISCORD_CLIENT_ID: "discord-client-id",
                DISCORD_CLIENT_SECRET: "discord-client-secret",
                ENVIRONMENT: "production",
                JWT_SECRET: "test-jwt-secret",
                LIVE_TOKEN_PEPPER: "test-live-token-pepper",
                LOG_LEVEL: "info",
                NOTIFICATIONS_DISCORD_WEBHOOK_URL:
                  "https://discord.com/api/webhooks/123/token",
                TURN_KEY_API_TOKEN: "turn-key-api-token",
                TURN_KEY_ID: "turn-key-id",
              },
            },
          }),
        ],
        test: {
          name: "worker",
          include: ["worker/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "client",
          environment: "node",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
        },
      },
    ],
  },
});
