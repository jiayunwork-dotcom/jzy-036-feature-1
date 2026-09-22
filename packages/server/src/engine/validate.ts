/**
 * 预览表单数据初始化与约束校验（validate）。
 * 校验按结构模型（即合法 Schema 的等价表达）执行，返回定位到字段路径的错误。
 */
import { FieldNode, JsonValue } from './types';

export type PathSeg = string | number;

export interface FieldError {
  path: PathSeg[];
  /** 形如 contacts.0.phone 的定位串 */
  loc: string;
  message: string;
}

export type FormData = Record<string, JsonValue | undefined>;

export function formatLoc(path: PathSeg[]): string {
  return path
    .map((p) => (typeof p === 'number' ? `[${p}]` : String(p)))
    .join('.')
    .replace(/\.\[/g, '[');
}

function labelOf(node: FieldNode): string {
  return node.title || node.name || '字段';
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

function err(node: FieldNode, path: PathSeg[], message: string): FieldError {
  return { path, loc: formatLoc(path), message: `${labelOf(node)}：${message}` };
}

export function deepGet(data: unknown, path: PathSeg[]): unknown {
  let cur: unknown = data;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

export function deepSet(data: Record<string, unknown>, path: PathSeg[], value: unknown): void {
  let cur: Record<string, unknown> = data;
  for (let i = 0; i < path.length - 1; i += 1) {
    const seg = path[i];
    const next = cur[seg];
    if (next === null || typeof next !== 'object') {
      const key = path[i + 1];
      cur[seg] = typeof key === 'number' ? [] : {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[path[path.length - 1] as string] = value;
}

/** 依据默认值初始化一份表单数据（布尔缺省 false，数组缺省空数组） */
export function initData(node: FieldNode): JsonValue | undefined {
  if (node.type === 'object') {
    const obj: Record<string, JsonValue> = {};
    for (const child of node.children ?? []) {
      const v = initData(child);
      if (v !== undefined) obj[child.name] = v;
    }
    return obj;
  }
  if (node.type === 'array') {
    return [];
  }
  if (node.type === 'boolean') return node.default !== undefined ? node.default : false;
  if (node.default !== undefined) return node.default;
  return undefined;
}

/** 新增一个数组项时使用的空数据（带默认值） */
export function initItemData(item: FieldNode): JsonValue {
  const v = initData(item);
  return (v ?? {}) as JsonValue;
}

function validateNode(node: FieldNode, value: unknown, path: PathSeg[], errors: FieldError[]): void {
  const required = !!node.required;

  if (node.type === 'object') {
    const obj = (value ?? {}) as Record<string, unknown>;
    if (required && Object.keys(obj).length === 0) {
      errors.push(err(node, path, '该分组为必填，请至少填写其中字段'));
    }
    for (const child of node.children ?? []) {
      validateNode(child, obj[child.name], [...path, child.name], errors);
    }
    return;
  }

  if (node.type === 'array') {
    const arr = Array.isArray(value) ? value : [];
    if (required && arr.length === 0) {
      errors.push(err(node, path, '至少添加一项'));
    }
    if (node.item) {
      arr.forEach((item, i) => validateNode(node.item as FieldNode, item, [...path, i], errors));
    }
    return;
  }

  if (isEmpty(value)) {
    if (required) errors.push(err(node, path, '该字段为必填项'));
    return; // 非必填的空值跳过后续约束
  }

  if (node.type === 'boolean') {
    if (typeof value !== 'boolean') {
      errors.push(err(node, path, '必须是布尔值'));
    } else if (required && value === false) {
      errors.push(err(node, path, '必须勾选'));
    }
    return;
  }

  if (node.type === 'string') {
    const s = typeof value === 'string' ? value : String(value);
    if (node.enum && !node.enum.includes(s)) {
      errors.push(err(node, path, '取值不在允许的枚举范围内'));
    }
    const len = Array.from(s).length;
    if (node.minLength !== undefined && len < node.minLength) {
      errors.push(err(node, path, `长度不能少于 ${node.minLength} 个字符（当前 ${len}）`));
    }
    if (node.maxLength !== undefined && len > node.maxLength) {
      errors.push(err(node, path, `长度不能超过 ${node.maxLength} 个字符（当前 ${len}）`));
    }
    if (node.pattern) {
      try {
        if (!new RegExp(node.pattern).test(s)) {
          errors.push(err(node, path, '格式不符合要求的正则模式'));
        }
      } catch {
        errors.push(err(node, path, 'Schema 中配置的正则无效'));
      }
    }
    return;
  }

  // number / integer
  let n: number;
  if (typeof value === 'number') n = value;
  else {
    n = Number(value);
  }
  if (!Number.isFinite(n)) {
    errors.push(err(node, path, '请输入有效数字'));
    return;
  }
  if (node.type === 'integer' && !Number.isInteger(n)) {
    errors.push(err(node, path, '必须是整数'));
  }
  if (node.minimum !== undefined && n < node.minimum) {
    errors.push(err(node, path, `不能小于 ${node.minimum}`));
  }
  if (node.maximum !== undefined && n > node.maximum) {
    errors.push(err(node, path, `不能大于 ${node.maximum}`));
  }
  if (node.enum && !node.enum.includes(n)) {
    errors.push(err(node, path, '取值不在允许的枚举范围内'));
  }
}

/** 校验整份表单数据；返回所有违例（按字段路径定位），空数组表示通过 */
export function validateForm(root: FieldNode, data: FormData): FieldError[] {
  if (root.type !== 'object') return [{ path: [], loc: '', message: '根节点必须是 object' }];
  const errors: FieldError[] = [];
  for (const child of root.children ?? []) {
    validateNode(child, (data as Record<string, unknown>)[child.name], [child.name], errors);
  }
  return errors;
}

/** 只校验单个字段（失焦时实时提示用） */
export function validateField(root: FieldNode, data: FormData, path: PathSeg[]): FieldError[] {
  const all = validateForm(root, data);
  const prefix = formatLoc(path);
  return all.filter((e) => e.loc === prefix || e.loc.startsWith(`${prefix}[`) || e.loc.startsWith(`${prefix}.`));
}
