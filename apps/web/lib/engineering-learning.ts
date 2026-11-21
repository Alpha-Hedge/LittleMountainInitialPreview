import { createHash } from "node:crypto";
import { getDb } from "./db";
import { engineeringConnection } from "./engineering-connection";
import type { LearningEntity } from "./learning-export";

type Source = { id: string; file_name: string; mime: string; sha256: string };
type Entry = { key: string; id: string; kind: string; stamp: string };
const table = () => {
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS engineering_learning (key TEXT PRIMARY KEY, stamp TEXT NOT NULL, payload TEXT NOT NULL);"
    + "CREATE TABLE IF NOT EXISTS engineering_learning_files (sha256 TEXT PRIMARY KEY, original BLOB NOT NULL);");
  return db;
};

export function exportEngineeringLearning(key: string, generation: number): LearningEntity {
  const db = table();
  const row = db.prepare("SELECT payload FROM engineering_learning WHERE key=?").get(key);
  if (!row) throw new Error("Engineering history is unavailable.");
  const { data, source, kind } = JSON.parse(String(row.payload)) as {
    data: Record<string, unknown>; source: Source | null; kind: string;
  };
  const files: LearningEntity["files"] = [];
  if (source) {
    const original = db.prepare("SELECT original FROM engineering_learning_files WHERE sha256=?").get(source.sha256)?.original;
    if (!(original instanceof Uint8Array)) throw new Error("Engineering source file is unavailable.");
    files.push({ sha256: source.sha256, bytes: Buffer.from(original), fileName: source.file_name, mimeType: source.mime });
  }
  return { key, generation, records: [{ kind: "engineering_" + kind, key, data: { ...data, source } }], files, candidates: [] };
}

export async function captureEngineeringLearning(after: string, limit = 20) {
  const connection = engineeringConnection();
  if (!connection) return "";
  const db = table();
  const fetchRecord = async (path: string) => {
    const response = await fetch(connection.origin + path, {
      headers: { Authorization: "Bearer " + connection.token },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Engineering history transfer is waiting for the engineering service.");
    return response;
  };
  const prefix = "/v1/learning/engineering";
  const entries: Entry[] = await (await fetchRecord(prefix + "?limit=" + limit + "&after=" + encodeURIComponent(after))).json();
  for (const entry of entries) {
    const key = "engineering:" + entry.key;
    if (db.prepare("SELECT 1 FROM engineering_learning WHERE key=? AND stamp=?").get(key, entry.stamp)) continue;
    const body = await (await fetchRecord(prefix + "/" + entry.kind + "/" + entry.id)).json() as {
      data: Record<string, unknown>; source: Source | null;
    };
    const source = body.source;
    let bytes: Buffer | undefined;
    if (source && !db.prepare("SELECT 1 FROM engineering_learning_files WHERE sha256=?").get(source.sha256)) {
      const file = await fetchRecord("/v1/drawings/" + source.id + "/source");
      bytes = Buffer.from(await file.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
        throw new Error("An engineering source checksum did not match.");
    }
    db.exec("SAVEPOINT engineering_learning_capture");
    try {
      if (bytes && source) db.prepare("INSERT OR IGNORE INTO engineering_learning_files VALUES(?,?)").run(source.sha256, bytes);
      db.prepare("INSERT INTO engineering_learning VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET stamp=excluded.stamp,payload=excluded.payload")
        .run(key, entry.stamp, JSON.stringify({ ...body, kind: entry.kind }));
      db.prepare("INSERT INTO learning_queue(entity_key,generation) VALUES(?,?) ON CONFLICT(entity_key) DO UPDATE SET generation=MAX(generation+1,excluded.generation)")
        .run(key, Date.now());
      db.exec("RELEASE engineering_learning_capture");
    } catch (error) {
      db.exec("ROLLBACK TO engineering_learning_capture; RELEASE engineering_learning_capture");
      throw error;
    }
  }
  return entries.length < limit ? "" : entries.at(-1)!.key;
}
