import { getDb } from "../db";
import { QuoteError } from "../quotes";
import type { DatabaseSync } from "node:sqlite";

const schemaReady = new WeakSet<DatabaseSync>();
export function mailDb() {
  const db = getDb();
  if (schemaReady.has(db)) return db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_messages (
      id TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES quotes(id),
      rfc_id TEXT NOT NULL UNIQUE, account TEXT NOT NULL, provider_id TEXT, thread_id TEXT,
      sender TEXT NOT NULL, sender_name TEXT NOT NULL, reply_to TEXT NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL, sent_at TEXT NOT NULL, raw BLOB NOT NULL,
      UNIQUE(account, provider_id)
    );
    CREATE INDEX IF NOT EXISTS mail_by_quote ON mail_messages(quote_id);
    CREATE TABLE IF NOT EXISTS mail_links (identifier TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES quotes(id));
    CREATE TABLE IF NOT EXISTS mail_files (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES mail_messages(id),
      name TEXT NOT NULL, mime TEXT NOT NULL, original BLOB NOT NULL, drawing_revision TEXT
    );
    CREATE TABLE IF NOT EXISTS mail_clarifications (
      quote_id TEXT PRIMARY KEY REFERENCES quotes(id), body TEXT NOT NULL, updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mail_account (
      id INTEGER PRIMARY KEY CHECK(id=1), sender TEXT NOT NULL, sealed_refresh TEXT NOT NULL,
      label_id TEXT NOT NULL DEFAULT '', label_name TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS mail_outbox (
      id TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES quotes(id), version INTEGER NOT NULL,
      channel TEXT NOT NULL, recipient TEXT NOT NULL, sender TEXT NOT NULL,
      rfc_id TEXT NOT NULL UNIQUE, thread_id TEXT, raw BLOB NOT NULL, draft_id TEXT,
      status TEXT NOT NULL, receipt TEXT, detail TEXT NOT NULL DEFAULT '',
      lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL,
      UNIQUE(quote_id, version, channel)
    );
    CREATE TABLE IF NOT EXISTS mail_test_mailbox (
      receipt TEXT PRIMARY KEY, rfc_id TEXT NOT NULL UNIQUE, recipient TEXT NOT NULL,
      raw BLOB NOT NULL, received TEXT NOT NULL
    );
  `);
  if (!db.isTransaction) schemaReady.add(db);
  return db;
}

export function mailTransaction<T>(fn: () => T): T {
  const db = mailDb();
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function linkMail(identifier: string, quoteId: string) {
  const db = mailDb();
  const other = db.prepare("SELECT quote_id FROM mail_links WHERE identifier=?").get(identifier);
  if (other && other.quote_id !== quoteId) throw new QuoteError("This message refers to two different quote requests.", 409);
  db.prepare("INSERT OR IGNORE INTO mail_links VALUES (?,?)").run(identifier, quoteId);
}

export const testRecipient = "quotes-test@littlemountain.test";
export const testSender = "nick@littlemountain.test";
export function validAddress(input: string) {
  return input.length <= 254 && /^[^\s<>@,;:\[\]"\\]+@[^\s<>@,;:\[\]"\\]+\.[^\s<>@,;:\[\]"\\]+$/.test(input);
}

