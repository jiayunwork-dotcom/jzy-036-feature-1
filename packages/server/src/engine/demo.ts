/**
 * 预置示范 Schema：一张「技术沙龙报名表」，覆盖嵌套对象、数组、
 * 字符串/整数/布尔/枚举以及必填、长度、数值范围、正则、默认值等约束。
 */
import { JsonSchemaObject } from './types';

export const DEMO_SCHEMA: JsonSchemaObject = {
  type: 'object',
  title: '技术沙龙报名表',
  description: '预置示范：用于体验双向同步、嵌套结构与约束校验。',
  required: ['fullName', 'email', 'age', 'track'],
  properties: {
    fullName: {
      type: 'string',
      title: '姓名',
      minLength: 2,
      maxLength: 20,
    },
    email: {
      type: 'string',
      title: '邮箱',
      pattern: '^[\\w.+-]+@[\\w-]+\\.[\\w.-]+$',
    },
    age: {
      type: 'integer',
      title: '年龄',
      minimum: 18,
      maximum: 99,
    },
    track: {
      type: 'string',
      title: '报名场次',
      enum: ['前端专场', '后端专场', 'AI 专场'],
      default: '前端专场',
    },
    needInvoice: {
      type: 'boolean',
      title: '是否需要发票',
      default: false,
    },
    address: {
      type: 'object',
      title: '联系地址',
      properties: {
        city: { type: 'string', title: '城市', minLength: 2 },
        zipCode: { type: 'string', title: '邮编', pattern: '^\\d{6}$' },
      },
      required: ['city'],
    },
    companions: {
      type: 'array',
      title: '同行人员',
      description: '可增删的重复项数组',
      items: {
        type: 'object',
        title: '同行人员',
        required: ['name'],
        properties: {
          name: { type: 'string', title: '姓名', minLength: 1, maxLength: 20 },
          role: {
            type: 'string',
            title: '角色',
            enum: ['同事', '朋友', '学生'],
          },
        },
      },
    },
    remark: {
      type: 'string',
      title: '备注',
      maxLength: 200,
    },
  },
};
