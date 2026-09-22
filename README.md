# JSON Schema 可视化表单生成器

浏览器内三栏联动的 JSON Schema 工具：

- **🏗️ 结构编辑区**：可视化增删字段、切换类型（string/number/integer/boolean/object/array）、
  编辑必填/长度/数值范围/正则/枚举/默认值、缩进反缩进调整嵌套层级；
- **📝 Schema 文本编辑区**：直接编辑原始 JSON Schema；
- **✅ 表单预览区**：按 Schema 即时渲染可填写表单（文本框/数字/勾选/下拉/分组/可增删数组），
  失焦即时校验、提交全量校验，违例拦截并定位到字段。

两侧文本与结构表达同一份 Schema，任意一侧改动实时同步；后端负责解析校验、双向变换、
控件映射、表单校验与文档/版本持久化（SQLite）。

## 目录结构

```
packages/
  server/                     Express + TypeScript + better-sqlite3
    src/
      index.ts                进程入口（播种示范文档）
      app.ts                  Express 应用工厂（生产托管前端静态文件）
      db.ts                   SQLite 持久化：documents / versions，事务 + revision 乐观锁
      routes/
        schema.ts             引擎 HTTP：parse / serialize / controls / validate-form
        docs.ts               文档 CRUD、版本列表/查看/回滚
      engine/                 ★ 零依赖纯 TS 核心，前端经 Vite alias 复用同一份代码
        types.ts              结构模型 FieldNode / Schema 类型 / 错误类型
        parser.ts             文本 -> 模型（永不抛异常，带行列定位）
        serialize.ts          模型 -> Schema（确定性字段顺序）
        tree.ts               结构树操作（增删/改名/改类型/层级移动）
        controls.ts           Schema -> 控件树映射
        validate.ts           表单数据初始化 + 约束校验（错误定位到字段路径）
        sync.ts               ★ 双向同步状态机：「最近一次合法状态」回退逻辑
        demo.ts               预置示范 Schema（嵌套对象/数组/枚举/约束的报名表）
  web/                        Vue 3 + TypeScript + Vite
    src/
      App.vue                 顶栏（文档/导入导出/版本入口）+ 三栏布局
      api.ts                  后端接口封装
      stores/syncSession.ts   同步会话（reactive 包装引擎状态机）
      stores/docs.ts          多文档/版本/回滚 store
      components/
        StructureEditor.vue   结构编辑区外壳
        SchemaNode.vue        递归字段节点（含约束编辑面板）
        TextEditor.vue        文本编辑区（错误条 + 位置提示）
        FormPreview.vue       表单预览（校验/提交/重置）
        FormField.vue         递归预览字段（object 分组 / arraylist / 标量控件）
        VersionsDialog.vue    历史版本查看与回滚
tests/                        Vitest：43 个自动化用例
```

## 本地运行（Node 20）

```bash
npm install
npm run dev        # 后端 http://localhost:4000，前端 http://localhost:5173（/api 已代理）
```

生产构建（后端在 4000 端口同时提供页面与接口）：

```bash
npm run build      # tsc 构建后端 + vite 构建前端
npm start          # http://localhost:4000
```

SQLite 默认落在 `packages/server/data/app.db`，可用 `DB_PATH` 覆盖；`PORT` 覆盖端口。

## 容器

```bash
docker compose up --build
# 打开 http://localhost:4000 ，数据持久化在命名卷 jsf-data
```

## 自动化测试

```bash
npm test
```

覆盖五类成功判据（共 43 个用例）：

| 文件 | 守住的判据 |
| --- | --- |
| `tests/roundtrip.test.ts` | 结构 → 文本 → 再解析回结构，语义不变；多轮往返幂等 |
| `tests/invalid-fallback.test.ts` | 非法 JSON/非法 Schema 时结构区停留在最近合法态不清空、错误含行列；恢复合法重新接上；非法期改结构以结构为准重建 |
| `tests/constraints.test.ts` | 必填、长度（码点）、数值范围/整数、正则、枚举、嵌套对象、数组项索引定位等违例拦截与合法放行 |
| `tests/controls.test.ts` | 六种类型到控件的映射及默认值初始化 |
| `tests/api.test.ts` | HTTP 解析/序列化/校验；导入导出等价；保存边界拒绝非法；版本轨迹与回滚后内容一致；多文档隔离与同文档并发 409 |

## 双向同步与「最近一次合法状态」的关键设计

1. 全应用只有一个同步会话（`sync.ts` 的状态机），其不变量是
   **`session.model` 永远是最近一次合法 Schema 的结构模型**。
2. `setText()`：交给 `parser.parseSchemaText()`（**永不抛异常**）。
   - 合法 → 用新模型替换 `session.model`，结构区/预览即时刷新；
   - 非法（JSON 语法错误带行列、或语义不支持）→ 只置 `valid=false` 与错误原因，
     **`model` 一个字段都不动**，所以可视化树不会被清空；文本内容也不会被回滚覆盖。
3. `syncFromModel()`：结构侧任何编辑后以模型为准重新确定性序列化文本，valid 回到 true。
4. 前端跑在浏览器里的引擎与服务端是**同一份源码**（`server/src/engine` 经 Vite alias 引入），
   服务端另外在保存/导入边界做权威校验，HTTP `/parse` 对非法输入返回 `200 + ok:false`
   （工具不崩），非法内容永远无法持久化。

## HTTP 接口摘要

- `POST /api/schema/parse` `{text}` → `{ok, model, controls}` 或 `{ok:false,error,line,column}`
- `POST /api/schema/serialize` `{model}` → `{ok,text}`
- `POST /api/schema/controls` `{text}` → `{ok,controls}`
- `POST /api/schema/validate-form` `{text,data}` → `{valid,errors:[{loc,message}],defaults}`
- `GET/POST /api/documents`，`GET/PUT/PATCH/DELETE /api/documents/:id`
- `GET /api/documents/:id/versions[/::version]`，`POST /api/documents/:id/rollback/:version`

保存与回滚都要求携带 `expectedRevision`（乐观锁）：同一文档并发保存时，后到的旧版本写入
收到 **409** 被拒绝；不同文档各自行隔离，互不覆盖。每次内容更新追加一条 `versions` 快照，
**回滚 = 把所选历史版本内容写成新版本**，轨迹连续可再回滚。

## 预置示范

首次启动自动创建「示范：技术沙龙报名表」，包含必填文本（长度）、邮箱/邮编正则、
整数范围、字符串枚举默认值、布尔默认值、嵌套地址对象、对象数组（项内必填+枚举）等，
打开即三侧一致可交互。

## 范围说明

仅涉及 JSON Schema 的可视化编辑、双向同步、表单预览与文档/版本持久化；
不含账户体系与第三方登录。支持 JSON Schema 的常用子集（根为 object、同构数组、
string/number/integer/boolean 标量及上述约束）。
