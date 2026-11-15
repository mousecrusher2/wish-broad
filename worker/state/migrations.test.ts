import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { migrateSchema } from "./migrations";

describe("schema migrations", () => {
  it("creates the schema once and keeps stored rows when it runs again", async () => {
    // LiveState は起動時にスキーマを適用するため、新しいオブジェクトにはすでにテーブルがある。
    const stub = env.LIVE_STATE.get(env.LIVE_STATE.newUniqueId());
    await runInDurableObject(stub, (_instance, state) => {
      const { sql } = state.storage;
      sql.exec(
        "INSERT INTO users (user_id, display_name) VALUES ('user-1', 'Streamer')",
      );

      migrateSchema(sql);

      expect(
        sql.exec("SELECT version FROM schema_migrations").toArray(),
      ).toEqual([{ version: 1 }]);
      expect(sql.exec("SELECT display_name FROM users").toArray()).toEqual([
        { display_name: "Streamer" },
      ]);
    });
  });
});
