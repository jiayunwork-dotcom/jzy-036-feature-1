/**
 * 成功判据 2：文本区键入非法内容时，结构区停留在最近合法态且不被清空；
 * 恢复合法后两侧重新同步。
 */
import { describe, expect, it } from 'vitest';
import { createSyncSession, setText, syncFromModel } from '@engine/sync';
import { schemaToModel } from '@engine/parser';
import { addField } from '@engine/tree';
import { DEMO_SCHEMA } from '@engine/demo';
import { canonicalModel } from './helpers';

function demoSession() {
  return createSyncSession(schemaToModel(DEMO_SCHEMA));
}

describe('非法文本回退（最近一次合法状态）', () => {
  it('JSON 语法错误：valid=false 且有行列信息，model 保持为最近合法态', () => {
    const session = demoSession();
    const before = canonicalModel(session.model);

    const ok = setText(session, '{"type":"object","properties":{');
    expect(ok).toBe(false);
    expect(session.valid).toBe(false);
    expect(session.error).toMatch(/JSON 语法错误/);
    expect(session.errorLine).toBeTypeOf('number');
    // 关键断言：结构区不被清空
    expect(canonicalModel(session.model)).toEqual(before);
    expect(session.model.children?.length).toBeGreaterThan(0);
  });

  it('合法 JSON 但不是合法 Schema：model 同样保持旧态并说明原因', () => {
    const session = demoSession();
    const before = canonicalModel(session.model);

    expect(setText(session, '{"type":"object","properties":{"a":{"type":"datetime"}}}')).toBe(false);
    expect(session.error).toMatch(/不支持的类型/);
    expect(canonicalModel(session.model)).toEqual(before);
  });

  it('required 引用不存在字段：拒绝并保留旧态', () => {
    const session = demoSession();
    const before = canonicalModel(session.model);
    const bad = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['ghost'],
    };
    expect(setText(session, JSON.stringify(bad))).toBe(false);
    expect(session.error).toMatch(/ghost/);
    expect(canonicalModel(session.model)).toEqual(before);
  });

  it('空文本：非法但不崩，结构保留', () => {
    const session = demoSession();
    const before = canonicalModel(session.model);
    expect(setText(session, '   ')).toBe(false);
    expect(session.error).toMatch(/为空/);
    expect(canonicalModel(session.model)).toEqual(before);
  });

  it('非法正则：被拦截', () => {
    const session = demoSession();
    const bad = {
      type: 'object',
      properties: { a: { type: 'string', pattern: '([' } },
    };
    expect(setText(session, JSON.stringify(bad))).toBe(false);
    expect(session.error).toMatch(/正则|pattern/);
  });

  it('恢复合法后重新同步：结构刷新为新 Schema', () => {
    const session = demoSession();
    // 先打断
    setText(session, '{ not json');
    expect(session.valid).toBe(false);
    // 恢复成另一份合法 Schema
    const next = { type: 'object', properties: { onlyOne: { type: 'integer' } } };
    const ok = setText(session, JSON.stringify(next));
    expect(ok).toBe(true);
    expect(session.valid).toBe(true);
    expect(session.error).toBeUndefined();
    expect(session.model.children?.map((c) => c.name)).toEqual(['onlyOne']);
    expect(session.text).toContain('onlyOne');
  });

  it('非法文本期间在结构侧编辑：以结构为准重建文本并恢复合法', () => {
    const session = demoSession();
    setText(session, '<<broken>>');
    expect(session.valid).toBe(false);

    addField(session.model, null, 'boolean');
    const err = syncFromModel(session);
    expect(err).toBeUndefined();
    expect(session.valid).toBe(true);
    const reparsed = JSON.parse(session.text);
    expect(reparsed.properties).toBeDefined();
    // 新增的是布尔字段；示范文档原有 7 个字段，新字段名以 field 开头
    const newNames = Object.keys(reparsed.properties).filter((n) => n.startsWith('field'));
    expect(newNames.length).toBe(1);
    expect(reparsed.properties[newNames[0]].type).toBe('boolean');
  });
});
