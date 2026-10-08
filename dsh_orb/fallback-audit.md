# 什么情况下球会回到「兜底」

`syncGif` 里**有 23 个判定**，从"你正在拖球"一路排到"余额不足"。**只要有一个成立，球就不在兜底**；
下面这些是**全都不成立**的时刻，也就是球会显示 `idle`（没配 idle 就显示冻结头像）的情形。

## 一、兜底的判定本身

```
if (broke || idleSrc !== undefined) { 戴 poor 或 idle; return }
if (gif.dataset.mode === 'still') return
戴冻结头像并冻结
```

`broke` = 余额低于 `poor.below`。所以"兜底"其实是**三种**：`poor` / `idle` / 冻结头像。

## 二、会落到兜底的情形（按实际遇到的频率排）

| # | 情形 | 为什么没有任何分支成立 | 能不能加动画 |
|---|---|---|---|
| 1 | **回合之间的闲暇 / 你还没说话** | 没有回合在跑：`agentState === ''`、没有一次性提示、没人悬停 | ❌ 这就是"闲置"，本来就该这样 |
| 2 | **模型在两次输出之间的停顿** | 思考与文字都是"正在输出的块"；**停顿的间隙里没有块在 running**，`agentState` 掉成 `''` | ⚠️ 可以（见下） |
| 3 | **模型在等工具结果**（本页自己的回合） | **这就是你看到的那个 bug**：工具块被标成"已结束"，`agentPhase()` 返回 `''` | ✅ **已修**（本轮） |
| 4 | **另一窗口在等工具结果** | 那边的等待期没有 `tool-call-delta` 帧（参数一次给全），也没有"正在跑"的信号 | ⚠️ 缺口仍在 |
| 5 | **面板展开但没配 `idle`** | `play` 需要 `expanded && idleSrc === undefined && !brokeNow()`；配了 idle 就不走这条 | ❌ 有 idle 就正常 |
| 6 | **`sleep` 关闭后的长时间闲置** | 打盹那串关了，`nap` 永远不成立 | ❌ 你自己关的 |
| 7 | **工具/思考的脸没配上文件** | 例如 `thinkingSrc === undefined`，则该分支跳过 | ⚠️ 配置问题 |

## 三、本轮修掉的那个（第 3 条）——根因

`orb.ts` 里 `tool/call` 事件**建块时写的是 `running: false`**：

```ts
this.block(key, 'tool', name, false, 'set', { args: clip(toolArguments(data), 4000) })
```

而 `agentPhase()`（页面侧唯一决定"球在不在干活"的函数）**只认 `block.running === true`**：

```js
for (const block of blockData.values()) {
  if (block.running !== true) continue      // ← 整段工具执行期间都在这里被跳过
  ...
}
if (tooling) return { state: 'tooling', tool }
return { state: thinking ? 'thinking' : '' }   // ← 于是返回空 → 兜底
```

**唯一**能把工具标成 running 的地方是 `tool-call-delta`（模型流式吐参数）。所以：

- 参数**流式**给 → 块 running → 球戴画板 ✅
- 参数**一次给全** → 块从建立起就是"已结束" → 球**整段执行都闲置** ❌ ← 你看到的现象

已改成 `running: true`（由 `tool/result` 落定，回合结束时 `finishTurn` 兜底收尾，不会卡住）。

## 四、"执行命令" 这类事件的现状

| 你在做什么 | 本页自己的回合 | 另一窗口（DSH 主界面） |
|---|---|---|
| 跑命令 / 读文件 / 搜索 | **画板**（本轮修好后） | **画板**（`block-start (block tool-call)` 已认） |
| 跑 `web_fetch` | **`打字(恼怒)`**（`webfetch` 槽位） | 同上（`webfetch-elsewhere`） |
| 思考 | 思考 | 思考 |
| 写回答 | 打字 | 打字 |

也就是说：**"执行命令"本来就有专属的 `tool` 槽位（画板.gif）**，它不是兜底——它之前是**因为 bug 才看起来像兜底**。

## 五、还想加动画的话，缺的是这两类信号

1. **"工具正在跑"的独立信号**（第 4 条）：现在只能从工具块推断。若要精确，需要主机在工具执行期间
   周期性发一条（像 `words` 那样），页面据此戴脸。
2. **"工具名 → 专属脸"**：现在只有 `web_fetch` 有专属槽位（`webfetch`）。想给"执行命令""读文件"各自一张脸，
   需要新增槽位（`bash`/`read`/`grep` …）+ 主机把工具名发给球。`agentPhase()` 已经带回了 `tool` 名字，
   所以页面侧是现成的，**缺的只是槽位与配置**。
