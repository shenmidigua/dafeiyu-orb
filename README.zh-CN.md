<p align="center"><img src="docs/assets/ball.png" width="120" alt="dsh-orb 悬浮球"></p>

# dsh-orb

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的非官方个人开发者插件。一个可安装的 bundle，为官方 dsh 桌面版和 `dsh web` 加上带 Computer Use 的悬浮球 Agent——官方仓库一行不改，主窗口仍是官方 dsh Web UI。

> **声明** — 本项目由个人开发者维护，**与 DeepSeek AI 无任何隶属、认可或合作关系**。DeepSeek 名称、Logo 与头像素材归 DeepSeek AI 所有，此处仅作为上游项目自带的默认球头像使用。

悬浮球停靠在屏幕右沿。告诉它你要什么：看得见的操作当场通过 Computer Use 执行；耗时长的复杂任务派给后台代码会话，完成后结果回到球里。主窗口保留完整的 dsh Web UI——会话管理、插件市场、模型设置——你仍然可以在里面写代码、改文件、跑命令。

不收集任何遥测数据。

## 悬浮球

启动后插件拉起自己的 helper（锁定并校验过的 Electron 运行时，独立 profile），球出现在主屏右沿，置顶。

- **悬停**在球旁浮出一张小卡片，只显示**最新一条回复**；指针离开即收起，**单击**钉住慢慢看。**拖动**移动球；拖出左右屏幕边缘后收成细条——再悬停即可滑回。
- **右键**打开菜单：打开主窗口、悬浮球 Agent 设置与后台 Agent 设置（两条轨各自选模型和思考强度）、坐标编码开关、极简回复开关（上限写在菜单项里）、整点报时开关（夜间静音窗口写在菜单项里）、「停用悬浮球」。球跟着官方 dsh 进程走——官方应用退出，球随之退出。
- 球上不再有对话框：对话、历史、权限芯片和输入框都已经搬到主窗口，球旁边那 320×190 的卡片只是一块「刚说了什么」的看板。旧面板的界面元素仍留在页面里（隐藏而非删除），因为它们每一个都被页面按 id 引着，删掉会让整页启动即崩、球也一起消失；要恢复旧面板，删掉 `floating.css` 末尾那段样式即可。
- 只剩一个例外：Agent 在球的会话里向你提问时，卡片会自动放大到可回答的尺寸（选项 / 自定义输入 / 取消），这是球上唯一还需要你动手的地方；不回答的话 Agent 会一直等。
- 朗读、语音唤醒与语音输入仍在球上生效——只是没有可见的输入框，听写结果直接提交给球的会话。外观跟随主窗口（暗色 / 浅色、中文 / English，即时切换）。
- 球头像可在主窗口**设置 → 悬浮球**里挑 6 张内置动图，或换成自定义 GIF / PNG / WebP（2 MB 以内）。内置动图保持动画：球处于活动状态时照常播放，与自带头像行为一致。

## 极简回复

球上的会话默认按「说给耳朵听」来回答：先给结论，正文不超过 80 字、不超过 3 行，不用表格、不罗列参考链接、不写「顺带一提」式的补充，也不用 Markdown 表格 / 多层列表 / 代码块——这些都念不出来。只有你明确说「展开」「详细说说」时才越过限制。

规则写在系统提示词里，只作用于球上的会话（含它派出的后台会话）；主窗口里的普通会话不受影响。开关和字数上限在 dsh profile 目录的 `orb-reply.json`（与 `orb-speech.json`、`orb-wake.json` 同级）：

```json
{ "enabled": true, "maxReplyChars": 80 }
```

- **关掉极简模式**：在球上**右键 → 极简回复（≤80 字）**取消勾选即可——勾着表示约束生效，菜单项本身就写着当前上限。也可以把 `"enabled"` 写成 `false`；删掉该文件等于回到默认（**开启**）。两种方式都是下一条回复就生效。
- `maxReplyChars` 取 20–2000，超界按边界处理；缺字段或写坏回落默认。菜单项显示当前生效的上限，改上限仍然改这个字段。
- 文件每次回答都重新读取，改完下一条回复就生效，不用重启 dsh。

## 整点报时

球在**每个整点**开口报一次时间——「现在是上午九点整。」——然后继续安静。一行字、一个整点，说完就结束，不翻旧账也不预告下一件事。用的是球自己的朗读服务，所以听起来和回复是同一个人。

- **开关**：球上**右键 → 整点报时**。勾上即生效，**取消再勾上会立刻念一遍当下的时间**——不用等到下一个整点就知道它是什么声音。没有配置朗读服务时该行会显示「需先开启朗读」并置灰，因为没有声音可念。
- **夜间静音**：默认 0–7 点不报时。窗口写在同一份配置里，可以跨午夜（`"quietFrom": 22, "quietTo": 6` 表示 22 点到次日 5 点静默）。
- **不会盖住你**：正在朗读回复、正在听写、或语音连续对话进行中（刚说完在等回复、等开口、麦克风正要打开），整点一律让路；这个整点的报时就跳过，不会插进来。
- 配置在 dsh profile 目录的 `orb-chime.json`（与 `orb-speech.json`、`orb-wake.json` 同级），删掉即回到默认（开启、0–7 点静音）：

```json
{ "enabled": true, "quietFrom": 0, "quietTo": 7 }
```

- 开关由菜单写（只改 `enabled`），静音窗口由文件改（`quietFrom` / `quietTo` 取 0–24，两端相等表示整夜也报）。两个方向都是下一个整点生效，不用重启 dsh。
- 定时器按墙上时钟重算而不是「每小时加一小时」，机器睡过整点、或者整点那一下晚了超过 90 秒，就直接跳过这一小时——从不报一个已经不准的时间。

## 双轨 Agent 架构

由球内的 Computer Use Agent 决定每条消息怎么处理，运行时没有独立的任务分类器：

```mermaid
flowchart TD
    user["你对悬浮球说话"] --> orb["Computer Use Agent"]
    orb -->|"看得见的 GUI 操作"| gui["13 个 GUI 工具<br>在当前窗口当场执行"]
    orb -->|"快问快答：天气、新闻"| web["web_search / web_fetch<br>球上直接回答"]
    orb -->|"翻文件、产出文档或网站"| bg["code_agent 后台会话<br>派出即返回"]
    bg -->|"完成通知"| orb
```

- **前台轨 · Computer Use**：看得见的操作——打开应用、点按钮、填表单、改设置——用 GUI 工具当着你的面执行，每一步都基于前台窗口的实时截图。天气、新闻这类快问快答也留在球上，用 `web_search` / `web_fetch` 直接回答。
- **后台轨 · Code Agent**：复杂任务——翻文件、产出文档、搭网站——经 `code_agent` 派给后台标准会话。派出立即返回，球会告诉你后台在跑，你可以继续聊。后台会话结束且球空闲时，完成摘要自动回到球里，Computer Use Agent 决定下一步——继续点击、再派后台，还是收尾。

后台会话和你在主窗口手动建的会话是同一种；它出现在主窗口侧栏的 `dsh_orb` 文件夹里，可以打开、继续或停止。同一产物的后续修改回到同一个后台会话，无关的新工作另开一个。对话历史、权限、两条轨的模型设置都与官方 dsh 进程共享——球读写的就是主窗口的那份会话。

## Computer Use

球上的每条对话都带 Computer Use：第一条消息自动附上前台应用可见窗口的截图，之后每个动作都跟一张新截图（含鼠标光标），模型始终看到最新屏幕状态。

- Agent 操作期间，截图自动排除球、展开面板和观察边框，点击穿透球而不是落在球上；被观察的窗口有一圈发光的观察边框，标出 Agent 正在看哪里。非操作期间球是普通窗口，截图录屏照常包含。
- 工具列表：`click`（单击/双击/右键，支持修饰键）、`input_text`、`scroll`、`hotkey`、`long_press`、`drag`、`wait`、`long_wait`、`screenshot`（存到桌面并复制到剪贴板）、`open_in_browser`、`open_in_finder`、`list_apps`、`open_app`。
- **macOS**：第一次操作屏幕时，系统权限弹窗的授权对象是 **DeepSeek Harness**（桌面版）或你的终端（`dsh web`）——请对那个进程授权。球内的引导层会带你完成「屏幕录制」和「辅助功能」两项授权。
- **Windows**：无需系统权限引导；以管理员运行的窗口拒绝被点击和输入。
- 安装本插件即授权：GUI 工具不会逐次点击询问。

## 工作原理

```
DeepSeek Harness（官方，不改）
└─ Electron 壳（主窗口、dsh://open、单实例）
     └─ Host，以纯 Node 进程拉起（ELECTRON_RUN_AS_NODE=1）
          └─ dsh-orb 插件
               ├─ host — 会话、权限、模型、web 路由、helper 生命周期
               ├─ computer-use — 13 个 GUI 工具 + code_agent（Computer Use preset）
               └─ client-settings — 主窗口「悬浮球」设置节

Helper（自带的下载版 Electron，独立 userData）
├─ 球窗口、观察边框
└─ 数据请求 → 官方 Host 的鉴权 loopback URL
```

- 只装一个包：`dsh-orb` bundle 在构建时把 host、Computer Use 插件、helper 和设置页装配进自身。
- helper 运行时是官方原版 Electron 发布物，以 SHA-256 钉死（darwin/win32，arm64/x64），首次使用时下载并与钉死的哈希比对；运行在独立的 `userData`，与官方应用分开。
- helper 与 host 之间是只听 loopback 的 NDJSON socket，用每次启动随机生成的 32 字节 token 鉴权，只经环境变量传递——不进 argv、不落盘。带官方凭据的鉴权 URL 永远不交给 helper。
- 看门狗：socket 断开 helper 自行退出；host 最多重试 3 次。球起不来时，主窗口里的 Computer Use 仍然可用。

## 环境要求

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：桌面版，或 CLI 的 `dsh web`。按 dsh `0.1.7-rc.2` 编译；声明的兼容范围是 `>=0.1.7-rc.2 <0.3.0-0`。
- macOS（Apple Silicon / Intel）或 Windows x64。Linux 会加载插件但不建球——后台代码会话仍可用。
- Node.js `^22.19.0 || >=24.0.0` 与 pnpm `11.7.0`（仅从源码构建时需要）。

## 安装

### 从发布版安装

发布到 npm 后，按包名安装：

- **桌面版**：应用内打开插件页，添加包名 `dsh-orb`。
- **CLI**（`dsh web`）：`dsh plugin add dsh-orb`。

### 从本地构建安装

```sh
pnpm install
pnpm build
pnpm --filter dsh-orb pack        # 生成 ./dsh-orb-0.0.0.tgz
```

然后在桌面版插件页添加这个 tarball，或者：

```sh
dsh plugin add ./dsh-orb-0.0.0.tgz
```

首次使用悬浮球时会下载 helper 的 Electron 运行时，之后缓存复用。

## 开发

```sh
pnpm typecheck   # 各包 tsc 检查
pnpm test        # node:test 套件 + computer-use 的 vitest 套件
pnpm build       # 构建全部包并装配 bundle
```

本插件的设计文档在 [docs/](docs/)——可行性分析、架构、分阶段实施与持续追加的修订记录。

## 状态与已知限制

- **划词工具条**（划词后搜索 / 翻译 / 发给 Agent）修复缺陷期间暂时停用；代码保留，但所有入口已撤下，偏好里强制关闭。
- 按 dsh `0.1.7-rc.2` 构建与测试；兼容范围内的新版 dsh 可能需要重新验证。
- Linux 上没有悬浮球；无显示器的环境仍可跑后台代码会话。
- macOS 权限弹窗写的是 DeepSeek Harness 或终端，不是本插件——权限归属承载 Agent 的进程，这是系统行为。

## 与 DeepSeek Harness 的关系

本仓库是在 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 之上构建的非官方衍生作品。dsh 是 DeepSeek 开源的 everything-is-a-plugin Agent 框架，会话、插件、工具与 Web UI 全部由它驱动。本项目不改任何上游代码——像普通第三方 dsh 插件一样安装。想深入了解：

- [docs/01-analysis.md](docs/01-analysis.md) — 可行性与产品决定
- [docs/02-architecture.md](docs/02-architecture.md) — 进程、包、通信、安全
- [packages/computer-use/README.md](packages/computer-use/README.md) — GUI 工具、坐标编码与权限细节

## 许可证

[MIT](LICENSE)。上游衍生的代码与素材在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 中披露。
