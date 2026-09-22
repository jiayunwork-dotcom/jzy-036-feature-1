/**
 * 片段一等资源 + 持久化 + 回滚规则（HTTP 层）：
 *  - 片段 CRUD、revision 乐观锁、版本轨迹与片段回滚；
 *  - 保存片段时闭环 / 悬空当场拒绝；
 *  - 文档保存边界校验引用；含引用文档的导入导出往返保留 $ref；
 *  - 删除被引用片段：默认 409 并列引用方；cascade=true 单事务内联后删除；
 *  - 文档回滚到引用某个片段的历史版本：按「回滚时刻当前片段」晚绑定解释，
 *    片段被删后回滚不失败、不产生脏数据（还原为悬空文本，由非法态提示）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../packages/server/src/app';

const { app, repo } = createApp(':memory:');
let server: Server;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
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

const regionText = JSON.stringify(
  {
    type: 'object',
    title: '省市区',
    required: ['province'],
    properties: { province: { type: 'string', minLength: 2 }, city: { type: 'string' } },
  },
  null,
  2,
);
const addressText = JSON.stringify(
  {
    type: 'object',
    title: '联系地址',
    properties: {
      region: { $ref: 'fragment:region' },
      detail: { type: 'string', minLength: 3 },
    },
  },
  null,
  2,
);

describe('片段一等资源：CRUD / 版本 / 乐观锁', () => {
  it('创建片段（嵌套引用其他片段）并读取', async () => {
    const r1 = await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ name: 'region', title: '省市区', content: regionText }),
    });
    expect(r1.status).toBe(201);
    expect(r1.body.fragment.revision).toBe(1);

    const r2 = await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ name: 'contactAddress', title: '联系地址', content: addressText }),
    });
    expect(r2.status).toBe(201);

    const list = await call<{ fragments: Array<{ name: string }> }>('/api/fragments');
    expect(list.body.fragments.some((f) => f.name === 'contactAddress')).toBe(true);
  });

  it('重名片段被 409 拒绝', async () => {
    const r = await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ name: 'region', content: regionText }),
    });
    expect(r.status).toBe(409);
  });

  it('片段名非法被拒', async () => {
    const r = await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ name: 'bad name!', content: regionText }),
    });
    expect(r.status).toBe(400);
  });

  it('修改被引用中的片段：允许（复用的意义），产生新版本', async () => {
    const tightened = JSON.stringify(
      {
        type: 'object',
        title: '省市区',
        properties: { province: { type: 'string', minLength: 2 }, city: { type: 'string' } },
      },
      null,
      2,
    );
    const r = await call('/api/fragments/region', {
      method: 'PUT',
      body: JSON.stringify({ content: tightened, expectedRevision: 1 }),
    });
    expect(r.status).toBe(200);
    expect(r.body.fragment.revision).toBe(2);

    const versions = await call<{ versions: Array<{ version: number }> }>(
      '/api/fragments/region/versions',
    );
    expect(versions.body.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('片段并发保存：旧 revision 被 409 拒绝', async () => {
    const r = await call('/api/fragments/region', {
      method: 'PUT',
      body: JSON.stringify({ content: regionText, expectedRevision: 1 }),
    });
    expect(r.status).toBe(409);
  });
});

describe('片段保存边界：闭环 / 悬空被当场拦下', () => {
  it('保存形成两节点闭环的片段：400 且给出链路', async () => {
    const cyclic = JSON.stringify({
      type: 'object',
      properties: { back: { $ref: 'fragment:contactAddress' } },
    });
    const r = await call('/api/fragments/region', {
      method: 'PUT',
      body: JSON.stringify({ content: cyclic, expectedRevision: 2 }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/闭环/);
  });

  it('新建自引用片段：400', async () => {
    const self = JSON.stringify({
      type: 'object',
      properties: { self: { $ref: 'fragment:loopFrag' } },
    });
    const r = await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ name: 'loopFrag', content: self }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/闭环/);
  });

  it('片段悬空引用不存在片段：400', async () => {
    const dangling = JSON.stringify({
      type: 'object',
      properties: { x: { $ref: 'fragment:nope' } },
    });
    const r = await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ name: 'badFrag', content: dangling }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/nope|不存在/);
  });

  it('片段定义本身非法 JSON：400', async () => {
    const r = await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ name: 'brokenFrag', content: '{oops' }),
    });
    expect(r.status).toBe(400);
  });
});

describe('含引用文档：保存边界 / 解析 / 控件 / 校验 / 导入导出往返', () => {
  const docText = JSON.stringify({
    type: 'object',
    title: '双联系人报名表',
    properties: {
      primary: { $ref: 'fragment:contactAddress' },
      backup: { $ref: 'fragment:contactAddress', title: '备用地址' },
    },
  });
  let docId = 0;

  it('文档引用不存在片段：保存被 400 拦截', async () => {
    const r = await call('/api/documents', {
      method: 'POST',
      body: JSON.stringify({
        name: '悬空文档',
        content: JSON.stringify({ type: 'object', properties: { x: { $ref: 'fragment:ghost' } } }),
      }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/ghost/);
  });

  it('含合法引用的文档可保存', async () => {
    const r = await call('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ name: '引用文档', content: docText }),
    });
    expect(r.status).toBe(201);
    docId = r.body.doc.id;
  });

  it('/parse 返回引用节点（不展开抄录），/controls 穿透到真实控件', async () => {
    const parsed = await call('/api/schema/parse', {
      method: 'POST',
      body: JSON.stringify({ text: docText }),
    });
    expect(parsed.status).toBe(200);
    const primary = parsed.body.model.children.find((c: { name: string }) => c.name === 'primary');
    expect(primary.ref).toBe('contactAddress');
    expect(primary.children).toBeUndefined();
    // 控件穿透：primary 是 group，内部 region 又是 group（嵌套片段）
    const ctrl = parsed.body.controls.children.find((c: { name: string }) => c.name === 'primary');
    expect(ctrl.widget).toBe('group');
    expect(ctrl.children.map((c: { name: string }) => c.name)).toEqual(['region', 'detail']);
    const region = ctrl.children.find((c: { name: string }) => c.name === 'region');
    expect(region.children.map((c: { name: string }) => c.name)).toEqual(['province', 'city']);
  });

  it('/validate-form 按片段当前定义校验两处引用', async () => {
    const bad = await call('/api/schema/validate-form', {
      method: 'POST',
      body: JSON.stringify({
        text: docText,
        data: {
          primary: { region: { province: '浙' }, detail: 'x' },
          backup: { region: { province: '浙江' }, detail: 'xx' },
        },
      }),
    });
    expect(bad.body.valid).toBe(false);
    const locs = bad.body.errors.map((e: { loc: string }) => e.loc);
    expect(locs).toEqual(
      expect.arrayContaining(['primary.region.province', 'primary.detail', 'backup.detail']),
    );

    const good = await call('/api/schema/validate-form', {
      method: 'POST',
      body: JSON.stringify({
        text: docText,
        data: {
          primary: { region: { province: '浙江' }, detail: '文三路' },
          backup: { region: { province: '浙江' }, detail: '备用地址' },
        },
      }),
    });
    expect(good.body.valid).toBe(true);
  });

  it('导入导出往返：读回文本仍含 $ref，重新解析语义等价（不被展开成两份）', async () => {
    const loaded = await call<{ doc: { content: string } }>(`/api/documents/${docId}`);
    const loadedJson = JSON.parse(loaded.body.doc.content);
    expect(loadedJson.properties.primary.$ref).toBe('fragment:contactAddress');
    expect(loaded.body.doc.content).not.toContain('province');

    const reparsed = await call('/api/schema/parse', {
      method: 'POST',
      body: JSON.stringify({ text: loaded.body.doc.content }),
    });
    expect(reparsed.body.ok).toBe(true);
    expect(
      reparsed.body.model.children.map((c: { ref?: string; name: string }) => ({
        name: c.name,
        ref: c.ref,
      })),
    ).toEqual([
      { name: 'primary', ref: 'contactAddress' },
      { name: 'backup', ref: 'contactAddress' },
    ]);

    const reser = await call<{ text: string }>('/api/schema/serialize', {
      method: 'POST',
      body: JSON.stringify({ model: reparsed.body.model }),
    });
    expect(JSON.parse(reser.body.text)).toEqual(JSON.parse(docText));
  });
  it('改片段定义后，文档无需改动，校验立即按新定义（再次收紧 region）', async () => {
    const v3 = JSON.stringify(
      {
        type: 'object',
        title: '省市区',
        required: ['province'],
        properties: {
          province: { type: 'string', minLength: 3 }, // 2 -> 3
          city: { type: 'string' },
        },
      },
      null,
      2,
    );
    const saved = await call('/api/fragments/region', {
      method: 'PUT',
      body: JSON.stringify({ content: v3, expectedRevision: 2 }),
    });
    expect(saved.status).toBe(200);

    const r = await call('/api/schema/validate-form', {
      method: 'POST',
      body: JSON.stringify({
        text: docText,
        data: { primary: { region: { province: '浙江' }, detail: '文三路' } }, // 2 字，新规则下非法
      }),
    });
    expect(r.body.valid).toBe(false);
    expect(r.body.errors[0].loc).toMatch(/province/);
  });
});

describe('删除片段：引用保护、影响范围、级联内联', () => {
  it('查询引用方：列出文档与片段的具体位置', async () => {
    const r = await call<{ references: Array<{ kind: string; path: string }> }>(
      '/api/fragments/region/references',
    );
    expect(r.status).toBe(200);
    const kinds = r.body.references.map((x) => `${x.kind}:${x.path}`);
    expect(kinds.some((k) => k.startsWith('fragment:region') && k.includes('region'))).toBe(true);
    // contactAddress 片段在其 region 字段处引用
    expect(r.body.references.some((x) => x.kind === 'fragment' && x.fragmentName === 'contactAddress')).toBe(true);
  });

  it('删除仍被引用的片段（contactAddress 被文档引用）：409 且列出引用方', async () => {
    const r = await call('/api/fragments/contactAddress', { method: 'DELETE' });
    expect(r.status).toBe(409);
    expect(Array.isArray(r.body.references)).toBe(true);
    expect(r.body.references.length).toBeGreaterThan(0);
    expect(r.body.references.some((x: { kind: string }) => x.kind === 'document')).toBe(true);
    // 片段仍然存在
    const get = await call('/api/fragments/contactAddress');
    expect(get.status).toBe(200);
  });

  it('级联删除 region：引用处一跳内联为快照（内部不再依赖 region），片段被删', async () => {
    // contactAddress 引用 region -> 级联后 contactAddress 内联 region 的结构
    const r = await call('/api/fragments/region?cascade=true', { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(r.body.cascaded).toBe(true);
    expect(r.body.result.inlinedFragments).toContain('contactAddress');

    // region 已删除
    const gone = await call('/api/fragments/region');
    expect(gone.status).toBe(404);

    // contactAddress 内容里 region 已内联为 object，且不再含 $ref region
    const frag = await call<{ fragment: { content: string } }>('/api/fragments/contactAddress');
    const addr = JSON.parse(frag.body.fragment.content);
    expect(addr.properties.region.type).toBe('object');
    expect(addr.properties.region.$ref).toBeUndefined();
    expect(addr.properties.region.properties.province.type).toBe('string');

    // 引用它的文档仍然合法可校验（晚绑定到内联后的片段；region 已收紧为 province>=3）
    const docIdR = (
      await call<{ documents: Array<{ id: number; name: string }> }>('/api/documents')
    ).body.documents.find((d) => d.name === '引用文档')!.id;
    const doc = await call<{ doc: { content: string } }>(`/api/documents/${docIdR}`);
    expect(doc.body.doc.content).toContain('fragment:contactAddress'); // 文档仍引用 contactAddress
    const v = await call('/api/schema/validate-form', {
      method: 'POST',
      body: JSON.stringify({
        text: doc.body.doc.content,
        data: {
          primary: { region: { province: '浙江省' }, detail: '文三路' },
          backup: { region: { province: '浙江省' }, detail: '备用地址' },
        },
      }),
    });
    expect(v.body.valid).toBe(true);
  });

  it('无引用的片段可直接删除（204）', async () => {
    await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ name: 'lonely', content: JSON.stringify({ type: 'string' }) }),
    });
    const r = await call('/api/fragments/lonely', { method: 'DELETE' });
    expect(r.status).toBe(204);
  });
});

describe('文档版本回滚：引用按回滚时刻片段解释，片段状态变化不阻断回滚', () => {
  it('历史版本引用片段，片段被修改后回滚：按当前片段解释，回滚成功无脏数据', async () => {
    // 建一个新片段与文档
    const tagText = JSON.stringify({ type: 'string', enum: ['A', 'B'] });
    await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ name: 'tag', content: tagText }),
    });
    const v1 = JSON.stringify({
      type: 'object',
      properties: { t: { $ref: 'fragment:tag' } },
    });
    const created = await call<{ doc: { id: number } }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ name: '回滚引用文档', content: v1 }),
    });
    const id = created.body.doc.id;

    // 文档演进到 v2（去掉引用）
    const v2 = JSON.stringify({ type: 'object', properties: { other: { type: 'integer' } } });
    await call(`/api/documents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ content: v2, expectedRevision: 1 }),
    });

    // 片段被修改（枚举变为 A/C）——文档历史 v1 仍引用 tag
    const tagV2 = JSON.stringify({ type: 'string', enum: ['A', 'C'] });
    const tag = await call<{ fragment: { revision: number } }>('/api/fragments/tag');
    await call('/api/fragments/tag', {
      method: 'PUT',
      body: JSON.stringify({ content: tagV2, expectedRevision: tag.body.fragment.revision }),
    });

    // 回滚文档到 v1：动作本身成功（不因片段变了失败）
    const rb = await call(`/api/documents/${id}/rollback/1`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: 2 }),
    });
    expect(rb.status).toBe(200);
    expect(rb.body.doc.revision).toBe(3);
    // 文本逐字还原为历史内容（$ref 链路保留，按当前片段解释）
    expect(rb.body.doc.content).toBe(v1);

    // 按回滚时刻（当前）片段定义校验：枚举 A/C，B 已失效
    const check = await call('/api/schema/validate-form', {
      method: 'POST',
      body: JSON.stringify({ text: rb.body.doc.content, data: { t: 'B' } }),
    });
    expect(check.body.valid).toBe(false); // B 已不在当前片段枚举中
    const ok = await call('/api/schema/validate-form', {
      method: 'POST',
      body: JSON.stringify({ text: rb.body.doc.content, data: { t: 'C' } }),
    });
    expect(ok.body.valid).toBe(true);
  });

  it('历史版本引用的片段已被级联删除：回滚不失败，内容原样还原（悬空由非法态/保存边界提示）', async () => {
    // 文档 v1 引用一个随后会被删除的片段
    await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ name: 'tempFrag', content: JSON.stringify({ type: 'string' }) }),
    });
    const v1 = JSON.stringify({
      type: 'object',
      properties: { z: { $ref: 'fragment:tempFrag' } },
    });
    const created = await call<{ doc: { id: number } }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ name: '待删片段引用文档', content: v1 }),
    });
    const id = created.body.doc.id;
    const v2 = JSON.stringify({ type: 'object', properties: { q: { type: 'boolean' } } });
    await call(`/api/documents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ content: v2, expectedRevision: 1 }),
    });

    // 先级联解除文档对 tempFrag 的引用（v2 不引用它，可直接删）
    const del = await call('/api/fragments/tempFrag', { method: 'DELETE' });
    expect(del.status).toBe(204);

    // 回滚到 v1：动作成功，内容原样还原为含悬空 $ref 的历史文本
    const rb = await call(`/api/documents/${id}/rollback/1`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: 2 }),
    });
    expect(rb.status).toBe(200);
    expect(rb.body.doc.content).toBe(v1);

    // 该悬空内容无法再次保存（保存边界拦截），但当前回滚已落库且轨迹连续
    const resave = await call(`/api/documents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ content: v1, expectedRevision: 3 }),
    });
    expect(resave.status).toBe(400);
    expect(resave.body.error).toMatch(/tempFrag|不存在/);

    // 引擎解析给出非法态（不崩），结构区可据此停留最近合法态
    const parsed = await call('/api/schema/parse', {
      method: 'POST',
      body: JSON.stringify({ text: v1 }),
    });
    expect(parsed.body.ok).toBe(false);
    expect(parsed.body.error).toMatch(/tempFrag/);
  });
});
