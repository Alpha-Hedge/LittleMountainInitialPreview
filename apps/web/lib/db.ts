import { workspaceRoot } from "./workspace-root";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeLearningTracking } from "./learning-tracking";

export function getDataDir(): string {
  return path.resolve(workspaceRoot(), process.env.LMM_DATA_DIR || "data");
}

// Keep one connection per Next.js worker, including across development reloads.
const connections = globalThis as typeof globalThis & { lmmDb?: DatabaseSync };

export function getDb(): DatabaseSync {
  if (connections.lmmDb) return connections.lmmDb;

  const directory = getDataDir();
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, "quotes.sqlite"));
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS quotes (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        version INTEGER NOT NULL DEFAULT 1,
        draft TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_meta (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    initializeLearningTracking(db);
    connections.lmmDb = db;
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
