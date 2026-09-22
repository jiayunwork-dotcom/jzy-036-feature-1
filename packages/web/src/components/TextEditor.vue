<script setup lang="ts">
/**
 * 文本 Schema 编辑区。
 * 每次输入直接驱动同步状态机：
 *  - 合法：结构树与预览即时更新；
 *  - 非法：顶部红条给出原因与位置，结构树/预览保持最近合法态，文本不被回滚覆盖。
 */
import { session, onTextInput } from '../stores/syncSession';

function onInput(e: Event): void {
  onTextInput((e.target as HTMLTextAreaElement).value);
}

function format(): void {
  try {
    const obj = JSON.parse(session.text);
    session.text = JSON.stringify(obj, null, 2) + '\n';
    onTextInput(session.text);
  } catch {
    /* 非法时格式化按钮无效，错误条已提示 */
  }
}
</script>

<template>
  <section class="panel">
    <div class="panel-header">
      📝 Schema 文本
      <span :class="['status-chip', session.valid ? 'ok' : 'bad']">
        {{ session.valid ? '合法 · 已同步' : '非法 · 保留最近合法结构' }}
      </span>
      <span class="spacer" />
      <button class="tiny" @click="format" title="解析并重新缩进（仅合法时生效）">格式化</button>
    </div>

    <div v-if="!session.valid" class="error-banner">
      <strong>当前文本不是合法的 JSON Schema，结构区与预览已停留在最近一次合法状态。</strong>
      <div style="margin-top: 4px">
        原因：{{ session.error }}
        <span v-if="session.errorLine" class="hint">
          （第 {{ session.errorLine }} 行{{ session.errorColumn ? ` 第 ${session.errorColumn} 列` : '' }}）
        </span>
      </div>
      <div class="hint" style="margin-top: 4px">
        你可以继续修改文本；恢复合法后两侧会自动重新接上。也可以在左侧编辑结构，将以结构为准重建文本。
      </div>
    </div>

    <div class="panel-body">
      <textarea
        class="schema-textarea"
        spellcheck="false"
        :value="session.text"
        @input="onInput"
      ></textarea>
    </div>
  </section>
</template>
