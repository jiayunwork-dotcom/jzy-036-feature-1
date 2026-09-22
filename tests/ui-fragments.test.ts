/**
 * 前端同步会话在片段引用下的双向表达（happy-dom）：
 *  - 文本区写 $ref -> 结构区出现引用节点（ref，不展开）；
 *  - 结构区「转为引用」-> 文本区生成 $ref；
 *  - 控件树穿透片段真实类型；片段库变化后引用处跟随更新；
 *  - 悬空引用进非法态、结构不被清空。
 */
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent, nextTick } from 'vue';
import {
  session,
  onTextInput,
  onModelChanged,
  convertFieldToRef,
  inlineFieldRef,
  refreshFragmentLibrary,
} from '../packages/web/src/stores/syncSession';
import { createSyncSession } from '@engine/sync';
import { addField, emptyRoot, findById, updateNode } from '@engine/tree';
import { modelToControls } from '@engine/controls';
import type { FragmentLibrary } from '@engine/fragments';
import { schemaToModel } from '@engine/parser';

const Probe = defineComponent({
  setup() {
    return { session };
  },
  template: '<div>{{ session.valid ? "ok" : "bad" }}:{{ session.model.children?.length ?? 0 }}</div>',
});

function mountProbe() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const app = createApp(Probe);
  app.mount(el);
  return { el, app };
}

function reset(): void {
  const fresh = createSyncSession(emptyRoot());
  session.model = fresh.model;
  session.library = {};
  session.text = fresh.text;
  session.valid = true;
  session.error = undefined;
  session.lastExpanded = fresh.lastExpanded;
}

function addressLib(): FragmentLibrary {
  return {
    contactAddress: schemaToModel(
      {
        type: 'object',
        title: '联系地址',
        required: ['detail'],
        properties: { detail: { type: 'string', title: '详细地址', minLength: 3 } },
      },
      { allowNonObjectRoot: true },
    ),
  };
}

describe('结构区 <-> 文本区：片段引用双向同步', () => {
  beforeEach(() => reset());

  it('文本区写 $ref：结构区出现引用节点（ref 且不展开内容）', () => {
    refreshFragmentLibrary(addressLib());
    onTextInput(JSON.stringify({
      type: 'object',
      properties: { addr: { $ref: 'fragment:contactAddress' } },
    }));
    expect(session.valid).toBe(true);
    const addr = session.model.children![0];
    expect(addr.ref).toBe('contactAddress');
    expect(addr.type).toBeUndefined();
    expect(addr.children).toBeUndefined();
  });

  it('控件树穿透引用取真实类型与约束', () => {
    refreshFragmentLibrary(addressLib());
    onTextInput(JSON.stringify({
      type: 'object',
      properties: { addr: { $ref: 'fragment:contactAddress' } },
    }));
    const controls = modelToControls(session.model, session.library);
    const addr = controls.children![0];
    expect(addr.widget).toBe('group');
    const detail = addr.children!.find((c) => c.name === 'detail')!;
    expect(detail.minLength).toBe(3);
  });

  it('结构区把普通字段转为引用：文本区生成 $ref（反向表达）', () => {
    refreshFragmentLibrary(addressLib());
    onTextInput(JSON.stringify({
      type: 'object',
      properties: { addr: { type: 'object', properties: { x: { type: 'string' } } } },
    }));
    const id = session.model.children![0].id;
    expect(convertFieldToRef(id, 'contactAddress')).toBe(true);
    expect(session.valid).toBe(true);
    const schema = JSON.parse(session.text);
    expect(schema.properties.addr).toEqual({ $ref: 'fragment:contactAddress' });
  });

  it('结构区把引用收编为内嵌：文本区生成内联结构（往返语义等价于片段当前定义）', () => {
    refreshFragmentLibrary(addressLib());
    onTextInput(JSON.stringify({
      type: 'object',
      properties: { addr: { $ref: 'fragment:contactAddress' } },
    }));
    const id = session.model.children![0].id;
    expect(inlineFieldRef(id)).toBe(true);
    const schema = JSON.parse(session.text);
    expect(schema.properties.addr.type).toBe('object');
    expect(schema.properties.addr.properties.detail.minLength).toBe(3);
    expect(schema.properties.addr.$ref).toBeUndefined();
  });

  it('片段库更新：结构模型不动，控件/展开跟随片段当前定义', () => {
    const lib = addressLib();
    refreshFragmentLibrary(lib);
    onTextInput(JSON.stringify({
      type: 'object',
      properties: { addr: { $ref: 'fragment:contactAddress' } },
    }));
    const nodeSnapshot = session.model.children![0];
    expect(nodeSnapshot.ref).toBe('contactAddress');

    lib.contactAddress = schemaToModel(
      { type: 'object', properties: { detail: { type: 'string', maxLength: 5 } } },
      { allowNonObjectRoot: true },
    );
    refreshFragmentLibrary(lib);
    expect(session.model.children![0].ref).toBe('contactAddress'); // 还是引用
    const detail = modelToControls(session.model, session.library)
      .children![0].children!.find((c) => c.name === 'detail')!;
    expect(detail.maxLength).toBe(5);
    expect(detail.minLength).toBeUndefined();
  });

  it('悬空引用：非法态、错误提示、结构区保留最近合法字段', async () => {
    onTextInput(JSON.stringify({ type: 'object', properties: { keep: { type: 'boolean' } } }));
    const { el } = mountProbe();
    expect(el.textContent).toBe('ok:1');

    onTextInput(JSON.stringify({
      type: 'object',
      properties: { addr: { $ref: 'fragment:missing' } },
    }));
    expect(session.valid).toBe(false);
    expect(session.error).toMatch(/missing/);
    expect(session.model.children!.map((c) => c.name)).toEqual(['keep']); // 结构没被清空
    await nextTick();
    expect(el.textContent).toBe('bad:1');
  });

  it('结构区常规编辑在片段库存在时仍正常（老操作不回归）', () => {
    refreshFragmentLibrary(addressLib());
    onTextInput(JSON.stringify({ type: 'object', properties: {} }));
    const node = addField(session.model, null, 'string')!;
    updateNode(session.model, node.id, { name: 'phone', required: true });
    onModelChanged();
    const schema = JSON.parse(session.text);
    expect(schema.properties.phone.type).toBe('string');
    expect(schema.required).toEqual(['phone']);
  });
});
