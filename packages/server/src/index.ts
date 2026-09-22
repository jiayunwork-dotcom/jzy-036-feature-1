/**
 * 服务进程入口。
 */
import { createApp, ensureDemoDocument, ensureDemoFragments } from './app';

const PORT = Number(process.env.PORT ?? 4000);
const DB_PATH = process.env.DB_PATH ?? `${__dirname}/../../data/app.db`;

const { app, repo } = createApp(DB_PATH);
ensureDemoFragments(repo);
const demoId = ensureDemoDocument(repo);

// eslint-disable-next-line no-console
console.log(`[server] demo document id=${demoId}`);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on http://localhost:${PORT}`);
});
