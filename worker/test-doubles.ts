// Test doubles shared by the Worker tests. Nothing here is bundled into the
// Worker.
import { DatabaseSync } from "node:sqlite";
import type { LiveStateStorage } from "./live-state";
import type { Bindings } from "./types";

/**
 * A Durable Object's storage backed by an in-memory SQLite database, so that
 * the SQL in ./database runs against a real engine. `getAlarm` reports the
 * alarm the code under test left behind.
 *
 * The alarm does not fire by itself. A test that fires it clears it first, as
 * the runtime does: the alarm that is running no longer counts as set.
 *
 * `transaction` does what the Durable Objects storage documentation promises
 * and no more: every operation made while its closure runs, alarm calls
 * included, belongs to the transaction, and it is rolled back only when the
 * closure calls `rollback()`. A closure that merely throws keeps what it
 * wrote, so code that counts on an undocumented rollback fails its tests.
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
      async getAlarm() {
        return alarmAt;
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
      async transaction(closure) {
        const alarmBefore = alarmAt;
        const state = { isRolledBack: false };
        database.exec("BEGIN");
        try {
          return await closure({
            rollback() {
              if (!state.isRolledBack) {
                database.exec("ROLLBACK");
                alarmAt = alarmBefore;
                state.isRolledBack = true;
              }
            },
          });
        } finally {
          if (!state.isRolledBack) {
            database.exec("COMMIT");
          }
        }
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
