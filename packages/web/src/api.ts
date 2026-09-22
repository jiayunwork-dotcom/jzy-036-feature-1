/** 后端接口封装 */

async function jsonFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body as { error?: string })?.error ?? `请求失败 (${res.status})`;
    const err = new Error(message) as Error & { status: number; body: unknown };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

export interface DocSummary {
  id: number;
  name: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface DocRecord extends DocSummary {
  content: string;
}

export interface VersionRecord {
  version: number;
  revision: number;
  content: string;
  created_at: string;
  note: string | null;
}

export interface FragmentRecord {
  key: string;
  title: string;
  content: string;
  revision: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface FragmentReference {
  kind: 'document' | 'fragment';
  id: number | string;
  name: string;
  refKey: string;
  path: string;
  indirect: boolean;
}

export const api = {
  health: () => jsonFetch<{ ok: boolean }>('/api/health'),

  listDocs: () => jsonFetch<{ documents: DocSummary[] }>('/api/documents'),
  createDoc: (name: string, content: string) =>
    jsonFetch<{ doc: DocRecord; version: number }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ name, content }),
    }),
  getDoc: (id: number) => jsonFetch<{ doc: DocRecord }>(`/api/documents/${id}`),
  saveDoc: (id: number, content: string, expectedRevision: number, note?: string) =>
    jsonFetch<{ doc: DocRecord; version: number }>(`/api/documents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ content, expectedRevision, note }),
    }),
  renameDoc: (id: number, name: string) =>
    jsonFetch<{ doc: DocRecord }>(`/api/documents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteDoc: (id: number) =>
    fetch(`/api/documents/${id}`, { method: 'DELETE' }).then((r) => {
      if (!r.ok && r.status !== 204) throw new Error('删除失败');
    }),
  listVersions: (id: number) =>
    jsonFetch<{ versions: VersionRecord[] }>(`/api/documents/${id}/versions`),
  getVersion: (id: number, version: number) =>
    jsonFetch<{ version: VersionRecord }>(`/api/documents/${id}/versions/${version}`),
  rollback: (id: number, version: number, expectedRevision: number) =>
    jsonFetch<{ doc: DocRecord; version: number }>(
      `/api/documents/${id}/rollback/${version}`,
      { method: 'POST', body: JSON.stringify({ expectedRevision }) },
    ),

  parse: (text: string) =>
    jsonFetch<{ ok: boolean; error?: string; controls?: unknown }>('/api/schema/parse', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  // ---- 结构片段 ----
  listFragments: () => jsonFetch<{ fragments: FragmentRecord[] }>('/api/fragments'),
  createFragment: (key: string, title: string, content: string) =>
    jsonFetch<{ fragment: FragmentRecord; version: number }>('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ key, title, content }),
    }),
  getFragment: (key: string) =>
    jsonFetch<{ fragment: FragmentRecord }>(`/api/fragments/${encodeURIComponent(key)}`),
  saveFragment: (
    key: string,
    payload: { content?: string; title?: string; expectedRevision: number; note?: string },
  ) =>
    jsonFetch<{ fragment: FragmentRecord; version: number }>(
      `/api/fragments/${encodeURIComponent(key)}`,
      { method: 'PUT', body: JSON.stringify(payload) },
    ),
  fragmentUsage: (key: string) =>
    jsonFetch<{ key: string; references: FragmentReference[] }>(
      `/api/fragments/${encodeURIComponent(key)}/usage`,
    ),
  fragmentVersions: (key: string) =>
    jsonFetch<{
      versions: Array<{ version: number; revision: number; note: string | null; created_at: string }>;
    }>(`/api/fragments/${encodeURIComponent(key)}/versions`),
  deleteFragment: (key: string, mode?: 'reject' | 'detach') => {
    const qs = mode === 'detach' ? '?mode=detach' : '';
    return fetch(`/api/fragments/${encodeURIComponent(key)}${qs}`, { method: 'DELETE' }).then(
      async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          const err = new Error(
            (body as { error?: string })?.error ?? `删除失败 (${r.status})`,
          ) as Error & { status: number; body: unknown };
          err.status = r.status;
          err.body = body;
          throw err;
        }
        return body;
      },
    );
  },
};
