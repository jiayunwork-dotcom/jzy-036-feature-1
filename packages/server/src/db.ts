/**
 * 持久化层（SQLite）：Schema 文档为一等实体，每次内容更新落一条版本快照。
 * 文档之间按 id 行隔离，更新走事务 + revision 乐观锁，防止并发编辑互相覆盖。
 */
import Database from 'better-sqlite3';
import type { Database as DBType } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface DocRecord {
  id: number;
  name: string;
  content: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface VersionRecord {
  version: number;
  revision: number;
  content: string;
  created_at: string;
  note: string | null;
}

export interface CreateDocInput {
  name: string;
  content: string;
}

export interface UpdateDocInput {
  content: string;
  /** 调用方持有的 revision；与库内不一致则拒绝（防并发覆盖） */
  expectedRevision: number;
  note?: string;
}

export interface UpdateResult {
  conflict: boolean;
  doc?: DocRecord;
  version?: number;
  currentRevision?: number;
}

export interface Repository {
  createDoc(input: CreateDocInput): DocRecord;
  listDocs(): Array<Pick<DocRecord, 'id' | 'name' | 'revision' | 'created_at' | 'updated_at'>>;
  getDoc(id: number): DocRecord | undefined;
  updateDoc(id: number, input: UpdateDocInput): UpdateResult;
  renameDoc(id: number, name: string): DocRecord | undefined;
  deleteDoc(id: number): boolean;
  listVersions(id: number): VersionRecord[];
  getVersion(id: number, version: number): VersionRecord | undefined;
  /** 回滚 = 把历史版本内容作为一次新的更新写入（保留版本轨迹连续性） */
  rollbackToVersion(id: number, version: number, expectedRevision: number): UpdateResult;
  close(): void;
}

export function openDatabase(filename: string): DBType {
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      content TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(document_id, version)
    );
  `);
  return db;
}

export function createRepository(db: DBType): Repository {
  const insertDoc = db.prepare(
    `INSERT INTO documents (name, content, revision) VALUES (@name, @content, 1)`,
  );
  const insertVersion = db.prepare(
    `INSERT INTO versions (document_id, version, revision, content, note)
     VALUES (@document_id, @version, @revision, @content, @note)`,
  );
  const selectDoc = db.prepare(`SELECT * FROM documents WHERE id = ?`);
  const maxVersion = db.prepare(
    `SELECT COALESCE(MAX(version), 0) AS v FROM versions WHERE document_id = ?`,
  );

  function createDoc(input: CreateDocInput): DocRecord {
    const tx = db.transaction(() => {
      const info = insertDoc.run({ name: input.name, content: input.content });
      const id = Number(info.lastInsertRowid);
      insertVersion.run({ document_id: id, version: 1, revision: 1, content: input.content, note: '创建文档' });
      return selectDoc.get(id) as DocRecord;
    });
    return tx();
  }

  function listDocs() {
    return db
      .prepare(
        `SELECT id, name, revision, created_at, updated_at FROM documents ORDER BY updated_at DESC, id DESC`,
      )
      .all() as Array<Pick<DocRecord, 'id' | 'name' | 'revision' | 'created_at' | 'updated_at'>>;
  }

  function getDoc(id: number): DocRecord | undefined {
    return selectDoc.get(id) as DocRecord | undefined;
  }

  function applyContentUpdate(id: number, content: string, expectedRevision: number, note: string): UpdateResult {
    const tx = db.transaction((): UpdateResult => {
      const current = selectDoc.get(id) as DocRecord | undefined;
      if (!current) return { conflict: true };
      if (current.revision !== expectedRevision) {
        return { conflict: true, currentRevision: current.revision };
      }
      const nextRevision = current.revision + 1;
      db.prepare(
        `UPDATE documents SET content = ?, revision = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(content, nextRevision, id);
      const nextVersion = (maxVersion.get(id) as { v: number }).v + 1;
      insertVersion.run({
        document_id: id,
        version: nextVersion,
        revision: nextRevision,
        content,
        note,
      });
      return { conflict: false, doc: selectDoc.get(id) as DocRecord, version: nextVersion };
    });
    return tx();
  }

  function updateDoc(id: number, input: UpdateDocInput): UpdateResult {
    return applyContentUpdate(id, input.content, input.expectedRevision, input.note ?? '保存修改');
  }

  function renameDoc(id: number, name: string): DocRecord | undefined {
    db.prepare(
      `UPDATE documents SET name = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(name, id);
    return getDoc(id);
  }

  function deleteDoc(id: number): boolean {
    const info = db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  function listVersions(id: number): VersionRecord[] {
    return db
      .prepare(
        `SELECT version, revision, content, created_at, note FROM versions
         WHERE document_id = ? ORDER BY version DESC`,
      )
      .all(id) as VersionRecord[];
  }

  function getVersion(id: number, version: number): VersionRecord | undefined {
    return db
      .prepare(
        `SELECT version, revision, content, created_at, note FROM versions
         WHERE document_id = ? AND version = ?`,
      )
      .get(id, version) as VersionRecord | undefined;
  }

  function rollbackToVersion(id: number, version: number, expectedRevision: number): UpdateResult {
    const v = getVersion(id, version);
    if (!v) return { conflict: true };
    return applyContentUpdate(id, v.content, expectedRevision, `回滚到版本 v${version}`);
  }

  return {
    createDoc,
    listDocs,
    getDoc,
    updateDoc,
    renameDoc,
    deleteDoc,
    listVersions,
    getVersion,
    rollbackToVersion,
    close: () => db.close(),
  };
}
