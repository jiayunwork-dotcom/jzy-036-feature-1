/**
 * 文档持久化 HTTP 路由：新建 / 列表 / 读取 / 保存 / 重命名 / 删除，
 * 以及版本列表、查看历史版本、回滚。
 *
 * 约定：
 *  - 文档内容一律为「Schema 文本」；服务端在写入边界做权威解析校验；
 *  - 保存带 expectedRevision（乐观锁），revision 不一致返回 409，杜绝并发串号覆盖；
 *  - 回滚 = 以历史内容再写一次新版本，版本轨迹连续可查。
 */
import { Router, Request, Response } from 'express';
import { Repository } from '../db';
import { buildLibrary, validateDocumentText } from '../engine/fragmentService';

/** 保存/导入边界权威校验：语法合法、受支持子集、片段引用全部可解析可展开（无悬空/闭环） */
function validateContent(repo: Repository, content: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof content !== 'string') return { ok: false, error: 'content 必须是字符串' };
  const { library } = buildLibrary(repo);
  const result = validateDocumentText(content, library);
  if (!result.ok) return { ok: false, error: result.error ?? 'Schema 不合法' };
  return { ok: true };
}

export function createDocsRouter(repo: Repository): Router {
  const router = Router();

  // 新建文档
  router.post('/', (req: Request, res: Response) => {
    const { name, content } = req.body as { name?: unknown; content?: unknown };
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name 必填' });
      return;
    }
    const check = validateContent(repo, content);
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
    const check = validateContent(repo, content);
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
    if (!repo.getVersion(id, version)) {
      res.status(404).json({ error: '版本不存在' });
      return;
    }
    const result = repo.rollbackToVersion(id, version, expectedRevision as number);
    if (result.conflict) {
      res.status(409).json({ error: '文档已被其他会话修改，请刷新后重试', currentRevision: result.currentRevision });
      return;
    }
    res.json({ doc: result.doc, version: result.version });
  });

  return router;
}
