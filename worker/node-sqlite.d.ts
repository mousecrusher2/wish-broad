// Vitest は Node 上で Worker のテストを実行し、Node 組み込みの SQLite が
// Durable Object の SQL ストレージの代用となる（./test-doubles を参照）。
// Worker プロジェクトでは Node の型定義を読み込まないため、テストで使う分だけをここで宣言する。
declare module "node:sqlite" {
  class StatementSync {
    all(...parameters: (string | number | null)[]): Record<string, unknown>[];
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
