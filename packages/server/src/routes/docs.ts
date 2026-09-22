/**
 * 文档持久化 HTTP 路由：新建 / 列表 / 读取 / 保存 / 重命名 / 删除，
 * 以及版本列表、查看历史版本、回滚。
 *
 * 约定：
 *  - 文档内容一律为「Schema 文本」（引用以 $fragment 原样保存，不展开）；
 *  - 服务端在写入边界用当前片段库做权威解析：悬空引用 / 闭环 / 片段定义非法
 *    一律拒绝落库；
 *  - 保存带 expectedRevision（乐观锁），revision 不一致返回 409；
 *  - 回滚 = 以历史内容再写一次新版本。片段在历史之后可能已被删除：
 *    存活片段的引用保持指针（按当前定义动态解释），已删片段用归档的最后定义
 *    就地展开——回滚因此永不因片段状态失败，产物也始终合法。
 */
import { Router, Request, Response } from 'express';
import { Repository } from '../db';
import { buildFragmentLib, collectSchemaRefs, materializeArchived } from '../engine/fragments';
import { parseSchemaText } from '../engine/parser';
import { modelToSchemaText } from '../engine/serialize';
import { checkDocumentContent, loadFragmentLib } from './support';
import { isRef } from '../engine/types';

export function createDocsRouter(repo: Repository): Router {
  const router = Router();

  // 新建文档
  router.post('/', (req: Request, res: Response) => {
    const { name, content } = req.body as { name?: unknown; content?: unknown };
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name 必填' });
      return;
    }
    const check = checkDocumentContent(content, loadFragmentLib(repo));
    if (!check.ok) {
      res.status(400).json({ error: `无法保存非法 Schema：${check.error}` });
      return;
    }
    const doc = repo.createDoc({ name: name.trim(), content: content as string });
    res.status(201).json({ doc, version: 1 });
  });

  // 文档列表
  router.get('/', (_req: Request, res: Response) => {
    res.json({ documents: repo.listDocs() });
  });

  // 读取单个文档
  router.get('/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'id 必须是整数' });
      return;
    }
    const doc = repo.getDoc(id);
    if (!doc) {
      res.status(404).json({ error: '文档不存在' });
      return;
    }
    res.json({ doc });
  });

  // 保存（更新内容，产生新版本）
  router.put('/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const { content, expectedRevision, note } = req.body as {
      content?: unknown;
      expectedRevision?: unknown;
      note?: unknown;
    };
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'id 必须是整数' });
      return;
    }
    if (!repo.getDoc(id)) {
      res.status(404).json({ error: '文档不存在' });
      return;
    }
    if (!Number.isInteger(expectedRevision)) {
      res.status(400).json({ error: 'expectedRevision 必须是整数（用于并发保护）' });
      return;
    }
    const check = checkDocumentContent(content, loadFragmentLib(repo));
    if (!check.ok) {
      res.status(400).json({ error: `无法保存非法 Schema：${check.error}` });
      return;
    }
    const result = repo.updateDoc(id, {
      content: content as string,
      expectedRevision: expectedRevision as number,
      note: typeof note === 'string' ? note : undefined,
    });
    if (result.conflict) {
      res.status(409).json({
        error: '文档已被其他会话修改，保存被拒绝以防止覆盖（请重新载入后再保存）',
        currentRevision: result.currentRevision,
      });
      return;
    }
    res.json({ doc: result.doc, version: result.version });
  });

  // 重命名（不产生内容版本）
  router.patch('/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const { name } = req.body as { name?: unknown };
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name 必填' });
      return;
    }
    const doc = repo.renameDoc(id, name.trim());
    if (!doc) {
      res.status(404).json({ error: '文档不存在' });
      return;
    }
    res.json({ doc });
  });

  // 删除
  router.delete('/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!repo.deleteDoc(id)) {
      res.status(404).json({ error: '文档不存在' });
      return;
    }
    res.status(204).end();
  });

  // 版本列表
  router.get('/:id/versions', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!repo.getDoc(id)) {
      res.status(404).json({ error: '文档不存在' });
      return;
    }
    res.json({ versions: repo.listVersions(id) });
  });

  // 查看某个历史版本
  router.get('/:id/versions/:version', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const version = Number(req.params.version);
    const v = repo.getVersion(id, version);
    if (!v) {
      res.status(404).json({ error: '版本不存在' });
      return;
    }
    res.json({ version: v });
  });

  // 回滚到历史版本（写入新版本，返回最新文档）
  router.post('/:id/rollback/:version', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const version = Number(req.params.version);
    const { expectedRevision } = req.body as { expectedRevision?: unknown };
    if (!repo.getDoc(id)) {
      res.status(404).json({ error: '文档不存在' });
      return;
    }
    if (!Number.isInteger(expectedRevision)) {
      res.status(400).json({ error: 'expectedRevision 必须是整数' });
      return;
    }
    const v = repo.getVersion(id, version);
    if (!v) {
      res.status(404).json({ error: '版本不存在' });
      return;
    }

    // 片段状态可能在该历史版本之后变化：
    //  存活片段 -> 引用保持指针，按片段当前定义解释；
    //  已删（归档）片段 -> 用其最后定义就地展开，产物不再悬空。
    // 不含任何引用写法的老文档走快路径：逐字沿用历史内容，行为与升级前完全一致。
    let contentOverride: string | undefined;
    let materialized = false;
    if (v.content.includes('$fragment')) {
      const serverLib = loadFragmentLib(repo);
      const parsed = parseSchemaText(v.content, { lenientRefs: true, rootMustBeObject: true });
      if (parsed.ok && parsed.model) {
        const archived = buildFragmentLib(
          repo
            .listFragments(true)
            .filter((f) => f.archived === 1)
            .map((f) => ({ key: f.key, content: f.content })),
        ).lib;
        const mat = materializeArchived(parsed.model, serverLib.lib, archived);
        if (mat && !isRef(mat)) {
          const text = modelToSchemaText(mat);
          // 语义判定：仅当引用集合发生变化（有引用被就地展开）才回写，
          // 避免老内容因确定性重排产生无谓差异
          const beforeRefs = collectSchemaRefs(JSON.parse(v.content));
          const afterRefs = collectSchemaRefs(JSON.parse(text));
          if (beforeRefs.length !== afterRefs.length ||
              [...new Set(beforeRefs)].some((k) => !new Set(afterRefs).has(k))) {
            contentOverride = text;
            materialized = true;
          }
        }
      }
    }

    const result = repo.rollbackToVersion(id, version, expectedRevision as number, contentOverride);
    if (result.conflict) {
      res.status(409).json({ error: '文档已被其他会话修改，请刷新后重试', currentRevision: result.currentRevision });
      return;
    }
    res.json({
      doc: result.doc,
      version: result.version,
      materialized,
    });
  });

  return router;
}
