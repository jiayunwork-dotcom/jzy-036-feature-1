/**
 * 同步会话 store：封装引擎的同步状态机为 Vue 响应式对象。
 * 所有「文本 <-> 结构」状态收敛于此，组件不自行持有 Schema 副本。
 *
 * 注意：session 是一个「长期存活、只做就地替换」的 reactive 对象，
 * 绝不重新赋值引用 —— 这样非法文本时保留旧 model 的引擎语义，
 * 在 Vue 响应式下依然是「结构区不被清空」。
 *
 * 片段：会话额外持有当前片段库快照（session.library）。
 * 引用节点保留在 model 中（不展开）；控件/预览使用 lastExpanded（最近一次
 * 合法展开）。悬空/闭环/片段定义不合法统一走非法态。
 */
import { reactive, computed } from 'vue';
import {
  createSyncSession,
  setText,
  syncFromModel,
  setFragmentLibrary,
  type SyncSessionState,
} from '@engine/sync';
import { emptyRoot } from '@engine/tree';
import { modelToControls, type ControlNode } from '@engine/controls';
import { initData, type FormData } from '@engine/validate';
import { convertNodeToRef, inlineNodeRef } from '@engine/tree';
import type { FragmentLibrary } from '@engine/fragments';

const initial = createSyncSession(emptyRoot());

export const session: SyncSessionState = reactive({
  model: initial.model,
  library: initial.library,
  text: initial.text,
  valid: initial.valid,
  error: undefined,
  errorLine: undefined,
  errorColumn: undefined,
  lastExpanded: initial.lastExpanded,
}) as SyncSessionState;

/** 就地替换会话内容（新建 / 载入 / 导入） */
function adopt(next: SyncSessionState): void {
  session.model = next.model;
  session.library = next.library;
  session.text = next.text;
  session.valid = next.valid;
  session.error = next.error;
  session.errorLine = next.errorLine;
  session.errorColumn = next.errorColumn;
  session.lastExpanded = next.lastExpanded;
}

export const syncState = session;

/** 当前片段库快照（由 fragments store 推送；引擎同步状态机的一部分） */
export function currentLibrary(): FragmentLibrary {
  return session.library;
}

/** 控件树（按片段当前定义穿透展开；非法时停留在最近一次合法展开，不被清空） */
export const controlTree = computed<ControlNode>(() => {
  try {
    return modelToControls(session.model, session.library);
  } catch {
    return modelToControls(session.lastExpanded, {});
  }
});

/** 依据当前结构生成一份新的表单数据（引用默认值取片段当前定义） */
export function freshFormData(): FormData {
  try {
    return (initData(session.model, session.library) ?? {}) as FormData;
  } catch {
    return (initData(session.lastExpanded) ?? {}) as FormData;
  }
}

/** 文本区输入：合法返回 true 并刷新结构；非法返回 false 且结构保持不动 */
export function onTextInput(text: string): boolean {
  return setText(session, text);
}

/** 结构区任意编辑完成后调用：以结构为准重建文本，恢复合法态 */
export function onModelChanged(): void {
  syncFromModel(session);
}

/** 结构区把内嵌字段转换为片段引用 */
export function convertFieldToRef(nodeId: string, fragmentName: string): boolean {
  const node = convertNodeToRef(session.model, nodeId, fragmentName);
  if (!node) return false;
  syncFromModel(session);
  return true;
}

/** 结构区把引用节点收编为内嵌定义（片段当前内容的快照） */
export function inlineFieldRef(nodeId: string): boolean {
  const node = inlineNodeRef(session.model, nodeId, session.library);
  if (!node) return false;
  syncFromModel(session);
  return true;
}

/** 片段库变更（保存/删除/载入）后推送新库：重新校验与展开（文档文本不被改写，晚绑定） */
export function refreshFragmentLibrary(library: FragmentLibrary): boolean {
  return setFragmentLibrary(session, library);
}

/** 载入：用新模型替换会话，文本由模型重新生成 */
export function loadModel(model: ReturnType<typeof emptyRoot>): void {
  adopt(createSyncSession(model, session.library));
}

/** 载入文本：合法则接上，非法也进入会话（展示错误，结构保持空/旧态） */
export function loadText(text: string): boolean {
  const next = createSyncSession(emptyRoot(), session.library);
  const ok = setText(next, text);
  adopt(next);
  return ok;
}
