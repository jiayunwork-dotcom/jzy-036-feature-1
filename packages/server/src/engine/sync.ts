/**
 * 双向同步状态机：保证文本侧与结构侧「不打架」的唯一入口。
 *
 * 不变量：
 *  - state.model 永远是「最近一次合法 Schema」对应的结构模型；
 *  - 文本合法：setText 用新解析出的模型替换 state.model；
 *  - 文本非法：state.model 原样保留（可视化区不被清空），仅置 valid=false 与原因；
 *  - 结构侧任何编辑后调用 syncFromModel()，用当前模型重新生成文本，valid 回到 true。
 */
import { FieldNode } from './types';
import { modelToSchemaText } from './serialize';
import { parseSchemaText } from './parser';

export interface SyncSessionState {
  model: FieldNode;
  text: string;
  valid: boolean;
  error?: string;
  errorLine?: number;
  errorColumn?: number;
}

export function createSyncSession(model: FieldNode): SyncSessionState {
  return { model, text: modelToSchemaText(model), valid: true };
}

/**
 * 文本区改动入口。
 * @returns true 表示本次改动后处于合法态（结构区已刷新）；false 表示非法（结构区保持旧态）
 */
export function setText(state: SyncSessionState, text: string): boolean {
  state.text = text;
  const result = parseSchemaText(text);
  if (result.ok && result.model) {
    state.model = result.model;
    state.valid = true;
    state.error = undefined;
    state.errorLine = undefined;
    state.errorColumn = undefined;
    return true;
  }
  state.valid = false;
  state.error = result.error;
  state.errorLine = result.line;
  state.errorColumn = result.column;
  // 关键：不修改 state.model —— 可视化区停留在最近一次合法状态
  return false;
}

/**
 * 结构区改动入口：以当前结构模型为准重新生成文本。
 * 若当前模型本身无法序列化（理论上不应出现），保留文本并返回错误。
 */
export function syncFromModel(state: SyncSessionState): string | undefined {
  try {
    const text = modelToSchemaText(state.model);
    state.text = text;
    state.valid = true;
    state.error = undefined;
    state.errorLine = undefined;
    state.errorColumn = undefined;
    return undefined;
  } catch (e) {
    state.valid = false;
    state.error = (e as Error).message;
    return state.error;
  }
}
