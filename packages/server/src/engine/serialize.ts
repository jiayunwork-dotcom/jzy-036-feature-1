/**
 * 结构模型 -> JSON Schema（modelToSchema）。
 * 输出字段顺序固定，保证「结构 -> 文本 -> 再解析」往返结果稳定可比较。
 */
import { FieldNode, FieldType, JsonSchemaObject, SchemaEngineError } from './types';
import { REF_PREFIX, isRefNode } from './fragments';

function assignScalarConstraints(schema: JsonSchemaObject, node: FieldNode): void {
  if (node.type === 'string') {
    if (typeof node.minLength === 'number' && Number.isFinite(node.minLength)) schema.minLength = node.minLength;
    if (typeof node.maxLength === 'number' && Number.isFinite(node.maxLength)) schema.maxLength = node.maxLength;
    if (node.pattern !== undefined && node.pattern !== '') schema.pattern = node.pattern;
  }
  if (node.type === 'number' || node.type === 'integer') {
    if (typeof node.minimum === 'number' && Number.isFinite(node.minimum)) schema.minimum = node.minimum;
    if (typeof node.maximum === 'number' && Number.isFinite(node.maximum)) schema.maximum = node.maximum;
  }
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    schema.enum = [...node.enum];
  }
  if (node.default !== undefined && node.default !== '') {
    schema.default = node.default;
  }
}

function convertNode(node: FieldNode, path: string): JsonSchemaObject {
  if (!node || typeof node !== 'object') {
    throw new SchemaEngineError('字段节点不是对象', path);
  }
  // 引用节点：原样输出为 $ref 链路，绝不把片段内容抄展开
  if (isRefNode(node)) {
    const schema: JsonSchemaObject = { $ref: `${REF_PREFIX}${node.ref}` };
    if (node.title) schema.title = node.title;
    if (node.description) schema.description = node.description;
    return schema;
  }
  if (!node.type || !ALL_TYPES.includes(node.type)) {
    throw new SchemaEngineError(`未知字段类型「${String(node.type)}」`, path || node.name);
  }
  if (node.pattern) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(node.pattern);
    } catch (e) {
      throw new SchemaEngineError(`正则表达式无效: ${(e as Error).message}`, path || node.name);
    }
  }
  checkRange(node, path);

  const schema: JsonSchemaObject = {};
  if (node.title) schema.title = node.title;
  if (node.description) schema.description = node.description;

  if (node.type === 'object') {
    schema.type = 'object';
    const properties: Record<string, JsonSchemaObject> = {};
    const required: string[] = [];
    for (const child of node.children ?? []) {
      if (!child.name) throw new SchemaEngineError('对象属性缺少字段名', path);
      if (Object.prototype.hasOwnProperty.call(properties, child.name)) {
        throw new SchemaEngineError(`字段名「${child.name}」在同一对象下重复`, path);
      }
      properties[child.name] = convertNode(child, path ? `${path}.${child.name}` : child.name);
      if (child.required) required.push(child.name);
    }
    if (Object.keys(properties).length > 0) schema.properties = properties;
    if (required.length > 0) schema.required = required;
    return schema;
  }

  if (node.type === 'array') {
    schema.type = 'array';
    if (node.item) {
      schema.items = convertNode(node.item, `${path}[]`);
    } else {
      schema.items = {};
    }
    return schema;
  }

  schema.type = node.type;
  assignScalarConstraints(schema, node);
  return schema;
}

function checkRange(node: FieldNode, path: string): void {
  const p = path || node.name;
  if (node.type === 'string' && node.minLength !== undefined && node.maxLength !== undefined) {
    if (node.minLength > node.maxLength) {
      throw new SchemaEngineError('minLength 不能大于 maxLength', p);
    }
  }
  if ((node.type === 'number' || node.type === 'integer') && node.minimum !== undefined && node.maximum !== undefined) {
    if (node.minimum > node.maximum) {
      throw new SchemaEngineError('minimum 不能大于 maximum', p);
    }
  }
  if (node.type !== 'string') {
    if (node.minLength !== undefined || node.maxLength !== undefined || node.pattern !== undefined) {
      // 模型在切换类型时会清理，但此处做一道防线
      throw new SchemaEngineError('长度/正则约束只允许出现在 string 字段上', p);
    }
  }
  if (node.type !== 'number' && node.type !== 'integer') {
    if (node.minimum !== undefined || node.maximum !== undefined) {
      throw new SchemaEngineError('最小/最大值只允许出现在 number/integer 字段上', p);
    }
  }
}

const ALL_TYPES: FieldType[] = ['string', 'number', 'integer', 'boolean', 'object', 'array'];

/** 将结构模型转换为 JSON Schema 对象（根必须是 object） */
export function modelToSchema(root: FieldNode): JsonSchemaObject {
  if (!root || root.type !== 'object') {
    throw new SchemaEngineError('根节点必须是 object 类型');
  }  const schema = convertNode(root, '');
  if (root.title) schema.title = root.title;
  if (root.description) schema.description = root.description;
  return schema;
}

/** 序列化为格式化文本（根为 object） */
export function modelToSchemaText(root: FieldNode, indent = 2): string {
  return JSON.stringify(modelToSchema(root), null, indent) + '\n';
}

/** 片段定义专用：根可以是任意受支持类型（片段不要求是 object），但根本身必须是直接定义 */
export function modelToSchemaTextAny(root: FieldNode, indent = 2): string {
  if (!root.type || !ALL_TYPES.includes(root.type)) {
    throw new SchemaEngineError(`未知字段类型「${String(root.type)}」`);
  }
  checkRange(root, '');
  return JSON.stringify(convertNode(root, ''), null, indent) + '\n';
}
