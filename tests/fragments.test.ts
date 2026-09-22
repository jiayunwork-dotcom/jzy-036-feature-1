/**
 * 可复用结构片段 —— 引擎层测试：
 *  1) 引用节点是结构模型的一等节点：解析不展开、序列化存指针、往返等价；
 *  2) 穿透（resolveModel）按片段当前定义取真实类型/约束，片段一改多处同步；
 *  3) 片段嵌套引用、闭环 / 悬空在解析与图校验边界即被拦下；
 *  4) 非法态通道复用：悬空 / 闭环 / 片段定义非法都保留最近合法模型；
 *  5) 结构侧「内嵌 -> 引用」「引用 -> 还原内嵌」双向转换。
 */
import { describe, expect, it } from 'vitest';
import {
  buildFragmentLib,
  checkFragmentSave,
  collectRefs,
  findRefOccurrences,
  materializeArchived,
  pruneRefs,
  resolveModel,
} from '@engine/fragments';
import { parseSchemaText } from '@engine/parser';
import { modelToSchemaText } from '@engine/serialize';
import { initData, validateForm } from '@engine/validate';
import { createSyncSession, setFragmentLib, setText, syncFromModel } from '@engine/sync';
import {
  addField,
  addRefField,
  convertToRef,
  emptyRoot,
  findById,
  inlineRefNode,
  updateNode,
} from '@engine/tree';
import { isRef, type FieldNode } from '@engine/types';

const regionSchema = {
  type: 'object',
  properties: {
    province: { type: 'string', title: '省' },
    city: { type: 'string', title: '市', minLength: 2 },
  },
  required: ['province', 'city'],
};

const addressSchema = {
  type: 'object',
  title: '联系地址',
  properties: {
    detail: { type: 'string', title: '详细地址', maxLength: 100 },
    region: { $fragment: 'region' },
  },
  required: ['detail'],
};

const zipSchema = { type: 'string', title: '邮编', pattern: '^\\d{6}$' };

function libWith(...entries: Array<[string, unknown]>) {
  return buildFragmentLib(
    entries.map(([key, schema]) => ({ key, content: JSON.stringify(schema) })),
  );
}

const docSchema = () => ({
  type: 'object',
  title: '报名表',
  properties: {
    name: { type: 'string', title: '姓名' },
    primary: { $fragment: 'address' },
    backup: { $fragment: 'address' },
  },
  required: ['name', 'primary'],
});

describe('片段库构建与嵌套引用', () => {
  it('嵌套片段（address 内嵌 region 引用）构建无错误', () => {
    const built = libWith(['region', regionSchema], ['address', addressSchema]);
    expect(built.errors.size).toBe(0);
    expect(built.lib.get('address')?.root.type).toBe('object');
  });

  it('片段定义自身非法时被标记，不拖垮其他片段', () => {
    const built = libWith(
      ['region', regionSchema],
      ['bad', { type: 'object', properties: { x: { type: 'datetime' } } }],
    );
    expect(built.errors.get('bad')).toMatch(/不支持的类型/);
    expect(built.lib.has('region')).toBe(true);
    expect(built.lib.has('bad')).toBe(false);
  });
});

describe('引用节点：解析不展开、序列化存指针、往返等价', () => {
  const built = libWith(['region', regionSchema], ['address', addressSchema]);

  it('文本 -> 模型：引用位置是 RefNode 而非展开副本', () => {
    const r = parseSchemaText(JSON.stringify(docSchema()), { lib: built.lib });
    expect(r.ok).toBe(true);
    const model = r.model as FieldNode;
    const [name, primary, backup] = model.children!;
    expect(isRef(primary)).toBe(true);
    expect(isRef(backup)).toBe(true);
    expect(name.name).toBe('name');
    expect((primary as any).ref).toBe('address');
    expect(primary.required).toBe(true);
    expect(backup.required).toBeUndefined();
    // 引用节点上没有片段字段的复制
    expect((primary as any).children).toBeUndefined();
  });

  it('模型 -> 文本：两处引用原样输出 $fragment，绝不展开片段内容', () => {
    const r = parseSchemaText(JSON.stringify(docSchema()), { lib: built.lib });
    const text = modelToSchemaText(r.model as FieldNode);
    expect(text).toContain('"$fragment": "address"');
    expect(text).not.toContain('详细地址');
    expect(text.match(/\$fragment/g)).toHaveLength(2);
  });

  it('结构 -> 文本 -> 再解析回结构：引用关系与语义等价（多轮幂等）', () => {
    const r1 = parseSchemaText(JSON.stringify(docSchema()), { lib: built.lib });
    const t1 = modelToSchemaText(r1.model as FieldNode);
    const r2 = parseSchemaText(t1, { lib: built.lib });
    expect(r2.ok).toBe(true);
    const refs1 = collectRefs(r1.model);
    const refs2 = collectRefs(r2.model);
    expect(refs2).toEqual(refs1);
    expect(refs2).toEqual(['address', 'address']);
    const t2 = modelToSchemaText(r2.model as FieldNode);
    const t3 = modelToSchemaText(parseSchemaText(t2, { lib: built.lib }).model as FieldNode);
    expect(t3).toBe(t2);
    expect(t2).toBe(t1);
  });

  it('空片段库 / 不含引用的老文档：行为与升级前一致', () => {
    const old = { type: 'object', properties: { a: { type: 'string', minLength: 1 } } };
    const r = parseSchemaText(JSON.stringify(old));
    expect(r.ok).toBe(true);
    expect(collectRefs(r.model)).toEqual([]);
    expect(modelToSchemaText(r.model as FieldNode)).toBe(JSON.stringify(old, null, 2) + '\n');
  });
});

describe('穿透：控件/默认值/校验按片段当前定义', () => {
  const built = libWith(['region', regionSchema], ['address', addressSchema], ['zip', zipSchema]);

  it('resolveModel 生成独立展开副本（嵌套片段一并穿透，不回写片段定义）', () => {
    const r = parseSchemaText(JSON.stringify(docSchema()), { lib: built.lib });
    const resolved = resolveModel(r.model as FieldNode, built.lib);
    const primary = resolved.children![1] as FieldNode;
    expect(primary.type).toBe('object');
    expect(primary.required).toBe(true); // 引用处必填覆盖
    const region = primary.children!.find((c) => c.name === 'region') as FieldNode;
    expect(region.type).toBe('object');
    expect(region.children!.map((c) => c.name)).toEqual(['province', 'city']);
    // 原模型依然是引用
    expect(isRef((r.model as FieldNode).children![1])).toBe(true);
  });

  it('同一片段两处引用展开为两棵独立子树', () => {
    const r = parseSchemaText(JSON.stringify(docSchema()), { lib: built.lib });
    const resolved = resolveModel(r.model as FieldNode, built.lib);
    const [, p, b] = resolved.children! as FieldNode[];
    expect(p).not.toBe(b);
    expect(p.children).not.toBe(b.children);
  });

  it('校验：片段必填/长度/正则约束在引用路径上定位生效', () => {
    const doc = {
      type: 'object',
      properties: {
        primary: { $fragment: 'address' },
        mailZip: { $fragment: 'zip' },
      },
    };
    const r = parseSchemaText(JSON.stringify(doc), { lib: built.lib });
    const resolved = resolveModel(r.model as FieldNode, built.lib);
    const errors = validateForm(resolved, {
      primary: { detail: '', region: { province: '', city: '京' } },
      mailZip: 'abc',
    } as any);
    const locs = errors.map((e) => e.loc);
    expect(locs).toEqual(
      expect.arrayContaining([
        'primary.detail',
        'primary.region.province',
        'primary.region.city',
        'mailZip',
      ]),
    );
    const ok = validateForm(resolved, {
      primary: { detail: 'xx', region: { province: '浙江', city: '杭州' } },
      mailZip: '310000',
    } as any);
    expect(ok).toEqual([]);
  });

  it('默认值穿透：标量片段默认值在初始化表单时生效', () => {
    const withDefault = libWith(['track', { type: 'string', enum: ['A', 'B'], default: 'A' }]);
    const r = parseSchemaText(
      JSON.stringify({ type: 'object', properties: { t: { $fragment: 'track' } } }),
      { lib: withDefault.lib },
    );
    const data = initData(resolveModel(r.model as FieldNode, withDefault.lib));
    expect((data as any).t).toBe('A');
  });

  it('片段定义一改，所有引用处的结构与校验即时同步', () => {
    const v1 = libWith(['region', regionSchema], ['address', addressSchema]);
    const r = parseSchemaText(JSON.stringify(docSchema()), { lib: v1.lib });
    const model = r.model as FieldNode;

    // 改片段：address 增加邮编、region 引用移除
    const v2 = libWith(
      ['region', regionSchema],
      [
        'address',
        {
          type: 'object',
          properties: {
            detail: { type: 'string' },
            mailZip: { $fragment: 'zip' },
          },
        },
      ],
      ['zip', zipSchema],
    );
    const resolved2 = resolveModel(model, v2.lib);
    const primary = resolved2.children![1] as FieldNode;
    expect(primary.children!.map((c) => c.name)).toEqual(['detail', 'mailZip']);
    const mailZip = primary.children![1] as FieldNode;
    expect(mailZip.pattern).toBe('^\\d{6}$'); // 新引用的片段约束
    // 文本侧的引用指针完全没变，变的只是片段库里的定义
    expect(collectRefs(model)).toEqual(['address', 'address']);
  });
});

describe('闭环与悬空：在保存/解析边界拦截，不拖到渲染期', () => {
  it('A→B→A 闭环：两个片段都被标记，错误信息给出链路', () => {
    const built = libWith(
      ['fragA', { type: 'object', properties: { b: { $fragment: 'fragB' } } }],
      ['fragB', { type: 'object', properties: { a: { $fragment: 'fragA' } } }],
    );
    expect(built.errors.get('fragA')).toMatch(/闭环.*fragA.*fragB.*fragA/s);
    expect(built.errors.get('fragB')).toMatch(/闭环/);
  });

  it('自环片段（直接或间接引用自身）被拒绝', () => {
    const direct = libWith(['s', { type: 'object', properties: { me: { $fragment: 's' } } }]);
    expect(direct.errors.get('s')).toMatch(/闭环/);
  });

  it('checkFragmentSave：编辑后引入闭环当场识别；无环时放行', () => {
    // a 拟改成引用 b；b 现存定义里又引用 a —— 形成 a→b→a 间接闭环
    const base = libWith(
      ['b', { type: 'object', properties: { back: { $fragment: 'a' } } }],
    );
    const r = parseSchemaText(
      JSON.stringify({ type: 'object', properties: { b: { $fragment: 'b' } } }),
      { lenientRefs: true, rootMustBeObject: false },
    );
    expect(checkFragmentSave(base.lib, 'a', r.model!)).toMatch(/闭环/);
    const ok = parseSchemaText(JSON.stringify({ type: 'string' }), {
      lenientRefs: true,
      rootMustBeObject: false,
    });
    expect(checkFragmentSave(base.lib, 'a', ok.model!)).toBeUndefined();
  });

  it('checkFragmentSave：引用不存在的片段（悬空）当场拒绝', () => {
    const base = libWith(['x', { type: 'string' }]);
    const r = parseSchemaText(
      JSON.stringify({ type: 'object', properties: { g: { $fragment: 'ghost' } } }),
      { lenientRefs: true, rootMustBeObject: false },
    );
    expect(checkFragmentSave(base.lib, 'x', r.model!)).toMatch(/不存在的片段「ghost」/);
  });

  it('悬空引用：文档严格解析被拒并指出片段 key', () => {
    const r = parseSchemaText(JSON.stringify(docSchema()), { lib: new Map() });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/不存在的片段「address」/);
  });

  it('悬空引用：嵌套在片段定义内部也被严格解析拒绝', () => {
    const built = libWith(['address', addressSchema]); // 缺 region
    const r = parseSchemaText(
      JSON.stringify({ type: 'object', properties: { a: { $fragment: 'address' } } }),
      { lib: built.lib },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/region/);
  });

  it('$fragment 与其他关键字混写被拒绝（引用必须是纯指针）', () => {
    const r = parseSchemaText(
      JSON.stringify({ type: 'object', properties: { a: { $fragment: 'zip', type: 'string' } } }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/不允许同时携带/);
  });
});

describe('非法态通道复用：片段相关失败走同一套回退', () => {
  const built = libWith(['address', addressSchema], ['region', regionSchema]);

  it('引用改悬空：valid=false + 原因，模型停留在最近合法态', () => {
    const session = createSyncSession(
      parseSchemaText(JSON.stringify(docSchema()), { lib: built.lib }).model as FieldNode,
      built.lib,
    );
    const snapshot = JSON.stringify(session.model);
    const ok = setText(
      session,
      JSON.stringify({ type: 'object', properties: { x: { $fragment: 'ghost' } } }),
    );
    expect(ok).toBe(false);
    expect(session.valid).toBe(false);
    expect(session.error).toMatch(/不存在的片段/);
    expect(JSON.stringify(session.model)).toEqual(snapshot);
  });

  it('片段库换成含闭环的库：进入非法态；恢复后自动接上', () => {
    const session = createSyncSession(
      parseSchemaText(JSON.stringify(docSchema()), {
        lib: built.lib,
        fragmentErrors: built.errors,
      }).model as FieldNode,
      built.lib,
      built.errors,
    );
    const cyclic = libWith(
      ['address', addressSchema],
      ['region', { type: 'object', properties: { back: { $fragment: 'address' } } }],
    );
    // address -> region -> address 闭环（坏片段不入 lib，错误经 fragmentErrors 传入）
    expect(setFragmentLib(session, cyclic.lib, cyclic.errors)).toBe(false);
    expect(session.error).toMatch(/闭环/);
    // 恢复健康库后同一文本重新合法
    expect(setFragmentLib(session, built.lib, built.errors)).toBe(true);
    expect(session.valid).toBe(true);
  });

  it('非法态期间编辑结构：以结构为准重建文本恢复合法', () => {
    const session = createSyncSession(
      parseSchemaText(JSON.stringify(docSchema()), { lib: built.lib }).model as FieldNode,
      built.lib,
    );
    setText(session, '{ broken');
    expect(session.valid).toBe(false);
    addField(session.model, null, 'boolean');
    expect(syncFromModel(session)).toBeUndefined();
    expect(session.valid).toBe(true);
    const reparsed = JSON.parse(session.text);
    expect(reparsed.properties.primary.$fragment).toBe('address');
  });
});

describe('结构区双向转换：内嵌 ↔ 引用', () => {
  const built = libWith(['address', addressSchema], ['region', regionSchema]);

  it('普通字段转换为引用：保留字段名与必填，定义替换为指针；文本同步生成', () => {
    const root = emptyRoot('测试');
    addField(root, null, 'object');
    const node = root.children![0];
    updateNode(root, node.id, { name: 'contact', required: true });
    convertToRef(root, node.id, 'address');
    const ref = root.children![0];
    expect(isRef(ref)).toBe(true);
    expect(ref.name).toBe('contact');
    expect(ref.required).toBe(true);
    const text = modelToSchemaText(root);
    expect(JSON.parse(text).properties.contact).toEqual({ $fragment: 'address' });
  });

  it('引用还原为内嵌：取片段当前定义生成独立副本，从此与片段互不相干', () => {
    const root = emptyRoot('测试');
    addRefField(root, null, 'address');
    const ref = root.children![0];
    updateNode(root, ref.id, { name: 'contact' });
    inlineRefNode(root, ref.id, built.lib.get('address')!.root);
    const inlined = root.children![0] as FieldNode;
    expect(isRef(inlined)).toBe(false);
    expect(inlined.type).toBe('object');
    expect(inlined.name).toBe('contact');
    // 内部嵌套片段引用仍然保留（还原只解开一层）
    const inner = inlined.children!.find((c) => c.name === 'region');
    expect(isRef(inner)).toBe(true);
  });

  it('在对象下新增引用字段 + 数组项引用，序列化/解析往返保留', () => {
    const r = parseSchemaText(
      JSON.stringify({
        type: 'object',
        properties: {
          zips: { type: 'array', items: { $fragment: 'zip' } },
        },
      }),
      { lib: libWith(['zip', zipSchema]).lib },
    );
    expect(r.ok).toBe(true);
    const arr = (r.model as FieldNode).children![0] as FieldNode;
    expect(isRef(arr.item!)).toBe(true);
    expect((arr.item as any).ref).toBe('zip');
    const back = modelToSchemaText(r.model as FieldNode);
    expect(JSON.parse(back).properties.zips.items).toEqual({ $fragment: 'zip' });
  });
});

describe('回滚物化与 detach 原语', () => {
  it('已删片段就地展开、存活片段保持引用，结果可严格解析', () => {
    const live = libWith(['region', regionSchema], ['zip', zipSchema]);
    const archived = libWith(['address', addressSchema]);
    const model = parseSchemaText(JSON.stringify(docSchema()), { lenientRefs: true }).model!;
    const mat = materializeArchived(model, live.lib, archived.lib) as FieldNode;
    const text = modelToSchemaText(mat);
    expect(text).not.toContain('"$fragment": "address"');
    expect(text).toContain('"$fragment": "region"');
    // 用存活库严格解析回滚产物必须合法
    expect(parseSchemaText(text, { lib: live.lib }).ok).toBe(true);
    // 且展开内容语义就是片段定义
    const reparsed = resolveModel(parseSchemaText(text, { lib: live.lib }).model as FieldNode, live.lib);
    const primary = reparsed.children![1] as FieldNode;
    expect(primary.children!.map((c) => c.name)).toEqual(['detail', 'region']);
  });

  it('物化保留引用处的字段名与必填（覆盖片段根自身约束）', () => {
    const live = libWith(['region', regionSchema]);
    const archived = libWith(['address', addressSchema]);
    // primary 显式必填；address 片段根自身无 required
    const model = parseSchemaText(
      JSON.stringify({
        type: 'object',
        properties: {
          contact: { $fragment: 'address' },
          other: { type: 'string' },
        },
        required: ['contact'],
      }),
      { lenientRefs: true },
    ).model!;
    const mat = materializeArchived(model, live.lib, archived.lib) as FieldNode;
    const contact = mat.children!.find((c) => c.name === 'contact') as FieldNode;
    expect(contact).toBeDefined();
    expect(isRef(contact)).toBe(false);
    expect(contact.required).toBe(true);
    const schema = JSON.parse(modelToSchemaText(mat));
    expect(schema.required).toEqual(['contact']);
  });

  it('pruneRefs：摘除对象属性引用与数组项引用后仍为合法 Schema', () => {
    const model = parseSchemaText(
      JSON.stringify({
        type: 'object',
        properties: {
          a: { type: 'string' },
          gone: { $fragment: 'address' },
          list: { type: 'array', items: { $fragment: 'address' } },
        },
      }),
      { lenientRefs: true },
    ).model as FieldNode;
    const pruned = pruneRefs(model, new Set(['address']));
    const text = modelToSchemaText(pruned);
    expect(text).not.toContain('address');
    const json = JSON.parse(text);
    expect(Object.keys(json.properties)).toEqual(['a', 'list']);
    // 数组项引用摘除后退化为一个普通 string item，数组仍是合法同构数组
    expect(json.properties.list.items).toEqual({ type: 'string' });
  });

  it('引用出现位置可枚举（影响范围展示）', () => {
    const model = parseSchemaText(
      JSON.stringify({
        type: 'object',
        properties: {
          primary: { $fragment: 'address' },
          nested: {
            type: 'object',
            properties: { backup: { $fragment: 'address' }, other: { $fragment: 'zip' } },
          },
        },
      }),
      { lenientRefs: true },
    ).model as FieldNode;
    const occ = findRefOccurrences(model, new Set(['address']));
    expect(occ.map((o) => o.path)).toEqual(['$root.primary', '$root.nested.backup']);
    expect(findById(model, model.children![0].id)?.id).toBe(model.children![0].id);
  });
});
