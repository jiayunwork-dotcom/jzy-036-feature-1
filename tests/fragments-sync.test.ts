/**
 * 片段引用接入既有「最近一次合法状态」非法态：
 *  - 悬空引用 / 闭环 / 片段定义不合法都让文本进入非法态，结构树与预览停留在最近合法态；
 *  - 恢复合法（片段被补建 / 环解除）后自动重新接上；
 *  - 片段库在文档编辑期间变化：晚绑定重新校验，文档文本不被改写；
 *  - 结构侧把字段转成引用后，文本生成 $ref。
 */
import { describe, expect, it } from 'vitest';
import { createSyncSession, setText, syncFromModel, setFragmentLibrary } from '@engine/sync';
import { schemaToModel } from '@engine/parser';
import { convertNodeToRef, inlineNodeRef } from '@engine/tree';
import type { FragmentLibrary } from '@engine/fragments';
import { canonicalModel } from './helpers';

const addrFragment = () =>
  schemaToModel(
    {
      type: 'object',
      title: '联系地址',
      properties: { detail: { type: 'string', minLength: 3 } },
      required: ['detail'],
    },
    { allowNonObjectRoot: true },
  );

const docText = (ref: string) =>
  JSON.stringify({
    type: 'object',
    properties: { addr: { $ref: ref } },
  });

describe('片段引用进入同步状态机非法态', () => {
  it('引用不存在的片段：valid=false 给原因，结构模型停留在最近合法态', () => {
    const session = createSyncSession(
      schemaToModel({ type: 'object', properties: { keep: { type: 'boolean' } } }),
      {},
    );
    const before = canonicalModel(session.model);
    expect(setText(session, docText('fragment:ghost'))).toBe(false);
    expect(session.valid).toBe(false);
    expect(session.error).toMatch(/ghost/);
    expect(canonicalModel(session.model)).toEqual(before);
    // 文本不被回滚覆盖
    expect(session.text).toContain('fragment:ghost');
  });

  it('片段补齐后：重新设置片段库即恢复合法并接上（晚绑定）', () => {
    const session = createSyncSession(
      schemaToModel({ type: 'object', properties: {} }),
      {},
    );
    setText(session, docText('fragment:contactAddress'));
    expect(session.valid).toBe(false);

    const lib: FragmentLibrary = { contactAddress: addrFragment() };
    expect(setFragmentLibrary(session, lib)).toBe(true);
    expect(session.valid).toBe(true);
    expect(session.text).toContain('fragment:contactAddress'); // 链路仍在，未被展开抄写
    // 最近展开态穿透到了片段真实结构
    expect(session.lastExpanded.children[0].type).toBe('object');
    expect(session.lastExpanded.children[0].children.map((c) => c.name)).toEqual(['detail']);
  });

  it('片段被改后：引用处展开态按新定义变化，文档 model 本身不动', () => {
    const lib: FragmentLibrary = { contactAddress: addrFragment() };
    const session = createSyncSession(
      schemaToModel({ type: 'object', properties: {} }),
      lib,
    );
    setText(session, docText('fragment:contactAddress'));
    expect(session.valid).toBe(true);
    expect(session.lastExpanded.children[0].children[0].minLength).toBe(3);

    // 片段定义被修改（放宽长度）——文档没改
    lib.contactAddress = schemaToModel(
      { type: 'object', properties: { detail: { type: 'string', minLength: 1 } } },
      { allowNonObjectRoot: true },
    );
    setFragmentLibrary(session, lib);
    expect(session.valid).toBe(true);
    expect(session.model.children[0].ref).toBe('contactAddress'); // 仍是引用节点
    expect(session.lastExpanded.children[0].children[0].minLength).toBe(1);
  });

  it('片段被删除导致悬空：进入非法态、保留最近合法展开，重建片段后恢复', () => {
    const lib: FragmentLibrary = { contactAddress: addrFragment() };
    const session = createSyncSession(
      schemaToModel({ type: 'object', properties: {} }),
      lib,
    );
    setText(session, docText('fragment:contactAddress'));
    expect(session.valid).toBe(true);

    expect(setFragmentLibrary(session, {})).toBe(false);
    expect(session.valid).toBe(false);
    expect(session.error).toMatch(/contactAddress|不存在/);
    // 预览仍停留在上一次成功展开
    expect(session.lastExpanded.children[0].type).toBe('object');

    expect(setFragmentLibrary(session, { contactAddress: addrFragment() })).toBe(true);
    expect(session.valid).toBe(true);
  });

  it('闭环片段库：使用处进入非法态，环解除后恢复', () => {
    const a = schemaToModel(
      { type: 'object', properties: { b: { $ref: 'fragment:b' } } },
      { allowNonObjectRoot: true },
    );
    const b = schemaToModel(
      { type: 'object', properties: { a: { $ref: 'fragment:a' } } },
      { allowNonObjectRoot: true },
    );
    const session = createSyncSession(schemaToModel({ type: 'object', properties: {} }), {});
    setText(session, JSON.stringify({ type: 'object', properties: { x: { $ref: 'fragment:a' } } }));
    expect(session.valid).toBe(false);
    expect(session.error).toMatch(/不存在|闭环/);
    // 即便环片段被「塞进」库（绕过保存边界的异常情况），展开也不崩、进入闭环非法态
    expect(setFragmentLibrary(session, { a, b })).toBe(false);
    expect(session.error).toMatch(/闭环/);
  });

  it('结构侧把字段转换为引用：文本生成 $ref；引用片段缺失时进入非法态但结构保留', () => {
    const session = createSyncSession(
      schemaToModel({
        type: 'object',
        properties: { addr: { type: 'object', properties: { x: { type: 'string' } } } },
      }),
      {},
    );
    const id = session.model.children[0].id;
    convertNodeToRef(session.model, id, 'contactAddress');
    syncFromModel(session);
    // 片段还不存在 -> 非法态，但文本已表达为引用、结构区是引用节点
    expect(session.valid).toBe(false);
    expect(session.model.children[0].ref).toBe('contactAddress');
    expect(session.text).toContain('"$ref": "fragment:contactAddress"');

    // 补建片段 -> 恢复
    setFragmentLibrary(session, { contactAddress: addrFragment() });
    expect(session.valid).toBe(true);
  });

  it('结构侧把引用收编为内嵌：文本变为内联结构，此后不再随片段变化', () => {
    const lib: FragmentLibrary = { contactAddress: addrFragment() };
    const session = createSyncSession(schemaToModel({ type: 'object', properties: {} }), lib);
    setText(session, docText('fragment:contactAddress'));
    const id = session.model.children[0].id;
    inlineNodeRef(session.model, id, lib);
    syncFromModel(session);
    expect(session.valid).toBe(true);
    const schema = JSON.parse(session.text);
    expect(schema.properties.addr.type).toBe('object');
    expect(schema.properties.addr.$ref).toBeUndefined();
    expect(schema.properties.addr.properties.detail.minLength).toBe(3);

    // 片段之后再怎么改，内联字段不受影响
    lib.contactAddress = schemaToModel(
      { type: 'object', properties: { detail: { type: 'string', maxLength: 999 } } },
      { allowNonObjectRoot: true },
    );
    setFragmentLibrary(session, lib);
    expect(JSON.parse(session.text).properties.addr.properties.detail.minLength).toBe(3);
  });
});
