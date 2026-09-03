import type { TelemetryRecord, TelemetryStats, TelemetryStore } from "../types.js";

/**
 * In-memory telemetry store: no persistence, but zero native dependencies.
 * Used as the automatic fallback when the SQLite backend's native module
 * fails to load (docs/DESIGN.md risk #1), and directly by tests that don't
 * want to depend on better-sqlite3 compiling successfully in CI.
 */
export class InMemoryTelemetryStore implements TelemetryStore {
  private readonly records: TelemetryRecord[] = [];

  recordAttempt(record: TelemetryRecord): void {
    this.records.push(record);
  }

  getStats(providerId: string, modelId: string, taskType: string): TelemetryStats {
    const matches = this.records.filter(
      (r) => r.providerId === providerId && r.modelId === modelId && r.taskType === taskType,
    );
    return {
      attempts: matches.length,
      successes: matches.filter((r) => r.acceptance === "passed").length,
    };
  }

  allRecords(): TelemetryRecord[] {
    return [...this.records];
  }

  close(): void {
    // nothing to release
  }
}

// Minimal structural shape of the better-sqlite3 API surface this store
// actually uses. Declared locally (rather than importing better-sqlite3's
// types at module scope) so this file never statically imports the native
// module — see openTelemetryStore() below.
interface SqlitePreparedStatement {
  run(params: Record<string, unknown>): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  pragma(sql: string): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): SqlitePreparedStatement;
  close(): void;
}
type SqliteDatabaseCtor = new (path: string) => SqliteDatabase;

/**
 * SQLite-backed telemetry store (docs/DESIGN.md §1.5). Takes an
 * already-loaded better-sqlite3 constructor rather than importing the
 * module itself, so the "native module failed to load" failure mode is
 * something callers (openTelemetryStore) can catch — a module-level
 * `import "better-sqlite3"` would throw before any try/catch in this file
 * ever ran.
 */
export class SqliteTelemetryStore implements TelemetryStore {
  private readonly db: SqliteDatabase;

  constructor(DatabaseCtor: SqliteDatabaseCtor, dbPath: string) {
    this.db = new DatabaseCtor(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        specId TEXT NOT NULL,
        taskType TEXT NOT NULL,
        providerId TEXT NOT NULL,
        modelId TEXT NOT NULL,
        usd REAL NOT NULL,
        latencyMs INTEGER NOT NULL,
        acceptance TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_provider_task
        ON attempts(providerId, modelId, taskType);
    `);
  }

  recordAttempt(record: TelemetryRecord): void {
    this.db
      .prepare(
        `INSERT INTO attempts (specId, taskType, providerId, modelId, usd, latencyMs, acceptance, timestamp)
         VALUES (@specId, @taskType, @providerId, @modelId, @usd, @latencyMs, @acceptance, @timestamp)`,
      )
      .run({ ...record });
  }

  getStats(providerId: string, modelId: string, taskType: string): TelemetryStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS attempts,
                SUM(CASE WHEN acceptance = 'passed' THEN 1 ELSE 0 END) AS successes
         FROM attempts
         WHERE providerId = ? AND modelId = ? AND taskType = ?`,
      )
      .get(providerId, modelId, taskType) as { attempts: number; successes: number | null };

    return { attempts: row.attempts, successes: row.successes ?? 0 };
  }

  allRecords(): TelemetryRecord[] {
    return this.db.prepare(`SELECT * FROM attempts ORDER BY timestamp ASC`).all() as TelemetryRecord[];
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Opens the workspace-local telemetry store, preferring the persistent
 * SQLite backend and falling back to an in-memory-only store (with one
 * clear diagnostic, never a crash) if the native module can't be loaded on
 * this platform. docs/DESIGN.md risk #1.
 */
export async function openTelemetryStore(dbPath: string): Promise<TelemetryStore> {
  try {
    const mod: unknown = await import("better-sqlite3");
    const DatabaseCtor = ((mod as { default?: unknown }).default ?? mod) as SqliteDatabaseCtor;
    return new SqliteTelemetryStore(DatabaseCtor, dbPath);
  } catch (err) {
    // This is the one clear diagnostic docs/DESIGN.md promises on a native-module load failure, not debug noise.
    console.warn(
      `[thp] telemetry: better-sqlite3 failed to load (${(err as Error).message}); ` +
        "falling back to an in-memory-only telemetry store for this session. " +
        "Cost/success history will not persist across restarts. See docs/DESIGN.md risk #1.",
    );
    return new InMemoryTelemetryStore();
  }
}
