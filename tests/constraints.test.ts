/**
 * 成功判据 3：预览表单对违反约束的输入拦截、对合法输入放行，且错误定位到字段。
 */
import { describe, expect, it } from 'vitest';
import { validateForm, FieldError } from '@engine/validate';
import { schemaToModel } from '@engine/parser';
import { DEMO_SCHEMA } from '@engine/demo';
import type { FormData } from '@engine/validate';

const root = schemaToModel(DEMO_SCHEMA);

function validData(): FormData {
  return {
    fullName: '张三',
    email: 'zs@example.com',
    age: 25,
    track: 'AI 专场',
    needInvoice: false,
    address: { city: '杭州', zipCode: '310000' },
    companions: [{ name: '李四', role: '同事' }],
    remark: '你好',
  };
}

function expectBlocked(errors: FieldError[], locPart: string): void {
  const hit = errors.some((e) => e.loc === locPart || e.loc.includes(locPart));
  expect(hit, `期望字段 ${locPart} 被拦截，实际错误：${JSON.stringify(errors)}`).toBe(true);
}

describe('表单约束校验', () => {
  it('完全合法的数据被放行', () => {
    const errors = validateForm(root, validData());
    expect(errors).toEqual([]);
  });

  it('必填缺失被拦截并定位字段', () => {
    const data = validData();
    data.fullName = '';
    const errors = validateForm(root, data);
    expectBlocked(errors, 'fullName');
    expect(errors[0].message).toContain('必填');
  });

  it('字符串长度上下限', () => {
    let data = validData();
    data.fullName = 'A'; // minLength 2
    expectBlocked(validateForm(root, data), 'fullName');

    data = validData();
    data.fullName = '一'.repeat(21); // maxLength 20
    const errors = validateForm(root, data);
    expectBlocked(errors, 'fullName');
    expect(errors[0].message).toMatch(/不能超过 20/);
  });

  it('字符长度按码点计（emoji/中文不被误伤）', () => {
    const data = validData();
    data.fullName = '张三😀'; // 4 个码点，2 <= 4 <= 20
    expect(validateForm(root, data)).toEqual([]);
  });

  it('正则模式：邮编与邮箱', () => {
    let data = validData();
    data.address = { city: '杭州', zipCode: 'abc123' };
    expectBlocked(validateForm(root, data), 'zipCode');

    data = validData();
    data.email = 'not-an-email';
    expectBlocked(validateForm(root, data), 'email');
  });

  it('数值范围与整数约束', () => {
    let data = validData();
    data.age = 17;
    expectBlocked(validateForm(root, data), 'age');

    data = validData();
    data.age = 100;
    expectBlocked(validateForm(root, data), 'age');

    data = validData();
    data.age = 20.5 as unknown as number;
    expectBlocked(validateForm(root, data), 'age');

    data = validData();
    data.age = Number('abc');
    expectBlocked(validateForm(root, data), 'age');
  });

  it('枚举越界被拦截', () => {
    const data = validData();
    data.track = '摇滚专场' as unknown as string;
    expectBlocked(validateForm(root, data), 'track');
  });

  it('嵌套对象内必填（address.city）', () => {
    const data = validData();
    data.address = { city: '' };
    expectBlocked(validateForm(root, data), 'address.city');
  });

  it('数组：必填数组为空被拦截；数组项内字段错误被定位到索引', () => {
    // companions 非必填，空数组合法
    let data = validData();
    data.companions = [];
    expect(validateForm(root, data)).toEqual([]);

    // 数组项缺 name
    data = validData();
    data.companions = [{ name: '', role: '朋友' }];
    const errors = validateForm(root, data);
    expectBlocked(errors, 'companions[0].name');

    // 数组项枚举越界
    data = validData();
    data.companions = [{ name: '王五', role: '外星人' as string }];
    expectBlocked(validateForm(root, data), 'companions[0].role');
  });

  it('非必填字段留空跳过其他约束（不报错）', () => {
    const data = validData();
    data.remark = '';
    data.email = ''; // email 必填
    const errors = validateForm(root, data);
    expect(errors.some((e) => e.loc === 'remark')).toBe(false);
    expectBlocked(errors, 'email');
  });

  it('布尔必填且未勾选', () => {
    const model = schemaToModel({
      type: 'object',
      required: ['agree'],
      properties: { agree: { type: 'boolean', title: '同意条款' } },
    });
    expectBlocked(validateForm(model, { agree: false }), 'agree');
    expect(validateForm(model, { agree: true })).toEqual([]);
  });

  it('数字枚举只接受枚举值', () => {
    const model = schemaToModel({
      type: 'object',
      properties: { level: { type: 'integer', enum: [1, 2, 3] } },
    });
    expect(validateForm(model, { level: 2 })).toEqual([]);
    expectBlocked(validateForm(model, { level: 5 }), 'level');
  });
});
