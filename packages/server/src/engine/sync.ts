/**
 * 双向同步状态机：保证文本侧与结构侧「不打架」的唯一入口。
 *
 * 不变量：
 *  - state.model 永远是「最近一次合法 Schema」对应的结构模型（引用以 ref 节点保留，不展开）；
 *  - state.library 是当前片段库快照（片段是一等资源，独立于文档持久化，会随时更新）；
 *  - 文本合法：setText 用新解析出的模型替换 state.model；
 *  - 文本非法（含悬空引用 / 闭环引用 / 片段定义不合法）：state.model 原样保留
 *    （可视化区不被清空），仅置 valid=false 与原因——与 JSON 语法错误走同一套回退；
 *  - 结构侧任何编辑后调用 syncFromModel()，用当前模型重新生成文本，valid 回到 true。
 */
import { FieldNode } from './types';
import { modelToSchemaText } from './serialize';
import { parseSchemaText } from './parser';
import { expandModel } from './fragments';
import type { FragmentLibrary } from './fragments';

export interface SyncSessionState {
  model: FieldNode;
  /** 当前片段库快照 */
  library: FragmentLibrary;
  text: string;
  valid: boolean;
  error?: string;
  errorLine?: number;
  errorColumn?: number;
  /**
   * 最近一次能成功展开的纯内嵌模型。即使当前因片段悬空/闭环处于非法态，
   * 控件树与预览仍可停留在这份「最近合法展开态」，与文本非法态语义一致。
   */
  lastExpanded: FieldNode;
}

export function createSyncSession(model: FieldNode, library: FragmentLibrary = {}): SyncSessionState {
  return {
    model,
    library,
    text: modelToSchemaText(model),
    valid: true,
    lastExpanded: safeExpand(model, library),
  };
}

/** 展开失败（悬空/闭环）时返回 null，由调用方决定回退策略 */
function safeExpand(model: FieldNode, library: FragmentLibrary): FieldNode {
  try {
    return expandModel(model, library);
  } catch {
    // 初始化等场景：无合法展开时退化为模型本身（引用节点由 UI 以引用样式渲染）
    return model;
  }
}

/** 重新校验当前 model + library；返回是否处于合法态，并维护 lastExpanded */
function revalidate(state: SyncSessionState): boolean {
  try {
    state.lastExpanded = expandModel(state.model, state.library);
    return true;
  } catch (e) {
    state.valid = false;
    state.error = (e as Error).message;
    return false;
  }
}

/**
 * 文本区改动入口。
 * @returns true 表示本次改动后处于合法态（结构区已刷新）；false 表示非法（结构区保持旧态）
 */
export function setText(state: SyncSessionState, text: string): boolean {
  state.text = text;
  const result = parseSchemaText(text, { library: state.library });
  if (result.ok && result.model) {
    state.model = result.model;
    state.valid = true;
    state.error = undefined;
    state.errorLine = undefined;
    state.errorColumn = undefined;
    revalidate(state);
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
 * 引用仍悬空/闭环时（例如刚把字段转成一个拼错名字的片段引用）也进入非法态，
 * 由同一套「最近合法态」提示与回退兜住。
 */
export function syncFromModel(state: SyncSessionState): string | undefined {
  try {
    const text = modelToSchemaText(state.model);
    state.text = text;
    state.errorLine = undefined;
    state.errorColumn = undefined;
    if (revalidate(state)) {
      state.valid = true;
      state.error = undefined;
    }
    return undefined;
  } catch (e) {
    state.valid = false;
    state.error = (e as Error).message;
    return state.error;
  }
}

/**
 * 片段库变更（保存/删除片段）后调用：文档模型本身不动（引用是晚绑定链路），
 * 但要按新库重新校验并刷新展开态。改片段定义 -> 所有引用处的控件/校验即时变化；
 * 若新库让本文档的引用悬空或卷入闭环，进入非法态并保留最近合法展开。
 * @returns true 表示当前文档在新库下仍合法
 */
export function setFragmentLibrary(state: SyncSessionState, library: FragmentLibrary): boolean {
  state.library = library;
  // 用当前库重新解析一遍文本，捕捉「片段被改名/删除导致悬空」等变化；
  // 文本本身（$ref 链路）不被重写。
  const result = parseSchemaText(state.text, { library });
  if (result.ok && result.model) {
    state.model = result.model;
    state.valid = true;
    state.error = undefined;
    state.errorLine = undefined;
    state.errorColumn = undefined;
    state.lastExpanded = safeExpand(result.model, library);
    return true;
  }
  state.valid = false;
  state.error = result.error;
  // 模型保持旧值；lastExpanded 保持上一次成功展开（预览不清空）
  return false;
}

/**
 * 结构侧把某节点在「内嵌定义 <-> 片段引用」之间转换后调用：
 * 本质是一次结构编辑，复用 syncFromModel 的序列化 + 重新校验。
 */
export function resyncAfterRefChange(state: SyncSessionState): string | undefined {
  return syncFromModel(state);
}
