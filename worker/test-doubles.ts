// Test doubles shared by the Worker tests. Nothing here is bundled into the
// Worker.
import { DatabaseSync } from "node:sqlite";
import type { LiveStateStorage } from "./live-state";
import type { Bindings } from "./types";

/**
 * A Durable Object's storage backed by an in-memory SQLite database, so that
 * the SQL in ./database runs against a real engine. `getAlarm` reports the
 * alarm the code under test left behind.
 */
export function createTestStorage(): {
  getAlarm(): number | null;
  storage: LiveStateStorage;
} {
  const database = new DatabaseSync(":memory:");
  let alarmAt: number | null = null;

  return {
    getAlarm: () => alarmAt,
    storage: {
      async deleteAlarm() {
        alarmAt = null;
      },
      async setAlarm(scheduledTime) {
        alarmAt = scheduledTime;
      },
      sql: {
        exec(query, ...bindings) {
          const rows = database.prepare(query).all(...bindings);
          return { toArray: () => rows };
        },
      },
      transactionSync(closure) {
        database.exec("BEGIN");
        try {
          const result = closure();
          database.exec("COMMIT");
          return result;
        } catch (error: unknown) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
}

function failUnusedLiveStateAccess(): never {
  throw new Error("Unexpected LiveState access in tests");
}

/**
 * The LIVE_STATE binding for tests that replace `getLiveState`, which is the
 * only code that may touch the binding.
 */
export function createUnusedLiveStateNamespace(): Bindings["LIVE_STATE"] {
  return {
    get: failUnusedLiveStateAccess,
    getByName: failUnusedLiveStateAccess,
    idFromName: failUnusedLiveStateAccess,
    idFromString: failUnusedLiveStateAccess,
    jurisdiction: failUnusedLiveStateAccess,
    newUniqueId: failUnusedLiveStateAccess,
  };
}
