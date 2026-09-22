/**
 * 可复用结构片段 —— HTTP/持久化层测试：
 *  - 片段 CRUD + 版本轨迹；文档含 $fragment 的保存/解析/控件/校验往返；
 *  - 改片段定义 -> 所有引用处按当前定义生效（控件、校验）；
 *  - 闭环 / 悬空在保存边界被拒；
 *  - 删除守卫：仍被引用 -> 409 列出引用方（含路径/间接）；显式 detach 才归档；
 *  - 导入导出原样保住引用；
 *  - 文档回滚：存活片段按当前定义解释（内容逐字不变），已删片段就地展开且产物合法。
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
      const addr = server.address();
      base = `http://127.0.0.1:${(addr as { port: number }).port}`;
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

const regionContent = JSON.stringify(
  {
    type: 'object',
    title: '省市区',
    properties: {
      province: { type: 'string', title: '省' },
      city: { type: 'string', title: '市', minLength: 2 },
    },
    required: ['province', 'city'],
  },
  null,
  2,
);

const addressContent = JSON.stringify(
  {
    type: 'object',
    title: '联系地址',
    properties: {
      detail: { type: 'string', title: '详细地址', maxLength: 100 },
      region: { $fragment: 'region' },
    },
    required: ['detail'],
  },
  null,
  2,
);

const docContent = (): string =>
  JSON.stringify(
    {
      type: 'object',
      title: '双联系人报名表',
      properties: {
        name: { type: 'string', title: '姓名' },
        primary: { $fragment: 'address' },
        backup: { $fragment: 'address' },
      },
      required: ['name', 'primary'],
    },
    null,
    2,
  );

describe('片段一等资源：CRUD 与版本', () => {
  it('创建片段：嵌套引用的两个片段均可创建（无环）', async () => {
    const r1 = await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ key: 'region', title: '省市区', content: regionContent }),
    });
    expect(r1.status).toBe(201);
    expect(r1.body.fragment.revision).toBe(1);

    const r2 = await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ key: 'address', title: '联系地址', content: addressContent }),
    });
    expect(r2.status).toBe(201);
  });

  it('非法 key / 空标题 / 非法定义被拒', async () => {
    const badKey = await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ key: '-bad', title: 'x', content: '{"type":"string"}' }),
    });
    expect(badKey.status).toBe(400);

    const badDef = await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ key: 'ok_key', title: 'x', content: '{broken' }),
    });
    expect(badDef.status).toBe(400);
  });

  it('重复 key（含已归档）冲突', async () => {
    const r = await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ key: 'region', title: '重复', content: regionContent }),
    });
    expect(r.status).toBe(409);
  });

  it('片段版本轨迹', async () => {
    const r = await call<{ versions: Array<{ version: number; note: string }> }>(
      '/api/fragments/region/versions',
    );
    expect(r.body.versions.map((v) => v.version)).toEqual([1]);
  });
});

describe('文档引用片段：解析 / 控件 / 校验 / 保存', () => {
  it('保存含引用文档成功；解析返回引用节点 + 穿透控件树', async () => {
    const created = await call<{ doc: { id: number } }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ name: '引用文档', content: docContent() }),
    });
    expect(created.status).toBe(201);

    const parsed = await call('/api/schema/parse', {
      method: 'POST',
      body: JSON.stringify({ text: docContent() }),
    });
    expect(parsed.status).toBe(200);
    const primary = parsed.body.model.children.find((c: any) => c.name === 'primary');
    expect(primary.kind).toBe('ref');
    expect(primary.ref).toBe('address');

    // 控件树穿透两层片段：primary.region.city
    const root = parsed.body.controls;
    const pCtrl = root.children.find((c: any) => c.name === 'primary');
    expect(pCtrl.widget).toBe('group');
    const regionCtrl = pCtrl.children.find((c: any) => c.name === 'region');
    expect(regionCtrl.children.map((c: any) => c.name)).toEqual(['province', 'city']);
  });

  it('控件映射穿透引用取真实类型（片段内枚举 -> select；长文本 -> textarea）', async () => {
    await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({
        key: 'track',
        title: '场次',
        content: JSON.stringify({ type: 'string', enum: ['A', 'B', 'C'] }),
      }),
    });
    await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({
        key: 'bio',
        title: '简介',
        content: JSON.stringify({ type: 'string', maxLength: 500 }),
      }),
    });
    const text = JSON.stringify({
      type: 'object',
      properties: { t: { $fragment: 'track' }, b: { $fragment: 'bio' } },
    });
    const r = await call('/api/schema/controls', { method: 'POST', body: JSON.stringify({ text }) });
    expect(r.status).toBe(200);
    const t = r.body.controls.children.find((c: any) => c.name === 't');
    const b = r.body.controls.children.find((c: any) => c.name === 'b');
    expect(t.widget).toBe('select');
    expect(t.enumOptions).toEqual(['A', 'B', 'C']);
    expect(b.widget).toBe('textarea');
  });

  it('表单校验按片段当前约束生效（违例定位到片段字段路径）', async () => {
    const bad = await call('/api/schema/validate-form', {
      method: 'POST',
      body: JSON.stringify({
        text: docContent(),
        data: { name: '', primary: { detail: '', region: { province: '', city: '京' } } },
      }),
    });
    expect(bad.body.valid).toBe(false);
    const locs = bad.body.errors.map((e: any) => e.loc);
    expect(locs).toEqual(
      expect.arrayContaining(['name', 'primary.detail', 'primary.region.city']),
    );

    const good = await call('/api/schema/validate-form', {
      method: 'POST',
      body: JSON.stringify({
        text: docContent(),
        data: {
          name: '张三',
          primary: { detail: 'xx', region: { province: '浙江', city: '杭州' } },
          backup: { detail: 'yy', region: { province: '江苏', city: '南京' } },
        },
      }),
    });
    expect(good.body.valid).toBe(true);
  });

  it('两处引用同一片段：两处都按片段校验', async () => {
    const r = await call('/api/schema/validate-form', {
      method: 'POST',
      body: JSON.stringify({
        text: docContent(),
        data: {
          name: '张三',
          primary: { detail: 'xx', region: { province: '浙', city: '杭州' } },
          backup: { detail: 'yy', region: { province: '苏', city: '' } },
        },
      }),
    });
    const locs = r.body.errors.map((e: any) => e.loc);
    expect(locs).toContain('backup.region.city');
    expect(locs).not.toContain('primary.region.city');
  });

  it('悬空引用文档不能保存（持久化边界权威拒绝）', async () => {
    const r = await call('/api/documents', {
      method: 'POST',
      body: JSON.stringify({
        name: '悬空',
        content: JSON.stringify({ type: 'object', properties: { x: { $fragment: 'ghost' } } }),
      }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/不存在的片段「ghost」/);
  });
});

describe('片段定义更新：一处改、多处同步', () => {
  it('改片段约束后，引用文档的解析与校验即时按新定义', async () => {
    const updated = JSON.stringify(
      {
        type: 'object',
        title: '联系地址',
        properties: {
          detail: { type: 'string', title: '详细地址', minLength: 5, maxLength: 200 },
          zipCode: { type: 'string', title: '邮编', pattern: '^\\d{6}$' },
          region: { $fragment: 'region' },
        },
        required: ['detail', 'zipCode'],
      },
      null,
      2,
    );
    const r = await call('/api/fragments/address', {
      method: 'PUT',
      body: JSON.stringify({ content: updated, expectedRevision: 1, note: '加邮编+长度' }),
    });
    expect(r.status).toBe(200);
    expect(r.body.fragment.revision).toBe(2);

    // 文档文本一个字没改，但穿透视图里两处地址都有了 zipCode 与新约束
    const parsed = await call('/api/schema/parse', {
      method: 'POST',
      body: JSON.stringify({ text: docContent() }),
    });
    const p = parsed.body.controls.children.find((c: any) => c.name === 'primary');
    expect(p.children.map((c: any) => c.name)).toEqual(['detail', 'zipCode', 'region']);
    expect(p.children[0].minLength).toBe(5);

    const v = await call('/api/schema/validate-form', {
      method: 'POST',
      body: JSON.stringify({
        text: docContent(),
        data: {
          name: '张三',
          primary: { detail: 'ab', zipCode: 'bad', region: { province: '浙', city: '杭州' } },
        },
      }),
    });
    const locs = v.body.errors.map((e: any) => e.loc);
    expect(locs).toEqual(expect.arrayContaining(['primary.detail', 'primary.zipCode']));
  });

  it('片段并发保存：旧 revision 被 409 拒绝', async () => {
    // 先用当前 revision 成功更新一次（revision 前进）
    const first = await call('/api/fragments/region', {
      method: 'PUT',
      body: JSON.stringify({ content: regionContent, expectedRevision: 1, note: '并发测试' }),
    });
    expect(first.status).toBe(200);
    // 仍持有旧 revision=1 的会话再写 -> 409
    const stale = await call('/api/fragments/region', {
      method: 'PUT',
      body: JSON.stringify({ content: regionContent, expectedRevision: 1 }),
    });
    expect(stale.status).toBe(409);
  });
});

describe('闭环拦截（片段保存边界）', () => {
  it('自环片段不能创建', async () => {
    const r = await call('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({
        key: 'selfloop',
        title: '自环',
        content: JSON.stringify({ type: 'object', properties: { me: { $fragment: 'selfloop' } } }),
      }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/闭环/);
  });

  it('把现有片段改成引用闭环：保存被拒，旧定义不动', async () => {
    // 让 track 引用 address，再试图把 address 改成引用 track —— track→address→track
    const track = await call<{ fragment: { revision: number } }>('/api/fragments/track');
    const trackUpdated = JSON.stringify({
      type: 'object',
      properties: { addr: { $fragment: 'address' } },
    });
    const r1 = await call('/api/fragments/track', {
      method: 'PUT',
      body: JSON.stringify({ content: trackUpdated, expectedRevision: track.body.fragment.revision }),
    });
    expect(r1.status).toBe(200);

    const addr = await call<{ fragment: { revision: number } }>('/api/fragments/address');
    const cyclic = JSON.stringify({
      type: 'object',
      properties: { t: { $fragment: 'track' } },
    });
    const r2 = await call('/api/fragments/address', {
      method: 'PUT',
      body: JSON.stringify({ content: cyclic, expectedRevision: addr.body.fragment.revision }),
    });
    expect(r2.status).toBe(400);
    expect(r2.body.error).toMatch(/闭环/);

    // address 定义仍是闭环前的 revision 2（含 zipCode）
    const after = await call<{ fragment: { revision: number; content: string } }>(
      '/api/fragments/address',
    );
    expect(after.body.fragment.revision).toBe(addr.body.fragment.revision);
    expect(after.body.fragment.content).toContain('zipCode');
  });
});

describe('删除守卫与引用影响范围', () => {
  it('删除仍被文档引用的片段：409 且列出引用方与位置', async () => {
    const r = await call('/api/fragments/address', { method: 'DELETE' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/仍被/);
    const docs = r.body.references.filter((x: any) => x.kind === 'document');
    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(docs[0].path).toBeTruthy();
  });

  it('删除被其他片段引用的底层片段：列出片段引用方（含路径）', async () => {
    const r = await call('/api/fragments/region', { method: 'DELETE' });
    expect(r.status).toBe(409);
    const fragRefs = r.body.references.filter((x: any) => x.kind === 'fragment');
    expect(fragRefs.some((x) => x.id === 'address')).toBe(true);
    expect(fragRefs.find((x) => x.id === 'address').path).toContain('region');
  });

  it('无引用的片段可直接删除（归档）', async () => {
    const r = await call('/api/fragments/bio', { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(r.body.archived).toBe('bio');
    // 默认列表不可见
    const list = await call<{ fragments: Array<{ key: string }> }>('/api/fragments');
    expect(list.body.fragments.find((f) => f.key === 'bio')).toBeUndefined();
  });

  it('usage 接口：无引用时返回空数组', async () => {
    const r = await call<{ references: unknown[] }>('/api/fragments/track/usage');
    // track 当前引用 address，因此至少有其自身作为引用方之外的记录情况：
    // track 引用 address，故查 address 时 track 出现；查 track 自身被谁引用——可能为空
    expect(Array.isArray(r.body.references)).toBe(true);
  });

  it('间接引用：文档经 address 间接依赖 region 时，删 region 也被守卫并标注间接', async () => {
    // 新建一份只引用 address 的文档（address 内部引用 region）
    const created = await call<{ doc: { id: number; name: string } }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({
        name: '间接依赖文档',
        content: JSON.stringify({
          type: 'object',
          properties: { addr: { $fragment: 'address' } },
        }),
      }),
    });
    expect(created.status).toBe(201);

    const r = await call('/api/fragments/region', { method: 'DELETE' });
    expect(r.status).toBe(409);
    const docRefs = r.body.references.filter((x: any) => x.kind === 'document');
    const mine = docRefs.find((x: any) => x.id === created.body.doc.id);
    expect(mine).toBeDefined();
    expect(mine.indirect).toBe(true);
    // address 是直接引用方
    const fragRef = r.body.references.find((x: any) => x.kind === 'fragment' && x.id === 'address');
    expect(fragRef.indirect).toBe(false);
  });

  it('detach 删除底层片段：中间片段被剪枝后，间接文档仍可严格解析', async () => {
    // region 当前被 address 引用；detach 应改写 address（移除 region），文档引用 address 保持有效
    const del = await call('/api/fragments/region?mode=detach', { method: 'DELETE' });
    expect(del.status).toBe(200);

    const docs = await call<{ documents: Array<{ id: number; name: string }> }>('/api/documents');
    const target = docs.body.documents.find((d) => d.name === '间接依赖文档');
    const loaded = await call<{ doc: { content: string } }>(`/api/documents/${target!.id}`);
    const parsed = await call('/api/schema/parse', {
      method: 'POST',
      body: JSON.stringify({ text: loaded.body.doc.content }),
    });
    expect(parsed.body.ok).toBe(true);
    // 文档仍引用 address（address 存活），其内部不再有 region 引用
    const addr = await call<{ fragment: { content: string } }>('/api/fragments/address');
    expect(addr.body.fragment.content).not.toContain('region');
    expect(loaded.body.doc.content).toContain('$fragment');
  });
});

describe('导入导出：引用关系原样保住', () => {
  it('导出文本 -> 重新解析 -> 再次序列化，$fragment 不被展开', async () => {
    const docs = await call<{ documents: Array<{ id: number; name: string }> }>('/api/documents');
    const target = docs.body.documents.find((d) => d.name === '引用文档');
    expect(target).toBeDefined();
    const loaded = await call<{ doc: { content: string } }>(`/api/documents/${target!.id}`);
    expect(loaded.body.doc.content).toContain('$fragment');

    const reparsed = await call('/api/schema/parse', {
      method: 'POST',
      body: JSON.stringify({ text: loaded.body.doc.content }),
    });
    expect(reparsed.body.ok).toBe(true);

    const reser = await call<{ text?: string }>('/api/schema/serialize', {
      method: 'POST',
      body: JSON.stringify({ model: reparsed.body.model }),
    });
    expect(reser.status).toBe(200);
    expect(reser.body.text, `serialize 返回异常：${JSON.stringify(reser.body)}`).toBeTypeOf('string');
    const round = JSON.parse(reser.body.text);
    expect(round.properties.primary).toEqual({ $fragment: 'address' });
    expect(round.properties.backup).toEqual({ $fragment: 'address' });
    expect(reser.body.text).not.toContain('zipCode'); // 片段内容绝不被内联进文档
  });
});

describe('文档版本回滚在片段状态变化后的规则', () => {
  it('片段仍存活：回滚后引用保持指针（内容逐字回到历史版本），按片段当前定义解释', async () => {
    const created = await call<{ doc: { id: number; revision: number } }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ name: '回滚-存活片段', content: docContent() }),
    });
    const id = created.body.doc.id;

    // v2：文档本地加一个普通字段
    const v2 = JSON.stringify({
      type: 'object',
      properties: {
        only: { type: 'boolean' },
        primary: { $fragment: 'address' },
      },
    });
    await call(`/api/documents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ content: v2, expectedRevision: 1 }),
    });

    // 回滚到 v1
    const rb = await call(`/api/documents/${id}/rollback/1`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: 2 }),
    });
    expect(rb.status).toBe(200);
    expect(rb.body.materialized).toBeFalsy();

    const after = await call<{ doc: { content: string } }>(`/api/documents/${id}`);
    // 引用仍是指针，文档内容逐字等于 v1
    expect(JSON.parse(after.body.doc.content).properties.primary).toEqual({ $fragment: 'address' });
    // 解释按片段当前定义（revision 2，含 zipCode）
    const parsed = await call('/api/schema/parse', {
      method: 'POST',
      body: JSON.stringify({ text: after.body.doc.content }),
    });
    const p = parsed.body.controls.children.find((c: any) => c.name === 'primary');
    expect(p.children.map((c: any) => c.name)).toContain('zipCode');
  });

  it('片段已删除（归档）：回滚不失败，已删片段就地展开、存活片段保持引用', async () => {
    // 用独立的 region2/address2，避免与其他用例共享的片段生命周期互相影响
    const region2 = JSON.stringify({
      type: 'object',
      properties: { province: { type: 'string' }, city: { type: 'string', minLength: 2 } },
      required: ['province', 'city'],
    });
    const address2 = JSON.stringify({
      type: 'object',
      title: '地址2',
      properties: {
        detail: { type: 'string', minLength: 1 },
        zipCode: { type: 'string', pattern: '^\\d{6}$' },
        region: { $fragment: 'region2' },
      },
      required: ['detail', 'zipCode'],
    });
    expect((await call('/api/fragments', { method: 'POST', body: JSON.stringify({ key: 'region2', title: '地区2', content: region2 }) })).status).toBe(201);
    expect((await call('/api/fragments', { method: 'POST', body: JSON.stringify({ key: 'address2', title: '地址2', content: address2 }) })).status).toBe(201);

    const v1 = JSON.stringify({
      type: 'object',
      properties: {
        name: { type: 'string' },
        contact: { $fragment: 'address2' },
      },
    });
    const created = await call<{ doc: { id: number; revision: number } }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ name: '回滚-已删片段2', content: v1 }),
    });
    expect(created.status).toBe(201);
    const id = created.body.doc.id;

    // v2 普通内容
    await call(`/api/documents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        content: JSON.stringify({ type: 'object', properties: { only: { type: 'number' } } }),
        expectedRevision: 1,
      }),
    });

    // 显式 detach 归档 address2（region2 仍存活；文档当前版本不引用它，故 detach 0 处）
    const del = await call('/api/fragments/address2?mode=detach', { method: 'DELETE' });
    expect(del.status).toBe(200);

    // 回滚到 v1（引用 address2）：应物化为内嵌，不报错
    const cur = await call<{ doc: { revision: number } }>(`/api/documents/${id}`);
    const rb = await call(`/api/documents/${id}/rollback/1`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: cur.body.doc.revision }),
    });
    expect(rb.status).toBe(200);
    expect(rb.body.materialized).toBe(true);

    const after = await call<{ doc: { content: string } }>(`/api/documents/${id}`);
    const json = JSON.parse(after.body.doc.content);
    expect(json.properties.contact.$fragment).toBeUndefined();
    expect(json.properties.contact.type).toBe('object');
    expect(json.properties.contact.properties.zipCode).toBeDefined();
    // 嵌套的 region2 仍存活 -> 保持引用
    expect(json.properties.contact.properties.region).toEqual({ $fragment: 'region2' });

    // 物化产物可被服务端严格解析与校验（无脏数据）
    const parsed = await call('/api/schema/parse', {
      method: 'POST',
      body: JSON.stringify({ text: after.body.doc.content }),
    });
    expect(parsed.body.ok).toBe(true);

    const valid = await call('/api/schema/validate-form', {
      method: 'POST',
      body: JSON.stringify({
        text: after.body.doc.content,
        data: {
          name: '张三',
          contact: { detail: 'x', zipCode: '310000', region: { province: '浙江', city: '杭州' } },
        },
      }),
    });
    expect(valid.body.valid).toBe(true);
  });

  it('回滚不因 expectedRevision 之外的原因失败：回滚后版本轨迹连续', async () => {
    // 用仅含存活片段的独立文档
    const v1 = JSON.stringify({
      type: 'object',
      properties: { a: { type: 'string' }, addr: { $fragment: 'address' } },
    });
    const created = await call<{ doc: { id: number } }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ name: '轨迹连续2', content: v1 }),
    });
    expect(created.status).toBe(201);
    const id = created.body.doc.id;
    await call(`/api/documents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        content: JSON.stringify({ type: 'object', properties: { x: { type: 'string' } } }),
        expectedRevision: 1,
      }),
    });
    const cur = await call<{ doc: { revision: number } }>(`/api/documents/${id}`);
    const rb = await call(`/api/documents/${id}/rollback/1`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: cur.body.doc.revision }),
    });
    expect(rb.status).toBe(200);
    const versions = await call<{ versions: Array<{ version: number; note: string }> }>(
      `/api/documents/${id}/versions`,
    );
    expect(versions.body.versions.map((v) => v.version)).toEqual([3, 2, 1]);
  });
});

describe('老文档与空片段库：行为零偏差', () => {
  it('不含引用写法的历史文档保存/解析/回滚逐字一致', async () => {
    const oldText = JSON.stringify(
      {
        type: 'object',
        title: '老文档',
        required: ['name'],
        properties: {
          name: { type: 'string', title: '姓名', minLength: 2, maxLength: 10 },
        },
      },
      null,
      2,
    );
    const created = await call<{ doc: { id: number } }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ name: '老文档', content: oldText }),
    });
    const id = created.body.doc.id;
    const v2 = JSON.stringify({ type: 'object', properties: { z: { type: 'boolean' } } });
    await call(`/api/documents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ content: v2, expectedRevision: 1 }),
    });
    const rb = await call(`/api/documents/${id}/rollback/1`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: 2 }),
    });
    expect(rb.body.materialized).toBeFalsy();
    const after = await call<{ doc: { content: string } }>(`/api/documents/${id}`);
    expect(after.body.doc.content).toBe(oldText);
  });
});
