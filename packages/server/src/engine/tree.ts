/**
 * 结构树操作：可视化区的所有编辑动作都集中在这里，保持组件轻量、
 * 让「结构 -> Schema」的逻辑可独立测试。
 *
 * 树中节点分两种：内嵌定义（FieldNode）与片段引用（RefNode）。
 * 引用节点没有类型/约束/子字段可编辑，只能：改名、切换必填、跳转片段、
 * 还原为内嵌（inline）或删除；增删子字段、改类型、缩进等结构操作只作用于
 * 内嵌节点。
 */
import {
  FieldNode,
  FieldType,
  RefNode,
  SCALAR_TYPES,
  StructureNode,
  createRefNode,
  isRef,
  uid,
} from './types';

export interface NodeLocation {
  parent: StructureNode | null;
  /** object 中为 children，array item / 引用无子列表 */
  list: StructureNode[] | null;
  index: number;
}

export function walk(
  node: StructureNode,
  fn: (n: StructureNode, parent: StructureNode | null) => void,
  parent: StructureNode | null = null,
): void {
  fn(node, parent);
  if (isRef(node)) return;
  node.children?.forEach((c) => walk(c, fn, node));
  if (node.item) walk(node.item, fn, node);
}

export function findById(root: StructureNode, id: string): StructureNode | undefined {
  let hit: StructureNode | undefined;
  walk(root, (n) => {
    if (n.id === id) hit = n;
  });
  return hit;
}

export function locate(root: StructureNode, id: string): NodeLocation | undefined {
  let result: NodeLocation | undefined;
  walk(root, (n, parent) => {
    if (result || isRef(n)) return;
    if (n.children) {
      const index = n.children.findIndex((c) => c.id === id);
      if (index >= 0) result = { parent: n, list: n.children, index };
    }
    if (n.item && n.item.id === id && !result) {
      result = { parent: n, list: null, index: -1 };
    }
  });
  return result;
}

function uniqueName(parent: FieldNode, base = 'field'): string {
  const used = new Set((parent.children ?? []).map((c) => c.name));
  let i = (parent.children?.length ?? 0) + 1;
  let name = `${base}${i}`;
  while (used.has(name)) {
    i += 1;
    name = `${base}${i}`;
  }
  return name;
}

export function createNode(type: FieldType = 'string', name = ''): FieldNode {
  const node: FieldNode = { id: uid(), name: name || 'field', type };
  if (type === 'object') node.children = [];
  if (type === 'array') node.item = createNode('string', '$item');
  return node;
}

/** 在对象中新增字段；parentId 为空时加到根 */
export function addField(root: FieldNode, parentId: string | null, type: FieldType = 'string'): FieldNode | undefined {
  const parent = parentId ? findById(root, parentId) : root;
  if (!parent || isRef(parent) || parent.type !== 'object') return undefined;
  parent.children = parent.children ?? [];
  const node = createNode(type, uniqueName(parent));
  parent.children.push(node);
  return node;
}

/** 新增一个片段引用字段到指定对象 */
export function addRefField(root: FieldNode, parentId: string | null, ref: string): RefNode | undefined {
  const parent = parentId ? findById(root, parentId) : root;
  if (!parent || isRef(parent) || parent.type !== 'object') return undefined;
  parent.children = parent.children ?? [];
  const baseName = uniqueRefName(parent, ref);
  const node = createRefNode(ref, baseName);
  parent.children.push(node);
  return node;
}

function uniqueRefName(parent: FieldNode, ref: string): string {
  const used = new Set((parent.children ?? []).map((c) => c.name));
  let name = ref;
  let i = 2;
  while (used.has(name)) {
    name = `${ref}${i++}`;
  }
  void used;
  return name;
}

export function removeNode(root: FieldNode, id: string): boolean {
  if (root.id === id) return false;
  const loc = locate(root, id);
  if (!loc) return false;
  if (loc.list) {
    loc.list.splice(loc.index, 1);
    return true;
  }
  // 数组 item
  if (loc.parent && !isRef(loc.parent) && loc.parent.item?.id === id) {
    loc.parent.item = createNode('string', '$item');
    return true;
  }
  return false;
}

export function moveNode(root: FieldNode, id: string, delta: -1 | 1): boolean {
  const loc = locate(root, id);
  if (!loc || !loc.list) return false;
  const target = loc.index + delta;
  if (target < 0 || target >= loc.list.length) return false;
  const [node] = loc.list.splice(loc.index, 1);
  loc.list.splice(target, 0, node);
  return true;
}

/** 缩进：成为前一个兄弟内嵌 object 的最后一个子字段 */
export function indentNode(root: FieldNode, id: string): boolean {
  const loc = locate(root, id);
  if (!loc || !loc.list || loc.index === 0) return false;
  const prev = loc.list[loc.index - 1];
  if (isRef(prev) || prev.type !== 'object') return false;
  const [node] = loc.list.splice(loc.index, 1);
  prev.children = prev.children ?? [];
  prev.children.push(node);
  return true;
}

/** 反缩进：从父对象中移出，放到父对象之后（祖父的 children 里） */
export function outdentNode(root: FieldNode, id: string): boolean {
  const loc = locate(root, id);
  if (!loc || !loc.parent || !loc.list || isRef(loc.parent)) return false;
  const grand = locate(root, loc.parent.id);
  if (!grand || !grand.list) return false;
  const [node] = loc.list.splice(loc.index, 1);
  grand.list.splice(grand.index + 1, 0, node);
  return true;
}

/** 局部更新字段属性（改名 / 约束 / 枚举 / 默认值 / 引用 key 等） */
export function updateNode(
  root: StructureNode,
  id: string,
  patch: Partial<FieldNode> & Partial<RefNode>,
): StructureNode | undefined {
  const node = findById(root, id);
  if (!node) return undefined;
  Object.assign(node, patch);
  return node;
}

/** 切换字段类型：清掉与新类型不兼容的结构与约束（仅内嵌节点） */
export function changeType(root: FieldNode, id: string, next: FieldType): FieldNode | undefined {
  const node = findById(root, id);
  if (!node || isRef(node)) return undefined;
  if (node.type === next) return node;

  const prev = node.type;
  node.type = next;

  if (next === 'object') {
    node.children = prev === 'object' ? node.children ?? [] : [];
    delete node.item;
    stripScalar(node);
  } else if (next === 'array') {
    if (prev !== 'array') node.item = createNode('string', '$item');
    stripScalar(node);
  } else {
    delete node.children;
    delete node.item;
    // 类型改变后旧枚举/默认值大概率不兼容，统一清空，由用户重新填写
    delete node.enum;
    delete node.default;
    if (SCALAR_TYPES.includes(next)) stripScalar(node, true);
    if (next === 'string') {
      // number/integer -> string
      delete node.minimum;
      delete node.maximum;
    } else {
      // -> number/integer/boolean
      delete node.minLength;
      delete node.maxLength;
      delete node.pattern;
    }
    if (next === 'boolean') {
      delete node.minimum;
      delete node.maximum;
    } else if (next !== 'number') {
      delete node.minimum;
      delete node.maximum;
    }
  }
  return node;
}

function stripScalar(node: FieldNode, keepAll = false): void {
  if (keepAll) return;
  delete node.minLength;
  delete node.maxLength;
  delete node.pattern;
  delete node.minimum;
  delete node.maximum;
  delete node.enum;
  delete node.default;
}

/** 数组 item 类型切换的便捷入口（item 为引用时不允许） */
export function setArrayItemType(root: FieldNode, arrayId: string, itemType: FieldType): void {
  const arr = findById(root, arrayId);
  if (!arr || isRef(arr) || arr.type !== 'array') return;
  if (!arr.item) {
    arr.item = createNode(itemType, '$item');
    return;
  }
  if (isRef(arr.item)) return;
  changeType(root, arr.item.id, itemType);
}

/** 把数组 item 替换为指向片段的引用 */
export function setArrayItemRef(root: FieldNode, arrayId: string, ref: string): boolean {
  const arr = findById(root, arrayId);
  if (!arr || isRef(arr) || arr.type !== 'array') return false;
  arr.item = createRefNode(ref, '$item');
  return true;
}

function reassignIds(node: StructureNode): StructureNode {
  node.id = uid();
  if (!isRef(node)) {
    node.children?.forEach(reassignIds);
    if (node.item) node.item = reassignIds(node.item);
  }
  return node;
}

function replaceNode(root: FieldNode, id: string, next: StructureNode): StructureNode | undefined {
  if (root.id === id) return undefined;
  const loc = locate(root, id);
  if (!loc) return undefined;
  if (loc.list) {
    loc.list.splice(loc.index, 1, next);
  } else if (loc.parent && !isRef(loc.parent) && loc.parent.item?.id === id) {
    loc.parent.item = next;
  }
  return next;
}

/**
 * 「转换为引用」：把一个内嵌字段就地替换成指向已有片段的引用节点，
 * 保留原字段名与必填；原有内嵌定义被移除（片段是唯一定义来源）。
 */
export function convertToRef(root: FieldNode, id: string, ref: string): RefNode | undefined {
  const node = findById(root, id);
  if (!node || isRef(node)) return undefined;
  const replacement = createRefNode(ref, node.name, node.required);
  return replaceNode(root, id, replacement) as RefNode | undefined;
}

/**
 * 「还原为内嵌」：把引用替换为给定片段定义的独立副本（重新分配 id）。
 * 副本与片段从此互不相干——这是用户显式脱离复用的操作。
 */
export function inlineRefNode(root: FieldNode, id: string, inlineDef: StructureNode): StructureNode | undefined {
  const node = findById(root, id);
  if (!node || !isRef(node)) return undefined;
  const clone = reassignIds(JSON.parse(JSON.stringify(inlineDef))) as StructureNode;
  clone.name = node.name;
  return replaceNode(root, id, clone);
}

export function emptyRoot(title = '未命名表单'): FieldNode {
  return { id: uid(), name: '', type: 'object', title, children: [] };
}
