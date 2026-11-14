// Worker テスト間で共有されるテストダブル。このファイルのコードは Worker にはバンドルされない。
import { DatabaseSync } from "node:sqlite";
import type { LiveStateStorage } from "./live-state";
import type { Bindings } from "./types";

/**
 * インメモリ SQLite データベースをバックエンドとする Durable Object 用ストレージ。
 * これにより ./database の SQL を実エンジン上で動作させる。`getAlarm` は
 * テスト対象コードが設定したままにしたアラーム時刻を返す。
 *
 * アラームは自動的には発火しない。アラームを発火させるテストはランタイムと同様に
 * まずアラームをクリアする（実行中のアラームはすでに設定済みとはみなされない）。
 *
 * `transaction` は Durable Objects storage のドキュメントで保証された通りの動作のみを行う。
 * クロージャー実行中に行われたすべての操作（アラーム操作を含む）はそのトランザクションに属し、
 * クロージャーが `rollback()` を呼んだ場合のみロールバックされる。クロージャーが単に例外を
 * スローしただけでは書き込んだ内容は保持されるため、ドキュメント化されていない暗黙ロールバックに
 * 依存するコードはテストで失敗する。
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
 * `getLiveState` を差し替えるテスト用の LIVE_STATE バインディング。
 * このバインディングに直接触れてよいのは `getLiveState` のみ。
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
