// Vitest runs the Worker tests in Node, whose built-in SQLite stands in for a
// Durable Object's SQL storage (see ./test-doubles). The Worker project does
// not load Node's type definitions, so this declares only what the tests use.
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
