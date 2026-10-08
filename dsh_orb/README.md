# dsh_orb 操作笔记

这个目录放的是**诊断与验证脚本**，不是插件源码（源码在 `packages/`）。这里记的是"改完之后怎么让它生效、怎么确认真的生效"——这几天反复用到的那些。

## 改动生效的路径

插件装在 `~/.dsh/profiles/desktop/node_modules/dsh-orb`，**不是**仓库里跑。改完源码必须：

```powershell
# 1) 编译（改了 packages/*/src/*.ts 才需要）
cd packages/helper; node <tsdown> ; cd ../host; node <tsdown>

# 2) 组装（**必须走这一步**，它把 native-selection 复制进 dist/ 并把主机的裸导入重写成相对路径）
cd packages/bundle; node ./scripts/assemble.mjs --out <临时目录>

# 3) 装机
#    把 <临时目录>\dist 与 \lib 覆盖到 node_modules\dsh-orb，另加 client.js / package.json / cordis.patch.yml
```

**只编 `packages/host` 就复制过去会把球弄坏**：`dist/host/index.js` 里有一句
`import … from '@dsh-orb/native-selection'`，而那个包只有 `assemble.mjs` 会放进 `dist/`。漏了它 →
插件**加载阶段**就 `ERR_MODULE_NOT_FOUND` → 球根本起不来（而且因为它自己加载失败，没有任何日志）。
用 `probe_host_start.mjs` 可以先行验证：它把已安装的 bundle 真的 `apply()` 一次，加载失败会直接显形。

## 什么时候必须重启 DSH

| 改了什么 | 要不要重启 DSH |
|---|---|
| `packages/host/src/*.ts`（主机） | **要**。主机跑在 DSH 进程里。 |
| `packages/helper/src/main.ts`（helper 主进程） | **要**（主机只在新 helper 启动时读它）。 |
| `packages/helper/assets/*`（页面 JS/CSS）、`preload.cjs` | **要**（页面只在 helper 启动时读一次）。 |
| `~/.dsh/dsh-orb/memes.json` | **不用**。有 10 秒 TTL，改完自动生效。 |

重启：`python dsh_orb/restart_helper.py`（只重启球）或加 `--dsh`（重启整个 DSH）。
**重启 DSH 会连带结束正在跑的会话**，所以由人来按，不要让 agent 自己按。

## 观察手段（看不见的东西怎么验）

- **球窗口的画面**：`watch_ball_frames.py` 抓窗口像素并算差异，`match_ball_face.py` 拿它跟包里的 GIF 比对。
- **哪些 GIF 真的被读了**：`watch_clip_reads.py snapshot/compare`。注意页面加载时会对**所有已配置帧**做一次
  扫描，所以**同一秒的一批 atime 不算播放**，只有加载之后新增的读取才是。
- **别让探针骗你**：`吸氧.gif` 那次就是例子——它被读是因为**随机 burst**抽中了它，与 `poor` 槽位无关。
- **主机日志默认看不到**（打在 DSH 进程的 stderr 里）。需要观察时，代码里临时加一个固定路径的落盘出口
  （例如 `~/.dsh/dsh-orb/stream.log`），验完删掉。

## 跨会话事件：已确认可行（2026-10-08）

主机里 `ctx.on('session/event', …, { global: true })` 与 `agent/assistant-stream`（同样 global）**确实能
把"别的会话"的事件送过来**。验证方式：主机收到**非本球会话**的第一帧时，写一行到

```
~/.dsh/dsh-orb/stream.log
```

重启 DSH 后在主界面说一句话，该文件里出现：

```
<时间> assistant stream reaches another session (session-fc4dd328-…) — the feed is global
<时间> words arriving in session-fc4dd328-… (1 frames so far)
```

页面那一半也当场验过：球闲置时抓窗口像素得到一套帧哈希（约 1.3 s 一循环），流式输出时得到**几乎完全
不重叠**的另一套，且存下来的 PNG 里就是 `打字(普通).gif`（趴在小键盘上的形象）。

这条为什么当初没验成：同一天早些时候的同一个实验里，同时存在"表情包总开关被关"和"随机 burst"两个干扰，
球没反应被误读成了订阅失败。**教训**：这条链最形象的失败方式是"什么都不发生"，与"页面没重绘"无法区分
——所以先让"收到事件"这件事**落盘可见**，再接播放逻辑。

`stream.log` 的写入点留在代码里（`orb.ts` 的 `noteOtherStream`）：它是这条链唯一的可观测证据，
DSH 升级若改变行为，它会第一个告诉你。

## 表情包规则

"什么动画在什么条件下播"的**唯一权威清单**在 `packages/helper/assets/shell.js` 的文件头
（`syncGif` 的分支顺序 = 优先级）。`memes.ts` 只负责把槽位名解析成文件。
随机 burst 不在那张表里：它由页面自己的定时器驱动，从整个 `dir` 目录随机抽，
`memes.json` 顶层那个 `enabled` **只管它**，不是总开关。
