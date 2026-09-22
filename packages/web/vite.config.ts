import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import fs from 'node:fs';

// 核心引擎是零依赖纯 TS，位于 server 包内；开发/构建时经 alias 直接编译同源代码，
// 保证浏览器内即时同步与服务端权威校验使用同一份实现。
const engineDir = path.resolve(__dirname, '../server/src/engine');

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@engine': engineDir,
    },
  },
  server: {
    port: 5173,
    fs: {
      // 允许读取 monorepo 内 server 包的引擎源码
      allow: [path.resolve(__dirname, '../..')],
    },
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});

// 显式引用，避免类型收窄时被误判未使用
void fs;
