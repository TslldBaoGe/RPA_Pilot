import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import type { DbStats } from '@shared/types'
import type { ProjectPaths } from './paths'
import { resolve } from 'node:path'

/** better-sqlite3 的数据库实例类型 */
export type Db = Database.Database

interface Migration {
  version: number
  statements: string
}

/**
 * 迁移用 SQLite 内置的 user_version 做版本号，顺序执行、只前进不回退。
 * 新增字段一律追加一条新迁移，不修改历史迁移。
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: `
      CREATE TABLE IF NOT EXISTS tasks (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE,
        script_path     TEXT NOT NULL,
        conda_env       TEXT NOT NULL,
        cwd             TEXT,
        args            TEXT NOT NULL DEFAULT '[]',
        cron_expr       TEXT,
        timezone        TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        timeout_sec     INTEGER NOT NULL DEFAULT 0,
        overlap_policy  TEXT NOT NULL DEFAULT 'skip',
        retry_times     INTEGER NOT NULL DEFAULT 0,
        notify_on_fail  INTEGER NOT NULL DEFAULT 0,
        enabled         INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      -- trigger 是 SQLite 关键字，故列名用 trigger_type
      CREATE TABLE IF NOT EXISTS runs (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        trigger_type  TEXT NOT NULL,
        status        TEXT NOT NULL,
        exit_code     INTEGER,
        pid           INTEGER,
        started_at    TEXT,
        finished_at   TEXT,
        duration_ms   INTEGER,
        log_path      TEXT,
        error_summary TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_task_started ON runs(task_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  },
  {
    // 「待配置」必须是显式字段：靠「名称等于文件名」来猜是不可靠的
    version: 2,
    statements: `
      ALTER TABLE tasks ADD COLUMN configured INTEGER NOT NULL DEFAULT 0;
    `
  }
]

export function openDatabase(paths: ProjectPaths): Db {
  // 目录先就位，SQLite 不会自己建父目录
  mkdirSync(paths.dataDir, { recursive: true })
  mkdirSync(paths.tasksDir, { recursive: true })
  mkdirSync(paths.logsDir, { recursive: true })

  const db = new Database(paths.dbFile)

  // WAL：UI 查询与调度写入互不阻塞，单机场景最合适
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  migrate(db)
  return db
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue

    db.exec('BEGIN')
    try {
      db.exec(migration.statements)
      db.pragma(`user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(
        `数据库迁移到 v${migration.version} 失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

export function readStats(db: Db, dbFile: string): DbStats {
  const count = (sql: string): number => (db.prepare(sql).get() as { c: number }).c

  return {
    dbFile: resolve(dbFile),
    taskCount: count('SELECT COUNT(*) AS c FROM tasks'),
    enabledTaskCount: count('SELECT COUNT(*) AS c FROM tasks WHERE enabled = 1'),
    runCount: count('SELECT COUNT(*) AS c FROM runs'),
    runningRunCount: count("SELECT COUNT(*) AS c FROM runs WHERE status = 'running'"),
    schemaVersion: db.pragma('user_version', { simple: true }) as number,
    journalMode: String(db.pragma('journal_mode', { simple: true }))
  }
}
