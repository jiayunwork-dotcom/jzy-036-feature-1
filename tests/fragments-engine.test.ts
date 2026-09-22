/**
 * 片段引用：引擎层核心语义。
 *  - 文本 $ref 解析为引用节点（与内嵌节点区分），往返不展开；
 *  - 控件映射/校验按片段「当前」定义穿透，改一处全局生效；
 *  - 悬空 / 闭环统一为解析失败（进非法态）；
 *  - 结构 <-> 引用的转换与收编；嵌套片段与一跳内联。
 */
import { describe, expect, it } from 'vitest';
import { parseSchemaText, schemaToModel } from '@engine/parser';
import { modelToSchema, modelToSchemaText } from '@engine/serialize';
import { modelToControls } from '@engine/controls';
import { validateForm } from '@engine/validate';
import {
  collectRefs,
  expandModel,
  checkSaveFragment,
  isRefNode,
  inlineRefsInTree,
  convertToRef,
  inlineRef,
} from '@engine/fragments';
import type { FragmentLibrary } from '@engine/fragments';
import { canonicalModel } from './helpers';

function fragmentModel(schema: unknown) {
  return schemaToModel(schema as never, { allowNonObjectRoot: true });
}

function buildLibrary(): FragmentLibrary {
  return {
    region: fragmentModel({
      type: 'object',
      title: '省市区',
      required: ['province'],
      properties: {
        province: { type: 'string', title: '省份', minLength: 2 },
        city: { type: 'string', title: '城市' },
      },
    }),
    contactAddress: fragmentModel({
      type: 'object',
      title: '联系地址',
      required: ['detail'],
      properties: {
        region: { $ref: 'fragment:region' },
        detail: { type: 'string', title: '详细地址', minLength: 3 },
      },
    }),
    phone: fragmentModel({
      type: 'string',
      title: '联系电话',
      pattern: '^\\d{6,12}$',
    }),
  };
}

const docWithRefs = (extra: Record<string, unknown> = {}) => ({
  type: 'object',
  title: '报名表',
  properties: {
    primary: { $ref: 'fragment:contactAddress' },
    backup: { $ref: 'fragment:contactAddress', title: '备用联系人地址' },
    mobile: { $ref: 'fragment:phone' },
    inline: { type: 'string', title: '普通字段' },
    ...extra,
  },
});

describe('片段引用：解析 / 往返 / 节点模型', () => {
  it('$ref 解析为引用节点，与内嵌节点区分，且不把子结构抄进来', () => {
    const lib = buildLibrary();
    const r = parseSchemaText(JSON.stringify(docWithRefs()), { library: lib });
    expect(r.ok).toBe(true);
    const primary = r.model!.children!.find((c) => c.name === 'primary')!;
    expect(isRefNode(primary)).toBe(true);
    expect(primary.ref).toBe('contactAddress');
    expect(primary.children).toBeUndefined();
    expect(primary.type).toBeUndefined();
    const inline = r.model!.children!.find((c) => c.name === 'inline')!;
    expect(isRefNode(inline)).toBe(false);
    expect(inline.type).toBe('string');
  });

  it('引用关系被收集（含嵌套片段内部的引用与路径）', () => {
    const lib = buildLibrary();
    const refs = collectRefs(lib.contactAddress);
    expect(refs.map((x) => x.target)).toEqual(['region']);
    expect(refs[0].path).toBe('region');
  });

  it('结构 -> 文本 -> 结构：$ref 原样保留，绝不展开为两份内容（幂等）', () => {
    const lib = buildLibrary();
    const m = parseSchemaText(JSON.stringify(docWithRefs()), { library: lib }).model!;
    const text = modelToSchemaText(m);
    expect(text).toContain('"$ref": "fragment:contactAddress"');
    expect(text).not.toContain('province'); // 片段内容没被抄进文档
    const m2 = parseSchemaText(text, { library: lib }).model!;
    expect(canonicalModel(m)).toEqual(canonicalModel(m2));
    const text2 = modelToSchemaText(m2);
    expect(text2).toBe(text); // 多轮往返幂等
  });

  it('使用处 title 保留，缺省回落到片段定义', () => {
    const lib = buildLibrary();
    const m = parseSchemaText(JSON.stringify(docWithRefs()), { library: lib }).model!;
    const backup = m.children!.find((c) => c.name === 'backup')!;
    expect(backup.title).toBe('备用联系人地址');
    const expanded = expandModel(m, lib);
    const primary = expanded.children!.find((c) => c.name === 'primary')!;
    expect(primary.title).toBe('联系地址'); // 回落片段标题
    expect(primary.children!.find((c) => c.name === 'detail')!.title).toBe('详细地址');
  });
});

describe('片段引用：穿透展开（控件/校验按当前定义，改一次全局生效）', () => {
  it('控件映射穿透到片段真实类型；嵌套片段一并展开', () => {
    const lib = buildLibrary();
    const controls = modelToControls(parseSchemaText(JSON.stringify(docWithRefs()), { library: lib }).model!, lib);
    const byName = Object.fromEntries(controls.children!.map((c) => [c.name, c]));
    expect(byName.primary.widget).toBe('group');
    expect(byName.primary.children!.map((c) => c.name)).toEqual(['region', 'detail']);
    const region = byName.primary.children!.find((c) => c.name === 'region')!;
    expect(region.widget).toBe('group');
    expect(region.children!.map((c) => c.name)).toEqual(['province', 'city']);
    expect(byName.mobile.widget).toBe('text');
    // 标量片段的约束透传
    expect(byName.mobile.pattern).toBe('^\\d{6,12}$');
  });

  it('校验按片段当前约束生效；两个引用处共享同一套规则', () => {
    const lib = buildLibrary();
    const model = parseSchemaText(JSON.stringify(docWithRefs()), { library: lib }).model!;
    // detail minLength 3、province minLength 2、phone 6~12 位数字
    const bad = validateForm(model, {
      primary: { region: { province: '浙' }, detail: 'x' },
      backup: { region: { province: '浙江' }, detail: 'xx' },
      mobile: '123',
      inline: '',
    }, lib);
    const locs = bad.map((e) => e.loc);
    expect(locs).toEqual(expect.arrayContaining([
      'primary.region.province',
      'primary.detail',
      'backup.detail',
      'mobile',
    ]));
    const good = validateForm(model, {
      primary: { region: { province: '浙江', city: '杭州' }, detail: '文三路' },
      backup: { region: { province: '浙江' }, detail: '备用地址' },
      mobile: '13800000000',
      inline: 'ok',
    }, lib);
    expect(good).toEqual([]);
  });

  it('改一次片段定义，所有引用处的结构/校验同步变化（单一事实来源）', () => {
    const lib = buildLibrary();
    const model = parseSchemaText(JSON.stringify(docWithRefs()), { library: lib }).model!;
    const full = () => ({
      primary: { region: { province: '浙江' }, detail: '文三路' },
      backup: { region: { province: '浙江' }, detail: '备用地址' },
      inline: '',
    });
    expect(validateForm(model, { ...full(), mobile: '13800000000' }, lib)).toEqual([]);
    // 收紧片段：电话改为 11 位手机号（文档模型一个字段都没动）
    lib.phone = fragmentModel({
      type: 'string',
      title: '联系电话',
      pattern: '^1\\d{10}$',
    });
    expect(validateForm(model, { ...full(), mobile: '02345678901' }, lib).some((e) => e.loc === 'mobile')).toBe(true);
    expect(validateForm(model, { ...full(), mobile: '13800000000' }, lib)).toEqual([]);
  });
});

describe('片段引用：悬空 / 闭环 —— 在解析边界被认出并进非法态', () => {
  it('引用不存在的片段：解析失败、带字段路径，结构不被接受', () => {
    const lib = buildLibrary();
    const bad = { type: 'object', properties: { a: { $ref: 'fragment:ghost' } } };
    const r = parseSchemaText(JSON.stringify(bad), { library: lib });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ghost/);
    expect(r.error).toMatch(/a/);
  });

  it('片段图两节点闭环：保存边界拒绝并给出链路', () => {
    const lib = buildLibrary();
    // 让 region 反过来引用 contactAddress
    const cyclicRegion = fragmentModel({
      type: 'object',
      properties: { back: { $ref: 'fragment:contactAddress' } },
    });
    const issues = checkSaveFragment('region', cyclicRegion, lib);
    expect(issues.some((i) => i.kind === 'cycle')).toBe(true);
    expect(issues[0].message).toMatch(/region.*contactAddress.*region|contactAddress.*region.*contactAddress/);
  });

  it('片段直接引用自己：拒绝', () => {
    const selfRef = fragmentModel({
      type: 'object',
      properties: { self: { $ref: 'fragment:loop' } },
    });
    const issues = checkSaveFragment('loop', selfRef, {});
    expect(issues.some((i) => i.kind === 'cycle')).toBe(true);
  });

  it('新片段悬空引用别的不存在片段：保存拒绝', () => {
    const dangling = fragmentModel({
      type: 'object',
      properties: { x: { $ref: 'fragment:nope' } },
    });
    const issues = checkSaveFragment('newbie', dangling, {});
    expect(issues.some((i) => i.kind === 'dangling')).toBe(true);
  });

  it('引用处于闭环链中的片段：文档解析也被拒绝（不在运行时才崩）', () => {
    const a = fragmentModel({ type: 'object', properties: { b: { $ref: 'fragment:b' } } });
    const b = fragmentModel({ type: 'object', properties: { a: { $ref: 'fragment:a' } } });
    const lib: FragmentLibrary = { a, b };
    const r = parseSchemaText(
      JSON.stringify({ type: 'object', properties: { x: { $ref: 'fragment:a' } } }),
      { library: lib },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/闭环/);
  });

  it('非法 $ref 写法被拒', () => {
    const r = parseSchemaText(JSON.stringify({
      type: 'object',
      properties: { a: { $ref: '#/definitions/x' } },
    }), { library: buildLibrary() });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/fragment:/);
  });

  it('引用处再声明约束被拒（约束统一由片段定义）', () => {
    const r = parseSchemaText(JSON.stringify({
      type: 'object',
      properties: { a: { $ref: 'fragment:phone', minLength: 2 } },
    }), { library: buildLibrary() });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/minLength/);
  });
});

describe('片段引用：结构侧「内嵌 <-> 引用」转换与级联内联', () => {
  it('内嵌节点转换为引用：结构只剩链路，文本生成 $ref', () => {
    const model = schemaToModel({
      type: 'object',
      properties: { addr: { type: 'object', properties: { x: { type: 'string' } } } },
    });
    const addr = model.children![0];
    convertToRef(addr, 'contactAddress');
    expect(isRefNode(addr)).toBe(true);
    expect(addr.children).toBeUndefined();
    const schema = modelToSchema(model) as Record<string, unknown>;
    expect(schema.properties!.addr).toEqual({ $ref: 'fragment:contactAddress' });
  });

  it('引用收编为内嵌：得到片段当前内容快照（嵌套引用继续穿透展开）', () => {
    const lib = buildLibrary();
    const model = parseSchemaText(JSON.stringify(docWithRefs()), { library: lib }).model!;
    const primary = model.children!.find((c) => c.name === 'primary')!;
    inlineRef(primary, lib);
    expect(isRefNode(primary)).toBe(false);
    expect(primary.type).toBe('object');
    // 完整展开（含嵌套 region）成为独立快照
    expect(primary.children!.map((c) => c.name)).toEqual(['region', 'detail']);
    const region = primary.children!.find((c) => c.name === 'region')!;
    expect(region.children!.map((c) => c.name)).toEqual(['province', 'city']);
  });

  it('一跳内联：目标片段展开、内部对其他片段的引用原样保留（级联删除语义）', () => {
    const lib = buildLibrary();
    const model = parseSchemaText(JSON.stringify({
      type: 'object',
      properties: {
        office: { $ref: 'fragment:contactAddress' },
        home: { $ref: 'fragment:contactAddress' },
      },
    }), { library: lib }).model!;
    const count = inlineRefsInTree(model, 'contactAddress', lib);
    expect(count).toBe(2);
    const schema = modelToSchema(model) as any;
    expect(schema.properties.office.properties.detail.type).toBe('string');
    // contactAddress 内对 region 的引用保持为引用，没被抄平
    expect(schema.properties.office.properties.region.$ref).toBe('fragment:region');
  });

  it('片段库为空 / 文档不含引用：行为与升级前一致（普通全内嵌）', () => {
    const plain = { type: 'object', properties: { s: { type: 'string', minLength: 2 } } };
    const r = parseSchemaText(JSON.stringify(plain), { library: {} });
    expect(r.ok).toBe(true);
    expect(modelToSchemaText(r.model!)).toBe(JSON.stringify(plain, null, 2) + '\n');
    const errs = validateForm(r.model!, { s: 'a' }, {});
    expect(errs.length).toBe(1);
  });
});
