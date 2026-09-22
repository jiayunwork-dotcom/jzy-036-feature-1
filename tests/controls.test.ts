/**
 * 成功判据：控件映射覆盖 string/number/integer/boolean/enum/object/array 形态；
 * 默认值初始化正确。
 */
import { describe, expect, it } from 'vitest';
import { modelToControls } from '@engine/controls';
import { schemaToModel } from '@engine/parser';
import { initData } from '@engine/validate';

describe('Schema -> 控件映射', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      bio: { type: 'string', maxLength: 500 },
      age: { type: 'integer', minimum: 0, maximum: 120 },
      score: { type: 'number' },
      active: { type: 'boolean', default: true },
      role: { type: 'string', enum: ['admin', 'user'] },
      tags: { type: 'array', items: { type: 'string' } },
      profile: { type: 'object', properties: { city: { type: 'string' } } },
    },
  };
  const controls = modelToControls(schemaToModel(schema));
  const byName = Object.fromEntries((controls.children ?? []).map((c) => [c.name, c]));

  it('string -> text，长文本 -> textarea', () => {
    expect(byName.name.widget).toBe('text');
    expect(byName.bio.widget).toBe('textarea');
  });
  it('number/integer -> number', () => {
    expect(byName.age.widget).toBe('number');
    expect(byName.score.widget).toBe('number');
    expect(byName.age.minimum).toBe(0);
    expect(byName.age.maximum).toBe(120);
  });
  it('boolean -> checkbox', () => {
    expect(byName.active.widget).toBe('checkbox');
    expect(byName.active.default).toBe(true);
  });
  it('enum -> select 并带选项', () => {
    expect(byName.role.widget).toBe('select');
    expect(byName.role.enumOptions).toEqual(['admin', 'user']);
  });
  it('object -> group 且含嵌套子控件', () => {
    expect(byName.profile.widget).toBe('group');
    expect(byName.profile.children?.[0].name).toBe('city');
  });
  it('array -> arraylist 且携带 item 控件', () => {
    expect(byName.tags.widget).toBe('arraylist');
    expect(byName.tags.item?.widget).toBe('text');
  });
  it('默认值初始化：布尔 false、数组 []、字符串默认值', () => {
    const data = initData(schemaToModel(schema)) as Record<string, unknown>;
    expect(data.active).toBe(true);
    expect(data.tags).toEqual([]);
  });
});
