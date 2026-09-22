/**
 * Schema 引擎相关 HTTP 路由：解析校验、序列化、控件映射、表单数据校验。
 * 前端本地复用同一套引擎做即时同步；这里是服务端权威实现，保存/导入时必经。
 *
 * 含片段引用的文本会按服务端当前片段库解析/展开：悬空引用、闭环引用在此被认出，
 * 与非法 JSON 一样返回 200 + ok:false（工具不崩），由调用方进入「非法态」。
 */
import { Router, Request, Response } from 'express';
import { parseSchemaText } from '../engine/parser';
import { modelToSchemaText, modelToSchemaTextAny } from '../engine/serialize';
import { modelToControls } from '../engine/controls';
import { initData, validateForm } from '../engine/validate';
import { schemaToModel } from '../engine/parser';
import type { FormData } from '../engine/validate';
import type { Repository } from '../db';
import { buildLibrary, validateFragmentText } from '../engine/fragmentService';

export function createSchemaRouter(repo?: Repository): Router {
  const router = Router();

  const currentLibrary = () => (repo ? buildLibrary(repo).library : {});

  /** POST /api/schema/parse —— 解析 Schema 文本；非法返回 200 + ok:false（工具不崩） */
  router.post('/parse', (req: Request, res: Response) => {
    const { text } = req.body as { text?: unknown };
    if (typeof text !== 'string') {
      res.status(400).json({ ok: false, error: '请求体需要 { text: string }' });
      return;
    }
    const library = currentLibrary();
    const result = parseSchemaText(text, { library });
    if (!result.ok) {
      res.json({ ok: false, error: result.error, line: result.line, column: result.column });
      return;
    }
    res.json({
      ok: true,
      schema: result.schema,
      // 模型中的 id 为前端会话态，服务端只回传结构内容
      model: stripIds(result.model!),
      controls: modelToControls(result.model!, library),
    });
  });

  /** POST /api/schema/serialize —— 结构模型 -> Schema 文本（保留 $ref 链路，不展开） */
  router.post('/serialize', (req: Request, res: Response) => {
    const { model, fragmentRoot } = req.body as { model?: any; fragmentRoot?: boolean };
    if (!model || typeof model !== 'object') {
      res.status(400).json({ ok: false, error: '请求体需要 { model }' });
      return;
    }
    try {
      const text = fragmentRoot
        ? modelToSchemaTextAny(attachIds(model))
        : modelToSchemaText(attachIds(model));
      res.json({ ok: true, text });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  /** POST /api/schema/controls —— Schema 文本 -> 控件树（穿透片段当前定义） */
  router.post('/controls', (req: Request, res: Response) => {
    const { text } = req.body as { text?: unknown };
    if (typeof text !== 'string') {
      res.status(400).json({ ok: false, error: '请求体需要 { text: string }' });
      return;
    }
    const library = currentLibrary();
    const result = parseSchemaText(text, { library });
    if (!result.ok) {
      res.status(400).json({ ok: false, error: result.error });
      return;
    }
    res.json({ ok: true, controls: modelToControls(result.model!, library) });
  });

  /** POST /api/schema/validate-form —— 依据 Schema（按片段当前定义展开）校验表单数据 */
  router.post('/validate-form', (req: Request, res: Response) => {
    const { text, data } = req.body as { text?: unknown; data?: FormData };
    if (typeof text !== 'string') {
      res.status(400).json({ ok: false, error: '请求体需要 { text, data }' });
      return;
    }
    const library = currentLibrary();
    const result = parseSchemaText(text, { library });
    if (!result.ok) {
      res.status(400).json({ ok: false, error: result.error });
      return;
    }
    const errors = validateForm(result.model!, (data ?? {}) as FormData, library);
    res.json({ ok: true, valid: errors.length === 0, errors, defaults: initData(result.model!, library) });
  });

  /** POST /api/schema/validate-fragment —— 片段定义文本校验（闭环/悬空在此拦截） */
  router.post('/validate-fragment', (req: Request, res: Response) => {
    const { name, content } = req.body as { name?: unknown; content?: unknown };
    if (typeof name !== 'string' || typeof content !== 'string') {
      res.status(400).json({ ok: false, error: '请求体需要 { name: string, content: string }' });
      return;
    }
    const library = currentLibrary();
    const result = validateFragmentText(name, content, library);
    res.json(result.ok ? { ok: true } : { ok: false, error: result.error, issues: result.issues });
  });

  return router;
}

/** 服务端持久化的模型不带 id（id 是前端会话态），序列化前补临时 id */
let tempId = 0;
function attachIds(node: any): any {
  if (Array.isArray(node)) return node.map(attachIds);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = { id: `srv_${tempId++}` };
    for (const [k, v] of Object.entries(node)) {
      if (k === 'id') continue;
      out[k] = attachIds(v);
    }
    return out;
  }
  return node;
}

function stripIds(node: any): any {
  if (Array.isArray(node)) return node.map(stripIds);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'id') continue;
      out[k] = stripIds(v);
    }
    return out;
  }
  return node;
}

export { schemaToModel };
