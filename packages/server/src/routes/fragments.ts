/**
 * 结构片段 HTTP 路由：片段是与文档对齐的一等资源——
 * 独立 key、独立保存（revision 乐观锁）、独立版本历史、可查引用影响范围。
 *
 * 删除守卫：片段仍被至少一处引用时默认拒绝（409）并列出引用方（文档/片段、
 * 是否间接、字段路径）；显式 mode=detach 才先摘除全部引用再软删除（归档，
 * 供历史文档回滚时物化）。
 */
import { Router, Request, Response } from 'express';
import { Repository, FragmentReference } from '../db';
import { findRefOccurrences, pruneFragmentRefs, pruneRefs } from '../engine/fragments';
import { parseSchemaText } from '../engine/parser';
import { modelToSchemaText } from '../engine/serialize';
import { fragmentSaveCheck, loadFragmentLib } from './support';
import { isRef } from '../engine/types';

const FRAGMENT_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export function createFragmentsRouter(repo: Repository): Router {
  const router = Router();

  /** 列出片段（默认不含已归档） */
  router.get('/', (req: Request, res: Response) => {
    const includeArchived = req.query.includeArchived === '1';
    res.json({ fragments: repo.listFragments(includeArchived) });
  });

  /** 创建片段 */
  router.post('/', (req: Request, res: Response) => {
    const { key, title, content } = req.body as {
      key?: unknown;
      title?: unknown;
      content?: unknown;
    };
    if (typeof key !== 'string' || !FRAGMENT_KEY_RE.test(key)) {
      res.status(400).json({ error: 'key 必填且只能包含字母/数字/下划线/中划线（中划线不得开头）' });
      return;
    }
    if (typeof title !== 'string' || !title.trim()) {
      res.status(400).json({ error: 'title 必填' });
      return;
    }
    if (repo.getFragment(key, true)) {
      res.status(409).json({ error: `片段 key「${key}」已存在（含已归档片段）` });
      return;
    }
    const check = fragmentSaveCheck(key, content, loadFragmentLib(repo));
    if (!check.ok) {
      res.status(400).json({ error: `无法保存片段：${check.error}` });
      return;
    }
    try {
      const fragment = repo.createFragment({
        key,
        title: title.trim(),
        content: check.normalized,
      });
      res.status(201).json({ fragment, version: 1 });
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  /** 单个片段元数据 + 内容 */
  router.get('/:key', (req: Request, res: Response) => {
    const fragment = repo.getFragment(req.params.key);
    if (!fragment) {
      res.status(404).json({ error: '片段不存在' });
      return;
    }
    res.json({ fragment });
  });

  /** 保存片段内容（产生新版本；revision 乐观锁） */
  router.put('/:key', (req: Request, res: Response) => {
    const { key } = req.params;
    const { content, title, expectedRevision, note } = req.body as {
      content?: unknown;
      title?: unknown;
      expectedRevision?: unknown;
      note?: unknown;
    };
    if (!repo.getFragment(key)) {
      res.status(404).json({ error: '片段不存在' });
      return;
    }
    if (!Number.isInteger(expectedRevision)) {
      res.status(400).json({ error: 'expectedRevision 必须是整数' });
      return;
    }
    if (content === undefined && typeof title !== 'string') {
      res.status(400).json({ error: '至少提供 content 或 title' });
      return;
    }
    const serverLib = loadFragmentLib(repo);
    let normalized: string | undefined;
    if (content !== undefined) {
      const check = fragmentSaveCheck(key, content, serverLib);
      if (!check.ok) {
        res.status(400).json({ error: `无法保存片段：${check.error}` });
        return;
      }
      normalized = check.normalized;
    }
    const result = repo.updateFragment(key, {
      content: normalized,
      title: typeof title === 'string' ? title.trim() : undefined,
      expectedRevision: expectedRevision as number,
      note: typeof note === 'string' ? note : undefined,
    });
    if (result.conflict) {
      res.status(409).json({
        error: '片段已被其他会话修改，保存被拒绝（请重新载入）',
        currentRevision: result.currentRevision,
      });
      return;
    }
    res.json({ fragment: result.fragment, version: result.version });
  });

  /** 版本列表 */
  router.get('/:key/versions', (req: Request, res: Response) => {
    if (!repo.getFragment(req.params.key)) {
      res.status(404).json({ error: '片段不存在' });
      return;
    }
    res.json({ versions: repo.listFragmentVersions(req.params.key) });
  });

  /** 引用影响范围：谁（文档/片段）在哪些位置引用了该片段 */
  router.get('/:key/usage', (req: Request, res: Response) => {
    const { key } = req.params;
    if (!repo.getFragment(key, true)) {
      res.status(404).json({ error: '片段不存在' });
      return;
    }
    const references = repo.findReferencesToFragments([key]);
    const withPaths = references.map((ref) => ({ ...ref, path: locatePath(repo, ref, key) }));
    res.json({ key, references: withPaths });
  });

  /**
   * 删除片段：
   *  默认（mode 缺省/reject）：仍被引用则 409 拒绝并列出引用方；
   *  mode=detach：先从所有引用方摘除引用（文档保存新版本，引用片段同步改写后
   *  仍需通过图校验），再归档删除。
   */
  router.delete('/:key', (req: Request, res: Response) => {
    const { key } = req.params;
    const mode = req.query.mode === 'detach' ? 'detach' : 'reject';
    const fragment = repo.getFragment(key);
    if (!fragment) {
      res.status(404).json({ error: '片段不存在' });
      return;
    }
    const references = repo
      .findReferencesToFragments([key])
      .map((ref) => ({ ...ref, path: locatePath(repo, ref, key) }));

    if (references.length > 0 && mode === 'reject') {
      res.status(409).json({
        error: `片段「${fragment.title || key}」仍被 ${references.length} 处引用，不能删除`,
        fragmentTitle: fragment.title,
        references,
      });
      return;
    }

    if (mode === 'detach') {
      detachAllReferences(repo, key);
    }

    repo.archiveFragment(key);
    res.json({ ok: true, archived: key, detached: references.length });
  });

  return router;
}

/**
 * 定位引用在引用方结构中的字段路径（用于删除前影响范围展示）。
 * 间接引用返回经片段的链路口径（从直接引用该依赖的片段处取路径）。
 */
function locatePath(repo: Repository, ref: FragmentReference, targetKey: string): string {
  try {
    if (ref.kind === 'document') {
      const doc = repo.getDoc(ref.id as number);
      if (!doc) return '';
      const parsed = parseSchemaText(doc.content, { lenientRefs: true });
      if (!parsed.ok || !parsed.model) return '';
      const hits = findRefOccurrences(parsed.model, new Set([targetKey]));
      return hits[0]?.path.replace(/^\$root\.?/, '') ?? '';
    }
    // 片段引用方：直接引用时给自身结构内路径；间接引用给出经由片段提示
    const frag = repo.getFragment(ref.id as string);
    if (!frag) return ref.indirect ? `（经片段「${ref.id}」间接引用）` : '';
    const parsed = parseSchemaText(frag.content, { lenientRefs: true, rootMustBeObject: false });
    if (!parsed.ok || !parsed.model) return '';
    const hits = findRefOccurrences(parsed.model, new Set([targetKey]));
    if (hits.length > 0) return hits[0].path.replace(/^\$root\.?/, '');
    return `（经其他片段间接引用）`;
  } catch {
    return '';
  }
}

/**
 * detach：把所有引用方对 key 的引用摘除。
 *  - 文档：剪枝后另存（不占用调用方 revision，直接重写当前内容并补一条版本）；
 *  - 片段：剪枝后通过常规 update 通道改写（expectedRevision 以库内现值为准）。
 */
function detachAllReferences(repo: Repository, key: string): void {
  const references = repo.findReferencesToFragments([key]);
  const keys = new Set([key]);

  // 用 lenient 解析剪枝，写回前再走各自的严格校验通道（由调用方保证 detach
  // 发生在归档之前，库中其他片段仍然健康）。
  const docIds = new Set(
    references.filter((r) => r.kind === 'document').map((r) => r.id as number),
  );
  for (const id of docIds) {
    const doc = repo.getDoc(id);
    if (!doc) continue;
    const parsed = parseSchemaText(doc.content, { lenientRefs: true });
    if (!parsed.ok || !parsed.model || isRef(parsed.model)) continue;
    const pruned = pruneRefs(parsed.model, keys);
    const text = modelToSchemaText(pruned);
    if (text !== doc.content) {
      repo.updateDoc(id, {
        content: text,
        expectedRevision: doc.revision,
        note: `删除片段「${key}」时自动摘除引用`,
      });
    }
  }

  const fragIds = new Set(
    references.filter((r) => r.kind === 'fragment').map((r) => r.id as string),
  );
  for (const fkey of fragIds) {
    const frag = repo.getFragment(fkey);
    if (!frag) continue;
    const parsed = parseSchemaText(frag.content, { lenientRefs: true, rootMustBeObject: false });
    if (!parsed.ok || !parsed.model) continue;
    const text = pruneFragmentRefs(parsed.model, keys);
    if (text !== frag.content) {
      repo.updateFragment(fkey, {
        content: text,
        expectedRevision: frag.revision,
        note: `删除片段「${key}」时自动摘除引用`,
      });
    }
  }
}
