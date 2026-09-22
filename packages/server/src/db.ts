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

/** 片段是与文档对齐的一等资源：独立命名（名为身份，不可改）、独立留版本历史 */
export interface FragmentRecord {
  name: string;
  title: string | null;
  /** 片段定义文本（任意受支持类型的 Schema，根不要求 object） */
  content: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface FragmentVersionRecord {
  version: number;
  revision: number;
  content: string;
  created_at: string;
  note: string | null;
}

/** 一处引用关系：某文档/某片段的某路径引用了目标片段 */
export interface ReferenceEntry {
  kind: 'document' | 'fragment';
  /** kind=document 时为文档 id */
  documentId?: number;
  documentName?: string;
  /** kind=fragment 时为引用方片段名 */
  fragmentName?: string;
  /** 引用在引用方结构中的路径 */
  path: string;
}

export interface CreateFragmentInput {
  name: string;
  title?: string;
  content: string;
}

export interface UpdateFragmentInput {
  content: string;
  expectedRevision: number;
  title?: string;
  note?: string;
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

  /* ---- 片段：与文档对齐的一等资源（名为身份、revision 乐观锁、版本快照） ---- */
  createFragment(input: CreateFragmentInput): FragmentRecord;
  listFragments(): Array<Pick<FragmentRecord, 'name' | 'title' | 'revision' | 'created_at' | 'updated_at'>>;
  getFragment(name: string): FragmentRecord | undefined;
  updateFragment(name: string, input: UpdateFragmentInput): UpdateFragmentResult;
  deleteFragmentRow(name: string): boolean;
  listFragmentVersions(name: string): FragmentVersionRecord[];
  getFragmentVersion(name: string, version: number): FragmentVersionRecord | undefined;
  rollbackFragment(name: string, version: number, expectedRevision: number): UpdateFragmentResult;
  /** 事务内执行回调（级联删除/引用一致性操作用） */
  withTransaction<T>(fn: () => T): T;
  /** 全量读取当前文档（级联扫描引用方用） */
  allDocs(): DocRecord[];
  /** 级联处理中批量改写文档/片段内容并各记一个版本 */
  rewriteDocs(rewrites: Array<{ id: number; content: string; note: string }>): void;
  rewriteFragments(rewrites: Array<{ name: string; content: string; title?: string | null; note: string }>): void;
  close(): void;
}

export interface UpdateFragmentResult {
  conflict: boolean;
  fragment?: FragmentRecord;
  version?: number;
  currentRevision?: number;
  notFound?: boolean;
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
    CREATE TABLE IF NOT EXISTS fragments (
      name TEXT PRIMARY KEY,
      title TEXT,
      content TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS fragment_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fragment_name TEXT NOT NULL REFERENCES fragments(name) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      content TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(fragment_name, version)
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

  /* ------------------------------ 片段 ------------------------------ */

  const selectFragment = db.prepare(`SELECT * FROM fragments WHERE name = ?`);
  const maxFragmentVersion = db.prepare(
    `SELECT COALESCE(MAX(version), 0) AS v FROM fragment_versions WHERE fragment_name = ?`,
  );
  const insertFragmentRow = db.prepare(
    `INSERT INTO fragments (name, title, content, revision) VALUES (@name, @title, @content, 1)`,
  );
  const insertFragmentVersion = db.prepare(
    `INSERT INTO fragment_versions (fragment_name, version, revision, content, note)
     VALUES (@fragment_name, @version, @revision, @content, @note)`,
  );

  function createFragment(input: CreateFragmentInput): FragmentRecord {
    const tx = db.transaction(() => {
      insertFragmentRow.run({
        name: input.name,
        title: input.title ?? null,
        content: input.content,
      });
      insertFragmentVersion.run({
        fragment_name: input.name,
        version: 1,
        revision: 1,
        content: input.content,
        note: '创建片段',
      });
      return selectFragment.get(input.name) as FragmentRecord;
    });
    return tx();
  }

  function listFragments() {
    return db
      .prepare(
        `SELECT name, title, revision, created_at, updated_at FROM fragments ORDER BY name ASC`,
      )
      .all() as Array<Pick<FragmentRecord, 'name' | 'title' | 'revision' | 'created_at' | 'updated_at'>>;
  }

  function getFragment(name: string): FragmentRecord | undefined {
    return selectFragment.get(name) as FragmentRecord | undefined;
  }

  function updateFragment(name: string, input: UpdateFragmentInput): UpdateFragmentResult {
    const tx = db.transaction((): UpdateFragmentResult => {
      const current = selectFragment.get(name) as FragmentRecord | undefined;
      if (!current) return { conflict: true, notFound: true };
      if (current.revision !== input.expectedRevision) {
        return { conflict: true, currentRevision: current.revision };
      }
      const nextRevision = current.revision + 1;
      const title = input.title === undefined ? current.title : input.title;
      db.prepare(
        `UPDATE fragments SET content = ?, title = ?, revision = ?, updated_at = datetime('now') WHERE name = ?`,
      ).run(input.content, title, nextRevision, name);
      const nextVersion = (maxFragmentVersion.get(name) as { v: number }).v + 1;
      insertFragmentVersion.run({
        fragment_name: name,
        version: nextVersion,
        revision: nextRevision,
        content: input.content,
        note: input.note ?? '保存修改',
      });
      return { conflict: false, fragment: selectFragment.get(name) as FragmentRecord, version: nextVersion };
    });
    return tx();
  }

  function deleteFragmentRow(name: string): boolean {
    const info = db.prepare(`DELETE FROM fragments WHERE name = ?`).run(name);
    return info.changes > 0;
  }

  function listFragmentVersions(name: string): FragmentVersionRecord[] {
    return db
      .prepare(
        `SELECT version, revision, content, created_at, note FROM fragment_versions
         WHERE fragment_name = ? ORDER BY version DESC`,
      )
      .all(name) as FragmentVersionRecord[];
  }

  function getFragmentVersion(name: string, version: number): FragmentVersionRecord | undefined {
    return db
      .prepare(
        `SELECT version, revision, content, created_at, note FROM fragment_versions
         WHERE fragment_name = ? AND version = ?`,
      )
      .get(name, version) as FragmentVersionRecord | undefined;
  }

  function rollbackFragment(name: string, version: number, expectedRevision: number): UpdateFragmentResult {
    const v = getFragmentVersion(name, version);
    if (!v) return { conflict: true, notFound: true };
    return updateFragment(name, {
      content: v.content,
      expectedRevision,
      note: `回滚到片段版本 v${version}`,
    });
  }

  function withTransaction<T>(fn: () => T): T {
    return db.transaction(fn)();
  }

  function allDocs(): DocRecord[] {
    return db.prepare(`SELECT * FROM documents ORDER BY id ASC`).all() as DocRecord[];
  }

  /** 级联处理：批量把文档内容改写为新文本，各自追加一条版本（调用方须在事务内） */
  function rewriteDocs(rewrites: Array<{ id: number; content: string; note: string }>): void {
    for (const r of rewrites) {
      const current = selectDoc.get(r.id) as DocRecord;
      const nextRevision = current.revision + 1;
      db.prepare(
        `UPDATE documents SET content = ?, revision = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(r.content, nextRevision, r.id);
      const nextVersion = (maxVersion.get(r.id) as { v: number }).v + 1;
      insertVersion.run({
        document_id: r.id,
        version: nextVersion,
        revision: nextRevision,
        content: r.content,
        note: r.note,
      });
    }
  }

  function rewriteFragments(
    rewrites: Array<{ name: string; content: string; title?: string | null; note: string }>,
  ): void {
    for (const r of rewrites) {
      const current = selectFragment.get(r.name) as FragmentRecord;
      const nextRevision = current.revision + 1;
      const title = r.title === undefined ? current.title : r.title;
      db.prepare(
        `UPDATE fragments SET content = ?, title = ?, revision = ?, updated_at = datetime('now') WHERE name = ?`,
      ).run(r.content, title, nextRevision, r.name);
      const nextVersion = (maxFragmentVersion.get(r.name) as { v: number }).v + 1;
      insertFragmentVersion.run({
        fragment_name: r.name,
        version: nextVersion,
        revision: nextRevision,
        content: r.content,
        note: r.note,
      });
    }
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
    createFragment,
    listFragments,
    getFragment,
    updateFragment,
    deleteFragmentRow,
    listFragmentVersions,
    getFragmentVersion,
    rollbackFragment,
    withTransaction,
    allDocs,
    rewriteDocs,
    rewriteFragments,
    close: () => db.close(),
  };
}
