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
  FragmentLib,
  JsonSchemaObject,
  JsonValue,
  ParseResult,
  RefNode,
  SchemaEngineError,
  StructureNode,
  createRefNode,
  isField,
  isRef,
  uid,
} from './types';

const SUPPORTED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);

export interface ParseOptions {
  /**
   * 片段库：默认 undefined（兼容老行为）。提供时，$fragment 引用会按库解析，
   * 并在此处完成悬空 / 闭环检查（片段定义自身非法同样拒绝）。
   */
  lib?: FragmentLib;
  /**
   * 宽松模式：$fragment 引用不要求目标存在（构建片段库 / 校验片段保存时用，
   * 悬空与闭环交给 validateFragmentGraph 统一判定）。
   */
  lenientRefs?: boolean;
  /**
   * 已知的片段图问题（key -> 原因，由 buildFragmentGraph/validateFragmentGraph 产出）。
   * 严格解析文档时，只要文档引用到了问题片段（直接或间接），即判为非法：
   * 闭环/悬空/片段定义非法一律挡在持久化与解析边界，不拖到渲染期。
   */
  fragmentErrors?: Map<string, string>;
  /** 根节点是否必须是 object（文档 true；片段定义可任意类型） */
  rootMustBeObject?: boolean;
}

/** 引用节点唯一允许的键 */
const REF_ONLY = new Set(['$fragment']);

/** 片段 key 规则：字母/数字/下划线/中划线，中划线不得开头 */
const FRAGMENT_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

/**
 * 严格解析时递归验证片段定义内部的引用：目标须存在且不闭环。
 * 片段定义自身的结构在入库解析时已校验，这里只查其引用可达性。
 */
function resolveFragmentDef(def: { root: StructureNode }, opts: ParseOptions, stack: string[]): void {
  const lib = opts.lib;
  if (!lib) return;
  const walk = (n: StructureNode, chain: string[]): void => {
    if (isRef(n)) {
      const graphProblem = opts.fragmentErrors?.get(n.ref);
      if (graphProblem) {
        throw new SchemaEngineError(`引用的片段「${n.ref}」当前不可用：${graphProblem}`);
      }
      const target = lib.get(n.ref);
      if (!target) {
        if (!opts.lenientRefs) {
          throw new SchemaEngineError(
            `片段「${chain[0]}」的定义引用了不存在的片段「${n.ref}」`,
          );
        }
        return;
      }
      if (chain.includes(n.ref)) {
        throw new SchemaEngineError(`片段引用形成闭环：${[...chain, n.ref].join(' → ')}`);
      }
      walk(target.root, [...chain, n.ref]);
      return;
    }
    for (const c of n.children ?? []) walk(c, chain);
    if (n.item) walk(n.item, chain);
  };
  walk(def.root, stack);
}

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

function convertSchema(
  schema: JsonSchemaObject,
  name: string,
  path: string,
  opts: ParseOptions,
  refStack: string[] = [],
): StructureNode {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new SchemaEngineError('Schema 节点必须是 JSON 对象', path);
  }

  // 片段引用：{"$fragment": "key"} —— 解析为引用节点，绝不就地展开
  if (typeof schema.$fragment === 'string') {
    for (const k of Object.keys(schema)) {
      if (!REF_ONLY.has(k)) {
        throw new SchemaEngineError(
          `$fragment 引用节点不允许同时携带「${k}」等其他定义（引用只是一条指向片段的链路）`,
          path,
        );
      }
    }
    const key = schema.$fragment;
    if (!FRAGMENT_KEY_RE.test(key)) {
      throw new SchemaEngineError(
        `非法片段 key「${key}」（字母/数字/下划线/中划线，且不以中划线开头）`,
        path,
      );
    }
    const node = createRefNode(key, name);

    // 引用目标（或其依赖链）在片段图中已被标记问题：闭环 / 悬空 / 定义非法。
    // 坏片段不会进入 lib，因此该检查必须先于 lib 查找。
    const graphProblem = opts.fragmentErrors?.get(key);
    if (graphProblem) {
      throw new SchemaEngineError(`引用的片段「${key}」当前不可用：${graphProblem}`, path);
    }

    const def = opts.lib?.get(key);
    if (def) {
      if (refStack.includes(key)) {
        throw new SchemaEngineError(
          `片段引用形成闭环：${[...refStack, key].join(' → ')}`,
          path,
        );
      }
      // 穿透校验片段定义当前是否合法（定义内部的引用一并递归验证）
      resolveFragmentDef(def, opts, [...refStack, key]);
    } else if (opts.lib && !opts.lenientRefs) {
      throw new SchemaEngineError(`引用了不存在的片段「${key}」`, path);
    }
    return node;
  } else if (schema.$fragment !== undefined) {
    throw new SchemaEngineError('$fragment 必须是字符串（片段 key）', path);
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
      const child = convertSchema(rawSub, key, path ? `${path}.${key}` : key, opts, refStack);
      // 引用节点：缺省（undefined）表示必填性取片段定义，仅在显式 required 时覆盖
      if (required.has(key)) child.required = true;
      return child;
    });
    return node;
  }

  if (type === 'array') {
    if (!isSchemaObject(schema.items)) {
      throw new SchemaEngineError('数组必须声明 items（本工具支持同构数组）', path);
    }
    node.item = convertSchema(schema.items, '$item', `${path}[]`, opts, refStack);
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

/** 解析 Schema 文本；非法时返回结构化错误（不抛异常） */
export function parseSchemaText(text: string, options: ParseOptions = {}): ParseResult {
  const opts: ParseOptions = { rootMustBeObject: true, ...options };
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
    const rootIsRef = typeof json.$fragment === 'string';
    if (opts.rootMustBeObject && !rootIsRef && rootType !== undefined && rootType !== 'object') {
      return fail(`根 Schema 的 type 必须是 object（当前为「${String(rootType)}」）`);
    }
    const model = convertSchema(json, '', '', opts) as FieldNode;
    if (opts.rootMustBeObject && !isRef(model) && model.type !== 'object') {
      return fail('根 Schema 必须是 object 类型');
    }
    return { ok: true, model, schema: json };
  } catch (e) {
    if (e instanceof SchemaEngineError) return fail(e.message);
    return fail(`解析失败: ${(e as Error).message}`);
  }
}

/** 由已解析的 Schema 对象构建模型（受信调用方使用；不校验片段引用；根须为 object） */
export function schemaToModel(schema: JsonSchemaObject): FieldNode {
  const result = parseSchemaText(JSON.stringify(schema));
  if (!result.ok || !result.model) throw new SchemaEngineError(result.error ?? '解析失败');
  return result.model as FieldNode;
}
