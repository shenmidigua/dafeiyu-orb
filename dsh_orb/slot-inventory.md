# 槽位清单：有什么、在哪触发、排查时看哪

数据来自 `~/.dsh/dsh-orb/memes.json` 与 `packages/helper/assets/shell.js` 文件头那张表。
**权威是源码里的表**（`shell.js` 头部，29 行，编号连号）；这份文档是它的索引 + 排查手册。

---

## 一、一次性提示（播一遍就交还）

| # | 槽位 | 现在的文件 | 什么时候播 |
|---|---|---|---|
| 1 | `drag` | 拎起.gif + 悬空.gif | 你按住球在拖 |
| 2 | `drop` | 下落.gif | 拖拽松手落地 |
| 3 | `dockArrive` | 冒泡 1登场*.gif | 吸附后鼠标停在条上 —— **已暂停**，见 `DOCK_HOVER_ENABLED` |
| 4 | `click` | 摸头.gif（holdMs 1400） | 点了球一下 |
| 5 | `wake` | 叹号.gif | 麦克风听到唤醒词 |
| 6 | `ask` | 问号.gif | AI 停下来提问 |
| 7 | `nod` | 点头.gif | 你发了一条消息给 agent |
| 8 | `fail` | 停止工作.gif | 回合出错 **或**你按停止 |
| 9 | `done` | 摇铃.gif | 回合正常跑完 |
| 10 | `interrupted` | 惊吓.gif | 会话关闭时未收尾的回合被补发中断 |
| 11 | `approval` | 问号.gif | AI 等你批准工具 |
| 12 | `maxtokens` | 叹号.gif | 回合达到输出上限 |
| 13 | `arrive` | 到达.gif + 打招呼 1.gif | 页面加载完（每次加载一遍） |
| 14 | `typing` | 记录 1.gif | 你在**球面板**输入框里打字（窗口 3 s） |
| 15 | `reply` | 打字(普通).gif | 模型正在生成文字 |
| 16 | `tool` | 画板.gif | 模型正在调用工具 |
| 17 | `thinking` | 思考(认真地).gif | 模型在推理 |

**8–12 是同一套机制**（回合怎么结束），判定与排查见 `shell.js` 的规则 G/H。

## 二、别的会话（DSH 主窗口）里发生的事

复用上面的同名槽位，只是**排在 15–17 之后**——本页自己的状态优先。

| # | mode | 复用槽位 | 条件 |
|---|---|---|---|
| 18 | `reply-elsewhere` | `reply` | 主窗口在生成文字（窗口 2.5 s） |
| 19 | `tool-elsewhere` | `tool` | 主窗口在调用工具（窗口 4 s；主机带名字时用 `tool.tools`） |
| 20 | `thinking-elsewhere` | `thinking` | 主窗口在推理（窗口 4 s） |

## 三、条件成立就一直戴

| # | 槽位 | 现在的文件 | 条件 |
|---|---|---|---|
| 21 | `speak` | PNGTuber 说话.gif | 球正在朗读 |
| 22 | `voice` | 点头.gif | 麦克风在录音 / 转写中 |
| 23 | `hover` | 期待 2.gif + 打招呼 1.gif | 鼠标停在球上 |
| 24 | (无槽位) | avatar | 对话进行中 / 面板展开 |
| 25 | `sleep` | **关掉了**（`files: []`） | 闲置一段后打盹 |
| 26 | `skit` | 带薪拉屎 / 饮料 / 跳舞 1 | 闲置时每隔 gapMs 演一段（**别的会话在干活时不演**，规则 F） |
| 27 | `poor` | 吸氧.gif | 余额低于 `poor.below` |
| 28 | `idle` | PNGTuber 闲置.gif | 兜底 |
| 29 | (无槽位) | avatar 冻结 | 什么都没配时的最后兜底 |

**关掉的**：`sleep`、顶层 `enabled`（随机 burst）、`skit.interjects`、悬停弹出框（`DOCK_HOVER_ENABLED = false`）。

## 四、按工具名给脸（`tool.tools`）

`tool` 是共用脸；下表按工具名覆盖。**没列到的工具继续用共用脸**。

| 工具 | 文件 |
|---|---|
| `pwsh` | 打字(恼怒).gif |
| `edit` | 打字(普通).gif |
| `read` | 记录 1.gif |
| `grep` | 指.gif |
| `read_image` | 像素墨镜反光.gif |
| `todo_write` | 有主意了.gif |
| `subagent` | 扩音器.gif |
| `wait` | 加载(茶_咖啡杯).gif |

撤销：`node dsh_orb/restore_tool_faces.mjs`。改一条：`node dsh_orb/set_tool_face.mjs pwsh="xxx.gif"`。

**注意**：`wait` 内部会跑 `pwsh`，最后一个工具事件常是 `pwsh`，所以 `wait` 那张容易被覆盖。

## 五、排查时看哪（按上游到下游）

| 文件 | 记什么 |
|---|---|
| `~/.dsh/dsh-orb/tools.log` | 主机：`event turn/end own=…`（事件到没到、守卫放行没有）、`turn ended: <分类>`（分类成功没有）、`sent kind=…` / `suppressed …`（广播发没发、有没有被节流）；helper：`asked="grep" own-face=…`（页面问了什么、答了什么） |
| `~/.dsh/dsh-orb/stream.log` | 主机：`chunk kind seen from another conversation: …`（真实词汇）、`any session event reaches this plugin`（全局订阅第一个事件）、`tool (pwsh) arriving`（**每 15 秒的摘要**，短对话可能不写，别用它判断有没有名字） |
| helper 的 stderr | `undelivered message type=…` —— 消息类型 helper 不认识（规则 H 的坑 2） |
| `packages/helper/tests/turn-end-readers.test.ts` | 主机的分类表与页面的读取表是否对齐（坑 3） |

## 六、这条链上的四个静默失败（都踩过）

| 坑 | 现象 | 防护 |
|---|---|---|
| `reason` 读成了事件顶层 | 六类一个都不分类 | `turn-ending.test.ts` 用真实载荷钉住嵌套 |
| 发明了 helper 不认识的消息类型 | helper 静默丢弃 | 走 `session-turn` 通道；`deliver()` 现在未知类型会报错 |
| 页面读取表漏了 `ask` | 主窗口提问不出脸 | `turn-end-readers.test.ts` 比对两份名单 |
| 循环片只留 85% 的时长 | "一瞬间"，看不清 | `TURN_END_MIN_HOLD_MS = 2200`；工具脸是 `TOOL_FACE_HOLD_MS = 3000` |

## 七、为什么"球自己"和"主窗口"有时不一样

| | 球自己的对话 | DSH 主窗口 |
|---|---|---|
| 状态从哪来 | 页面读**自己的对话记录**（工具卡片、块） | 主机**广播**（`session-turn` / `outcome: 'ended'`） |
| 工具名 | 页面直接读卡片 | 主机从 `tool-call-delta` / `block-*` 里取，**带不过来就没有名字** |
| 回合结束 | `agentState` 那条路 | `turn/end` + `reason.kind`，**主机跳过自己的会话**以免播两遍 |
| 提问 / 审批 | `playAskFrame`（走块） | 走广播，**读取表漏了 `ask` 就在这里暴露** |

**所以一个改动只对上一边是常事** —— 这也是为什么"球自己的对话"一直好用，掩盖了主窗口那三条链上的三个坑。
