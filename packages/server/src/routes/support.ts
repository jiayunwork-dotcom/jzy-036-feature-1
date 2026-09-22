/**
 * 服务端边界校验共用：从仓储即时构建片段库，并以「严格模式」解析文档/片段。
 * 所有落库与权威接口都走这一条通道，悬空引用 / 闭环 / 片段定义非法在这里被挡下。
 */
import { Repository } from '../db';
import { buildFragmentLib, checkFragmentSave } from '../engine/fragments';
import { parseSchemaText } from '../engine/parser';
import { nodeToSchemaText } from '../engine/serialize';
import { FragmentLib, StructureNode } from '../engine/types';

export interface ServerLib {
  lib: FragmentLib;
  /** key -> 该片段当前的问题（定义非法 / 悬空 / 参与闭环） */
  errors: Map<string, string>;
}

export function loadFragmentLib(repo: Repository): ServerLib {
  return buildFragmentLib(repo.fragmentEntries());
}

export type ContentCheck =
  | { ok: true; model: StructureNode }
  | { ok: false; error: string };

/** 文档内容边界校验：根必须 object；所有引用必须存活、不闭环、片段定义合法 */
export function checkDocumentContent(content: unknown, serverLib: ServerLib): ContentCheck {
  if (typeof content !== 'string') return { ok: false, error: 'content 必须是字符串' };
  const result = parseSchemaText(content, {
    lib: serverLib.lib,
    fragmentErrors: serverLib.errors,
    rootMustBeObject: true,
  });
  if (!result.ok || !result.model) {
    return { ok: false, error: result.error ?? 'Schema 不合法' };
  }
  return { ok: true, model: result.model };
}

/**
 * 片段定义边界校验（拟以 key 保存）：根类型任意；定义必须合法；
 * 引用必须存活（不悬空）；不允许直接/间接闭环（含自环）。
 * 返回规范化（确定性字段顺序）后的文本。
 *
 * 注意：宽松解析结构（库里不放待保存 key 自身，否则自环会被当成可达链漏过），
 * 再由 checkFragmentSave 在「库 + 待保存定义」的临时图上统一判定悬空与闭环。
 */
export function fragmentSaveCheck(
  key: string,
  content: unknown,
  serverLib: ServerLib,
): { ok: true; normalized: string; model: StructureNode } | { ok: false; error: string } {
  if (typeof content !== 'string') return { ok: false, error: 'content 必须是字符串' };
  const result = parseSchemaText(content, { lenientRefs: true, rootMustBeObject: false });
  if (!result.ok || !result.model) {
    return { ok: false, error: result.error ?? '片段定义不合法' };
  }
  const model = result.model as StructureNode;
  const graphError = checkFragmentSave(serverLib.lib, key, model);
  if (graphError) return { ok: false, error: graphError };
  return { ok: true, normalized: nodeToSchemaText(model), model };
}
