/**
 * 核心类型定义：结构模型（FieldNode）与 JSON Schema 子集。
 *
 * 结构模型是编辑器两侧（可视化 / 文本）共同表达的「最近一次合法状态」：
 *  - 可视化区直接编辑 FieldNode 树；
 *  - 文本区合法时经 schema -> FieldNode 解析后替换该树；
 *  - 文本区非法时该树保持不动，UI 不被清空。
 */

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

/** 预览表单可用的控件类型（由控件映射引擎决定） */
export type WidgetType = 'text' | 'textarea' | 'number' | 'checkbox' | 'select' | 'group' | 'arraylist';

export interface FieldNode {
  /** 仅用于前端列表 key / 树操作，不参与 Schema 语义，序列化时剥离 */
  id: string;
  /** 字段名；根节点固定为 ''  */
  name: string;
  /**
   * 节点类型。内嵌定义节点必有类型；引用节点（ref 非空）没有自身类型，
   * 其「真实类型」在控件映射 / 校验时穿透到片段定义取得。
   */
  type?: FieldType;
  /**
   * 引用节点：指向片段库中某个具名片段（形如 `contactAddress`）。
   * 与 type/children/item/各类约束互斥——引用节点不是片段内容的复制品，
   * 而是一条指向同一份定义的链路。
   */
  ref?: string;
  title?: string;
  description?: string;
  required?: boolean;
  /** string */
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** number / integer */
  minimum?: number;
  maximum?: number;
  /** 通用枚举（boolean 亦可带枚举） */
  enum?: (string | number | boolean)[];
  /** 默认值（仅标量；对象/数组默认值不在编辑器支持范围） */
  default?: string | number | boolean;
  /** object：有序的属性字段 */
  children?: FieldNode[];
  /** array：单一 items 节点（本工具支持同构数组） */
  item?: FieldNode;
}

/** 任意 JSON 值 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type JsonSchemaObject = {
  type?: string;
  /** 引用某个具名片段，写法 `fragment:片段名`；引用节点不得再声明其他结构/约束关键字 */
  $ref?: string;
  title?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, JsonSchemaObject>;
  items?: JsonSchemaObject;
  enum?: JsonValue[];
  const?: JsonValue;
  default?: JsonValue;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  [k: string]: JsonValue | JsonSchemaObject | JsonSchemaObject[] | undefined;
};

/** 文本解析结果（不抛异常，非法时给出可展示原因） */
export interface ParseResult {
  ok: boolean;
  model?: FieldNode;
  schema?: JsonSchemaObject;
  error?: string;
  /** 出错位置（若能从 JSON 解析异常中提取） */
  line?: number;
  column?: number;
}

/** 引擎层统一错误（带路径，便于定位字段） */
export class SchemaEngineError extends Error {
  path: string;
  constructor(message: string, path = '') {
    super(path ? `${path}: ${message}` : message);
    this.name = 'SchemaEngineError';
    this.path = path;
  }
}

let idCounter = 0;
export function uid(): string {
  idCounter += 1;
  return `f_${Date.now().toString(36)}_${idCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

export const SCALAR_TYPES: FieldType[] = ['string', 'number', 'integer', 'boolean'];
export const ALL_TYPES: FieldType[] = ['string', 'number', 'integer', 'boolean', 'object', 'array'];
