/**
 * 同步会话 store：封装引擎的同步状态机为 Vue 响应式对象。
 * 所有「文本 <-> 结构」状态收敛于此，组件不自行持有 Schema 副本。
 *
 * 注意：session 是一个「长期存活、只做就地替换」的 reactive 对象，
 * 绝不重新赋值引用 —— 这样非法文本时保留旧 model 的引擎语义，
 * 在 Vue 响应式下依然是「结构区不被清空」。
 *
 * 片段库（fragments）是引用节点的解释上下文，同样收敛在本 store：
 *  - session.model 保留引用节点（不展开），结构区据此渲染引用节点；
 *  - resolvedModel/computed 穿透到片段当前定义，供控件树与预览校验使用；
 *  - 片段被改/删导致悬空/闭环时，引擎 setText 进入既有「非法态」，
 *    结构区与预览停留在最近合法态。
 */
import { reactive, computed } from 'vue';
import {
  createSyncSession,
  setText,
  syncFromModel,
  setFragmentLib,
  type SyncSessionState,
} from '@engine/sync';
import { emptyRoot } from '@engine/tree';
import { mapControl, type ControlNode } from '@engine/controls';
import { initData, type FormData } from '@engine/validate';
import { resolveModel } from '@engine/fragments';
import type { FieldNode, FragmentDef } from '@engine/types';

const initial = createSyncSession(emptyRoot());

export const session: SyncSessionState = reactive({
  model: initial.model,
  text: initial.text,
  valid: initial.valid,
  error: undefined,
  errorLine: undefined,
  errorColumn: undefined,
  fragments: new Map<string, FragmentDef>(),
  fragmentErrors: undefined,
}) as SyncSessionState;

/** 就地替换会话内容（新建 / 载入 / 导入） */
function adopt(next: SyncSessionState): void {
  session.model = next.model;
  session.text = next.text;
  session.valid = next.valid;
  session.error = next.error;
  session.errorLine = next.errorLine;
  session.errorColumn = next.errorColumn;
  session.fragments = next.fragments;
}

export const syncState = session;

/**
 * 穿透片段引用后的结构视图（控件/预览专用）。
 * 片段悬空/闭环时穿透会抛错——此时退回原始模型，保证界面不崩；
 * 真正的拦截与提示由 session.valid/error 通道负责。
 */
export const resolvedModel = computed<FieldNode>(() => {
  try {
    return resolveModel(session.model, session.fragments);
  } catch {
    return session.model;
  }
});

/** 控件树（合法时随结构更新；非法时 model 保持旧值，预览同样停留在最近合法态） */
export const controlTree = computed<ControlNode>(() => mapControl(resolvedModel.value));

/** 依据当前结构生成一份新的表单数据（片段默认值随其当前定义生效） */
export function freshFormData(): FormData {
  return (initData(resolvedModel.value) ?? {}) as FormData;
}

/** 文本区输入：合法返回 true 并刷新结构；非法返回 false 且结构保持不动 */
export function onTextInput(text: string): boolean {
  return setText(session, text);
}

/** 结构区任意编辑完成后调用：以结构为准重建文本，恢复合法态 */
export function onModelChanged(): void {
  syncFromModel(session);
}

/** 载入：用新模型替换会话，文本由模型重新生成；片段库沿用当前会话 */
export function loadModel(model: FieldNode): void {
  const next = createSyncSession(model, session.fragments);
  adopt({ ...next, fragments: session.fragments });
}

/** 载入文本：合法则接上，非法也进入会话（展示错误，结构保持空/旧态） */
export function loadText(text: string): boolean {
  const next = createSyncSession(emptyRoot(), session.fragments);
  const ok = setText(next, text);
  adopt({ ...next, fragments: session.fragments });
  return ok;
}

/** 替换片段库并重新解释当前文本（悬空/闭环 -> 非法态） */
export function refreshFragmentLib(lib: Map<string, FragmentDef>, errors?: Map<string, string>): boolean {
  return setFragmentLib(session, lib, errors);
}
