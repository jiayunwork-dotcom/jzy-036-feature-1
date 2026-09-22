/**
 * 成功判据 1：同一份 Schema 经「结构 -> 文本 -> 再解析回结构」一圈往返后语义不变。
 */
import { describe, expect, it } from 'vitest';
import { parseSchemaText } from '@engine/parser';
import { modelToSchema, modelToSchemaText } from '@engine/serialize';
import { schemaToModel } from '@engine/parser';
import { DEMO_SCHEMA } from '@engine/demo';
import { canonicalModel, sameSchema } from './helpers';

describe('结构 -> Schema 文本 -> 结构：往返语义不变', () => {
  it('示范 Schema（嵌套对象/数组/枚举/约束）往返后 Schema 等价', () => {
    const text = JSON.stringify(DEMO_SCHEMA, null, 2);
    const parsed = parseSchemaText(text);
    expect(parsed.ok).toBe(true);

    const serialized = modelToSchema(parsed.model!);
    expect(sameSchema(serialized, DEMO_SCHEMA)).toBe(true);

    // 再来一圈
    const text2 = modelToSchemaText(parsed.model!);
    const parsed2 = parseSchemaText(text2);
    expect(parsed2.ok).toBe(true);
    expect(sameSchema(modelToSchema(parsed2.model!), DEMO_SCHEMA)).toBe(true);
  });

  it('往返后结构模型（剥离会话态 id）等价', () => {
    const model1 = schemaToModel(DEMO_SCHEMA);
    const text = modelToSchemaText(model1);
    const model2 = parseSchemaText(text).model!;
    expect(canonicalModel(model1)).toEqual(canonicalModel(model2));
  });

  it('结构侧编辑后再解析，约束被完整保留', () => {
    const model = schemaToModel(DEMO_SCHEMA);
    const text = modelToSchemaText(model);
    const again = schemaToModel(JSON.parse(text));
    const schema = modelToSchema(again) as Record<string, any>;
    expect(schema.properties.fullName.minLength).toBe(2);
    expect(schema.properties.fullName.maxLength).toBe(20);
    expect(schema.properties.age.minimum).toBe(18);
    expect(schema.properties.age.maximum).toBe(99);
    expect(schema.properties.email.pattern).toBe(DEMO_SCHEMA.properties!.email.pattern);
    expect(schema.properties.track.enum).toEqual(['前端专场', '后端专场', 'AI 专场']);
    expect(schema.properties.address.properties.zipCode.pattern).toBe('^\\d{6}$');
    expect(schema.properties.companions.items.properties.role.enum).toEqual(['同事', '朋友', '学生']);
  });

  it('多次往返文本逐字节稳定（幂等）', () => {
    const t1 = modelToSchemaText(schemaToModel(DEMO_SCHEMA));
    const t2 = modelToSchemaText(schemaToModel(JSON.parse(t1)));
    const t3 = modelToSchemaText(schemaToModel(JSON.parse(t2)));
    expect(t2).toBe(t1);
    expect(t3).toBe(t1);
  });
});
