/**
 * JSON Schema 文本 -> 结构模型（schemaToModel）。
 *
 * 关键容错：parseSchemaText 永不抛异常。文本不是合法 JSON 或不是受支持的
 * Schema 子集时返回 { ok:false, error, line, column }，调用方据此让可视化区
 * 停留在「最近一次合法状态」，并在文本区展示原因。
 */
import {
  FieldNode,
  FieldType,
  JsonSchemaObject,
  JsonValue,
  ParseResult,
  SchemaEngineError,
  uid,
} from './types';
import { FragmentLibrary, parseRef, validateRefs } from './fragments';

const SUPPORTED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);

function isSchemaObject(v: unknown): v is JsonSchemaObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(error: string, line?: number, column?: number): ParseResult {
  return { ok: false, error, line, column };
}

/** 从 JSON.parse 异常文本中提取行列位置（V8: "... at position N"） */
function locateJsonError(text: string, err: unknown): { line?: number; column?: number } {
  const msg = (err as Error)?.message ?? '';
  const m = msg.match(/position (\d+)/);
  if (!m) return {};
  const pos = Number(m[1]);
  const before = text.slice(0, pos);
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function inferType(schema: JsonSchemaObject, path: string): FieldType | null {
  if (typeof schema.type === 'string') {
    if (!SUPPORTED_TYPES.has(schema.type)) {
      throw new SchemaEngineError(`不支持的类型「${schema.type}」（支持 string/number/integer/boolean/object/array）`, path);
    }
    return schema.type as FieldType;
  }
  // 无 type 时按关键字推断
  if (isSchemaObject(schema.properties)) return 'object';
  if (isSchemaObject(schema.items)) return 'array';
  if (Array.isArray(schema.enum)) {
    const t = typeof schema.enum[0];
    if (schema.enum.every((v) => typeof v === t)) {
      if (t === 'string') return 'string';
      if (t === 'number') return 'number';
      if (t === 'boolean') return 'boolean';
    }
    throw new SchemaEngineError('枚举值类型不一致，且未声明 type', path);
  }
  if (schema.default !== undefined) {
    const t = typeof schema.default;
    if (t === 'string') return 'string';
    if (t === 'number') return 'number';
    if (t === 'boolean') return 'boolean';
    if (t === 'object') {
      return Array.isArray(schema.default) ? 'array' : 'object';
    }
  }
  return null;
}

function readInt(v: JsonValue | undefined, keyword: string, path: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new SchemaEngineError(`关键字 ${keyword} 必须是数字`, path);
  }
  return v;
}

function validateEnum(values: JsonValue[], type: FieldType, path: string): (string | number | boolean)[] {
  if (values.length === 0) throw new SchemaEngineError('enum 至少包含一个取值', path);
  const out: (string | number | boolean)[] = [];
  for (const v of values) {
    if (v === null || (typeof v === 'object')) {
      throw new SchemaEngineError('枚举值暂只支持字符串/数值/布尔', path);
    }
    if (typeof v !== type && !(type === 'integer' && Number.isInteger(v))) {
      throw new SchemaEngineError(`枚举值「${String(v)}」与声明类型 ${type} 不匹配`, path);
    }
    if (type === 'integer' && !Number.isInteger(v)) {
      throw new SchemaEngineError(`枚举值「${String(v)}」不是整数`, path);
    }
    out.push(v);
  }
  return out;
}

function checkDefault(d: JsonValue, type: FieldType, path: string): string | number | boolean {
  const t = typeof d;
  if (type === 'string') {
    if (t !== 'string') throw new SchemaEngineError('default 必须是字符串', path);
    return d as string;
  }
  if (type === 'number' || type === 'integer') {
    if (t !== 'number') throw new SchemaEngineError('default 必须是数值', path);
    if (type === 'integer' && !Number.isInteger(d as number)) {
      throw new SchemaEngineError('default 必须是整数', path);
    }
    return d as number;
  }
  if (type === 'boolean') {
    if (t !== 'boolean') throw new SchemaEngineError('default 必须是布尔值', path);
    return d as boolean;
  }
  throw new SchemaEngineError('对象/数组类型不支持默认值编辑', path);
}

function convertSchema(schema: JsonSchemaObject, name: string, path: string): FieldNode {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new SchemaEngineError('Schema 节点必须是 JSON 对象', path);
  }

  // 片段引用节点：`{ "$ref": "fragment:xxx" }`（引用处仅可附 title/description）
  if (schema.$ref !== undefined) {
    const refName = parseRef(schema.$ref);
    if (!refName) {
      throw new SchemaEngineError(
        `非法 $ref「${schema.$ref}」：引用片段必须写作 fragment:片段名`,
        path,
      );
    }
    const allowed = new Set(['$ref', 'title', 'description']);
    const illegal = Object.keys(schema).filter((k) => !allowed.has(k));
    if (illegal.length > 0) {
      throw new SchemaEngineError(
        `片段引用「${refName}」处不能再声明 ${illegal.join('、')}（约束统一由片段定义）`,
        path,
      );
    }
    const refNode: FieldNode = { id: uid(), name, ref: refName };
    if (typeof schema.title === 'string') refNode.title = schema.title;
    if (typeof schema.description === 'string') refNode.description = schema.description;
    return refNode;
  }

  const type = inferType(schema, path);
  if (!type) {
    throw new SchemaEngineError('无法确定字段类型：请声明 type，或提供 properties/items/enum/default', path || name);
  }

  const node: FieldNode = { id: uid(), name, type };
  if (typeof schema.title === 'string') node.title = schema.title;
  if (typeof schema.description === 'string') node.description = schema.description;

  if (type === 'object') {
    const properties = schema.properties;
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const r of required) {
      if (typeof r !== 'string') throw new SchemaEngineError('required 必须是字符串数组', path);
      if (!isSchemaObject(properties) || !(r in properties)) {
        throw new SchemaEngineError(`required 中的字段「${r}」未在 properties 中声明`, path);
      }
    }
    if (!isSchemaObject(properties)) {
      if (properties !== undefined) throw new SchemaEngineError('properties 必须是对象', path);
      node.children = [];
      return node;
    }
    node.children = Object.entries(properties).map(([key, rawSub]) => {
      if (!/^[A-Za-z_$][\w$]*$|^\S+$/.test(key) || key.length === 0) {
        throw new SchemaEngineError(`非法字段名「${key}」`, path);
      }
      if (!isSchemaObject(rawSub)) {
        throw new SchemaEngineError(`字段「${key}」的 Schema 必须是对象`, path);
      }
      const child = convertSchema(rawSub, key, path ? `${path}.${key}` : key);
      child.required = required.has(key);
      return child;
    });
    return node;
  }

  if (type === 'array') {
    if (!isSchemaObject(schema.items)) {
      throw new SchemaEngineError('数组必须声明 items（本工具支持同构数组）', path);
    }
    node.item = convertSchema(schema.items, `${name}[]`, `${path}[]`);
    return node;
  }

  // 标量字段约束
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) throw new SchemaEngineError('enum 必须是数组', path);
    node.enum = validateEnum(schema.enum, type, path);
  }
  if (schema.default !== undefined) {
    node.default = checkDefault(schema.default, type, path);
  }
  if (type === 'string') {
    node.minLength = readNonNegativeInt(schema.minLength, 'minLength', path);
    node.maxLength = readNonNegativeInt(schema.maxLength, 'maxLength', path);
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== 'string') throw new SchemaEngineError('pattern 必须是字符串', path);
      try {
        // eslint-disable-next-line no-new
        new RegExp(schema.pattern);
      } catch (e) {
        throw new SchemaEngineError(`pattern 不是合法正则: ${(e as Error).message}`, path);
      }
      node.pattern = schema.pattern;
    }
    if (node.minLength !== undefined && node.maxLength !== undefined && node.minLength > node.maxLength) {
      throw new SchemaEngineError('minLength 不能大于 maxLength', path);
    }
  }
  if (type === 'number' || type === 'integer') {
    node.minimum = readInt(schema.minimum, 'minimum', path);
    node.maximum = readInt(schema.maximum, 'maximum', path);
    if (node.minimum !== undefined && node.maximum !== undefined && node.minimum > node.maximum) {
      throw new SchemaEngineError('minimum 不能大于 maximum', path);
    }
  }
  return node;
}

function readNonNegativeInt(v: JsonValue | undefined, keyword: string, path: string): number | undefined {
  const n = readInt(v, keyword, path);
  if (n !== undefined && (n < 0 || !Number.isInteger(n))) {
    throw new SchemaEngineError(`${keyword} 必须是非负整数`, path);
  }
  return n;
}

export interface ParseOptions {
  /**
   * 片段库。提供时校验文档中的 $ref（悬空/闭环 -> ok:false，归入非法态）。
   * 不传则只做结构解析，不解析引用目标（供片段定义本身在入库前解析使用）。
   */
  library?: FragmentLibrary;
  /** 为 true 时允许根节点为任意类型（片段定义可以是标量/数组）；默认根必须是 object */
  allowNonObjectRoot?: boolean;
}

/** 解析 Schema 文本；非法时返回结构化错误（不抛异常） */
export function parseSchemaText(text: string, options: ParseOptions = {}): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) return fail('Schema 内容为空');
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (e) {
    const { line, column } = locateJsonError(text, e);
    return fail(`JSON 语法错误: ${(e as Error).message}`, line, column);
  }
  if (!isSchemaObject(json)) {
    return fail('Schema 顶层必须是 JSON 对象 {}');
  }
  try {
    const rootType = json.type;
    if (json.$ref !== undefined && options.allowNonObjectRoot && rootType === undefined) {
      return fail('片段定义必须直接声明结构（根节点不能只是 $ref 引用）');
    }
    if (!options.allowNonObjectRoot && json.$ref === undefined && rootType !== undefined && rootType !== 'object') {
      return fail(`根 Schema 的 type 必须是 object（当前为「${String(rootType)}」）`);
    }
    const model = convertSchema(json, '', '');
    if (options.library) {
      const issues = validateRefs(model, options.library);
      if (issues.length > 0) return fail(issues.map((i) => i.message).join('；'));
    }
    return { ok: true, model, schema: json };
  } catch (e) {
    if (e instanceof SchemaEngineError) return fail(e.message);
    return fail(`解析失败: ${(e as Error).message}`);
  }
}

/** 由已解析的 Schema 对象构建模型（受信调用方使用）；默认不校验片段引用 */
export function schemaToModel(schema: JsonSchemaObject, options: ParseOptions = {}): FieldNode {
  const result = parseSchemaText(JSON.stringify(schema), options);
  if (!result.ok || !result.model) throw new SchemaEngineError(result.error ?? '解析失败');
  return result.model;
}
