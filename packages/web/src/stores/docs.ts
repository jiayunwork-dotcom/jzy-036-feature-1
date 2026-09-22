/**
 * 文档管理 store：多份 Schema 文档彼此独立；revision 乐观锁防止并发覆盖；
 * 版本轨迹读取与回滚。
 */
import { reactive } from 'vue';
import { api, type DocSummary, type DocRecord, type VersionRecord } from '../api';

interface DocsState {
  documents: DocSummary[];
  currentId: number | null;
  currentName: string;
  revision: number;
  loading: boolean;
  versions: VersionRecord[];
  message: string | null;
}

export const docsState = reactive<DocsState>({
  documents: [],
  currentId: null,
  currentName: '',
  revision: 0,
  loading: false,
  versions: [],
  message: null,
});

function flash(msg: string): void {
  docsState.message = msg;
  window.setTimeout(() => {
    if (docsState.message === msg) docsState.message = null;
  }, 3500);
}

export async function refreshList(): Promise<void> {
  const { documents } = await api.listDocs();
  docsState.documents = documents;
}

export function newDocumentState(): void {
  docsState.currentId = null;
  docsState.currentName = '';
  docsState.revision = 0;
  docsState.versions = [];
}

export async function loadDocument(id: number, applyText: (text: string) => void): Promise<void> {
  const { doc } = await api.getDoc(id);
  docsState.currentId = doc.id;
  docsState.currentName = doc.name;
  docsState.revision = doc.revision;
  applyText(doc.content);
  await refreshVersions();
  flash(`已载入「${doc.name}」（revision ${doc.revision}）`);
}

export async function createDocument(name: string, content: string): Promise<number> {
  const { doc } = await api.createDoc(name, content);
  docsState.currentId = doc.id;
  docsState.currentName = doc.name;
  docsState.revision = doc.revision;
  await refreshList();
  await refreshVersions();
  flash(`已新建「${doc.name}」`);
  return doc.id;
}

export async function saveCurrent(content: string, note?: string): Promise<boolean> {
  if (!docsState.currentId) {
    const id = await createDocument(docsState.currentName || '未命名 Schema', content);
    void id;
    return true;
  }
  try {
    const { doc } = await api.saveDoc(
      docsState.currentId,
      content,
      docsState.revision,
      note,
    );
    docsState.revision = doc.revision;
    docsState.currentName = doc.name;
    await refreshList();
    await refreshVersions();
    flash(`已保存，revision ${doc.revision}（新版本 v${docsState.versions[0]?.version ?? 1}）`);
    return true;
  } catch (e) {
    if ((e as { status?: number }).status === 409) {
      flash(`保存被拒绝：文档在别处被修改，请重新载入后再保存（${(e as Error).message}）`);
    } else {
      flash(`保存失败：${(e as Error).message}`);
    }
    return false;
  }
}

export async function renameCurrent(name: string): Promise<void> {
  if (!docsState.currentId) {
    docsState.currentName = name;
    return;
  }
  const { doc } = await api.renameDoc(docsState.currentId, name);
  docsState.currentName = doc.name;
  await refreshList();
}

export async function removeDocument(id: number): Promise<void> {
  await api.deleteDoc(id);
  if (docsState.currentId === id) newDocumentState();
  await refreshList();
  flash('文档已删除');
}

export async function refreshVersions(): Promise<void> {
  if (!docsState.currentId) {
    docsState.versions = [];
    return;
  }
  const { versions } = await api.listVersions(docsState.currentId);
  docsState.versions = versions;
}

/** 查看历史版本（返回其内容，由 UI 决定只读预览或回滚） */
export async function fetchVersion(version: number): Promise<VersionRecord> {
  const { version: v } = await api.getVersion(docsState.currentId!, version);
  return v;
}

/** 回滚：历史内容作为新版本写入，成功后更新 revision 并应用文本 */
export async function rollbackTo(
  version: number,
  applyText: (text: string) => void,
): Promise<boolean> {
  if (!docsState.currentId) return false;
  try {
    const { doc } = await api.rollback(docsState.currentId, version, docsState.revision);
    docsState.revision = doc.revision;
    applyText(doc.content);
    await refreshVersions();
    await refreshList();
    flash(`已回滚到 v${version}（保存为新版本 v${docsState.versions[0]?.version}）`);
    return true;
  } catch (e) {
    flash(`回滚失败：${(e as Error).message}`);
    return false;
  }
}

export { flash as notify };
