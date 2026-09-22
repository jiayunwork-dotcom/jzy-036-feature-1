/**
 * 结构片段 store：片段是与文档对齐的一等资源（独立 revision / 版本历史）。
 * 浏览器侧把当前可见片段同步进同步会话的片段库（syncSession.refreshFragmentLib），
 * 结构区引用节点、控件穿透、预览校验全部据此工作。
 */
import { reactive } from 'vue';
import { api, type FragmentRecord, type FragmentReference } from '../api';
import { refreshFragmentLib } from './syncSession';
import { buildFragmentLib } from '@engine/fragments';
import type { FragmentDef } from '@engine/types';

interface FragmentsState {
  fragments: FragmentRecord[];
  loading: boolean;
  message: string | null;
}

export const fragmentsState = reactive<FragmentsState>({
  fragments: [],
  loading: false,
  message: null,
});

function flash(msg: string): void {
  fragmentsState.message = msg;
  window.setTimeout(() => {
    if (fragmentsState.message === msg) fragmentsState.message = null;
  }, 4000);
}

/** 拉取片段列表，构建引擎片段库并推送给同步会话（文本按新库重新解释） */
export async function refreshFragments(): Promise<Map<string, FragmentDef>> {
  const { fragments } = await api.listFragments();
  fragmentsState.fragments = fragments;
  const { lib, errors } = buildFragmentLib(
    fragments.map((f) => ({ key: f.key, content: f.content })),
  );
  refreshFragmentLib(lib, errors);
  // 库里存在问题片段（闭环/悬空/非法）时，引用它的文档会被同一套非法态兜住
  if (errors.size > 0) {
    flash(`片段库存在 ${errors.size} 个问题片段，相关引用已进入非法态提示`);
  }
  return lib;
}

export function fragmentOptions(): Array<{ key: string; title: string }> {
  return fragmentsState.fragments.map((f) => ({ key: f.key, title: f.title || f.key }));
}

export async function createFragment(key: string, title: string, content: string): Promise<boolean> {
  try {
    await api.createFragment(key, title, content);
    await refreshFragments();
    flash(`已创建片段「${title}」`);
    return true;
  } catch (e) {
    flash(`创建片段失败：${(e as Error).message}`);
    return false;
  }
}

export async function saveFragment(
  key: string,
  payload: { content?: string; title?: string; expectedRevision: number; note?: string },
): Promise<boolean> {
  try {
    await api.saveFragment(key, payload);
    await refreshFragments();
    // 片段内容变了：当前文档保持引用指针，控件/预览/校验即时按新定义生效
    flash(`片段「${key}」已保存，所有引用处按新定义生效`);
    return true;
  } catch (e) {
    flash(`保存片段失败：${(e as Error).message}`);
    return false;
  }
}

export async function fragmentUsage(key: string): Promise<FragmentReference[]> {
  const { references } = await api.fragmentUsage(key);
  return references;
}

/**
 * 删除片段：
 *  - 默认被引用时服务端 409，这里把引用方列表回传供 UI 展示；
 *  - detach=true 显式连同引用一起摘除（服务端改写引用方并归档片段）。
 */
export async function removeFragment(
  key: string,
  detach = false,
): Promise<{ ok: boolean; references?: FragmentReference[] }> {
  try {
    await api.deleteFragment(key, detach ? 'detach' : 'reject');
    await refreshFragments();
    flash(detach ? `片段「${key}」已归档，引用处已摘除` : `片段「${key}」已删除`);
    return { ok: true };
  } catch (e) {
    const err = e as Error & { status?: number; body?: { references?: FragmentReference[] } };
    if (err.status === 409 && err.body?.references) {
      return { ok: false, references: err.body.references };
    }
    flash(`删除片段失败：${(e as Error).message}`);
    return { ok: false };
  }
}

export { flash as notifyFragment };
