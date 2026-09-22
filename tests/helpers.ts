/**
 * 工具：深比较两份 Schema（忽略键顺序），并剥离结构模型上的会话态 id。
 */
import { FieldNode, JsonSchemaObject } from '@engine/types';

export function stripIds(node: any): any {
  if (Array.isArray(node)) return node.map(stripIds);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'id') continue;
      out[k] = stripIds(v);
    }
    return out;
  }
  return node;
}

/** 规范化模型（剥 id、去掉值为 undefined 的键），便于语义比较 */
export function canonicalModel(node: FieldNode): unknown {
  return stripIds(JSON.parse(JSON.stringify(node)));
}

/** 比较两个模型在剥离 id 后语义相同 */
export function sameModel(a: FieldNode, b: FieldNode): boolean {
  return JSON.stringify(canonicalModel(a)) === JSON.stringify(canonicalModel(b));
}

/** 比较两份 schema JSON 语义相同（忽略键顺序） */
export function sameSchema(a: JsonSchemaObject, b: JsonSchemaObject): boolean {
  return stable(a) === stable(b);
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
