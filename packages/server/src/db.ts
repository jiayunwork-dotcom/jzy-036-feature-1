/**
 * 持久化层（SQLite）：Schema 文档与结构片段均为一等实体，每次内容更新落一条
 * 版本快照。行之间按 id 隔离，更新走事务 + revision 乐观锁，防止并发编辑互相覆盖。
 *
 * 片段是「可复用结构片段」的一等资源：独立 key、独立版本历史、独立软删除归档。
 * 删除仍被引用的片段由路由层（findFragmentReferences）拦下；归档内容供文档
 * 回滚时物化已删片段，使回滚动作不依赖片段存活。
 */
import Database from 'better-sqlite3';
import type { Database as DBType } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { collectSchemaRefs } from './engine/fragments';

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
  rollbackToVersion(id: number, version: number, expectedRevision: number, contentOverride?: string): UpdateResult;
  close(): void;

  // ---- 结构片段（一等资源） ----
  createFragment(input: CreateFragmentInput): FragmentRecord;
  listFragments(includeArchived?: boolean): FragmentRecord[];
  getFragment(key: string, includeArchived?: boolean): FragmentRecord | undefined;
  updateFragment(key: string, input: UpdateFragmentInput): FragmentUpdateResult;
  renameFragment(key: string, title: string): FragmentRecord | undefined;
  /** 软删除：归档片段行与版本，列表默认不可见，回滚物化仍可取到最后定义 */
  archiveFragment(key: string): boolean;
  listFragmentVersions(key: string): FragmentVersionRecord[];
  getFragmentVersion(key: string, version: number): FragmentVersionRecord | undefined;
  /** 扫描所有未归档文档中对给定片段集合的引用 */
  findReferencesToFragments(keys: string[]): FragmentReference[];
  /** 列出所有未归档片段（构建片段库用） */
  fragmentEntries(): Array<{ key: string; content: string }>;
}

export interface CreateFragmentInput {
  key: string;
  title: string;
  content: string;
}

export interface FragmentRecord {
  key: string;
  title: string;
  content: string;
  revision: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface FragmentVersionRecord {
  version: number;
  revision: number;
  content: string;
  title: string;
  note: string | null;
  created_at: string;
}

export interface UpdateFragmentInput {
  content?: string;
  title?: string;
  expectedRevision: number;
  note?: string;
}

export interface FragmentUpdateResult {
  conflict: boolean;
  fragment?: FragmentRecord;
  version?: number;
  currentRevision?: number;
}

/** 一处片段引用（引用影响范围 / 删除前置提示用） */
export interface FragmentReference {
  kind: 'document' | 'fragment';
  /** 文档 id 或片段 key */
  id: number | string;
  name: string;
  /** 被引用的片段 key（间接引用时为引用链终点集合中的一个） */
  refKey: string;
  /** 引用出现位置（文档/片段内字段路径；无法精确定位时为 ''） */
  path: string;
  /** true 表示经由其他片段间接引用 */
  indirect: boolean;
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
      key TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS fragment_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fragment_key TEXT NOT NULL REFERENCES fragments(key) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(fragment_key, version)
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

  function rollbackToVersion(id: number, version: number, expectedRevision: number, contentOverride?: string): UpdateResult {
    const v = getVersion(id, version);
    if (!v) return { conflict: true };
    return applyContentUpdate(
      id,
      contentOverride ?? v.content,
      expectedRevision,
      contentOverride !== undefined ? `回滚到版本 v${version}（已删片段就地展开）` : `回滚到版本 v${version}`,
    );
  }

  // ---------------- 结构片段 ----------------

  const insertFragment = db.prepare(
    `INSERT INTO fragments (key, title, content, revision) VALUES (@key, @title, @content, 1)`,
  );
  const insertFragmentVersion = db.prepare(
    `INSERT INTO fragment_versions (fragment_key, version, revision, title, content, note)
     VALUES (@fragment_key, @version, @revision, @title, @content, @note)`,
  );
  const selectFragment = db.prepare(
    `SELECT * FROM fragments WHERE key = ? AND archived = 0`,
  );
  const selectFragmentAny = db.prepare(`SELECT * FROM fragments WHERE key = ?`);
  const maxFragmentVersion = db.prepare(
    `SELECT COALESCE(MAX(version), 0) AS v FROM fragment_versions WHERE fragment_key = ?`,
  );

  function createFragment(input: CreateFragmentInput): FragmentRecord {
    const tx = db.transaction((): FragmentRecord => {
      if (selectFragmentAny.get(input.key)) {
        throw new Error(`片段 key「${input.key}」已存在`);
      }
      insertFragment.run({ key: input.key, title: input.title, content: input.content });
      insertFragmentVersion.run({
        fragment_key: input.key,
        version: 1,
        revision: 1,
        title: input.title,
        content: input.content,
        note: '创建片段',
      });
      return selectFragment.get(input.key) as FragmentRecord;
    });
    return tx();
  }

  function listFragments(includeArchived = false): FragmentRecord[] {
    const sql = includeArchived
      ? `SELECT * FROM fragments ORDER BY updated_at DESC, key ASC`
      : `SELECT * FROM fragments WHERE archived = 0 ORDER BY updated_at DESC, key ASC`;
    return db.prepare(sql).all() as FragmentRecord[];
  }

  function getFragment(key: string, includeArchived = false): FragmentRecord | undefined {
    const row = (includeArchived ? selectFragmentAny : selectFragment).get(key) as
      | FragmentRecord
      | undefined;
    return row;
  }

  function updateFragment(key: string, input: UpdateFragmentInput): FragmentUpdateResult {
    const tx = db.transaction((): FragmentUpdateResult => {
      const current = selectFragment.get(key) as FragmentRecord | undefined;
      if (!current) return { conflict: true };
      if (current.revision !== input.expectedRevision) {
        return { conflict: true, currentRevision: current.revision };
      }
      const content = input.content ?? current.content;
      const title = input.title ?? current.title;
      const nextRevision = current.revision + 1;
      db.prepare(
        `UPDATE fragments SET content = ?, title = ?, revision = ?, updated_at = datetime('now') WHERE key = ?`,
      ).run(content, title, nextRevision, key);
      const nextVersion = (maxFragmentVersion.get(key) as { v: number }).v + 1;
      insertFragmentVersion.run({
        fragment_key: key,
        version: nextVersion,
        revision: nextRevision,
        title,
        content,
        note: input.note ?? '保存修改',
      });
      return { conflict: false, fragment: selectFragment.get(key) as FragmentRecord, version: nextVersion };
    });
    return tx();
  }

  function renameFragment(key: string, title: string): FragmentRecord | undefined {
    db.prepare(
      `UPDATE fragments SET title = ?, updated_at = datetime('now') WHERE key = ? AND archived = 0`,
    ).run(title, key);
    return getFragment(key);
  }

  function archiveFragment(key: string): boolean {
    const info = db
      .prepare(`UPDATE fragments SET archived = 1, updated_at = datetime('now') WHERE key = ? AND archived = 0`)
      .run(key);
    return info.changes > 0;
  }

  function listFragmentVersions(key: string): FragmentVersionRecord[] {
    return db
      .prepare(
        `SELECT version, revision, content, title, created_at, note FROM fragment_versions
         WHERE fragment_key = ? ORDER BY version DESC`,
      )
      .all(key) as FragmentVersionRecord[];
  }

  function getFragmentVersion(key: string, version: number): FragmentVersionRecord | undefined {
    return db
      .prepare(
        `SELECT version, revision, content, title, created_at, note FROM fragment_versions
         WHERE fragment_key = ? AND version = ?`,
      )
      .get(key, version) as FragmentVersionRecord | undefined;
  }

  function fragmentEntries(): Array<{ key: string; content: string }> {
    return db
      .prepare(`SELECT key, content FROM fragments WHERE archived = 0`)
      .all() as Array<{ key: string; content: string }>;
  }

  /**
   * 扫描引用方：
   *  - 直接引用：文档/片段的 Schema 文本内含 $fragment 指向目标集合；
   *  - 间接引用：沿片段引用边传递可达（文档 -> A -> ... -> 目标；片段 -> ... -> 目标）。
   * 删除被间接依赖的底层片段同样会让引用方悬空，因此两类都必须报告。
   * 字段路径定位在路由层用解析后的结构树补全。
   */
  function findReferencesToFragments(keys: string[]): FragmentReference[] {
    const target = new Set(keys);
    const refs: FragmentReference[] = [];

    const docs = db.prepare(`SELECT id, name, content FROM documents`).all() as Array<{
      id: number;
      name: string;
      content: string;
    }>;
    const frags = db
      .prepare(`SELECT key, title, content FROM fragments WHERE archived = 0`)
      .all() as Array<{ key: string; title: string; content: string }>;

    // 片段 key -> 它直接引用的 key
    const direct = new Map<string, string[]>();
    for (const f of frags) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(f.content);
      } catch {
        direct.set(f.key, []);
        continue;
      }
      direct.set(f.key, [...new Set(collectSchemaRefs(parsed))]);
    }

    /**
     * 从 start 出发沿片段边是否能到达 hit；返回 true 表示可达。
     * 带环保护（引用环不应导致扫描死循环；环由保存边界另行拦截）。
     */
    const canReach = (start: string, hit: string): boolean => {
      if (start === hit) return true;
      const seen = new Set<string>();
      const stack = [start];
      while (stack.length) {
        const k = stack.pop()!;
        if (k === hit) return true;
        if (seen.has(k)) continue;
        seen.add(k);
        for (const dep of direct.get(k) ?? []) {
          if (!seen.has(dep)) stack.push(dep);
        }
      }
      return false;
    };

    // 文档引用方：直接或经片段链间接到达目标
    for (const doc of docs) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(doc.content);
      } catch {
        continue;
      }
      const directRefs = [...new Set(collectSchemaRefs(parsed))];
      for (const refKey of target) {
        const directHit = directRefs.includes(refKey);
        const indirectHit =
          !directHit && directRefs.some((entry) => canReach(entry, refKey));
        if (directHit || indirectHit) {
          refs.push({
            kind: 'document',
            id: doc.id,
            name: doc.name,
            refKey,
            path: '',
            indirect: !directHit,
          });
        }
      }
    }

    // 片段引用方：能（直接或间接）到达目标的其他片段
    for (const f of frags) {
      if (target.has(f.key)) continue; // 目标片段自身不算引用方
      for (const refKey of target) {
        const directHit = (direct.get(f.key) ?? []).includes(refKey);
        const indirectHit =
          !directHit && (direct.get(f.key) ?? []).some((entry) => canReach(entry, refKey));
        if (directHit || indirectHit) {
          refs.push({
            kind: 'fragment',
            id: f.key,
            name: f.title || f.key,
            refKey,
            path: '',
            indirect: !directHit,
          });
        }
      }
    }

    return refs;
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
    createFragment,
    listFragments,
    getFragment,
    updateFragment,
    renameFragment,
    archiveFragment,
    listFragmentVersions,
    getFragmentVersion,
    findReferencesToFragments,
    fragmentEntries,
  };
}
