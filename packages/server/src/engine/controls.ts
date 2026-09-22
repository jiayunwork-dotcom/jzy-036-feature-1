/**
 * Schema（结构模型） -> 控件树映射。
 * string -> text（有 enum 时 -> select）
 * number/integer -> number
 * boolean -> checkbox
 * object -> group（嵌套字段分组）
 * array -> arraylist（可增删重复项）
 */
import { FieldNode, WidgetType } from './types';

export interface ControlNode {
  id: string;
  name: string;
  type: FieldNode['type'];
  widget: WidgetType;
  title: string;
  description?: string;
  required: boolean;
  enumOptions?: (string | number | boolean)[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  default?: string | number | boolean;
  children?: ControlNode[];
  item?: ControlNode;
}

function mapScalar(node: FieldNode): ControlNode {
  const c: ControlNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    widget: 'text',
    title: node.title || node.name,
    required: !!node.required,
  };
  if (node.description) c.description = node.description;
  if (node.type === 'number' || node.type === 'integer') {
    c.widget = 'number';
    c.minimum = node.minimum;
    c.maximum = node.maximum;
  }
  if (node.type === 'boolean') {
    c.widget = 'checkbox';
  }
  if (node.type === 'string') {
    c.widget = 'text';
    c.minLength = node.minLength;
    c.maxLength = node.maxLength;
    c.pattern = node.pattern;
    if (node.maxLength !== undefined && node.maxLength > 120) c.widget = 'textarea';
  }
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    c.widget = 'select';
    c.enumOptions = [...node.enum];
  }
  if (node.default !== undefined) c.default = node.default;
  return c;
}

export function mapControl(node: FieldNode): ControlNode {
  if (node.type === 'object') {
    const c: ControlNode = {
      id: node.id,
      name: node.name,
      type: 'object',
      widget: 'group',
      title: node.title || node.name || '',
      required: !!node.required,
      children: (node.children ?? []).map(mapControl),
    };
    if (node.description) c.description = node.description;
    return c;
  }
  if (node.type === 'array') {
    const c: ControlNode = {
      id: node.id,
      name: node.name,
      type: 'array',
      widget: 'arraylist',
      title: node.title || node.name,
      required: !!node.required,
      item: node.item ? mapControl(node.item) : undefined,
    };
    if (node.description) c.description = node.description;
    return c;
  }
  return mapScalar(node);
}

/** 控件映射 HTTP 接口使用的纯函数 */
export function modelToControls(root: FieldNode): ControlNode {
  if (root.type !== 'object') throw new Error('根节点必须是 object');
  return mapControl(root);
}
