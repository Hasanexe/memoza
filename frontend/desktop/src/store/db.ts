import Database from '@tauri-apps/plugin-sql';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS local_note (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title_ct TEXT NOT NULL,
    body_ct TEXT NOT NULL,
    tags_ct TEXT,
    wrapped_cek TEXT NOT NULL,
    wrap_method TEXT NOT NULL,
    has_unread_comment INTEGER NOT NULL DEFAULT 0,
    page_no INTEGER,
    is_public INTEGER NOT NULL DEFAULT 0,
    rev INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS local_comment (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    body_ct TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cursor TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS local_account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    wrapped_dek TEXT NOT NULL,
    wrapped_private_key TEXT NOT NULL,
    biometric_enabled INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS write_queue (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    note_id TEXT,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    failed INTEGER NOT NULL DEFAULT 0
  )`,
];

const ALTER_STATEMENTS = [
  'ALTER TABLE local_note ADD COLUMN page_no INTEGER',
  'ALTER TABLE local_note ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE local_account ADD COLUMN username TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE write_queue ADD COLUMN failed INTEGER NOT NULL DEFAULT 0',
];

let dbPromise: Promise<Database> | null = null;

export async function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await Database.load('sqlite:memoza.db');
      for (const statement of MIGRATIONS) await db.execute(statement);
      for (const statement of ALTER_STATEMENTS) {
        try {
          await db.execute(statement);
        } catch {
          // column already exists on an upgraded database
        }
      }
      const seed = await db.select<{ id: number }[]>('SELECT id FROM sync_state WHERE id = 1');
      if (seed.length === 0) await db.execute('INSERT INTO sync_state (id, cursor) VALUES (1, NULL)');
      return db;
    })();
  }
  return dbPromise;
}

export async function getCursor(): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ cursor: string | null }[]>('SELECT cursor FROM sync_state WHERE id = 1');
  return rows[0]?.cursor ?? null;
}

export async function setCursor(cursor: string | null): Promise<void> {
  const db = await getDb();
  await db.execute('UPDATE sync_state SET cursor = ? WHERE id = 1', [cursor]);
}

export async function wipeLocalStore(): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM local_note');
  await db.execute('DELETE FROM local_comment');
  await db.execute('DELETE FROM write_queue');
  await db.execute('UPDATE sync_state SET cursor = NULL WHERE id = 1');
}
