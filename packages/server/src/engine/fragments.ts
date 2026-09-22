/**
 * 可复用结构片段（Fragment）引擎核心。
 *
 * 设计要点：
 *  - 结构模型里节点分两种：内嵌定义（FieldNode）与片段引用（RefNode）。
 *    引用本身「存指针不展开」：解析、序列化、持久化、往返都保留引用；
 *  - 唯一的穿透点是 resolveModel()：控件映射 / 默认值 / 校验都先拿到一份
 *    「按片段当前定义展开」的虚拟视图再复用既有逻辑，展开结果绝不回写模型；
 *  - 片段可再引用片段；闭环引用与悬空引用在片段保存 / 文档保存边界即被
 *    validateFragmentGraph / 解析器拦下，不拖到渲染期；
 *  - 文档回滚时片段可能已被删除：对存活片段的引用保持指针（按当前定义动态
 *    解释），对已归档片段的引用用归档的最后定义就地展开（materializeArchived），
 *    回滚产物因此始终合法、动作本身永不失败。
 */
import {
  FieldNode,
  FragmentDef,
  FragmentError,
  FragmentLib,
  StructureNode,
  isRef,
} from './types';
import { parseSchemaText } from './parser';
import { nodeToSchemaText } from './serialize';

/** 收集一棵结构树中全部片段 key（含重复，顺序即出现顺序） */
export function collectRefs(node: StructureNode | undefined): string[] {
  const out: string[] = [];
  if (!node) return out;
  if (isRef(node)) {
    out.push(node.ref);
    return out;
  }
  for (const child of node.children ?? []) out.push(...collectRefs(child));
  if (node.item) out.push(...collectRefs(node.item));
  return out;
}

/** 在原始 Schema 对象上收集全部 $fragment 引用（持久层扫描引用方用） */
export function collectSchemaRefs(schema: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.$fragment === 'string') {
        out.push(o.$fragment);
        // 引用节点不允许携带其他结构关键字，无需继续深入
        return;
      }
      for (const val of Object.values(o)) walk(val);
    }
  };
  walk(schema);
  return out;
}

export interface FragmentEntry {
  key: string;
  /** 片段 Schema 文本 */
  content: string;
}

export interface BuiltLib {
  lib: FragmentLib;
  /** key -> 该片段自身的问题（内容非法 / 悬空 / 参与闭环） */
  errors: Map<string, string>;
}

/**
 * 由持久层片段内容构建片段库（宽松解析：片段间引用暂不校验存在性），
 * 随后对整张片段引用图做悬空 + 闭环校验。
 */
export function buildFragmentLib(entries: FragmentEntry[]): BuiltLib {
  const lib: FragmentLib = new Map();
  const errors = new Map<string, string>();

  for (const entry of entries) {
    const result = parseSchemaText(entry.content, { lenientRefs: true, rootMustBeObject: false });
    if (!result.ok || !result.model) {
      errors.set(entry.key, `片段「${entry.key}」定义不合法：${result.error ?? '解析失败'}`);
      continue;
    }
    lib.set(entry.key, {
      key: entry.key,
      title: typeof result.schema?.title === 'string' ? result.schema.title : undefined,
      description: typeof result.schema?.description === 'string' ? result.schema.description : undefined,
      root: result.model,
    });
  }

  for (const [key, msg] of validateFragmentGraph(lib)) errors.set(key, msg);
  return { lib, errors };
}

/**
 * 校验整张片段引用图：悬空引用（指向不存在的片段）与闭环引用。
 * 三色 DFS；闭环链路上的每个片段都被标记，保存其中任意一个都会被拒绝。
 *
 * @returns key -> 错误原因（空 Map 表示整图健康）
 */
export function validateFragmentGraph(lib: FragmentLib): Map<string, string> {
  const errors = new Map<string, string>();
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const edgesOf = (key: string): string[] => {
    const def = lib.get(key);
    return def ? collectRefs(def.root) : [];
  };

  const dfs = (key: string): void => {
    color.set(key, GRAY);
    stack.push(key);
    for (const target of edgesOf(key)) {
      if (!lib.has(target)) {
        errors.set(key, `片段「${key}」引用了不存在的片段「${target}」`);
        continue;
      }
      const c = color.get(target) ?? WHITE;
      if (c === GRAY) {
        const start = stack.indexOf(target);
        const cycle = [...stack.slice(start), target];
        const msg = `片段引用不允许形成闭环：${cycle.join(' → ')}`;
        for (const k of cycle) errors.set(k, msg);
      } else if (c === WHITE) {
        dfs(target);
      }
    }
    stack.pop();
    color.set(key, BLACK);
  };

  for (const key of lib.keys()) {
    if ((color.get(key) ?? WHITE) === WHITE) dfs(key);
  }
  return errors;
}

/**
 * 单个片段能否保存：
 * 以「当前库 + 待保存定义」构成临时图，返回该片段视角的错误（闭环/悬空/自身非法）。
 * 其余片段既有的问题不阻塞本次保存（不把无关历史问题算到这次编辑头上）。
 */
export function checkFragmentSave(
  lib: FragmentLib,
  key: string,
  next: StructureNode,
): string | undefined {
  const trial: FragmentLib = new Map(lib);
  trial.set(key, { key, root: next });
  const errors = validateFragmentGraph(trial);
  return errors.get(key);
}

function cloneField(node: FieldNode): FieldNode {
  const clone: FieldNode = { ...node };
  if (node.children) clone.children = node.children.map(cloneStructure);
  if (node.item) clone.item = cloneStructure(node.item);
  return clone;
}

function cloneStructure(node: StructureNode): StructureNode {
  if (isRef(node)) return { ...node };
  return cloneField(node);
}

/**
 * 穿透解析单个节点：把引用替换为片段当前定义的「展开副本」。
 * 每次调用都生成全新副本——同一片段被多处引用时展开为彼此独立的子树，
 * 消费方（控件/校验）对副本的任何读写都不会回伤到片段定义。
 */
export function resolveNode(
  node: StructureNode,
  lib: FragmentLib,
  refStack: string[] = [],
): FieldNode {
  if (!isRef(node)) {
    const clone = cloneField(node);
    clone.children = (node.children ?? []).map((c) => resolveNode(c, lib, refStack));
    if (node.item) clone.item = resolveNode(node.item, lib, refStack);
    return clone;
  }

  const def = lib.get(node.ref);
  if (!def) {
    throw new FragmentError(`引用了不存在的片段「${node.ref}」`);
  }
  if (refStack.includes(node.ref)) {
    throw new FragmentError(
      `片段引用形成闭环：${[...refStack, node.ref].join(' → ')}`,
    );
  }
  const expanded = resolveNode(def.root, lib, [...refStack, node.ref]);
  // 引用处自身的身份与必填覆盖片段定义
  expanded.name = node.name;
  if (node.required !== undefined) expanded.required = node.required;
  return expanded;
}

/**
 * 唯一穿透点：把含引用的文档结构展开为纯 FieldNode 虚拟视图。
 * 控件映射 / 默认值初始化 / 表单校验都基于它运行。
 */
export function resolveModel(root: FieldNode, lib: FragmentLib): FieldNode {
  return resolveNode(root, lib);
}

/** 片段引用的定位描述（引用影响范围展示用） */
export interface RefOccurrence {
  key: string;
  /** 文档/片段内字段路径，如 contacts[].address、$root.zipCode */
  path: string;
}

/** 遍历结构树，列出其中的引用出现位置 */
export function findRefOccurrences(
  node: StructureNode,
  keys?: Set<string>,
  path = '$root',
): RefOccurrence[] {
  const out: RefOccurrence[] = [];
  if (isRef(node)) {
    if (!keys || keys.has(node.ref)) {
      out.push({ key: node.ref, path });
    }
    return out;
  }
  for (const child of node.children ?? []) {
    out.push(...findRefOccurrences(child, keys, child.name === '$item' ? path : `${path}.${child.name}`));
  }
  if (node.item) out.push(...findRefOccurrences(node.item, keys, `${path}[]`));
  return out;
}

/**
 * 回滚专用：存活片段的引用保持为指针；已归档（删除）片段的引用按其最后
 * 定义就地展开为内嵌字段，且递归处理定义内部的引用。产物不再含任何悬空
 * 引用——找不到去处的引用（极端脏数据）直接摘除，保证回滚永不失败。
 *
 * @returns 新树（FieldNode 根；其中可仍含指向存活片段的 RefNode）
 */
export function materializeArchived(
  node: StructureNode,
  live: FragmentLib,
  archived: FragmentLib,
  nameOverride?: string,
  requiredOverride?: boolean,
): StructureNode | undefined {
  if (!isRef(node)) {
    const clone = cloneField(node);
    clone.children = (node.children ?? [])
      .map((c) =>
        materializeArchived(
          c,
          live,
          archived,
          isRef(c) ? c.name : undefined,
          isRef(c) ? c.required : undefined,
        ),
      )
      .filter((c): c is StructureNode => c !== undefined);
    if (node.item) {
      clone.item = materializeArchived(
        node.item,
        live,
        archived,
        isRef(node.item) ? '$item' : undefined,
        isRef(node.item) ? node.item.required : undefined,
      );
    }
    return clone;
  }

  if (live.has(node.ref)) {
    return { ...node, ...(nameOverride !== undefined ? { name: nameOverride } : {}) };
  }

  const tomb = archived.get(node.ref);
  if (!tomb) {
    // 既不存活也无归档：无法解释的悬空引用，摘除（保证结果可解析）
    return undefined;
  }

  const expanded = materializeArchived(tomb.root, live, archived);
  if (!expanded || isRef(expanded)) {
    // 片段根是个指向别的已删片段的引用且展开后仍是引用（无法就地落地）→ 摘除
    return undefined;
  }
  expanded.name = nameOverride ?? node.name;
  expanded.required = requiredOverride ?? node.required ?? expanded.required;
  return expanded;
}

/**
 * 删除片段（detach）专用：从树中摘除指向给定片段集合的引用节点。
 * 对象属性直接移除；数组 item 若就是被删引用，退化为一个普通 string item，
 * 保证序列化结果仍是可解析的同构数组。
 */
export function pruneRefs(root: FieldNode, keys: Set<string>): FieldNode {
  const walkNode = (node: FieldNode): void => {
    node.children = (node.children ?? []).filter((c) => !(isRef(c) && keys.has(c.ref)));
    for (const child of node.children) {
      if (!isRef(child)) walkNode(child);
    }
    if (node.item) {
      if (isRef(node.item) && keys.has(node.item.ref)) {
        node.item = { id: `pruned_${Math.random().toString(36).slice(2, 8)}`, name: '$item', type: 'string' };
      } else if (!isRef(node.item)) {
        walkNode(node.item);
      }
    }
  };
  const clone = cloneField(root);
  walkNode(clone);
  return clone;
}

/**
 * 片段定义剪枝（detach）专用：从任意类型根的片段定义中摘除指向给定集合的引用。
 * 与 pruneRefs 的区别在于根本身可以是引用或数组/标量：根就是被删引用时，
 * 退化为一个普通 string 定义（片段必须仍有合法结构）。
 */
export function pruneFragmentRefs(node: StructureNode, keys: Set<string>): string {
  let root: StructureNode = node;
  if (isRef(root) && keys.has(root.ref)) {
    root = { id: `pruned_${Math.random().toString(36).slice(2, 8)}`, name: '', type: 'string' };
  }
  if (!isRef(root) && root.type === 'object') {
    return nodeToSchemaText(pruneRefs(root, keys));
  }
  if (!isRef(root) && root.type === 'array') {
    const clone = cloneField(root);
    clone.item = pruneItem(clone.item, keys);
    return nodeToSchemaText(clone);
  }
  return nodeToSchemaText(root);
}

function pruneItem(item: StructureNode | undefined, keys: Set<string>): StructureNode {
  if (item && isRef(item) && keys.has(item.ref)) {
    return { id: `pruned_${Math.random().toString(36).slice(2, 8)}`, name: '$item', type: 'string' };
  }
  if (item && !isRef(item) && item.type === 'object') return pruneRefs(item, keys);
  return item ?? { id: `pruned_${Math.random().toString(36).slice(2, 8)}`, name: '$item', type: 'string' };
}
