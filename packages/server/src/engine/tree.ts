/**
 * 结构树操作：可视化区的所有编辑动作都集中在这里，保持组件轻量、
 * 让「结构 -> Schema」的逻辑可独立测试。
 */
import { FieldNode, FieldType, SCALAR_TYPES, uid } from './types';
import { FragmentLibrary, convertToRef, inlineRef, isRefNode } from './fragments';

export interface NodeLocation {
  parent: FieldNode | null;
  /** object 中为 children，array 中为 item */
  list: FieldNode[] | null;
  index: number;
}

export function walk(node: FieldNode, fn: (n: FieldNode, parent: FieldNode | null) => void, parent: FieldNode | null = null): void {
  fn(node, parent);
  node.children?.forEach((c) => walk(c, fn, node));
  if (node.item) walk(node.item, fn, node);
}
export function findById(root: FieldNode, id: string): FieldNode | undefined {
  let hit: FieldNode | undefined;
  walk(root, (n) => {
    if (n.id === id) hit = n;
  });
  return hit;
}

export function locate(root: FieldNode, id: string): NodeLocation | undefined {
  let result: NodeLocation | undefined;
  walk(root, (n, parent) => {
    if (result) return;
    if (n.children) {
      const index = n.children.findIndex((c) => c.id === id);
      if (index >= 0) result = { parent: n, list: n.children, index };
    }
    if (n.item && n.item.id === id && !result) {
      result = { parent: n, list: null, index: -1 };
    }
    void parent;
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
  if (!parent || parent.type !== 'object') return undefined;
  if (isRefNode(parent)) return undefined; // 引用节点是只读链路，不能直接挂子字段
  parent.children = parent.children ?? [];
  const node = createNode(type, uniqueName(parent));
  parent.children.push(node);
  return node;
}

export function removeNode(root: FieldNode, id: string): boolean {
  if (root.id === id) return false;
  const loc = locate(root, id);
  if (!loc || !loc.list) return false;
  loc.list.splice(loc.index, 1);
  return true;
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

/** 缩进：成为前一个兄弟 object 的最后一个子字段 */
export function indentNode(root: FieldNode, id: string): boolean {
  const loc = locate(root, id);
  if (!loc || !loc.list || loc.index === 0) return false;
  const prev = loc.list[loc.index - 1];
  if (prev.type !== 'object') return false;
  const [node] = loc.list.splice(loc.index, 1);
  prev.children = prev.children ?? [];
  prev.children.push(node);
  return true;
}

/** 反缩进：从父对象中移出，放到父对象之后（祖父的 children 里） */
export function outdentNode(root: FieldNode, id: string): boolean {
  const loc = locate(root, id);
  if (!loc || !loc.parent || !loc.list) return false;
  const grand = locate(root, loc.parent.id);
  if (!grand || !grand.list) return false;
  const [node] = loc.list.splice(loc.index, 1);
  grand.list.splice(grand.index + 1, 0, node);
  return true;
}

/** 局部更新字段属性（改名 / 约束 / 枚举 / 默认值等） */
export function updateNode(root: FieldNode, id: string, patch: Partial<FieldNode>): FieldNode | undefined {
  const node = findById(root, id);
  if (!node) return undefined;
  Object.assign(node, patch);
  return node;
}

/** 切换字段类型：清掉与新类型不兼容的结构与约束（引用节点需先内联或直接转引用） */
export function changeType(root: FieldNode, id: string, next: FieldType): FieldNode | undefined {
  const node = findById(root, id);
  if (!node || node.type === next) return node;
  if (isRefNode(node)) return undefined; // 引用节点没有自身类型可切换

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

/** 数组 item 类型切换的便捷入口 */
export function setArrayItemType(root: FieldNode, arrayId: string, itemType: FieldType): void {
  const arr = findById(root, arrayId);
  if (!arr || arr.type !== 'array') return;
  if (arr.item && isRefNode(arr.item)) return; // item 为片段引用时不能直接换类型（先内联）
  if (!arr.item) {
    arr.item = createNode(itemType, '$item');
    return;
  }
  changeType(root, arr.item.id, itemType);
}

/* ---------------- 片段引用：结构区「转换 / 收编」动作 ---------------- */

/** 把结构中的某个内嵌节点转换为指向具名片段的引用节点 */
export function convertNodeToRef(root: FieldNode, id: string, fragmentName: string): FieldNode | undefined {
  const node = findById(root, id);
  if (!node || isRefNode(node)) return undefined;
  convertToRef(node, fragmentName);
  return node;
}

/** 把结构中的某个引用节点收编为内嵌定义（片段当前内容的快照副本） */
export function inlineNodeRef(root: FieldNode, id: string, library: FragmentLibrary): FieldNode | undefined {
  const node = findById(root, id);
  if (!node || !isRefNode(node)) return undefined;
  inlineRef(node, library);
  return node;
}

export function emptyRoot(title = '未命名表单'): FieldNode {
  return { id: uid(), name: '', type: 'object', title, children: [] };
}
