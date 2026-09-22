/**
 * HTTP 层测试：
 *  - 引擎接口：解析（非法不 5xx、给出原因）、序列化、表单校验；
 *  - 导入导出：文本保存 -> 读回 -> 重新解析得到等价结构；
 *  - 版本轨迹：保存产生新版本、回滚后内容与所选版本一致；
 *  - 多文档独立 + revision 乐观锁：并发编辑不同文档不串号，并发改同一文档后写被 409 拒绝。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp, ensureDemoDocument } from '../packages/server/src/app';
import { DEMO_SCHEMA } from '@engine/demo';

const { app, repo } = createApp(':memory:');
let server: Server;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${(addr as { port: number }).port}`;
      resolve();
    });
  });
  ensureDemoDocument(repo);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  repo.close();
});

async function call<T = any>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

const sampleSchema = JSON.stringify(
  {
    type: 'object',
    title: '测试表单',
    required: ['name'],
    properties: {
      name: { type: 'string', title: '姓名', minLength: 2, maxLength: 10 },
      age: { type: 'integer', minimum: 1, maximum: 150 },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
    },
  },
  null,
  2,
);

describe('引擎 HTTP 接口', () => {
  it('健康检查', async () => {
    const r = await call('/api/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('POST /parse 合法 Schema', async () => {
    const r = await call('/api/schema/parse', {
      method: 'POST',
      body: JSON.stringify({ text: sampleSchema }),
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.controls.widget).toBe('group');
    const nameNode = r.body.model.children.find((c: { name: string }) => c.name === 'name');
    expect(nameNode.minLength).toBe(2);
  });

  it('POST /parse 非法 JSON 返回 200 + ok:false（工具不崩）', async () => {
    const r = await call('/api/schema/parse', {
      method: 'POST',
      body: JSON.stringify({ text: '{"type":' }),
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/JSON 语法错误/);
  });

  it('POST /parse 非法 Schema 语义被拒绝', async () => {
    const r = await call('/api/schema/parse', {
      method: 'POST',
      body: JSON.stringify({ text: JSON.stringify({ type: 'object', properties: { x: { type: 'weird' } } }) }),
    });
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/不支持的类型/);
  });

  it('POST /serialize 结构模型 -> 文本', async () => {
    const model = {
      name: '',
      type: 'object',
      propertiesWillBeIgnored: true,
      children: [
        { name: 'email', type: 'string', required: true, title: '邮箱' },
      ],
    };
    const r = await call('/api/schema/serialize', {
      method: 'POST',
      body: JSON.stringify({ model }),
    });
    expect(r.status).toBe(200);
    const reparsed = JSON.parse(r.body.text);
    expect(reparsed.type).toBe('object');
    expect(reparsed.required).toEqual(['email']);
    expect(reparsed.properties.email.title).toBe('邮箱');
  });

  it('POST /validate-form 违例拦截 / 合法放行', async () => {
    const text = JSON.stringify(DEMO_SCHEMA);
    const bad = await call('/api/schema/validate-form', {
      method: 'POST',
      body: JSON.stringify({
        text,
        data: { fullName: 'A', age: 5, email: 'bad', track: 'X' },
      }),
    });
    expect(bad.body.valid).toBe(false);
    const locs = bad.body.errors.map((e: { loc: string }) => e.loc);
    expect(locs).toEqual(expect.arrayContaining(['fullName', 'age', 'email', 'track']));

    const good = await call('/api/schema/validate-form', {
      method: 'POST',
      body: JSON.stringify({
        text,
        data: {
          fullName: '张三',
          age: 30,
          email: 'a@b.cn',
          track: '前端专场',
          address: { city: '北京' },
        },
      }),
    });
    expect(good.body.valid).toBe(true);
  });
});

describe('文档持久化 + 导入导出等价', () => {
  it('启动时已播种示范文档且内容可载入', async () => {
    const list = await call<{ documents: Array<{ name: string }> }>('/api/documents');
    expect(list.body.documents.some((d) => d.name.includes('报名表'))).toBe(true);
  });

  it('新建 -> 保存 -> 读回 -> 重新解析，结构等价（导出再导入）', async () => {
    const created = await call<{ doc: { id: number; revision: number } }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ name: '往返文档', content: sampleSchema }),
    });
    expect(created.status).toBe(201);
    const id = created.body.doc.id;
    expect(created.body.doc.revision).toBe(1);

    // 「导出」：读回服务端存住的文本
    const loaded = await call<{ doc: { content: string; revision: number } }>(`/api/documents/${id}`);
    const exportedText = loaded.body.doc.content;

    // 「导入」：把导出文本交给解析接口反向铺开
    const reparsed = await call('/api/schema/parse', {
      method: 'POST',
      body: JSON.stringify({ text: exportedText }),
    });
    expect(reparsed.status).toBe(200);
    expect(reparsed.body.ok).toBe(true);
    // /parse 返回结构模型（children 树）
    const nameNode = reparsed.body.model.children.find(
      (c: { name: string }) => c.name === 'name',
    );
    expect(nameNode.maxLength).toBe(10);
    const tagsNode = reparsed.body.model.children.find(
      (c: { name: string }) => c.name === 'tags',
    );
    expect(tagsNode.item.enum).toEqual(['a', 'b']);

    // 再次序列化应与原文本语义相同
    const reser = await call<{ text: string }>('/api/schema/serialize', {
      method: 'POST',
      body: JSON.stringify({ model: reparsed.body.model }),
    });
    expect(JSON.parse(reser.body.text)).toEqual(JSON.parse(sampleSchema));
  });

  it('非法 Schema 不能保存（持久化边界权威校验）', async () => {
    const r = await call('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ name: '非法的', content: '{broken' }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/非法 Schema/);
  });
});

describe('版本轨迹与回滚', () => {
  it('每次保存产生新版本；可查看历史版本', async () => {
    const created = await call<{ doc: { id: number; revision: number } }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ name: '版本文档', content: sampleSchema }),
    });
    const id = created.body.doc.id;

    const v2Text = JSON.stringify({
      type: 'object',
      properties: { only: { type: 'boolean' } },
    });
    const saved2 = await call(`/api/documents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ content: v2Text, expectedRevision: 1 }),
    });
    expect(saved2.status).toBe(200);
    expect(saved2.body.doc.revision).toBe(2);

    const versions = await call<{ versions: Array<{ version: number }> }>(
      `/api/documents/${id}/versions`,
    );
    expect(versions.body.versions.map((v) => v.version)).toEqual([2, 1]);

    const v1 = await call<{ version: { content: string } }>(`/api/documents/${id}/versions/1`);
    expect(JSON.parse(v1.body.version.content).title).toBe('测试表单');
  });

  it('回滚后文档内容与所选版本一致，且产生新版本（轨迹连续）', async () => {
    const created = await call<{ doc: { id: number } }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ name: '回滚文档', content: sampleSchema }),
    });
    const id = created.body.doc.id;

    const v2Text = JSON.stringify({ type: 'object', properties: { x: { type: 'number' } } });
    await call(`/api/documents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ content: v2Text, expectedRevision: 1 }),
    });

    // 回滚到 v1
    const rb = await call(`/api/documents/${id}/rollback/1`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: 2 }),
    });
    expect(rb.status).toBe(200);
    expect(rb.body.doc.revision).toBe(3);

    const after = await call<{ doc: { content: string; revision: number } }>(
      `/api/documents/${id}`,
    );
    // 回滚后当前内容与 v1 逐字一致
    expect(after.body.doc.content).toBe(sampleSchema);
    expect(after.body.doc.revision).toBe(3);

    const versions = await call<{ versions: Array<{ version: number; note: string | null }> }>(
      `/api/documents/${id}/versions`,
    );
    expect(versions.body.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versions.body.versions[0].note).toContain('回滚到版本 v1');
  });
});

describe('多文档隔离与并发保护', () => {
  it('不同文档各自独立，互不覆盖', async () => {
    const a = await call<{ doc: { id: number } }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ name: '文档A', content: sampleSchema }),
    });
    const b = await call<{ doc: { id: number } }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({
        name: '文档B',
        content: JSON.stringify({ type: 'object', properties: { onlyB: { type: 'boolean' } } }),
      }),
    });
    const idA = a.body.doc.id;
    const idB = b.body.doc.id;
    expect(idA).not.toBe(idB);

    // 两边并发各改各的，都应成功
    const a2Text = JSON.stringify({ type: 'object', properties: { a2: { type: 'string' } } });
    const b2Text = JSON.stringify({ type: 'object', properties: { b2: { type: 'integer' } } });
    const [ra, rb] = await Promise.all([
      call(`/api/documents/${idA}`, {
        method: 'PUT',
        body: JSON.stringify({ content: a2Text, expectedRevision: 1 }),
      }),
      call(`/api/documents/${idB}`, {
        method: 'PUT',
        body: JSON.stringify({ content: b2Text, expectedRevision: 1 }),
      }),
    ]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);

    const [ga, gb] = await Promise.all([
      call<{ doc: { content: string } }>(`/api/documents/${idA}`),
      call<{ doc: { content: string } }>(`/api/documents/${idB}`),
    ]);
    expect(JSON.parse(ga.body.doc.content).properties.a2).toBeDefined();
    expect(JSON.parse(ga.body.doc.content).properties.b2).toBeUndefined();
    expect(JSON.parse(gb.body.doc.content).properties.b2).toBeDefined();
    expect(JSON.parse(gb.body.doc.content).properties.a2).toBeUndefined();
  });

  it('同一文档并发保存：基于旧 revision 的第二次写入被 409 拒绝，先写不被覆盖', async () => {
    const created = await call<{ doc: { id: number } }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ name: '竞争文档', content: sampleSchema }),
    });
    const id = created.body.doc.id;

    const t1 = JSON.stringify({ type: 'object', properties: { winner: { type: 'string' } } });
    const t2 = JSON.stringify({ type: 'object', properties: { loser: { type: 'string' } } });

    // 两个会话都持有 revision=1 并发提交
    const [r1, r2] = await Promise.all([
      call(`/api/documents/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ content: t1, expectedRevision: 1 }),
      }),
      call(`/api/documents/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ content: t2, expectedRevision: 1 }),
      }),
    ]);

    const ok = [r1, r2].filter((r) => r.status === 200);
    const conflicts = [r1, r2].filter((r) => r.status === 409);
    expect(ok.length).toBe(1);
    expect(conflicts.length).toBe(1);

    const cur = await call<{ doc: { content: string } }>(`/api/documents/${id}`);
    expect(JSON.parse(cur.body.doc.content).properties.winner).toBeDefined();
    expect(JSON.parse(cur.body.doc.content).properties.loser).toBeUndefined();
  });
});
