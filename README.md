# JSON Schema 可视化表单生成器

浏览器内三栏联动的 JSON Schema 工具：

- **🏗️ 结构编辑区**：可视化增删字段、切换类型（string/number/integer/boolean/object/array）、
  编辑必填/长度/数值范围/正则/枚举/默认值、缩进反缩进调整嵌套层级；字段还能**转换为对可复用
  结构片段的引用**，引用节点醒目标识、就地不展开；
- **📝 Schema 文本编辑区**：直接编辑原始 JSON Schema，含片段引用写法
  `{"$fragment": "<key>"}`；
- **🧩 结构片段库**：把共用结构（如"联系地址""省市区"）定义一次、独立命名、独立留版本历史，
  在任意文档/片段中引用；改一次定义，所有引用处的控件、预览与校验即时按当前定义生效；
- **✅ 表单预览区**：按 Schema（片段引用穿透到片段当前定义）即时渲染可填写表单
  （文本框/数字/勾选/下拉/分组/可增删数组），失焦即时校验、提交全量校验，违例拦截并定位到字段。

两侧文本与结构表达同一份 Schema，任意一侧改动实时同步；后端负责解析校验、双向变换、
控件映射、表单校验与文档/片段/版本持久化（SQLite）。

## 可复用结构片段（Fragment）的关键语义

- **结构模型有两种节点**：内嵌定义 `FieldNode` 与片段引用 `RefNode`（判别字段 `kind:"ref"`）。
  引用节点只持有片段 key，不持有类型与约束——它是指向片段唯一定义的一条链路，不是复制品。
- **存指针不展开**：解析得到引用节点；序列化输出 `$fragment`；保存、导入导出、结构↔文本往返
  全程保留引用。文档里永远不内联片段内容。
- **唯一穿透点**：控件映射 / 默认值初始化 / 表单校验都基于 `resolveModel(model, lib)` 生成的
  「按片段当前定义展开」的虚拟视图（每次全新副本，不回写模型）。片段一改，多处同步。
- **片段可嵌套引用片段**，但**不允许闭环**（含自环）：片段保存 / 文档保存边界做三色 DFS
  图校验，闭环与悬空引用当场拒绝，不拖到渲染期。
- **删除守卫**：片段仍被引用（直接或经其他片段间接引用）时删除被 **409 拒绝**，响应列出
  引用方（文档/片段、字段路径、是否间接）；显式 `?mode=detach` 才先摘除全部引用（引用方
  自动产生新版本）再**软删除归档**。
- **回滚规则（明确且前后一致）**：回滚文档到历史版本时——引用的片段**仍存活**则保持指针、
  按片段**当前定义**解释（文档内容逐字回到历史版本）；片段**已删除（归档）**则用其归档的
  最后定义**就地展开**为内嵌字段，其中仍存活的嵌套片段保持引用。回滚动作本身永不因片段
  状态失败，产物始终可严格解析、无脏数据。
- **老文档零偏差**：片段库为空或文档不含 `$fragment` 时，解析/编辑/校验/保存/回滚与升级前
  逐字一致（回滚对无引用内容走完全旧的快路径）。
- **非法态通道复用**：悬空引用、闭环、片段定义非法全部归入文本区既有「非法态」——保留最近
  一次合法结构、给出原因、恢复合法后自动重新接上，不另起错误处理。

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
        types.ts              结构模型：内嵌 FieldNode / 引用 RefNode / 片段库 / 错误类型
        parser.ts             文本 -> 模型（$fragment 解析为引用节点；永不抛异常，带行列定位）
        serialize.ts          模型 -> Schema（引用原样输出 $fragment；确定性字段顺序）
        fragments.ts          ★ 片段核心：建库/图校验(闭环·悬空)/唯一穿透点 resolveModel/
                              引用收集与影响路径/回滚物化 materializeArchived/detach 剪枝
        tree.ts               结构树操作（增删/改名/改类型/层级；内嵌↔引用转换）
        controls.ts           穿透后视图 -> 控件树映射
        validate.ts           穿透后视图：表单数据初始化 + 约束校验（错误定位到字段路径）
        sync.ts               ★ 双向同步状态机：「最近一次合法状态」回退（含片段失败场景）
        demo.ts               预置示范 Schema（嵌套对象/数组/枚举/约束的报名表）
  web/                        Vue 3 + TypeScript + Vite
    src/
      App.vue                 顶栏（文档/片段库/导入导出/版本入口）+ 三栏布局
      api.ts                  后端接口封装
      stores/syncSession.ts   同步会话（reactive 包装引擎状态机 + 片段库 + 穿透视图）
      stores/docs.ts          多文档/版本/回滚 store
      stores/fragments.ts     片段库 store（拉取/建库/保存/删除守卫）
      components/
        StructureEditor.vue   结构编辑区外壳（新增内嵌字段 / 新增引用）
        SchemaNode.vue        递归节点：引用节点外观 + 内嵌↔引用互转 + 约束面板
        FragmentsDialog.vue   ★ 片段库管理（新建/编辑/版本/引用影响范围/带守卫删除）
        TextEditor.vue        文本编辑区（错误条 + 位置提示）
        FormPreview.vue       表单预览（基于穿透视图；校验/提交/重置）
        FormField.vue         递归预览字段（object 分组 / arraylist / 标量控件）
        VersionsDialog.vue    历史版本查看与回滚
tests/                        Vitest：102 个自动化用例
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

覆盖（共 102 个用例）：

| 文件 | 守住的判据 |
| --- | --- |
| `tests/roundtrip.test.ts` | 结构 → 文本 → 再解析回结构，语义不变；多轮往返幂等 |
| `tests/invalid-fallback.test.ts` | 非法 JSON/非法 Schema 时结构区停留在最近合法态不清空、错误含行列；恢复合法重新接上；非法期改结构以结构为准重建 |
| `tests/constraints.test.ts` | 必填、长度（码点）、数值范围/整数、正则、枚举、嵌套对象、数组项索引定位等违例拦截与合法放行 |
| `tests/controls.test.ts` | 六种类型到控件的映射及默认值初始化 |
| `tests/ui-sync.test.ts` | 前端响应式会话在合法/非法/恢复/结构→文本下的联动 |
| `tests/fragments.test.ts` | ★ 引擎：引用节点不展开/序列化存指针/往返等价；穿透按片段当前定义、一处改多处同步；嵌套片段；闭环/悬空/坏片段在边界拦截；非法态通道复用；内嵌↔引用互转；回滚物化与 detach 原语 |
| `tests/ui-fragments.test.ts` | ★ 前端会话 × 片段库：引用节点解析、改定义穿透视图同步、片段删除悬空非法态、重建后接上 |
| `tests/fragments-api.test.ts` | ★ HTTP：片段 CRUD/版本/乐观锁；含引用文档保存与穿透控件/校验；改片段全局生效；闭环自保存拦截；删除守卫列出引用方（含路径与间接）；detach 级联；导入导出保引用；回滚在片段存活/已删两种状态下的规则；老文档逐字不变 |
| `tests/api.test.ts` | HTTP 解析/序列化/校验；导入导出等价；保存边界拒绝非法；版本轨迹与回滚后内容一致；多文档隔离与同文档并发 409 |

## 双向同步与「最近一次合法状态」的关键设计

1. 全应用只有一个同步会话（`sync.ts` 的状态机），其不变量是
   **`session.model` 永远是最近一次合法 Schema 的结构模型（含引用节点，引用不展开）**。
2. `setText()`：交给 `parser.parseSchemaText(text, {lib, fragmentErrors})`（**永不抛异常**）。
   - 合法 → 用新模型替换 `session.model`，结构区/预览即时刷新；
   - 非法（JSON 语法错误带行列、语义不支持、**片段悬空 / 闭环 / 片段定义非法**）→
     只置 `valid=false` 与错误原因，**`model` 一个字段都不动**，所以可视化树不会被清空；
     文本内容也不会被回滚覆盖。
3. `syncFromModel()`：结构侧任何编辑后以模型为准重新确定性序列化文本，valid 回到 true。
4. 片段库通过 `setFragmentLib()` 注入：片段增删改后用同一 `setText` 通道重新解释当前文本，
   因此片段相关的失败天然复用「非法态 + 最近合法回退」，不另起一套错误处理。
5. 前端跑在浏览器里的引擎与服务端是**同一份源码**（`server/src/engine` 经 Vite alias 引入），
   服务端另外在保存/导入边界做权威解析（携带即时构建的片段库与片段图校验结果），
   HTTP `/parse` 对非法输入返回 `200 + ok:false`（工具不崩），非法内容永远无法持久化。

## HTTP 接口摘要

- `POST /api/schema/parse` `{text}` → `{ok, model, controls}` 或 `{ok:false,error,line,column}`
  （model 中引用节点形如 `{kind:"ref", ref, name}`；controls 已穿透片段当前定义）
- `POST /api/schema/serialize` `{model}` → `{ok,text}`（引用序列化为 `$fragment`，不展开）
- `POST /api/schema/controls` `{text}` → `{ok,controls}`（穿透引用）
- `POST /api/schema/validate-form` `{text,data}` → `{valid,errors:[{loc,message}],defaults}`
- `GET/POST /api/documents`，`GET/PUT/PATCH/DELETE /api/documents/:id`
- `GET /api/documents/:id/versions[/::version]`，`POST /api/documents/:id/rollback/:version`
  （回滚响应含 `materialized`：是否有已删片段被就地展开）
- 片段（与文档对齐的一等资源）：
  - `GET/POST /api/fragments`，`GET/PUT/DELETE /api/fragments/:key`
  - `GET /api/fragments/:key/versions`（版本轨迹）
  - `GET /api/fragments/:key/usage`（引用影响范围：文档/片段、字段路径、是否间接）
  - 删除：`DELETE /api/fragments/:key` 默认被引用时 **409** 并附 `references`；
    `DELETE /api/fragments/:key?mode=detach` 显式摘除全部引用后归档

保存与回滚都要求携带 `expectedRevision`（乐观锁）：同一文档并发保存时，后到的旧版本写入
收到 **409** 被拒绝；不同文档各自行隔离，互不覆盖。每次内容更新追加一条 `versions` 快照，
**回滚 = 把所选历史版本内容写成新版本**，轨迹连续可再回滚。

## 预置示范

首次启动自动创建「示范：技术沙龙报名表」，包含必填文本（长度）、邮箱/邮编正则、
整数范围、字符串枚举默认值、布尔默认值、嵌套地址对象、对象数组（项内必填+枚举）等，
打开即三侧一致可交互。

## 范围说明

仅涉及 JSON Schema 的可视化编辑、双向同步、表单预览，以及文档与**可复用结构片段**的
版本持久化；不含账户体系、权限分级与第三方登录，也不涉及本工具之外的系统集成。
支持 JSON Schema 的常用子集（文档根为 object、同构数组、
string/number/integer/boolean 标量及上述约束）；片段根可以是任意受支持类型（含标量/数组，
也可本身指向另一片段），片段引用图不允许闭环。
