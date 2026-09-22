/**
 * Express 应用工厂（测试可注入独立内存库）。
 */
import express, { Express } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { createRepository, openDatabase, Repository } from './db';
import { createSchemaRouter } from './routes/schema';
import { createDocsRouter } from './routes/docs';
import { createFragmentsRouter } from './routes/fragments';
import { DEMO_SCHEMA } from './engine/demo';

export interface AppContext {
  app: Express;
  repo: Repository;
}

export function createApp(dbPath: string): AppContext {
  const db = openDatabase(dbPath);
  const repo = createRepository(db);

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'json-schema-form-builder' });
  });

  app.use('/api/schema', createSchemaRouter(repo));
  app.use('/api/documents', createDocsRouter(repo));
  app.use('/api/fragments', createFragmentsRouter(repo));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });

  // 生产环境托管前端构建产物（src/ 与 dist/ 均位于 packages/server 下，退两级即 packages/）
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  return { app, repo };
}

/** 预置示范文档：固定名称，存在则不重复播种 */
export const DEMO_DOC_NAME = '示范：技术沙龙报名表';

export function ensureDemoDocument(repo: Repository): number {
  const existing = repo.listDocs().find((d) => d.name === DEMO_DOC_NAME);
  if (existing) return existing.id;
  const doc = repo.createDoc({ name: DEMO_DOC_NAME, content: JSON.stringify(DEMO_SCHEMA, null, 2) + '\n' });
  return doc.id;
}
