import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function openDatabase(path) {
  const raw = new DatabaseSync(path);
  const db = {
    prepare(sql) {
      const statement = raw.prepare(sql);
      let params = [];
      const bound = {
        bind(...args) { params = args; return bound; },
        async first() { return statement.get(...params) ?? null; },
        async all() { return { results: statement.all(...params) }; },
        async run() {
          const result = statement.run(...params);
          return { meta: { changes: Number(result.changes) } };
        },
      };
      return bound;
    },
  };
  return { raw, db };
}

export function applyMigrations(raw, dir = new URL('../../migrations/', import.meta.url)) {
  raw.exec('CREATE TABLE IF NOT EXISTS local_schema_migrations (name TEXT PRIMARY KEY NOT NULL)');
  for (const name of readdirSync(dir).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) {
    if (raw.prepare('SELECT 1 FROM local_schema_migrations WHERE name = ?').get(name)) continue;
    // A failed migration leaves no partial schema changes or recorded version.
    raw.exec('BEGIN IMMEDIATE');
    try {
      raw.exec(readFileSync(new URL(name, dir), 'utf8'));
      raw.prepare('INSERT INTO local_schema_migrations(name) VALUES (?)').run(name);
      raw.exec('COMMIT');
    } catch (error) {
      raw.exec('ROLLBACK');
      throw error;
    }
  }
}
