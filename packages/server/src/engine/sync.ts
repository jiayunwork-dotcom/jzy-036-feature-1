/**
 * 双向同步状态机：保证文本侧与结构侧「不打架」的唯一入口。
 *
 * 不变量：
 *  - state.model 永远是「最近一次合法 Schema」对应的结构模型（含引用节点，引用不展开）；
 *  - 文本合法：setText 用新解析出的模型替换 state.model；
 *  - 文本非法（JSON 错、Schema 语义错、片段悬空、片段闭环、片段定义非法）：
 *    state.model 原样保留（可视化区不被清空），仅置 valid=false 与原因；
 *  - 结构侧任何编辑后调用 syncFromModel()，用当前模型重新生成文本，valid 回到 true。
 *
 * 片段库（fragments）是引用的解释上下文：库为空时行为与升级前完全一致
 * （老文档不含 $fragment，解析路径逐行不变）。
 */
import { FieldNode, FragmentLib } from './types';
import { modelToSchemaText } from './serialize';
import { parseSchemaText } from './parser';
import { validateFragmentGraph } from './fragments';

export interface SyncSessionState {
  model: FieldNode;
  text: string;
  valid: boolean;
  error?: string;
  errorLine?: number;
  errorColumn?: number;
  /** 当前可见的片段库；刷新片段后对最近合法模型重新解释 */
  fragments: FragmentLib;
  /** 构建片段库时发现的图问题（坏片段不入 lib，错误信息随此图传入） */
  fragmentErrors?: Map<string, string>;
}

export function createSyncSession(
  model: FieldNode,
  fragments: FragmentLib = new Map(),
  fragmentErrors?: Map<string, string>,
): SyncSessionState {
  return { model, text: modelToSchemaText(model), valid: true, fragments, fragmentErrors };
}

/** 严格解析选项：携带当前库的闭环/悬空图校验结果 */
function strictOptions(state: SyncSessionState) {
  return {
    lib: state.fragments,
    fragmentErrors: state.fragmentErrors ?? validateFragmentGraph(state.fragments),
  };
}

/**
 * 文本区改动入口。
 * @returns true 表示本次改动后处于合法态（结构区已刷新）；false 表示非法（结构区保持旧态）
 */
export function setText(state: SyncSessionState, text: string): boolean {
  state.text = text;
  const result = parseSchemaText(text, strictOptions(state));
  if (result.ok && result.model) {
    state.model = result.model as FieldNode;
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

/**
 * 片段库变更入口：替换库后重新解释当前文本。
 * 片段被改/被删导致引用悬空或闭环时，进入既有「非法态」（结构区保留最近合法态，
 * 且此时的最近合法态是变更前的模型）；库恢复健康后自动重新接上。
 */
export function setFragmentLib(
  state: SyncSessionState,
  lib: FragmentLib,
  errors?: Map<string, string>,
): boolean {
  state.fragments = lib;
  state.fragmentErrors = errors ?? validateFragmentGraph(lib);
  return setText(state, state.text);
}
