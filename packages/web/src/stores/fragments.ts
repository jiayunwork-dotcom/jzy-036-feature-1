/**
 * 片段管理 store：片段是与文档对齐的一等资源（命名、版本历史、revision 乐观锁）。
 * 同时持有供编辑器引擎使用的片段库快照 library（片段名 -> 结构模型）。
 */
import { reactive } from 'vue';
import { api, FragmentRecord, FragmentReference, FragmentSummary } from '../api';
import { refreshFragmentLibrary } from './syncSession';
import type { FragmentLibrary } from '@engine/fragments';
import { parseSchemaText } from '@engine/parser';

interface FragmentsStateShape {
  fragments: FragmentSummary[];
  /** 片段名 -> 结构模型，供引用解析、控件穿透与校验 */
  library: FragmentLibrary;
  /** 片段库自身的问题（正常保存边界下为空） */
  errors: string[];
  message: string | null;
}

export const fragmentsState = reactive<FragmentsStateShape>({
  fragments: [],
  library: {},
  errors: [],
  message: null,
});

function flash(msg: string): void {
  fragmentsState.message = msg;
  window.setTimeout(() => {
    if (fragmentsState.message === msg) fragmentsState.message = null;
  }, 4000);
}

export async function refreshFragments(): Promise<void> {
  const list = await api.listFragments();
  fragmentsState.fragments = list.fragments;
  await loadLibrary();
}

/** 拉取片段库并解析为结构模型，通知同步会话按新库重新校验当前文档（晚绑定） */
async function loadLibrary(): Promise<void> {
  const library: FragmentLibrary = {};
  const errors: string[] = [];
  for (const f of fragmentsState.fragments) {
    const { fragment } = await api.getFragment(f.name);
    const parsed = parseSchemaText(fragment.content, { allowNonObjectRoot: true });
    if (!parsed.ok || !parsed.model) {
      errors.push(`片段「${f.name}」定义不合法：${parsed.error ?? '解析失败'}`);
      continue;
    }
    parsed.model.name = '';
    library[f.name] = parsed.model;
  }
  fragmentsState.library = library;
  fragmentsState.errors = errors;
  refreshFragmentLibrary(library);
}

export async function createFragment(name: string, content: string, title?: string): Promise<boolean> {
  try {
    await api.createFragment(name, content, title);
    await refreshFragments();
    flash(`已创建片段「${name}」`);
    return true;
  } catch (e) {
    flash(`创建片段失败：${(e as Error).message}`);
    return false;
  }
}

export async function saveFragment(
  name: string,
  content: string,
  expectedRevision: number,
  title?: string,
  note?: string,
): Promise<FragmentRecord | null> {
  try {
    const { fragment } = await api.saveFragment(name, content, expectedRevision, note, title);
    await refreshFragments();
    flash(`片段「${name}」已保存（revision ${fragment.revision}）`);
    return fragment;
  } catch (e) {
    flash(`保存片段失败：${(e as Error).message}`);
    return null;
  }
}

export async function fetchReferences(name: string): Promise<FragmentReference[]> {
  const { references } = await api.fragmentReferences(name);
  return references;
}

/**
 * 删除片段。cascade=false 时服务端在仍被引用情况下返回 409，
 * 错误 body.references 带完整引用方列表，由 UI 展示影响范围；
 * cascade=true 时服务端在单事务内把引用处一跳内联为快照再删除。
 */
export async function removeFragment(
  name: string,
  cascade: boolean,
): Promise<{ ok: true; references: FragmentReference[] } | { ok: false; references: FragmentReference[]; error: string }> {
  try {
    const r = await api.deleteFragment(name, cascade);
    await refreshFragments();
    flash(cascade ? `已级联删除片段「${name}」，引用处已内联为结构快照` : `已删除片段「${name}」`);
    return { ok: true, references: r.references ?? [] };
  } catch (e) {
    const err = e as Error & { body?: { references?: FragmentReference[] } };
    const references = err.body?.references ?? [];
    flash(`删除片段失败：${err.message}`);
    return { ok: false, references, error: err.message };
  }
}

export { flash as fragmentNotify };
