# 工作集工具拆分与审批设计

> 目标：解决工作集重复新建、周总结批量改动不可控的问题，同时保持实现足够简单，不引入过重的记忆工作流。

---

## 背景

当前工作集工具是 `upsert_working_item`，同时承担“新建”和“更新”。这导致几个问题：

- Agent 没有稳定拿到已有工作集 ID 时，容易把同一个项目反复新建。
- 如果传入不存在的 `id`，底层实际会插入新记录，但工具文案可能显示“已更新”。
- 周总结 / 手动合并会直接调用工具落库，缺少用户审批。

工作集是“我最近在搞什么”的快变量，可以被 Agent 更新，但仍然需要清晰边界：日常低风险写入要顺手，批量整理和合并要可确认、可追溯。

---

## 设计原则

1. 工具语义清楚，不再用一个 upsert 同时表达新建和更新。
2. system prompt 只在 session 创建时注入一次，不在 session 中途动态刷新。
3. 审批绑定到 pending tool call，而不是绑定到当前 Agent session。
4. 只对高影响工具加审批，避免日记流被频繁打断。
5. 数据库执行必须是确定性逻辑，不让审批后的落库再依赖 LLM。

---

## 非目标

- 不做通用“记忆变更计划系统”。
- 不做跨 session 的 Agent 暂停 / 恢复等待。
- 不在每次工具调用后重建 system prompt。
- 不物理删除重复工作集；合并时只更新状态和内容。
- 不给所有工具都加审批。

---

## 工作集工具拆分

### create_working_item

只负责新建工作集。

输入：

- `type`: `project` 或 `open_loop`
- `name`
- `status`
- `thesis`
- `current_questions`
- `decisions`
- `next_steps`
- `related_people`

规则：

- 新建成功后返回真实 `id`。
- 如果已存在同 `type`、同标准化 `name`、状态为 `active` 或 `dormant` 的条目，则拒绝新建，并在错误信息里返回候选已有条目的 `id` 和 `name`。
- 不允许用 create 覆盖已有条目。

标准化规则第一版只做 `trim()` + lowercase exact match，不做 fuzzy match、别名匹配或向量相似度。宁可漏掉少数语义重复，也不要为了“可能相似”误拦截正常新项目。

### update_working_item

只负责更新已有工作集。

输入：

- `id`: 必填
- 其它可更新字段同 `create_working_item`

规则：

- 找不到 `id` 直接报错。
- 不允许在 update 中隐式新建。
- 工具返回真实操作结果：`updated`。

### merge_working_items

用于合并重复或高度重叠的工作集。

输入：

- `keep_id`: 保留的工作集 ID
- `merge_ids`: 要合并进来的其它工作集 ID
- 合并后的字段：`name`、`status`、`thesis`、`current_questions`、`decisions`、`next_steps`、`related_people`
- `merged_item_status`: 被合并条目的新状态，默认 `dropped`

规则：

- Agent 调用时必须传入合并后的完整字段值；审批通过后不再让 LLM 参与生成内容。
- 只允许在审批通过后执行。
- 执行时用事务更新 `keep_id`，并把 `merge_ids` 标记为 `dropped` 或 `dormant`。
- 不物理删除记录，保留追溯能力。

---

## system prompt 中的工作集注入

工作集 snapshot 需要包含 ID，例如：

```text
## wi_mqjv0qsw_dbf2168137df | 个人 Agent（飞书）（project）
status: active
主旨：搭建一个基于飞书的个人 Agent，核心目标是让它越来越了解我
当前问题：日记导入的方式和节奏？
已决策：平台选定飞书
下一步：导入历史日记
```

补充规则：

- Agent 更新已有工作集时必须使用 snapshot 里的 `id`。
- 当前 session 内新建的工作集不会动态写回 system prompt。
- `create_working_item` 的工具结果会返回新 `id`；如果同一个 session 后续要改刚创建的条目，Agent 应使用这个工具结果里的 `id` 调 `update_working_item`。
- 新 session 创建时重新构建 snapshot，自然能看到上个 session 新增或更新后的工作集。

不动态刷新 system prompt 的原因：

- 当前架构本来就是 session 创建时注入记忆快照。
- session 内刷新 prompt 会增加状态复杂度，也会破坏 prefix cache 的简单性。
- 工具结果已经能覆盖“同一 session 内刚创建后再更新”的最小需求。

---

## 审批机制

审批对象是 pending tool call，不是 Agent session。

### pending_tool_approvals

新增一张最小表：

```sql
CREATE TABLE IF NOT EXISTS pending_tool_approvals (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  chat_id TEXT,
  message_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
```

`status` 取值：

- `pending`
- `approved`
- `rejected`
- `expired`
- `applied`
- `failed`

### 执行流程

1. Agent 调用需要审批的工具。
2. 工具不直接改业务表，而是写入 `pending_tool_approvals`。
3. 系统向飞书发送审批卡片，卡片按钮只带 `approval_id` 和动作。
4. 用户点击“应用”或“忽略”。
5. `cardAction` handler 读取 `approval_id` 对应的 payload。
6. 如果批准，则由确定性 executor 在事务中落库。
7. 落库成功后更新审批卡片状态。

关键点：

- 即使用户很久之后才点击，审批仍然可执行，因为 payload 已经持久化在 DB。
- 不要求原 Agent session 还活着。
- 批准后如果相关 chat 仍有活跃 session，可以 reset 该 session；如果已经过期，则不用处理，下一条消息会自然读到最新 snapshot。
- 审批 payload 是最终落库输入。executor 只做字段校验、事务更新和状态变更，不调用模型、不重新推理。
- 审批卡片只展示摘要：保留哪个条目、合并哪些条目、关键字段变化；全量 payload 保存在 DB，后续需要时再加详情查看，不把整段 JSON 塞进卡片。
- `pending` 超过 7 天仍未处理的审批视为过期；可以在用户点击时懒惰标记为 `expired`，也可以由后续定时清理任务统一处理。

---

## 哪些工具需要审批

第一版只审批高影响写入：

- `merge_working_items`
- 周总结 / 手动 `/consolidate` 中把工作集转为 `dormant`、`done`、`dropped` 的工具调用
- 周总结 / 手动 `/consolidate` 的单次运行中，计划修改 3 个或更多工作集的批量更新

第一版不审批：

- 日记轮内 `create_working_item`
- 日记轮内 `update_working_item`
- `write_episode`
- `search_diary`

原因：

- 日记轮是高频交互，频繁审批会打断使用。
- `create_working_item` / `update_working_item` 已经通过 ID 和重复检查降低误写概率。
- 周总结和合并是低频、高影响操作，更适合审批。

---

## 周总结与手动合并

当前周总结直接让 Agent 调工具落库。改造后：

- 周总结仍然生成自然语言总结。
- 工作集整理动作如果是高影响操作，转成待审批工具调用。
- 用户批准后才落库。

手动 `/consolidate` 与定时周总结共用同一套机制。

重复工作集合并可以作为周总结的一部分被提出，也可以后续加一个显式命令，例如 `/working-merge-suggestions`。第一版优先让周总结发现并提出合并建议，不新增命令。

---

## 当前重复工作集的处理方式

当前已有的重复工作集不手动删除。

后续实现 `merge_working_items` 后，用审批卡片提出一次合并：

- 选择一个保留条目作为 `keep_id`。
- 把其它重复条目放入 `merge_ids`。
- 合并字段时保留有效的 `decisions`、`current_questions`、`next_steps`。
- 被合并条目标记为 `dropped`，不物理删除。

这样既能修正 active 工作集污染，也保留历史记录。

---

## 实施顺序

### Phase 1：工具语义收敛

- 新增 `create_working_item`。
- 新增 `update_working_item`。
- 停用或移除 `upsert_working_item`。
- 工作集 snapshot 渲染 ID。
- `/working` 展示 ID。
- 工具结果返回真实 operation，避免“实际新建但显示更新”。

### Phase 2：审批基础设施

- 新增 `pending_tool_approvals` 表。
- 新增审批卡片渲染。
- 接入 `cardAction` handler。
- 实现 approval executor。

### Phase 3：合并工具与周总结接入

- 新增 `merge_working_items`。
- 将周总结中的高影响工作集变更改为审批工具。
- 手动 `/consolidate` 复用同一路径。
- 用审批卡片处理当前重复工作集。

---

## 验收标准

- Agent 不会再因为缺少 ID 把同名 active 工作集静默重复新建。
- `create_working_item` 命中已有同名同类型工作集时会失败并提示候选 ID。
- `update_working_item` 传入不存在的 ID 时会失败，不会隐式新增。
- 工作集 prompt 和 `/working` 都能看到 ID。
- 周总结提出的合并 / 批量状态变更不会直接落库，必须经用户审批。
- 审批卡片在原 session 过期后仍能执行或拒绝。
