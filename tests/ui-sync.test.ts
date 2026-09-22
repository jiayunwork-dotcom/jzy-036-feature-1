/**
 * 前端同步会话冒烟测试（happy-dom）：验证 Vue 响应式会话在
 * 「合法录入 / 非法保留 / 恢复同步 / 结构->文本」下的行为。
 */
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent, nextTick } from 'vue';
import { session, onTextInput, onModelChanged } from '../packages/web/src/stores/syncSession';
import { createSyncSession } from '@engine/sync';
import { addField, changeType, emptyRoot, findById, updateNode } from '@engine/tree';

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
  session.text = fresh.text;
  session.valid = true;
  session.error = undefined;
}

describe('同步会话与 Vue 响应式联动', () => {
  beforeEach(() => reset());

  it('合法文本录入：模型替换，视图更新', async () => {
    const { el } = mountProbe();
    expect(el.textContent).toBe('ok:0');
    onTextInput(
      JSON.stringify({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } } }),
    );
    expect(session.valid).toBe(true);
    expect(session.model.children?.map((c) => c.name)).toEqual(['a', 'b']);
    await nextTick();
    expect(el.textContent).toBe('ok:2');
  });

  it('非法文本：valid=false，字段数量停留最近合法态，结构不被清空', async () => {
    onTextInput(JSON.stringify({ type: 'object', properties: { a: { type: 'string' } } }));
    const { el } = mountProbe();
    expect(el.textContent).toBe('ok:1');

    onTextInput('{ broken');
    expect(session.valid).toBe(false);
    expect(session.error).toMatch(/JSON/);
    expect(session.model.children?.length).toBe(1);
    await nextTick();
    expect(el.textContent).toBe('bad:1');
  });

  it('恢复合法后重新接上', () => {
    onTextInput(JSON.stringify({ type: 'object', properties: { a: { type: 'string' } } }));
    onTextInput('{ broken');
    onTextInput(JSON.stringify({ type: 'object', properties: { only: { type: 'boolean' } } }));
    expect(session.valid).toBe(true);
    expect(session.model.children?.map((c) => c.name)).toEqual(['only']);
    expect(session.text).toContain('only');
  });

  it('结构侧新增字段并设必填后，文本即时更新', () => {
    onTextInput(JSON.stringify({ type: 'object', properties: {} }));
    const node = addField(session.model, null, 'string')!;
    updateNode(session.model, node.id, { name: 'phone', required: true });
    onModelChanged();
    const schema = JSON.parse(session.text);
    expect(schema.properties.phone.type).toBe('string');
    expect(schema.required).toEqual(['phone']);
  });

  it('切换类型清理不兼容约束，序列化合法', () => {
    onTextInput(
      JSON.stringify({
        type: 'object',
        properties: { x: { type: 'string', minLength: 2, pattern: '^a' } },
      }),
    );
    const node = findById(session.model, session.model.children![0].id)!;
    changeType(session.model, node.id, 'integer');
    onModelChanged();
    const schema = JSON.parse(session.text);
    expect(schema.properties.x.type).toBe('integer');
    expect(schema.properties.x.minLength).toBeUndefined();
    expect(schema.properties.x.pattern).toBeUndefined();
  });
});
