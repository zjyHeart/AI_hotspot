import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";

function open(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  // Preserve a consistent SQLite backup before the additive reliability migration.
  const hasMonitors = sqlite
    .prepare(
      "select name from sqlite_master where type='table' and name='monitors'",
    )
    .get();
  const needsBackup =
    hasMonitors &&
    (!(sqlite.pragma("table_info(monitors)") as { name: string }[]).some(
      (c) => c.name === "quality",
    ) ||
      !sqlite
        .prepare(
          "select name from sqlite_master where type='table' and name='analysis_candidates'",
        )
        .get());
  if (path !== ":memory:" && needsBackup) {
    const directory = resolve(dirname(path), "backups");
    mkdirSync(directory, { recursive: true });
    sqlite
      .prepare("VACUUM INTO ?")
      .run(
        resolve(
          directory,
          `before-analysis-pipeline-${Date.now()}-${process.pid}.db`,
        ),
      );
  }
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  return { db, sqlite };
}
const globalDb = globalThis as typeof globalThis & {
  signalDatabases?: Map<string, ReturnType<typeof open>>;
};
globalDb.signalDatabases ??= new Map();
export function getStore() {
  const input = (process.env.DATABASE_URL || "./data/hotspot.db").replace(
    /^file:/,
    "",
  );
  const path =
    input === ":memory:"
      ? input
      : resolve(/* turbopackIgnore: true */ process.cwd(), input);
  if (!globalDb.signalDatabases!.has(path))
    globalDb.signalDatabases!.set(path, open(path));
  return globalDb.signalDatabases!.get(path)!;
}
export function getDb() {
  return getStore().db;
}
