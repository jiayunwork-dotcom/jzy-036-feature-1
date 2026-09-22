/**
 * 片段持久化 HTTP 路由：片段是与文档对齐的一等资源。
 *
 *  - 独立命名（名为身份、不可改名）、revision 乐观锁、版本历史与回滚；
 *  - 保存边界做闭环/悬空检测：片段图有环、或引用了不存在的片段，当场拒绝；
 *  - 删除前给出影响范围（被哪些文档/片段、哪些位置引用）；
 *    默认拒绝删除仍被引用的片段，显式 cascade=true 才在单事务内联后删除；
 *  - GET /references/:name 单独提供影响范围查询。
 */
import { Router, Request, Response } from 'express';
import { Repository } from '../db';
import {
  buildLibrary,
  cascadeDeleteFragment,
  findReferences,
  validateFragmentText,
} from '../engine/fragmentService';

export function createFragmentsRouter(repo: Repository): Router {
  const router = Router();

  // 片段列表（不含正文，给管理面板与引用选择器）
  router.get('/', (_req: Request, res: Response) => {
    res.json({ fragments: repo.listFragments() });
  });

  // 新建片段
  router.post('/', (req: Request, res: Response) => {
    const { name, title, content } = req.body as {
      name?: unknown;
      title?: unknown;
      content?: unknown;
    };
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: '片段名 name 必填' });
      return;
    }
    const fragName = name.trim();
    if (typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: '片段定义 content 必填（Schema 文本）' });
      return;
    }
    if (repo.getFragment(fragName)) {
      res.status(409).json({ error: `片段「${fragName}」已存在（片段名不可重复、不可改名）` });
      return;
    }
    const { library } = buildLibrary(repo);
    const check = validateFragmentText(fragName, content, library);
    if (!check.ok) {
      res.status(400).json({ error: check.error, issues: check.issues });
      return;
    }
    const fragment = repo.createFragment({
      name: fragName,
      title: typeof title === 'string' ? title : undefined,
      content,
    });
    res.status(201).json({ fragment, version: 1 });
  });

  // 单个片段详情
  router.get('/:name', (req: Request, res: Response) => {
    const fragment = repo.getFragment(req.params.name);
    if (!fragment) {
      res.status(404).json({ error: '片段不存在' });
      return;
    }
    res.json({ fragment });
  });

  // 引用方 / 影响范围
  router.get('/:name/references', (req: Request, res: Response) => {
    const name = req.params.name;
    if (!repo.getFragment(name)) {
      res.status(404).json({ error: '片段不存在' });
      return;
    }
    res.json({ references: findReferences(repo, name) });
  });

  // 保存修改（产生新版本；允许在被引用时修改——复用的意义所在）
  router.put('/:name', (req: Request, res: Response) => {
    const name = req.params.name;
    const { content, expectedRevision, title, note } = req.body as {
      content?: unknown;
      expectedRevision?: unknown;
      title?: unknown;
      note?: unknown;
    };
    const current = repo.getFragment(name);
    if (!current) {
      res.status(404).json({ error: '片段不存在' });
      return;
    }
    if (!Number.isInteger(expectedRevision)) {
      res.status(400).json({ error: 'expectedRevision 必须是整数（用于并发保护）' });
      return;
    }
    if (typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: '片段定义 content 必填' });
      return;
    }
    const { library } = buildLibrary(repo);
    const check = validateFragmentText(name, content, library);
    if (!check.ok) {
      res.status(400).json({ error: check.error, issues: check.issues });
      return;
    }
    const result = repo.updateFragment(name, {
      content,
      expectedRevision: expectedRevision as number,
      title: typeof title === 'string' ? title : undefined,
      note: typeof note === 'string' ? note : undefined,
    });
    if (result.conflict) {
      res.status(409).json({
        error: '片段已被其他会话修改，保存被拒绝以防止覆盖（请重新载入后再保存）',
        currentRevision: result.currentRevision,
      });
      return;
    }
    res.json({ fragment: result.fragment, version: result.version });
  });

  // 删除：默认拒绝仍被引用的片段并列出引用方；cascade=true 时单事务内联后删除
  router.delete('/:name', (req: Request, res: Response) => {
    const name = req.params.name;
    if (!repo.getFragment(name)) {
      res.status(404).json({ error: '片段不存在' });
      return;
    }
    const cascade = req.query.cascade === 'true';
    const references = findReferences(repo, name);
    if (references.length > 0 && !cascade) {
      res.status(409).json({
        error:
          `片段「${name}」仍被 ${references.length} 处引用，不能删除。` +
          '请先处理这些引用，或显式选择 cascade=true 将引用处一并内联为结构快照后删除。',
        references,
      });
      return;
    }
    if (cascade && references.length > 0) {
      const result = cascadeDeleteFragment(repo, name);
      res.json({
        ok: true,
        cascaded: true,
        references,
        result,
      });
      return;
    }
    repo.deleteFragmentRow(name);
    res.status(204).end();
  });

  // 版本列表
  router.get('/:name/versions', (req: Request, res: Response) => {
    const name = req.params.name;
    if (!repo.getFragment(name)) {
      res.status(404).json({ error: '片段不存在' });
      return;
    }
    res.json({ versions: repo.listFragmentVersions(name) });
  });

  // 查看某个历史版本
  router.get('/:name/versions/:version', (req: Request, res: Response) => {
    const version = Number(req.params.version);
    const v = repo.getFragmentVersion(req.params.name, version);
    if (!v) {
      res.status(404).json({ error: '版本不存在' });
      return;
    }
    res.json({ version: v });
  });

  // 回滚片段到历史版本（受与保存相同的闭环/悬空校验保护）
  router.post('/:name/rollback/:version', (req: Request, res: Response) => {
    const name = req.params.name;
    const version = Number(req.params.version);
    const { expectedRevision } = req.body as { expectedRevision?: unknown };
    const current = repo.getFragment(name);
    if (!current) {
      res.status(404).json({ error: '片段不存在' });
      return;
    }
    if (!Number.isInteger(expectedRevision)) {
      res.status(400).json({ error: 'expectedRevision 必须是整数' });
      return;
    }
    const historical = repo.getFragmentVersion(name, version);
    if (!historical) {
      res.status(404).json({ error: '版本不存在' });
      return;
    }
    const { library } = buildLibrary(repo);
    const check = validateFragmentText(name, historical.content, library);
    if (!check.ok) {
      res.status(400).json({
        error: `该历史版本在当前片段库下不再合法，无法作为片段回滚：${check.error}`,
      });
      return;
    }
    const result = repo.rollbackFragment(name, version, expectedRevision as number);
    if (result.conflict) {
      res.status(409).json({ error: '片段已被其他会话修改，请刷新后重试', currentRevision: result.currentRevision });
      return;
    }
    res.json({ fragment: result.fragment, version: result.version });
  });

  return router;
}
