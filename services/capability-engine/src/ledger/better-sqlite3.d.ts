// Minimal local typing for the subset of better-sqlite3 the ledger uses (no @types dependency added).
declare module "better-sqlite3" {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }
  interface Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  interface Transaction<F extends () => unknown> {
    (): ReturnType<F>;
    immediate(): ReturnType<F>;
  }
  class Database {
    constructor(path: string);
    pragma(s: string): unknown;
    exec(sql: string): this;
    prepare(sql: string): Statement;
    transaction<F extends () => unknown>(fn: F): Transaction<F>;
    close(): this;
  }
  export default Database;
}
