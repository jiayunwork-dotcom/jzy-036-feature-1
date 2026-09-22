/**
 * 同步会话 store：封装引擎的同步状态机为 Vue 响应式对象。
 * 所有「文本 <-> 结构」状态收敛于此，组件不自行持有 Schema 副本。
 *
 * 注意：session 是一个「长期存活、只做就地替换」的 reactive 对象，
 * 绝不重新赋值引用 —— 这样非法文本时保留旧 model 的引擎语义，
 * 在 Vue 响应式下依然是「结构区不被清空」。
 */
import { reactive, computed } from 'vue';
import {
  createSyncSession,
  setText,
  syncFromModel,
  type SyncSessionState,
} from '@engine/sync';
import { emptyRoot, type FieldNode } from '@engine/tree';
import { mapControl, type ControlNode } from '@engine/controls';
import { initData, type FormData } from '@engine/validate';

const initial = createSyncSession(emptyRoot());

export const session: SyncSessionState = reactive({
  model: initial.model,
  text: initial.text,
  valid: initial.valid,
  error: undefined,
  errorLine: undefined,
  errorColumn: undefined,
}) as SyncSessionState;

/** 就地替换会话内容（新建 / 载入 / 导入） */
function adopt(next: SyncSessionState): void {
  session.model = next.model;
  session.text = next.text;
  session.valid = next.valid;
  session.error = next.error;
  session.errorLine = next.errorLine;
  session.errorColumn = next.errorColumn;
}

export const syncState = session;

/** 控件树（合法时随结构更新；非法时 model 保持旧值，预览同样停留在最近合法态） */
export const controlTree = computed<ControlNode>(() => mapControl(session.model));

/** 依据当前结构生成一份新的表单数据（默认值生效） */
export function freshFormData(): FormData {
  return (initData(session.model) ?? {}) as FormData;
}

/** 文本区输入：合法返回 true 并刷新结构；非法返回 false 且结构保持不动 */
export function onTextInput(text: string): boolean {
  return setText(session, text);
}

/** 结构区任意编辑完成后调用：以结构为准重建文本，恢复合法态 */
export function onModelChanged(): void {
  syncFromModel(session);
}

/** 载入：用新模型替换会话，文本由模型重新生成 */
export function loadModel(model: FieldNode): void {
  adopt(createSyncSession(model));
}

/** 载入文本：合法则接上，非法也进入会话（展示错误，结构保持空/旧态） */
export function loadText(text: string): boolean {
  const next = createSyncSession(emptyRoot());
  const ok = setText(next, text);
  adopt(next);
  return ok;
}
