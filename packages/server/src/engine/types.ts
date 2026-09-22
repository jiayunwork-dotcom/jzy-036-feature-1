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
  type: FieldType;
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
  /** object：有序的属性字段（内嵌定义或片段引用） */
  children?: StructureNode[];
  /** array：单一 items 节点（本工具支持同构数组；亦可为片段引用） */
  item?: StructureNode;
}

/**
 * 片段引用节点：结构模型里与「内嵌定义 FieldNode」并列的第二种节点。
 * 它自身不携带任何类型/约束信息，只是指向片段库中某份定义的一条链路；
 * 控件映射、表单渲染与校验时经 resolveModel 穿透到片段当前定义。
 */
export interface RefNode {
  /** 判别标记，区别于 FieldNode（FieldNode 上不存在 kind 字段） */
  kind: 'ref';
  /** 仅用于前端列表 key / 树操作，不参与 Schema 语义，序列化时剥离 */
  id: string;
  /** 引用所处的字段名（对象属性名 / 数组项为 '$item'；根固定为 ''） */
  name: string;
  /** 指向片段的稳定 key（片段可改名标题，key 一经创建不变） */
  ref: string;
  /** 引用处可独立声明必填；缺省取片段定义根的 required */
  required?: boolean;
}

/** 结构树节点：要么内嵌定义，要么引用他处定义 */
export type StructureNode = FieldNode | RefNode;

export function isRef(node: StructureNode | undefined | null): node is RefNode {
  return !!node && typeof node === 'object' && (node as RefNode).kind === 'ref';
}

export function isField(node: StructureNode | undefined | null): node is FieldNode {
  return !!node && typeof node === 'object' && (node as RefNode).kind !== 'ref';
}

export function createRefNode(ref: string, name: string, required?: boolean): RefNode {
  return { kind: 'ref', id: uid(), name, ref, ...(required ? { required: true } : {}) };
}

/** 任意 JSON 值 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type JsonSchemaObject = {
  type?: string;
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
  /** 片段引用：{"$fragment": "<key>"}，引用节点不允许携带其他结构关键字 */
  $fragment?: string;
  [k: string]: JsonValue | JsonSchemaObject | JsonSchemaObject[] | undefined;
};

/** 文本解析结果（不抛异常，非法时给出可展示原因） */
export interface ParseResult {
  ok: boolean;
  model?: StructureNode;
  schema?: JsonSchemaObject;
  error?: string;
  /** 出错位置（若能从 JSON 解析异常中提取） */
  line?: number;
  column?: number;
}

/** 片段定义：独立命名、独立管理、独立留版本历史的一等结构资源 */
export interface FragmentDef {
  /** 稳定 key，文档/片段经 $fragment 引用它；创建后不可变 */
  key: string;
  /** 展示名（可随时修改，不影响引用） */
  title?: string;
  description?: string;
  /** 片段结构定义根：任意受支持类型（也允许是指向另一片段的引用，形成复用链） */
  root: StructureNode;
}

/**
 * 片段库：解析/穿透引用时的上下文。键为片段 key。
 * 浏览器侧是会话当前可见的片段快照；服务端由持久层内容即时构建。
 */
export type FragmentLib = Map<string, FragmentDef>;

/** 引擎层统一错误（带路径，便于定位字段） */
export class SchemaEngineError extends Error {
  path: string;
  constructor(message: string, path = '') {
    super(path ? `${path}: ${message}` : message);
    this.name = 'SchemaEngineError';
    this.path = path;
  }
}

/** 片段相关错误（悬空引用 / 闭环 / 片段定义非法），沿用「非法态」同一通道 */
export class FragmentError extends SchemaEngineError {}

let idCounter = 0;
export function uid(): string {
  idCounter += 1;
  return `f_${Date.now().toString(36)}_${idCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

export const SCALAR_TYPES: FieldType[] = ['string', 'number', 'integer', 'boolean'];
export const ALL_TYPES: FieldType[] = ['string', 'number', 'integer', 'boolean', 'object', 'array'];
