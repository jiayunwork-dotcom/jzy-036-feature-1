# JSON Schema 可视化表单生成器

浏览器内三栏联动的 JSON Schema 工具：

- **🏗️ 结构编辑区**：可视化增删字段、切换类型（string/number/integer/boolean/object/array）、
  编辑必填/长度/数值范围/正则/枚举/默认值、缩进反缩进调整嵌套层级；
- **📝 Schema 文本编辑区**：直接编辑原始 JSON Schema；
- **✅ 表单预览区**：按 Schema 即时渲染可填写表单（文本框/数字/勾选/下拉/分组/可增删数组），
  失焦即时校验、提交全量校验，违例拦截并定位到字段。

两侧文本与结构表达同一份 Schema，任意一侧改动实时同步；后端负责解析校验、双向变换、
控件映射、表单校验与文档/版本持久化（SQLite）。

## 可复用结构片段（Fragment）

把多处共用的字段结构（如「联系地址」、主/备联系人）**定义一次、到处引用**：

- **引用语法**：文本区写 `{ "$ref": "fragment:片段名" }`；结构模型用引用节点 `ref`
  表达，与内嵌定义节点并存——引用是**指向同一份定义的链路，不是复制品**。
  序列化/持久化/导入导出始终保留 `$ref`，绝不抄展开。
- **穿透生效**：控件映射、表单预览与校验在运行时按片段**当前**定义即时展开；
  改一次片段定义，所有引用处的控件与约束同步变化。
- **一等资源**：片段独立命名（名为身份）、独立 revision 乐观锁与版本历史；
  删除/修改前可查询被哪些文档、哪些位置引用（`GET /api/fragments/:name/references`）。
- **嵌套与无环**：片段可再引用片段（公司地址→省市区），但**不允许闭环**；
  闭环与悬空引用在「片段保存 / 文档保存 / 引用建立」边界即被拒绝，不拖到渲染时。
- **删除保护**：被引用中的片段可照常修改（复用的意义），但删除默认 **409 拒绝并列引用方**；
  显式 `cascade=true` 时在**单事务**内把引用处一跳内联为结构快照（快照内对其他片段的
  引用保留）再删除。
- **非法态统一**：悬空引用 / 闭环 / 片段定义不合法，全部并入既有「最近一次合法状态」
  回退机制——结构区与预览停留在最近合法展开，文本区给原因，恢复后自动接上。
- **回滚规则（晚绑定）**：文档历史版本中的引用，一律按**回滚时刻的当前片段**解释；
  回滚动作本身不因片段被改/被删而失败或产生脏数据——若片段已不在，历史文本原样还原为
  悬空引用，由同一套非法态/保存边界提示。
- **零破坏升级**：不含引用的老文档、空片段库的表现与升级前逐字节一致（测试覆盖）。

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
        types.ts              结构模型 FieldNode（内嵌定义 + ref 引用节点）/ Schema / 错误类型
        fragments.ts          片段库、引用收集、闭环/悬空检测、运行时展开、内嵌⇄引用转换
        fragmentService.ts    片段库构建、引用方扫描、保存校验、级联删除（事务）
        parser.ts             文本 -> 模型（含 $ref，永不抛异常，带行列定位）
        serialize.ts          模型 -> Schema（$ref 原样保留，确定性字段顺序）
        tree.ts               结构树操作（增删/改名/改类型/层级/转引用/收编）
        controls.ts           Schema -> 控件树映射（穿透片段当前定义）
        validate.ts           表单初始化 + 约束校验（按片段当前定义展开）
        sync.ts               ★ 双向同步状态机：「最近一次合法状态」回退（含引用失败）
        demo.ts               预置示范 Schema（嵌套对象/数组/枚举/约束的报名表）
      routes/
        schema.ts             引擎 HTTP：parse / serialize / controls / validate-form
        docs.ts               文档 CRUD、版本列表/查看/回滚（保存边界校验片段引用）
        fragments.ts          片段 CRUD、引用方、版本、删除保护/级联
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
tests/                        Vitest：101 个自动化用例
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

覆盖五类成功判据（共 101 个用例）：

| 文件 | 守住的判据 |
| --- | --- |
| `tests/roundtrip.test.ts` | 结构 → 文本 → 再解析回结构，语义不变；多轮往返幂等 |
| `tests/invalid-fallback.test.ts` | 非法 JSON/非法 Schema 时结构区停留在最近合法态不清空、错误含行列；恢复合法重新接上；非法期改结构以结构为准重建 |
| `tests/constraints.test.ts` | 必填、长度（码点）、数值范围/整数、正则、枚举、嵌套对象、数组项索引定位等违例拦截与合法放行 |
| `tests/controls.test.ts` | 六种类型到控件的映射及默认值初始化 |
| `tests/api.test.ts` | HTTP 解析/序列化/校验；导入导出等价；保存边界拒绝非法；版本轨迹与回滚后内容一致；多文档隔离与同文档并发 409 |
| `tests/fragments-engine.test.ts` | $ref 解析为引用节点、往返不展开；控件/校验穿透片段当前定义、改一处全局生效；悬空/闭环/自环/非法 $ref 在边界拒绝；内嵌⇄引用转换、一跳内联 |
| `tests/fragments-sync.test.ts` | 悬空/闭环/片段删改进同步状态机非法态与恢复；晚绑定重新校验不改写文本；结构侧转引用/收编 |
| `tests/fragments-api.test.ts` | 片段 CRUD/版本/乐观锁；保存片段拦截闭环悬空；删除保护列引用方 + 级联单事务内联；含引用文档保存/导入导出/校验；回滚按当前片段解释、片段删后回滚不失败 |
| `tests/ui-fragments.test.ts` | 结构区↔文本区引用双向表达、控件穿透、片段库更新跟随、悬空非法态（Vue 响应式） |

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
- `GET/POST /api/fragments`，`GET/PUT/DELETE /api/fragments/:name[?cascade=true]`
- `GET /api/fragments/:name/references`，`GET /api/fragments/:name/versions[/:version]`，
  `POST /api/fragments/:name/rollback/:version`
- `POST /api/schema/validate-fragment`（片段定义闭环/悬空预检）

片段引用写法：`{ "$ref": "fragment:片段名" }`（引用处仅可附 `title`/`description`，
约束统一由片段定义维护）。删除被引用片段默认返回 **409** 且 body 带 `references`
引用方清单；`DELETE ?cascade=true` 在单事务内把引用处内联为快照后删除。

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
