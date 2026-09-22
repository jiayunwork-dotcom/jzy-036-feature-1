/**
 * 可复用结构片段（Fragment）核心。
 *
 * 片段是独立命名、独立管理、独立留版本历史的「结构片段定义」：
 *  - 结构模型中的引用节点（FieldNode.ref）通过片段名指向这里的某个根节点；
 *  - 引用不是复制品：序列化/持久化保留 $ref 链路，只有控件映射与表单校验
 *    在运行时按片段「当前」定义即时穿透展开（expandNode）；
 *  - 片段可以再引用别的片段（公司地址 -> 省市区），但片段图不允许闭环，
 *    闭环与悬空引用在「片段保存 / 引用关系建立」的边界即被认出并拒绝。
 */
import { FieldNode, FieldType, SchemaEngineError, uid } from './types';

/** 片段库：片段名 -> 片段根节点（根的 name 固定为 ''） */
export type FragmentLibrary = Record<string, FieldNode>;

export const REF_PREFIX = 'fragment:';

/** 片段名规则：字母/下划线开头，字母数字下划线/中划线组成（身份标识，不可改名） */
const FRAGMENT_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

export function isValidFragmentName(name: string): boolean {
  return FRAGMENT_NAME_RE.test(name);
}

/** 把文本中的 `fragment:xxx` 还原成片段名；非法返回 null */
export function parseRef(ref: string): string | null {
  if (typeof ref !== 'string' || !ref.startsWith(REF_PREFIX)) return null;
  const name = ref.slice(REF_PREFIX.length);
  return isValidFragmentName(name) ? name : null;
}

export function formatRef(name: string): string {
  return REF_PREFIX + name;
}

/** 判断是否为引用节点（结构模型同时表达「内嵌定义」与「引用他处定义」的分界） */
export function isRefNode(node: FieldNode | undefined | null): node is FieldNode & { ref: string } {
  return !!node && typeof node.ref === 'string' && node.ref.length > 0;
}

/* ------------------------------------------------------------------ */
/* 引用收集 / 闭环检测                                                  */
/* ------------------------------------------------------------------ */

export interface RefOccurrence {
  /** 被引用的片段名 */
  target: string;
  /** 引用在该结构中的字段路径（点/方括号形式，如 contacts[0].phone） */
  path: string;
}

/** 收集一个结构模型（文档或片段定义）中出现的全部片段引用 */
export function collectRefs(root: FieldNode, basePath = ''): RefOccurrence[] {
  const out: RefOccurrence[] = [];
  const segOf = (name: string): string =>
    name === '$item' ? '[]' : /^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `.${JSON.stringify(name)}`;

  const visit = (node: FieldNode, path: string): void => {
    if (isRefNode(node)) {
      out.push({ target: node.ref, path });
      return; // 引用节点内不允许再内嵌结构
    }
    node.children?.forEach((c) => visit(c, path + segOf(c.name)));
    if (node.item) visit(node.item, `${path}[]`);
  };

  // 根路径不显示前导点
  if (isRefNode(root)) {
    out.push({ target: root.ref, path: basePath });
    return out;
  }
  root.children?.forEach((c) => {
    const head = c.name === '$item' ? '[]' : c.name;
    visit(c, basePath ? `${basePath}${segOf(c.name)}` : head);
  });
  if (root.item) visit(root.item, basePath ? `${basePath}[]` : '[]');
  return out;
}

export interface GraphIssue {
  kind: 'dangling' | 'cycle';
  /** 出问题的引用所在片段名（片段图校验时）；文档引用校验时可能为空 */
  source?: string;
  target: string;
  /** 闭环链路（仅 cycle） */
  chain?: string[];
  message: string;
}

/**
 * 校验整个片段图：找出悬空引用（指向不存在片段）与闭环引用。
 * 闭环检测在「片段保存」边界运行，保证运行时展开永远不会死循环。
 */
export function validateFragmentGraph(library: FragmentLibrary): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const names = new Set(Object.keys(library));

  for (const [name, root] of Object.entries(library)) {
    for (const occ of collectRefs(root)) {
      if (!names.has(occ.target)) {
        issues.push({
          kind: 'dangling',
          source: name,
          target: occ.target,
          message: `片段「${name}」引用了不存在的片段「${occ.target}」（位置 ${occ.path || '根'}）`,
        });
      }
    }
  }

  // DFS 闭环检测：从每个片段出发沿引用边压栈，遇到栈内节点即闭环
  const cyclic = new Set<string>();
  for (const start of names) {
    const stack: string[] = [];
    const onStack = new Set<string>();
    const dfs = (name: string): boolean => {
      if (onStack.has(name)) {
        const i = stack.indexOf(name);
        const chain = [...stack.slice(i), name];
        issues.push({
          kind: 'cycle',
          source: start,
          target: name,
          chain,
          message: `片段之间存在闭环引用：${chain.join(' -> ')}`,
        });
        return true;
      }
      const root = library[name];
      if (!root) return false; // 悬空已在上面报告
      stack.push(name);
      onStack.add(name);
      let found = false;
      for (const occ of collectRefs(root)) {
        if (names.has(occ.target) && dfs(occ.target)) found = true;
      }
      stack.pop();
      onStack.delete(name);
      return found;
    };
    if (dfs(start)) cyclic.add(start);
  }
  return issues;
}

/**
 * 保存/更新单个片段前的定向校验：只关心从该片段出发能否到达自己（闭环）
 * 以及它自己是否悬空引用。existing 为更新前的库（不含待保存片段时即新建）。
 */
export function checkSaveFragment(
  name: string,
  definition: FieldNode,
  library: FragmentLibrary,
): GraphIssue[] {
  const candidate: FragmentLibrary = { ...library, [name]: definition };
  // 只保留从目标片段可达路径上的问题，其他片段的旧账不在本次保存的拒绝范围
  const reachable = new Set<string>([name]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of [...reachable]) {
      const root = candidate[n];
      if (!root) continue;
      for (const occ of collectRefs(root)) {
        if (!reachable.has(occ.target)) {
          reachable.add(occ.target);
          changed = true;
        }
      }
    }
  }
  return validateFragmentGraph(candidate).filter(
    (issue) =>
      reachable.has(issue.target) &&
      (issue.kind === 'cycle' || (issue.kind === 'dangling' && issue.source === name)),
  );
}

/** 校验一个使用者（文档/片段）的引用：悬空或落进闭环都给出错误 */
export function validateRefs(root: FieldNode, library: FragmentLibrary): GraphIssue[] {
  const graphIssues = validateFragmentGraph(library);
  const cyclicNodes = new Set<string>();
  for (const iss of graphIssues) {
    if (iss.kind === 'cycle') iss.chain?.forEach((n) => cyclicNodes.add(n));
  }
  const issues: GraphIssue[] = [];
  for (const occ of collectRefs(root)) {
    if (!library[occ.target]) {
      issues.push({
        kind: 'dangling',
        target: occ.target,
        message: `引用了不存在的片段「${occ.target}」（位置 ${occ.path || '根'}）`,
      });
    } else if (cyclicNodes.has(occ.target)) {
      issues.push({
        kind: 'cycle',
        target: occ.target,
        message: `引用的片段「${occ.target}」处于闭环引用链中（位置 ${occ.path || '根'}）`,
      });
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* 展开：引用 -> 片段当前定义（控件映射 / 校验 / 预览专用）               */
/* ------------------------------------------------------------------ */

/** 深拷贝一个节点并重新分配会话态 id（展开后的树独立于片段定义，可安全渲染） */
function cloneWithNewIds(node: FieldNode): FieldNode {
  const copy: FieldNode = { id: uid(), name: node.name };
  for (const [k, v] of Object.entries(node)) {
    if (k === 'id' || k === 'name') continue;
    if ((k === 'children' || k === 'item') && v) {
      // 只有 children/item 承载字段节点；enum/default 等原样拷贝
      (copy as unknown as Record<string, unknown>)[k] = Array.isArray(v)
        ? (v as FieldNode[]).map(cloneWithNewIds)
        : cloneWithNewIds(v as FieldNode);
    } else {
      (copy as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return copy;
}

/**
 * 把一个含引用的模型按片段库当前定义展开为纯内嵌模型。
 * 展开在每次控件映射 / 校验时进行，因此「改一次片段定义，所有引用处即时生效」。
 * 遇到悬空或闭环抛 SchemaEngineError——调用方（同步状态机）将其归入非法态，
 * 不让渲染与校验崩掉或陷入死循环。
 */
export function expandNode(
  node: FieldNode,
  library: FragmentLibrary,
  stack: string[] = [],
): FieldNode {
  if (!isRefNode(node)) {
    const copy = cloneWithNewIds(node);
    if (copy.children) copy.children = node.children!.map((c) => expandNode(c, library, stack));
    if (copy.item) copy.item = expandNode(node.item!, library, stack);
    return copy;
  }

  const name = node.ref;
  const def = library[name];
  if (!def) {
    throw new SchemaEngineError(`引用了不存在的片段「${name}」`);
  }
  if (stack.includes(name)) {
    throw new SchemaEngineError(`片段闭环引用：${[...stack, name].join(' -> ')}`);
  }
  // 引用处承接片段根定义，但字段名/必填/标题/说明以「使用处」为准（同名片段两处复用）
  const expanded = expandNode(def, library, [...stack, name]);
  expanded.id = uid();
  expanded.name = node.name;
  if (node.required !== undefined) expanded.required = node.required;
  // 使用处未显式给出的展示信息回落到片段定义
  if (node.title !== undefined) expanded.title = node.title;
  if (node.description !== undefined) expanded.description = node.description;
  return expanded;
}

/** 展开整份文档模型（根保持 object） */
export function expandModel(root: FieldNode, library: FragmentLibrary): FieldNode {
  if (isRefNode(root)) throw new SchemaEngineError('文档根节点不能是片段引用');
  const expanded = expandNode(root, library, []);
  if (!expanded.type) throw new SchemaEngineError('展开后根节点缺少类型');
  return expanded;
}

/* ------------------------------------------------------------------ */
/* 结构侧编辑动作：内嵌 <-> 引用                                        */
/* ------------------------------------------------------------------ */

/** 把一个普通（内嵌）节点转换为引用节点；其内嵌定义被移除，只剩指向片段的链路 */
export function convertToRef(
  node: FieldNode,
  fragmentName: string,
): FieldNode {
  if (!isValidFragmentName(fragmentName)) {
    throw new SchemaEngineError(`非法片段名「${fragmentName}」`);
  }
  if (isRefNode(node)) {
    node.ref = fragmentName;
    return node;
  }
  for (const key of Object.keys(node)) {
    if (key !== 'id' && key !== 'name' && key !== 'title' && key !== 'description' && key !== 'required') {
      delete (node as unknown as Record<string, unknown>)[key];
    }
  }
  node.ref = fragmentName;
  return node;
}

/** 把引用节点就地「收编」为内嵌定义快照（用片段当前定义填充，穿透片段别名链） */
export function inlineRef(
  node: FieldNode,
  library: FragmentLibrary,
): FieldNode {
  if (!isRefNode(node)) return node;
  if (!library[node.ref]) {
    throw new SchemaEngineError(`引用的片段「${node.ref}」不存在，无法内联`);
  }
  const expanded = expandNode(node, library, []);
  for (const key of Object.keys(node)) delete (node as unknown as Record<string, unknown>)[key];
  Object.assign(node, expanded);
  return node;
}

/** 引用节点类型的便捷取法：穿透片段定义拿到真实类型（控件选择用） */
export function refNodeType(node: FieldNode, library: FragmentLibrary): FieldType | undefined {
  if (!isRefNode(node)) return node.type;
  return library[node.ref]?.type;
}

/**
 * 「一跳内联」支持：replaceRefWithDefinition 用片段定义副本替换引用节点，
 * 定义内部对其他片段的引用原样保留（不递归展开）。
 */
/** 用给定定义节点替换引用节点（保留使用处的 name/required/title/description，深拷贝定义，嵌套引用原样保留） */
export function replaceRefWithDefinition(node: FieldNode, definition: FieldNode): FieldNode {
  const name = node.name;
  const required = node.required;
  const title = node.title;
  const description = node.description;
  const cloned = cloneWithNewIds(definition);
  for (const key of Object.keys(node)) delete (node as unknown as Record<string, unknown>)[key];
  Object.assign(node, cloned, { id: node.id, name });
  if (required !== undefined) node.required = required;
  if (title !== undefined) node.title = title;
  if (description !== undefined) node.description = description;
  return node;
}

/** 在整棵树中把对 targetName 的直接引用全部一跳内联（其他引用保留），返回替换处数 */
export function inlineRefsInTree(root: FieldNode, targetName: string, library: FragmentLibrary): number {
  let count = 0;
  const visit = (node: FieldNode): void => {
    if (isRefNode(node)) {
      if (node.ref === targetName) {
        const def = library[targetName];
        if (!def) throw new SchemaEngineError(`片段「${targetName}」不存在，无法内联`);
        replaceRefWithDefinition(node, def);
        count += 1;
      }
      return;
    }
    node.children?.forEach(visit);
    if (node.item) visit(node.item);
  };
  visit(root);
  return count;
}
