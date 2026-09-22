/**
 * 前端同步会话 × 片段（happy-dom）：
 *  - 含 $fragment 文本在结构会话中解析为引用节点（不展开）；
 *  - 片段定义更新后 refreshFragmentLib：文本未动，穿透视图随当前定义变化；
 *  - 片段被删 -> 悬空 -> 同一套非法态（结构保留最近合法态）；恢复后重新接上。
 */
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createApp, defineComponent, nextTick } from 'vue';
import {
  session,
  onTextInput,
  resolvedModel,
  refreshFragmentLib,
} from '../packages/web/src/stores/syncSession';
import { buildFragmentLib } from '@engine/fragments';
import { isRef } from '@engine/types';

const Probe = defineComponent({
  setup: () => ({ session, resolvedModel }),
  template:
    '<div>{{ session.valid ? "ok" : "bad" }}:' +
    '{{ session.model.children?.length ?? 0 }}:' +
    '{{ resolvedModel.children?.length ?? 0 }}</div>',
});

function withLib(schemas: Record<string, unknown>) {
  return buildFragmentLib(
    Object.entries(schemas).map(([key, s]) => ({ key, content: JSON.stringify(s) })),
  );
}

function reset(): void {
  session.fragments = new Map();
  session.fragmentErrors = undefined;
}

const docText = JSON.stringify({
  type: 'object',
  properties: { a: { type: 'string' }, addr: { $fragment: 'address' } },
});

describe('前端会话与片段库联动', () => {
  it('载入片段库后解析：结构树保留引用节点，穿透视图展开片段', async () => {
    reset();
    const v1 = withLib({
      address: {
        type: 'object',
        properties: { city: { type: 'string', minLength: 2 } },
        required: ['city'],
      },
    });
    refreshFragmentLib(v1.lib, v1.errors);
    expect(onTextInput(docText)).toBe(true);

    const addr = session.model.children![1];
    expect(isRef(addr)).toBe(true);
    expect((addr as any).ref).toBe('address');

    const el = document.createElement('div');
    document.body.appendChild(el);
    const app = createApp(Probe);
    app.mount(el);
    await nextTick();
    expect(el.textContent).toBe('ok:2:2');
    // 穿透视图里 addr 是带 city 的对象
    const resolved = resolvedModel.value.children[1] as any;
    expect(resolved.type).toBe('object');
    expect(resolved.children[0].name).toBe('city');
    expect(resolved.children[0].required).toBe(true);
    app.unmount();
  });

  it('片段定义更新：文本一字未改，穿透视图按新定义变化（一处定义、多处生效）', () => {
    reset();
    refreshFragmentLib(
      withLib({ address: { type: 'object', properties: { city: { type: 'string' } } } }).lib,
    );
    onTextInput(docText);
    expect((resolvedModel.value.children[1] as any).children.map((c: any) => c.name)).toEqual([
      'city',
    ]);

    // 片段改为含 zipCode
    const v2 = withLib({
      address: {
        type: 'object',
        properties: { city: { type: 'string' }, zip: { type: 'string' } },
      },
    });
    expect(refreshFragmentLib(v2.lib, v2.errors)).toBe(true);
    expect((resolvedModel.value.children[1] as any).children.map((c: any) => c.name)).toEqual([
      'city',
      'zip',
    ]);
    // 结构模型里的引用节点仍是引用，文本仍是引用写法
    expect(isRef(session.model.children![1])).toBe(true);
    expect(session.text).toContain('$fragment');
  });

  it('片段被删 -> 悬空 -> 非法态保留最近合法结构；片段重建后重新接上', () => {
    reset();
    const v1 = withLib({ address: { type: 'object', properties: { city: { type: 'string' } } } });
    refreshFragmentLib(v1.lib, v1.errors);
    onTextInput(docText);
    expect(session.valid).toBe(true);

    // 片段库清空（模拟删除）
    expect(refreshFragmentLib(new Map())).toBe(false);
    expect(session.valid).toBe(false);
    expect(session.error).toMatch(/不存在的片段「address」/);
    // 结构区保留最近合法态（仍是含引用的两个字段）
    expect(session.model.children?.length).toBe(2);

    // 片段重建（同名新定义）-> 自动重新接上
    const v2 = withLib({ address: { type: 'string' } });
    expect(refreshFragmentLib(v2.lib, v2.errors)).toBe(true);
    expect(session.valid).toBe(true);
    expect((resolvedModel.value.children[1] as any).type).toBe('string');
  });
});
