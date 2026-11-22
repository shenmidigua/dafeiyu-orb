# 修订记录

> 2026-09-28 对照源码和本机官方预览之后，对初版分析的修改。实施不要以本文的旧结论为准；规格在 [01-analysis.md](01-analysis.md)、[02-architecture.md](02-architecture.md)、[03-plan.md](03-plan.md)。
>
> 初版分析的日期也是 2026-09-28。下面「保留」的条目已经写进新的三份规格。「改掉」的条目不要再实现。

## 1. 保留并写进规格的

这些和源码一致，新文档直接采用了。

- Host 以 `ELECTRON_RUN_AS_NODE=1` 启动，插件进程里没有 `electron` 模块。
- 用户安装单位是带 `dsh.bundle.patch` 的 bundle。`dsh plugin add` 有 registry、绝对路径、tarball、git 四种 spec。
- 官方 CLI 不能管理 `desktop` profile。桌面安装走应用内插件页，`desktopPnpm.runExternalMarketPluginInstall` 存在。
- `tool-computer-use` 是 `"private": true`，要改名再发布。13 个 GUI 工具、`code_agent` 的 `whenIdle` + `followup`、可选的 `orbCodeAgentModel` / `orbCoordinateMode` 都属实。
- `floating.js` 除了 fetch，还有 `window.dshDesktop`。preload 必须在 helper 里复刻，否则页面第一行就没有 API。
- `ui-settings-orb` 在官方主窗口拿不到 `dshDesktop.orb`，会静默隐藏。数据面改 HTTP。
- `orb-agent-models.ts` 和壳侧 `orb-permission.ts` 要搬进 Host，不能只搬 desktop-host 里那几个被动服务。
- 依赖必须钉住官方发布版本。初版分析记录的 dist-tag 现象仍然有效：`latest` 偏旧，新版本在 `next`。编译对照的版本是 `0.1.7-rc.2`。安装范围是 `>=0.1.7-rc.2 <0.3.0-0`，不包含 `0.3.0` 的预发布版。
- Windows Computer Use 用 koffi 调系统 DLL，没有单独的预编译产物。划词的预编译工作主要在 macOS。
- 行数：`floating-window.ts` 961、`floating.js` 1448、`preload.ts` 88、`orb-agent-models.ts` 102，以及初版分析列出的其它文件行数，在当前 fork HEAD 上仍然相符。`api.floating` 31 处、`api.backend` 2 处、`api.locale` 1 处，也相符。

## 2. 改掉的

### 2.1 helper 运行时

初版分析把「spawn 官方 `process.execPath`，去掉 `ELECTRON_RUN_AS_NODE`，把我们的入口脚本喂进去」写成已经核实的主路径，下载 Electron 只是失败后的兜底。

源码只证明 Host 是用官方可执行文件以 Node 模式拉起的。已打包的 Electron 启动自己的 `app.asar`，额外参数不会换成另一份 main。官方 `single-instance.ts` 在拿不到锁时直接 `quit`。桌面版和 `dsh web` 的 helper 都使用下载的通用 Electron。`DSH_ORB_ELECTRON_PATH` 只给开发。

### 2.2 紧凑聊天

初版分析打算原样 vendor `ui-overlay-chat`，并让球的 iframe 打开 `index.html?surface=overlay`。

官方 `ui-layout` 总会注册 `root`。fork 能让出这个槽，是因为它改了官方包 `packages/client/ui-layout`，并在 `packages/api/session-controller` 里新增了 `overlayClientSurface`。官方 `0.1.7-rc.2` 没有这个导出。再注册同一个 `root` 会抛错；若 client 包去 import 不存在的导出，还可能让整个 Web UI 加载失败。

对话 UI 做在 helper 里。不修改、不替换官方 `ui-layout`。

### 2.3 preset 的两条通道

初版分析要求同时插入 `dsh-agent-preset` 行，以及 `agent-presets` + `computerUsePresetRoot` 目录。依据是 `apps/desktop-host/tests/overlay.spec.ts` 和 `apps/desktop-host/config/desktop.cordis.patch.yml`。

该 yml 不在当前 HEAD 里。官方 preset 注册表读的是声明行上的 `name`、`description`、`order`、`plugins`。旧的 `$DSH_HOME/.agent-presets/` 目录不再被读取。`preset-root.ts` 不进入发布物。显示名「Computer Use 模式」写在声明的 `config.name` 上。

### 2.4 `dsh-app://` 与 `listen: false`

初版分析把自定义 scheme、`listen: false`、`desktop-fetch.ts` 说成 fork 独有，并说官方桌面只提供 loopback。

官方壳同样注册了 `dsh-app`，并用 `forwardWebRequest` 转到 Host 的 loopback。`desktop-fetch.ts` 在当前 fork 里只被自己的测试引用。官方和当前 fork 的桌面 Host 都在听 TCP，并发送 `ctx.connection.authenticatedUrl(...)`。规格采用这条官方基址。helper 可以自己再注册一个 `dsh-app` 做转发，那是为了少改 `floating.js`，不是因为官方没有 scheme。

### 2.5 打开主窗口

初版分析写官方没有 URL scheme。官方 `main.ts` 在打包应用里调用 `setAsDefaultProtocolClient('dsh')`，`dsh://open` 会聚焦主窗口。macOS 用 `open dsh://open`。

### 2.6 原生模块被签名拦住

初版分析把「官方 Desktop 的 library validation 可能拦住 koffi 和 dylib」列为低到中风险，并要求阶段 1 第一天在官方桌面上实测。

2026-09-28 已在 `/Applications/DeepSeek Harness.app` `0.1.7-rc.2` 上实测：

- `codesign` 显示 hardened runtime，且 `com.apple.security.cs.disable-library-validation` 为真。团队 ID `NAN929V4UM`。
- 该可执行文件在 `ELECTRON_RUN_AS_NODE=1` 下加载了 koffi、ad-hoc 的 `libmacos-sck-capture.dylib` 和 ad-hoc 的 `macos-sck-napi.node`。
- 同一进程执行 `screencapture` 得到 160×160 PNG；执行 `osascript` 读到前台应用名。
- 同一进程调用 ScreenCaptureKit napi 的 `capture()` 超过 30 秒无输出，进程已结束。这不是签名拒绝，是 Node 模式没有 Cocoa 主循环，而 dylib 在等主队列。

因此 Mac 上「装了插件却完全不能 Computer Use」不成立。规格改为：常规截图和点击继续走子进程；采集排除放在 helper 窗口上。

### 2.7 计数

初版分析把 client 插件从 70 改成 71。按 `packages/` 里带 `dsh.client` 的包计算，官方 `master` 是 68 个，fork 另加 `ui-overlay-chat` 和 `ui-settings-orb`，合计 70。这个数字不参与实现。真实 bundle（去掉 `@local` 模板和测试 fixture）仍是 11 个，这一点保留。

## 3. 产品决定

这些是审核时一起定下来的，初版分析里没有写清楚。

- 用户只安装 `dsh-orb` 一个插件，就同时得到 preset 和悬浮球。
- 球跟着官方 dsh 进程。菜单是「停用悬浮球」，不是退出整个官方应用。
- 权限弹窗上的名字用官方应用或终端，引导文案照实写。
- Linux 不建球。
- 不把「等官方合并一个建窗 API」放进计划。

## 4. 截图必须带鼠标(2026-09-30)

Agent 执行期间看不到光标:点偏了无法自查,会误判为「点了没反应」。规格补一条:鼠标在采集范围内就必须出现在截图里,范围外可不管。两条采集路径都改:

- 常规路径(生产唯一路径,排除表恒空):`screencapture -x` 加 `-C`,由 WindowServer 把系统光标原位烤进全屏图,sips 裁剪后光标随裁剪保留。本机 macOS 26 实测光标位置与真实指针一致。
- SCK helper 路径(CLI 与 dylib 共用):`SCScreenshotManager` 的 `showsCursor` 在各版本上表现不一且窗口滤镜根本不含光标层,改为 `showsCursor = false` + 捕获后手动合成:SkyLight `CGSCopyCursor`(macOS 26 已无此符号,回落 `NSCursor.currentSystem`)取真实光标位图,再画一圈红底白边的定位环,环心即指针精确位置——热点换算按返回 CGImage 的实际倍率(`representations.first` 可能低于实际返回的倍率,曾导致尖端偏 5pt)。指针在区域外(留 12pt 边距)则原图返回,光标隐藏时不画,避免幻影。

合成逻辑带 `-D DSH_SCK_COMPOSITE_TEST` 独立测试入口(合成 2x 位图实拍验证尖端与环心重合)。本机 SCK 的内容枚举拿不到 displays 且流启动失败(macOS 26 环境先在问题),region 路径端到端仍以实机为准;Windows 的 GDI `capturePng` 同样不含光标,留待后续(已解决,见第 10 节)。

## 5. Agent 执行期间遮蔽悬浮球(2026-09-30)

对齐原版 deepseek-harness 的 overlay guard 语义:悬浮球平时可被截图/录屏(用户手动截图照常含球),但 Agent 自己的采集里必须看不到自家 chrome——否则球进观察图,Agent 可能对着球点击。覆盖球、划词工具条、观察框三个窗口,Windows 与 macOS 一致生效。

- helper 侧(packages/helper/src/cloak.ts + overlays.ts):refcount 遮蔽,`capture`/`input` 两个计数,任一 >0 即对所有 chrome 窗口 `setContentProtection(true)`;计数归零恢复常开状态。input 区间额外把球设为点击穿透(`setIgnoreMouseEvents(true, {forward:false})` + `blur`),让 CGEvent/SendInput 落到下层应用。观察框在 Windows 保留静止态保护(原版 observation-frame-window 同款,它停在观察区外围整轮可见)。新增 `overlay-capture {id, active}` socket 消息,与 `overlay-input` 对称;helper 随 host 断连退出,计数不跨进程存活,无需 reset 管道。
- host 侧(packages/host/src/overlay-guard.ts):`withCapture` 从直通改为真握手——depth 0 且 helper 在线时发 `overlay-capture begin`,等 ack 后再等 50ms(保护开关到达 WindowServer/WDA 的裕量)才放行采集,finally 补发 end(失败吞掉,helper 重启自愈)。input 区间内的嵌套 capture 不再发消息:整个 HID burst 期间保护本来就由 input 计数持有,省两次往返和 settle。
- 平台差异说明:原版 macOS 靠 SCK 按 CGWindowID 排除、Windows 靠 WDA_EXCLUDEFROMCAPTURE;本 fork 的采集路径是 `screencapture -x -C`(无法按 id 排除),故 macOS 也走动态 NSWindowSharingNone——效果与原版一致(采集瞬间从截图中消失,物理屏幕始终可见),但用户录屏时球会在每次 Agent 采集的几百毫秒里短暂消失,Windows 原版本就如此。
- 球窗口创建时的两处常开 `setContentProtection` 与工具条的一处已删除:静止态必须可被截取,开关全权归遮蔽。
- 测试:helper/tests/cloak.test.ts(静止态/区间开关/穿透/refcount 嵌套/窗口销毁容错/reset),host/tests/selection.test.ts 改写 overlay guard 组(capture 握手、无 helper 直通、input 内嵌套不发、失败仍补 end)。

补丁(同日):实测点击仍会落在球上——`setIgnoreMouseEvents` 设置后 WindowServer 的命中测试要过几十毫秒才提交,而 helper 应用完立即回 ack,Agent 的 CGEvent/SendInput 与这个提交赛跑。原版 `floating-window.ts` 的 `OVERLAY_GUARD_INPUT_APPLY_MS = 80` 就是为此存在("Milliseconds Electron waits after click-through before acking input begin, so WindowServer hit-testing has committed"),fork 从未移植。现补上:cloak.ts 新增 `scheduleCloakAck`,input-begin 的 ack 延迟 80ms 再回(从应用点击穿透那一刻起算;helper 繁忙时 timer 晚触发则裕量自动拉长),ack 到达即 host 放行 HID 的信号——时序与原版 helper 侧延迟完全一致;capture 区间与 input-end 仍立即回 ack。这个裕量是平台无关的,Windows(SendInput)与 macOS(CGEventPost)同样生效。

## 6. 悬浮球文字可选中复制 + 消息复制按钮与 Token 用量(2026-09-30)

对齐主窗口 chat 语义:悬浮球展开框里的对话内容此前全局 `user-select: none`,一个字都选不中,也没有任何复制入口。

- 可选中:`floating.css` 保持 html/body 全局 none(球/工具条等 chrome 不受拖选干扰),`#transcript` 单独放开 `user-select: text`,`#transcript button` 再收回 none;helper 的 `context-menu` 在 `params.hasSelection` 时放行系统菜单(Copy),裸右键仍是球自身菜单,与 `isEditable` 同一处理。
- 消息动作行(官方 MessageIconActions 的极简版,无 Fork/点赞/点踩):用户气泡下方右对齐一个复制图标按钮,复制气泡原文;assistant 回复下方一个复制图标按钮(复制原始 markdown,经 WeakMap 随 upsert 更新)+ Token 用量 pill。流式期间动作行隐藏,落定后出现;折叠语义不破坏(动作行在 block 内,随 `data-response` 折叠)。
- Token 用量:官方 `assistant/message` 事件本就带 `usage?: TokenUsage`(dsh-session 事件表),host 在 `onAssistant` 落定时把 usage 挂到该消息最后一个 assistant 块上单独再广播一条(推理块不带);`block()` 合并语义为「带 usage 即替换、不带则保留前值」,消息降级(response 反标记)与 finishTurn settleBlock 都经同一合并,usage 不丢。渲染端 pill 文案 `{count} tok`、总计 = 未缓存输入 + 缓存读 + 缓存写 + 输出(官方 UsagePill 的 billed 口径,不信 provider total),缩放格式与官方 formatTokens 一致(999 → `999`,1234 → `1.2K`,≥1M → `1.2M`),悬停 title「本轮用量」/「Turn usage」。
- 复制实现抽出 `writeClipboard`(navigator.clipboard 优先,execCommand 回落),卡内代码块复制与消息复制共用;消息按钮复制成功后图标换勾 1.2s。
- 新增 COPY/CHECK 两个 16px current-color 图标(icons.js)。测试:transcript-model 组补 tokenUsageTotal/formatTokenCount/usageLabels 与页面接线断言,host runtime 组新增「usage 只落在收尾回复块」用例(含降级保留)。Electron 44 冒烟实测:气泡/正文 computed user-select=text,动作行与用量 pill 正常渲染。

## 7. 悬浮球外观与语言跟随主窗口(2026-09-30)

球窗口、划词工具条与主窗口设置页此前不跟随官方「外观/语言」设置:CSS 的暗色 token 都在(键 `body[data-ds-dark-theme]`,从上游搬来),但页面只按系统 `prefers-color-scheme` 点亮;文案则各自读 `navigator.language`——系统英文 + dsh 设中文时,主窗口全中文、悬浮球设置页却是英文。现在两边都镜像官方设置文档(`ui-theme.preference`、`locale.preference`):

- host(packages/host/src/appearance.ts):经官方 `settings` 服务 `describe()` 读两个命名空间,订阅 `settings/document-updated`(cordis `emit` 无 thisArg 时全量投递,普通 `ctx.on` 即可收到);变化经 `setAppearance()` 存进 OrbRuntime 并广播 `appearance {theme, locale}` socket 消息,helper 连上时 `accept()` 补发,`launch()` 再把当前值塞进 `DSH_ORB_APPEARANCE` 环境变量——启动即正确,不等 socket 握手。
- helper 主进程:`nativeTheme.themeSource` 指到存储的偏好(`system`/缺省回落系统),renderer 的 `prefers-color-scheme` 随之而动(与官方 preload-theme 同机制),`updated` 事件(含 OS 换肤)把解析后的 `{dark, locale}` 推给球与工具条;原生菜单和千分比弹窗文案改读镜像语言(存储偏好 zh/en 前缀命中,否则按系统语言,与官方 detectBrowserLocale 的回落次序一致)。工具条窗口的转发走 overlays.ts 新增的 `appearance()` 方法。
- 球页面(shell.js):`messages`/`chatLabels`/`usageText` 改为可变,appearance 消息触发 `refreshAllText()`——静态文案收进 `applyStaticText()`(自查询,避免 TDZ),权限菜单/历史列表/进行中的提问卡/TCC 门(存最近一次状态)/过程组标签全部按新字典重绘,transcript 按 `blockData`(每个 block key 的最后一条消息)重跑 updateToolNode/updateAssistantNode,已渲染块的语言即时切换。`removeBlock`/`clearTranscript` 同步清理 blockData。
- 划词工具条:CSS 补 `body[data-ds-dark-theme]` 暗色变量(取值同球壳 floating.css),标签文案改走 `applyUiLanguage`,暗色与语言都经 `orb:appearance` 推送,matchMedia 作连接前的回落。观察框无文字,不动。
- 设置页(client-settings/client.js):`copy()` 改读 `<html lang>`(dsh-client-locale 会把解析后的语言落在上面,`zh-CN`),回落 navigator;组件挂 MutationObserver 重渲染,设置节随主窗口语言即时切换。开关配色改用官方 token(`--dsw-static-neutral-bluish-00` 滑块、`--dsw-alias-button-info-fill` 开态),明暗两态都成立。
- 测试:host/tests/appearance.test.ts(读取、缺省、事件过滤、去重、服务缺失),runtime 组新增「appearance 握手补发与变更推送」;设置页测试补「跟随 <html lang>」用例。Electron runtime 冒烟(.zcode/smoke/):真实 preload 通道灌 appearance,球页 zh↔en 切换(标题/占位/aria)、nativeTheme dark→body 属性 + 面板底色 rgb(255,255,255)→rgb(21,21,23)、工具条文案与暗色背景,SMOKE-PASS。

补丁（同日）：真机上复制按钮点了没反应——球是 `showInactive` 的非激活 panel，点击时 `document.hasFocus()` 为 false，Chromium 的 `navigator.clipboard.writeText` 直接 reject（"Document is not focused"），而回落只在 API 不存在时触发，被拒绝即静默返回。改走主进程：preload 新增 `copy(text)`（`orb:copy`，ipcRenderer.send），helper main 收到后 `clipboard.writeText`（fromBall 校验 + 100 万字符上限）——主进程写剪贴板不依赖文档焦点。`writeClipboard` 优先走桥，navigator.clipboard/execCommand 保留为无 preload 时的回落；代码块卡片的复制按钮同路径一并修好（此前同病）。Electron 44 冒烟：点击两个消息复制按钮，`pbpaste` 读回的正是所复制的正文。

## 8. 划词功能全面下线(2026-09-30)

划词功能存在 bug,先从所有 UI 撤下并全局关闭,代码保留待修复后再放开:

- 右键菜单(packages/helper/src/menu.ts):删掉「划词工具栏」复选框项,`ContextMenuState.selectionEnabled` 与 `ContextMenuActions.setSelection` 一并移除;helper main.ts 的 `ChromeState`/`readChrome`/`showMenu` 同步删字段。
- 设置页(packages/client-settings/client.js):删掉「划词工具栏」卡片、「划词不可用」横幅与 zh/en 四条 selection 文案。
- 强制关闭(packages/host/src/preferences.ts):`readSelection` 不再读 `selection-toolbar.json` 里的 `enabled`,恒返回 `false`——默认与已开启过的 profile 全部落到关闭态;文件里的 `translateTargetLanguage` 仍读取。socket `set-selection` 与 `POST /.dsh-orb/selection` API 保留但无 UI 入口,写入值重启后被忽略。
- chrome 广播(orb.ts `publishChrome`)不再携带 `selectionEnabled`(helper 已不读)。
- 测试:menu 组更新菜单项列表与索引;preferences 组断言默认 false 且已存 `enabled: true` 的文件读回 false;runtime 组 set-selection 用例改发 `enabled: true` 验证 socket 写路径(默认已 false,原用例 waitFor 瞬时通过导致文件未落盘 ENOENT);设置页组改为反向断言 client.js 源码不含「划词」/`selectionToggle`。222 项全过,`pnpm build` 装配后 bundle/helper 产物无「划词」字样。

## 9. 悬浮球内置动图头像(2026-09-30)

头像此前只有「上传一张」和「恢复默认」两个选择。现在设置页给出 6 张内置动图,点一下即换,上传与恢复默认照旧;内置资源是真动画 GIF,在设置页缩略图和球上都照常播放。

- 资源(`packages/helper/assets/avatars/`):6 张 512×512 / 45–51 帧 / 3.0–3.4s 的源动图按 256×256 重编码(ffmpeg `scale=256:256` + `palettegen`/`paletteuse`,`-loop 0`,帧数与逐帧延时原样保留),单张 1.9–2.5 MB,合计约 12 MB(原图 39 MB)。球是 72px,256 在 3x 屏上仍有余量;`point`/`rice`/`heart`/`cheer`/`cheeks`/`smile` 对应指点/干饭/比心/欢呼/托腮/微笑。
- 分发路径:内置 GIF 不走 socket 也不走 data URL——球页面按相对路径 `avatars/<file>.gif` 自己读盘(helper 的 `fetchAvatar` 有 2.5 MB 上限,兆级 GIF 走那条路必然失败,且 base64 会卡住每次 chrome 广播)。host 只发描述:`{type:'avatar', kind:'preset', src:'avatars/heart.gif', version}`,上传仍是 `kind:'custom'`(走原 HTTP 取字节 → data URL),默认是 `kind:'default'`。helper 侧新增 `packages/helper/src/avatar.ts` 专职解析,`src` 只接受 `^[a-z0-9][a-z0-9_-]*(/[a-z0-9_-]+)*\.gif$`(挡掉父目录跳转与 `file:` 等 scheme),不合法即回落默认。球页面(shell.js)不用改:`onAvatar` 本来就接受相对路径。
- 存储(packages/host/src/preferences.ts):`orb-avatar.json` 升为单一事实源,`{kind:'preset', preset}` 选内置、`{kind:'custom', mime}` 上传、旧版只有 `{mime}` 的文件仍按上传读。`avatarSelection()` 每次都对磁盘现状校验,未知 preset id(插件降级/资源被删)或半写状态一律回落自带 GIF。一个 profile 只有一张头像:上传会覆盖 preset 选择,选 preset 会删掉上传的字节。`avatarVersion()` 从 `orb-avatar` 的 mtime 改为 `orb-avatar.json` 优先(preset 只写 meta,版本必须跟着动),浏览器预览与球的重取都以此为缓存键。
- 路由(packages/host/src/routes.ts):新增 `GET/.dsh-orb/avatar/preset/<id>`(设置页画廊取字节,未知 id 404,不走 helper token 旁路)与 `POST /.dsh-orb/avatar/preset {preset}`(400 invalid-preset);`GET /.dsh-orb/avatar` 现在按当前选择返回内置/上传/自带三选一。快照新增 `avatarPresetId`(当前选中的 id)与 `avatarPresets[]`(id + url);画廊 URL 不带 `?v=`,否则任一次头像变动都会让设置页重取 6 张兆级 GIF。目录清单在 `packages/host/src/avatar-presets.ts`,相对路径由 host 生成,因此路径布局只此一处;id → 文案的字典在设置页(client.js `avatarPresetNames`),host 不持有 UI 文案。
- 设置页:头像卡片在上传/恢复默认下面多一排动图缩略图(48px 圆形,自带预览 72px),选中项描边用官方 `--dsh-alias-button-info-fill`,点击 POST 选,`aria-pressed` 跟随快照;`avatarPresets` 缺失时整排不渲染(老 host 不会画出空框)。
- 测试:helper 新增 avatar 组(src 合法性、custom 需要 version、旧消息回落);host preferences 组补「一个 profile 一张头像」全流程(选/传互斥、未知 id、半写状态、旧 meta);routes 组补画廊列表、字节、鉴权、目录穿越、选中后 `/avatar` 返回同一份字节、非法 id 400;runtime 组补「连上即发 avatar 描述、选 preset 后带 src」;设置页组按 host 真清单渲染画廊并断言每个 id 都有中文名(host 加 preset 而设置页漏文案会直接红)、点击 POST 的 body、选中描边;bundle 装配清单改为遍历 `assets/avatars/` 全量断言。`pnpm typecheck` 与全量测试通过。
- Electron 冒烟(`.zcode/smoke/orb-avatar-smoke.cjs`,装配后的 `dist/helper/assets`):按生产通道灌 `orb:avatar` 字符串,断言内置 GIF 在真实 CSP 下解码成功(256×256)、静止态照旧冻结成 still(canvas 快照,256×256)、展开/运行时球面真的在动——用 `capturePage` 对球的矩形连续取帧,静止态 4 帧完全相同(排除重绘伪影的对照),播放态 8 帧帧帧不同;灌 `''` 后回到自带 512×512 头像。SMOKE-PASS。冻结首帧是 fork 既有语义(离线省电),内置动图与自带头像行为一致:静止收起时定格首帧,展开/运行/提问时播放。

## 10. Windows 球抢焦点:排除自身窗口、提交后交还前台、截图补光标(2026-09-30)

Windows 上的实测反馈:在浏览器里点球、输入、回车提交后,**Agent 把悬浮球自己当成了"用户正在使用的应用"**——观察边框照着球画。根因两条,叠加才发作:

- Windows 上球是可激活的普通窗口(`packages/helper/src/main.ts`:`focusable: true`,`type: 'panel'` 只在 darwin 设置),点它就把系统前台抢过去,`GetForegroundWindow` 当场变成球的面板。
- 选观察窗口的逻辑本来就会跳过 overlay —— 但那条排除列表**从没接线**:`packages/host/src/overlay-guard.ts` 里 `withCapture` 一直硬编码 `run({ excludeWindowIds: [] })`。macOS 不需要它(非激活 panel 从不当前台),所以这个缺口一直没暴露;接到 Windows 就表现为"跳过列表为空 → 前台是谁就认谁 → 认成球"。

三处修复,全部按 `win32` 门控,macOS 路径与行为不变。

- **排除自身窗口(主修复)**:helper 新增 `packages/helper/src/chrome-windows.ts`——`windowIdFromHandle(buffer)` 把 Electron 的原生句柄转成与 host 侧 `hwndId()` 同一个数值(指针宽度 → `Number(BigUInt64)`,要求安全整数;两边对不上排除就是空转),`collectChromeWindowIds()` 仅 win32 产出。socket 连上、发完 `hello` 后追加一条 `{type:'chrome-windows', ids:[球,工具条,观察边框]}`(断线重连会重发;窗口是进程级单例,不需要变更推送)。host 侧 `orb.ts` 新增校验(`readWindowIds`:正整数安全整数、≤16 条、**任一条不合法即整条丢弃**,宁可退回"不排除"也不做半份排除)并按 socket 存,`chromeWindowIds()` 取并集,guard transport 新增 `chromeWindowIds?()`,`withCapture` 的两个分支都填入 `run({ excludeWindowIds })`。顺带修掉一个隐藏缺口:HID 区间内的嵌套采集此前恒拿空数组,也就是"点击动作之后的那张复采"仍会认错窗口——现在同样带着排除表。macOS 侧 helper 不上报 → 列表恒空 → 与原行为逐字节一致。
- **提交后交还前台**:host 新增 `packages/host/src/windows-foreground.ts`(win32-only,koffi 惰性 `createRequire`,与 `tcc.ts` 同一写法):250ms 采样 `GetForegroundWindow`,跳过 chrome 句柄,记住最后一个**非球**的前台窗口。`orb.ts` 在 helper 连上时 `start()`、断开与 `halt()` 时 `stop()`,并在 `onPrompt` 里、`sessionController.prompt` 之前 `restore()`——用与 computer-use `becomeForeground` 同款的 Alt + `SetForegroundWindow`(本进程没收到最后一次输入时 `SetForegroundWindow` 会被忽略,补一次 Alt 转移即可),保证早于 `agent/pre-step` 的首次采集;目标窗口已关闭则静默跳过。只在提交时触发,看历史/点菜单/收起面板都不动前台。
- **Windows 截图补鼠标光标**(补齐第 4 节的尾巴):macOS 生产路径是 `screencapture -x -C`,由 WindowServer 把真实光标原位烤进图;Windows 的 GDI `BitBlt` 不含光标层,于是 Agent 点偏了无法自查。新增 `packages/computer-use/src/cursor.ts`(纯函数:`cursorDrawPlacement` 按热点换算并留 12px 边界余量、指针更远则不画、光标隐藏不画、空/非有限值一律不画;`resolveCursorAlpha` 优先 alpha 通道、无 alpha 的旧式光标回落 AND mask;`compositeCursor` alpha 混合并裁剪;`flipRows` 行翻转)。`windows-native.ts` 的 `capturePng` 在 `BitBlt` 与 `GetDIBits` 之后合成:`GetCursorInfo`(`CURSOR_SHOWING`)+ `GetIconInfo`(热点 + 两个位图),`GetIconInfo` 交出的两个位图 `DeleteObject` 防 GDI 泄漏,新增 `DSH_CU_CURSORINFO`/`ICONINFO`/`BITMAP` 结构与 x64 布局断言;采集栅格改为翻转成 top-down 后 `encodeBgraPng(bottomUp=false)`。镜像的是 macOS 生产路径(真实光标、原位),不含 SCK 备用路径那圈红白定位环。
- 测试:computer-use 新增 `cursor.spec.ts` 14 例(热点定位、越界/边距、隐藏光标、DPI 缩放、alpha 混合、mask 回落、行翻转);helper 新增 `chrome-windows.test.ts` 4 例(8/4 字节句柄、0 与非安全整数、平台门控、句柄读取失败);host 新增 `overlay-guard.test.ts` 3 例(句柄流入两个分支、无 helper 时也排除、macOS 式空列表)与 `windows-foreground.test.ts` 4 例(记住用户窗口、忽略 chrome、持续采样与停止、原生调用抛错不致命);`runtime.test.ts` 新增 socket 级用例(上报 → guard 的 `excludeWindowIds`、畸形载荷整条丢弃,harness 补 `provide` 捕获与 overlay 自动 ack 以免等满 1s 超时)。新增 12 个 node:test 用例 + 14 个 vitest 用例,`pnpm typecheck`、`pnpm build` 通过;全量与改动前基线对照:新增用例全过,失败数不变(见下条)。
- **Windows 实机待验证(本仓库此前零 Windows 实测记录)**:① `getNativeWindowHandle()` 的 HWND 与 `listWindows().hwnd` 是否相等——这条不成立则排除列表空转,需临时打点核对;② `WDA_EXCLUDEFROMCAPTURE` 是否真把球挡在 GDI `BitBlt` 之外(第 5 节的遮蔽机制在 Windows 从未实测),若无效则加 win32 门控的兜底:采集区间直接隐藏 chrome 窗口;③ HID 期间点击穿透是否落在下层窗口、且不把球重新激活;④ 混合 DPI 多屏下光标位置与大小;⑤ 端到端:浏览器在前台 → 点球 → 输入 → 回车 → 观察边框围住浏览器、截图无球、光标可见、前台已交还。
- **Windows 上既有的测试失败(与本次改动无关,改动前后基线一致,均为环境性)**:`host/tests/preferences.test.ts` 与 `runtime.test.ts` 的 millifraction 用例(win32 默认千分比坐标,测试按 macOS 默认值写)、`client-settings` 的设置页用例(Windows 检出为 CRLF,测试正则按 LF 写)、`bundle` 的装配用例(`symlinkSync` 在 Windows 需要开发者模式/管理员,EPERM)。另 `computer-use` 的 `open.spec.ts`/`tools.spec.ts` 用 POSIX 路径(`/etc`)在 Windows 必失败——后者顺带暴露一个真实缺口:`open_in_finder` 的 `PATH_BLACKLIST` 只有 POSIX 前缀(`open.ts`),Windows 上 `C:\Windows` 这类路径不受护栏保护,且分隔符按 `/` 匹配,留待后续单独处理。

## 11. Windows 右键菜单「打开主窗口」没反应(2026-09-30)

现象:Windows 上悬浮球右键 → 打开主窗口,毫无反应;macOS 正常。排查与修复:

- **系统层没问题**:注册表里 `dsh` 协议注册正确(`"…\DeepSeek Harness.exe" "%1"`),在干净环境里 `cmd /c start "" dsh://open` 实测能把最小化的主窗口唤醒。
- **对照实验定位根因**:同一条命令加上 `ELECTRON_RUN_AS_NODE=1` 就完全没反应。host 正是以纯 Node 模式被官方应用拉起的,它 spawn 的 `cmd` 继承了这个标记,Windows 于是也以 Node 模式启动 `DeepSeek Harness.exe`——单实例转发根本没发生,自然不会弹窗。helper 启动早有同样处理(`orb.ts` 的 `delete env.ELECTRON_RUN_AS_NODE`,注释写明"保证 electron 当 app 跑"),打开主窗口这条路径此前漏了。
- **修复**(`packages/host/src/open-main.ts`):新增 `openEnvironment()`——复制环境并删掉 `ELECTRON_RUN_AS_NODE`,`spawnOpen` 用它作为子进程环境。macOS 走 `open`,由 LaunchServices 启动应用、拿不到这个环境,因此不受影响(该函数在 darwin 上是惰性的)。
- **验证**:真机在 `ELECTRON_RUN_AS_NODE=1` 下调用真实 `openMainWindow`,最小化的主窗口被唤醒并成为前台(`IsIconic=False`、前台窗口即主窗口);修复前同一条件无反应。
- **测试**:`host/tests/open-main.test.ts` 新增用例(删标记、保留其余变量、不改动调用方对象)。

## 12. 极简回复:球上的会话默认只说结论(2026-11-19)

球说的每句话都要被念出来,而「念」对文本有硬约束:表格、链接清单、代码块、三层嵌套列表都变成一串读不懂的音节。所以球上的会话默认按「说给耳朵听」来回答——先给结论,正文控制在 80 字、3 行以内,不用表格与 Markdown 结构,也不写「顺带一提」式的补充;只有用户明确说「展开」「详细说说」时才越过限制。

- **注入方式**(`packages/host/src/reply-style.ts`):`registerReplyStyle(ctx, store)` 往 prompt 组装里挂一个文本 provider,把 `store.reply()` 读到的规则拼成一段 section。provider 每次组装都重读 `orb-reply.json`,所以改开关或改上限是**下一条回复就生效**,既不重载 helper 也不重开 dsh。
- **只作用于球**:section 只在 `isOrbSession()` 为真时出现(含球派出的后台会话);主窗口里的普通会话拿到的是空字符串,行为与以前完全一样。
- **配置**(`packages/host/src/preferences.ts`):`orb-reply.json` = `{ enabled, maxReplyChars }`,默认 `{ true, 80 }`。`maxReplyChars` 夹取 20–2000(超界按边界处理),缺字段或写坏回落默认;`setReply` 先重读再写整份文件、只改传入字段——与 `setWakeEnabled` 同一套做法,用户随时可能在背后手改。
- **测试**:`host/tests/reply-style.test.ts` 覆盖规则文本与开关;`host/tests/preferences.test.ts` 覆盖默认值、夹取与落盘。

## 13. 极简回复开关进球的右键菜单(2026-11-19)

规则能落盘还不够——用户得能在一秒钟内关掉它,而球上唯一的入口就是右键菜单。

- **入口**(`packages/helper/src/menu.ts`):`ContextMenuState` 加 `replyEnabled` / `replyMaxChars`,`ContextMenuActions` 加 `setReply`;菜单行是 `type: 'checkbox'`,`checked` 取 host 广播来的 `chrome.reply.enabled`。上限直接写进文案(中文「极简回复（≤N 字）」、英文 `Minimal replies (≤N chars)`),因为那个数字在别处看不见。
- **链路**:菜单点击 → `write({ type: 'set-reply', enabled })`(`helper/src/main.ts` 的 `showMenu`)→ `orb.ts` 的 `onControl` → `setReplyEnabled()`;helper 侧的 `chrome` 消息新增 `reply: { enabled, maxReplyChars }` 字段,点击后重新广播,勾选态立刻跟着变。
- **不重载**:切开关只广播 chrome,不重建 helper,球窗不会闪一下。
- **测试**:`helper/tests/menu.test.ts` 补一条菜单用例(勾选态、`≤N 字` 文案跟配置走、点击两个方向都发 `setReply`)并更新既有的 `contextMenuTemplate` 调用;`host/tests/runtime.test.ts` 补端到端一条——`menu` 广播初始是 `{enabled:true, maxReplyChars:80}` → `set-reply false` → 文件落盘 `{"enabled":false,"maxReplyChars":80}` → 球的会话 section 变空、主窗口仍为空 → 再 `set-reply true` → section 回来且写着 80 字。

## 14. 整点报时(2026-11-20)

球在每个整点说一句时间。「现在是上午九点整。」一行字,说完就结束。这是球能主动提供的唯一一种信息,所以它的价值全在克制:一个整点、一句话、一个准确的时刻。

动手前工作区里已经有一版未提交的半成品(`shell.js` 的 `scheduleHourly`),但它有三处接不上:静默窗口硬编码 0–7;唯一的关闭方式是 `?hourly=off` 这个 URL 参数,而 helper 用 `loadFile('floating.html')` 从不带 query,于是这条开关是死代码——实际行为是「只要开了朗读就永远报时」,也没有任何菜单或设置入口;它还和朗读开关绑死,用户想关掉报时只能连朗读一起关。**它也从没进过安装包**:装好的 `dist/helper/assets/shell.js` 里没有 `hourly`,所以此前一次都没响过。

- **判定收进纯函数**(`packages/helper/assets/chime.js`):`hourlyLine(hour)`(零点/上午/中午/下午/晚上的措辞、12 与 0 的绕回)、`isQuietHour(hour, settings)`(支持跨午夜 `22 → 6`,`from === to` 表示整夜也报)、`chimeWanted({ hour, settings, now, at, canSpeak })`(开关 / 静默窗口 / 迟到 90 秒 / 是否有人在说话,四件事一个入口)、`nextHourAt(now)`、`normalizeChime(value)`(夹取 0–24)。放这里而不是页面里,是因为它们都是**可听出来的错**:3:04 报「三点」、凌晨四点开嗓、或者盖住正在念的回复。
- **配置**(`packages/host/src/preferences.ts`):`orb-chime.json`,`{ enabled, quietFrom, quietTo }`,默认 `{ true, 0, 7 }`——开启是因为球本来就是用户主动装的东西,一次没响过的报时没法评价;0–7 静音是因为凌晨四点响一次就是最快的卸载理由。`setChime` 先重读再写整份文件、只改传入字段(与 `setReply` 同一套做法,用户随时可能在背后手改),`chime()` 每次读盘,手改下一个整点生效,越界值夹取到 0–24 而不是信它。
- **链路**:`chrome` 广播新增 `chime` 字段 → helper `ChromeState` 读入(每字段独立回落)→ `orb:chime` 推送(收到 `chrome` 时一次、`did-finish-load` 再一次,免得页面重载后回到出厂默认);菜单点击 `write({ type: 'set-chime', enabled })` → host `setChimeEnabled()`(值没变就不写盘也不广播)。页面定时器**不因设置变化重排**:它在响的那一刻才读 `chime`,所以切换开关不会堆出第二个定时器。
- **菜单行**(`packages/helper/src/menu.ts`):`整点报时（0–7 点静音）`,勾选态来自 `chrome.chime.enabled`。静默窗口写进文案,因为那个数字在别处看不见;`quietFrom === quietTo` 时只写「整点报时」,不写「0–0 点静音」那种听起来像午夜静默的假区间。没有朗读服务时置灰并改成「整点报时（需先开启朗读）」——勾了却不出声是这个标签要避免的失败。
- **开启即试听**:`applyChime` 在 off→on 的沿上念一遍当前时间(`previewChime`),不受静默窗口约束(这一刻是用户自己要的)。理由很简单:一个开关如果唯一的证据是一小时后那声响,用户没法验证它。试听走同一条 `speaker.speak(..., 'hourly')` 路径,所以听到的就是整点会听到的。
- **不抢话**:页面用既有的 `maySpeakUp()` 回答「现在能不能说话」——正在朗读回复、听写中、或语音连续对话处于任何非空闲状态(说完等回复的 armed、等开口的 waiting、麦克风待开的 opening),任一为真就让路,这个整点直接跳过,不排队补报。原先只挡 `waiting`,但 `opening` 一响就会被录制进去、`armed` 一响会替对话把回合交出去,所以判据改成 `continuousVoice.active`。
- **测试**:新增 `helper/tests/chime.test.ts` 20 例(措辞、12/13/18/23 与 0 的绕回、跨午夜窗口与空窗口、迟到阈值、`canSpeak` 缺省视为否、让路判据、下一个整点跨午夜不漂移、夹取,以及「页面/helper/preload/host 四处接线都在」的源码断言);`helper/tests/menu.test.ts` 新增一条菜单用例(有声音/无静默窗口/没朗读三种文案与置灰)并更新既有调用的行序与索引;`host/tests/preferences.test.ts` 补 2 例(默认值与「只翻开关不动窗口」的落盘、越界夹取)。
- **装配**:`pnpm build`(bundle assemble 整目录复制 `assets`,新文件自动随包)→ `node packages/bundle/scripts/assemble.mjs --out ~/.dsh/dsh_orb/buildstage/package` → `python dsh_orb/pack_and_install.py`(81 files,20.2 MB,`INSTALL VERIFIED`)→ `python dsh_orb/restart_dsh.py` → `python dsh_orb/restart_helper.py --dry` 确认球窗在。第一个整点(15:00)是实机验收点:球应该「现在是下午三点整。」本机 8765 的朗读服务在线。
- **既存失败(改动前后一致,与本改动无关)**:`helper/tests/continuous-conversation.test.ts` 2 条与 `speak-frame.test.ts` 3 条仍是红的——工作区里未提交的连续对话改动把 `running` / `asking()` 塞进了 `syncSpeechButtons`,并把 `VOICE_WAITING` 加进了 `voice-turn.js` 的 import,配套测试没有跟着更新(测试沙箱没提供 `running`,import 断言还写着 `import { ContinuousVoice }`)。

## 15. 球的对话框降为「回复气泡」(2026-11-20)

用户把对话功能搬到了主窗口,要求把球上那个可展开的对话框注释掉,但不影响其余功能。落地结果:球旁那张 420×520 的卡片变成 320×190 的一块看板,只显示**最新一条回复**;拖动、停靠、右键菜单、朗读、语音唤醒、听写、整点报时、外观与头像全部照旧。

- **不删标记,只停笔画**(`packages/helper/assets/floating.css` 末尾新增一段「switch」式样式):`shell.js` 启动时按 id 解析约 60 个节点(transcript、composer、status、question、history、permission…),缺任何一个都是 TypeError,整页连同球一起消失。所以 `#history` / `#new-conversation` / `#permission` / `#history-list` / `#tcc-gate` / `#selection-chip` / `#composer` 全部 `display: none`,元素与接线一个不动——与第 9 节隐藏 `#wake-badge`/`#wake-meter` 是同一种做法。要恢复旧面板,删掉这一段即可,HTML 不必改。
- **为什么不改 `--panel-width` / `--panel-height`**:这两个数是页面与主进程的契约。`BALL_COLUMN` 由面板宽度推导、`BALL_ROW` 由面板高度推导,`geometry.test.ts` 把样式表钉在这两个常量上(第 190–196 行)。把契约改小会让球在它自己的窗口里挪位。所以气泡尺寸另起 `--bubble-width/height`,卡片画在原来那 520px 的列里;`body.expand-left` 的 `left`、`body.expand-up` 的 `top` 改成按 `--bubble-*` 重算,卡片与球之间仍然是那一个 `--panel-gap`。`expand-right` 不需要新规则:卡片从球的列起画,窗口本来就宽出一整块面板。
- **清掉为对话框预留的空位**:`#panel` 的 `padding`(底/顶那条 composer 带)、`#panel::after`(那条圆角输入框底)、`#transcript` 的 36px 让位内边距,全部归零,回复从卡片自己的 14×16 内边距开始。
- **展开即滚到底**(`shell.js` 的 `setExpanded(true)`):190px 只装得下几行,而恢复一段历史后 `scrollTop` 从 0 开始——不锚底的话,气泡打开时看到的是**最早**那条消息,恰好与「看最新回复」相反。加了一行 `transcript.scrollTop = transcript.scrollHeight` 并注明理由。
- **唯一例外:提问卡**。`shell.js` 在有待答提问时给 `body` 加 `asking`(第 5911 行),样式据此把卡片恢复成 420×520,选项/自定义输入/取消那套原样可用——那是球上唯一还需要用户动手、且答不了就会卡住 Agent 的地方。其余状态(`running` / `docked` / `wake-recording`)都不改变卡片尺寸。
- **保留下来的**:朗读与「开启即试听」、整点报时(依赖 `speaker` 与 `continuousVoice`,两者都是模块级、与面板是否显示无关)、语音唤醒与听写(听写写进隐藏的 composer 并照常提交,`#voice-row` 的状态行也没隐藏,所以听写/出错仍有一行字)、外观跟随、头像、拖动与停靠、右键菜单里的全部开关。
- **取舍(需要知道)**:球上不再有历史/**新建**、Access 权限芯片、文字输入框;macOS 的 TCC 授权提示(`#tcc-gate`)也一并不再显示。这些入口现在只在主窗口。
- **测试**:新增 `helper/tests/panel-bubble.test.ts` 8 例——气泡尺寸、`--panel-*` 未被改动、双向定位用 `--bubble-*`、隐藏清单、`transcript` 内边距、提问时恢复 420×520 且只有 `asking` 会、展开锚底;以及一条结构性护栏:把 `shell.js` 里 `querySelector('#…')` / `getElementById('…')` 的 id 全抓出来,逐个断言 `floating.html` 里仍有同名节点(「注释掉面板」最容易犯的错就是漏掉一个 id,让整页启动即崩)。全量 `host`+`helper` 629 例、625 过,4 条红仍是第 14 节记录的既存失败。
- **装配与实测**:`pnpm build` → `assemble.mjs --out ~/.dsh/dsh_orb/buildstage/package` → `pack_and_install.py`(`INSTALL VERIFIED`,81 files / 20.2 MB)→ `restart_helper.py` 重载球,`stream.log` 14:42 出现 `page: {"phase":"apply","ready":"complete"}` 说明新页面已跑起来。视觉上用装配后的 `floating.html` + `floating.css` 做了一次静态渲染(Chromium 无头、两段示例文字、去掉页面脚本):气泡量到 320×190,两段文字排满约六行、无工具栏无输入框;`body.asking` 状态量到 420×520,提问卡的选项与底部按钮都在。真机上的悬停动效与拖动仍未做像素级冒烟,留给用户看一眼。

## 16. 气泡里的「实时文字」：唤醒、听写、回复三处都有字(2026-11-20)

第 15 节把卡片降成气泡之后,用户立刻指出了真问题:气泡里没有字。三个时刻都空着——唤醒时球说的是「我在」(一段音频 clip,屏幕上什么都没有)、用户说完一句(文字写进的是被隐藏的 `#composer`,气泡里看不见)、球语音回复时(回复在**主窗口**那个会话里,本页 `#transcript` 拿不到)。

- **一条字幕元素,不改既有结构**(`floating.html` 的 `<p id="bubble-line">` + `floating.css` 末尾):`hidden` 时不占地方,所以安静的球和以前完全一样;有字时贴在 transcript 下方、卡片底部,最多三行、超出只留最新一截(前面加省略号)。`data-role="me"` 是用户自己那句(右对齐、无底色),`system` 是「正在听/正在识别」这类提示,默认是球说的话。
- **唤醒应答**:`applyWakeStatus` 里 `playWakeFrame()` 之后补一行 `showBubbleLine(messages.wakeAck)`,字就是那段 clip 正在说的「我在。」(`messages.wakeAck`,中英各一条)。这一段 clip 原本是唯一的确认,屏幕上看不见就成了「球没反应」。
- **听写**:`startDictation` 在开录和送识别两处各给一行(`正在听你说…` / `正在识别…`,hold=0 一直挂着——录音没有本页能看见的结束);`applyTranscript` 拿到文本后先 `showBubbleLine(text, 'me')` 再照原样写进 composer 并提交,所以「我说的是这句」第一次变得可读。
- **回复**:`speakReply` 是所有「答完一条」的统一入口,字幕放在 `if (!speaker.autoPlay) return` **之前**——朗读关掉时卡片是唯一能看到答案的地方,这一行不该跟着朗读一起消失。`speech.test.ts` 的 harness 因此多了 `showBubbleLine` 桩,并加了一条断言:autoPlay 关掉时仍会上字幕。
- **主窗口的回复**:这才是关键——用户的对话在主窗口,那是**另一个 session**,主机原本只广播「那边在写字」这个种类、不带字(`announceOtherStream`)。`host/src/orb.ts` 新增 `announceOtherText` + `flushOtherText`:把 `text-delta` 的 `chunk.text` 按 120ms 合并成一条 `{ type:'session-turn', outcome:'text', text }`,回答结束(`frame.type === 'end'`)时先把缓冲区发完再发 `streamed`,所以页面停在的是整句而不是半句。`user/message` 那条广播也顺带带上 `userText(...)`(截 200 字),于是用户在主窗口说的那句同样能上字幕。页面侧只是给 `onSessionTurn` 加了三个分支:`user`(换人说的话,重置累积)、`text`(追加)、`ended`/`streamed`(收尾,6 秒后自己淡出)。
- **什么时候替用户打开卡片**:`openBubbleForLine` 只在「没展开、没有待答提问、**没有吸附**、且配置允许自动展开(`wake.autoExpand()`,即 `orb-wake.json` 的 `autoExpandOnWake`)」时调用 `setExpanded(true)`。吸附(strip)是用户主动把球收起来的状态,为一句字幕把它拽出来是球在打断人;`setExpanded` 自己会 `applyDocked(undefined)`,所以吸附判断必须先做。
- **测试**:新增 `helper/tests/bubble-line.test.ts` 19 例——按 `other-stream.test.ts` 的老办法把页面函数抠出来编译,喂假节点断言:显示/角色、空串不清空、空白折叠、超长只留尾部、折叠时开卡片而展开时不动、吸附不开、提问中不开、配置关掉自动展开时不开、hold=0 不排定时器、流式累积与收尾、超时后自己隐藏;另有一组接线断言(唤醒/听写/回复/`onSessionTurn` 四分支/主机 `announceOtherText`/HTML+CSS+`querySelector` 三处都在)。`host`+`helper` 全量 648 例、644 过,4 条红仍是既存失败(第 14 节)。
- **装配与实测**:`pnpm build` → `assemble.mjs` → `pack_and_install.py`(`INSTALL VERIFIED`)→ `restart_helper.py` → `restart_dsh.py`(主机侧的新广播要整个 DSH 重起才会加载;`dist/host/index.js` 里已能看到 `announceOtherText`)。`stream.log` 07:16:57 出现 `page: {"phase":"apply","ready":"complete"}`,随后 `composer recorder ready: true`,说明新页面与新主机都在跑;重载后 07:19:36 又有一次 apply,是字幕元素补齐后的那一版。静态视觉仍用装配后的 html+css 走无头 Chromium:字幕贴在卡片底部、圆角浅底、三行内截断。

## 17. 气泡高度跟着文字走(2026-11-20)

用户接着问:回复的框能不能按文字多少实时变高。原来那张卡是死高 190px——一句「我在。」和一段六行的回答占一样大的地方,短句四周全是空白,长句在里面挤成滚动条。

- **改成内容高度**(`floating.css` 气泡块):`#panel` 从 `height: var(--bubble-height)` 换成 `height: auto`,加上 `--bubble-min-height: 76px`(单行字幕的矮条)与 `--bubble-max-height: 420px`(再长就由 transcript 自己滚)。`--bubble-height` 这个名字随之消失,免得「看着还在用、其实没人读」。
- **`flex: 1` 在自动高度里是个陷阱**:`#transcript` 的基样式是 `flex: 1`,即 `1 1 0%` ——在固定高卡片里是"撑满",在内容定高的卡片里那 0% 的 basis 会让正文塌成 0,只剩一条字幕浮在空条里。所以气泡块里重写成 `flex: 0 1 auto; min-height: 0; overflow-y: auto`:内容说多高就多高,顶到 420 之后自己滚。
- **锚边换了**:`body.expand-up` 原本算 `top = ball-row + ball - bubble-height`,高度一活这行就没有答案了。改成 `top: auto; bottom: var(--ball-row)` 让底边钉在球的下沿向上长——窗口高 = `BALL_ROW + PANEL_SIZE.height + CHROME_INSET`,球的下沿正好在窗口底边之上 `BALL_ROW`,所以是同一个变量换了个方向读。`expand-down` 不用动:它本来就是从球的上沿往下长。
- **提问卡仍是定高**:`body.asking #panel` 用 `--bubble-asking-height: 520px` + `max-height: none`,选项和取消按钮必须能点到,不能跟着问题文字变高。`body.asking #transcript` 那里恢复 `flex: 1`。
- **点击穿透要跟着重报**:窗口是"只有球和卡片区域接收点击"的(click-through),区域由 `syncHitTest()` 用实时 rect 报给主进程。卡片现在会**在打开之后继续长高**(回复流式进来),旧的 rect 会让下半截落进穿透区——字看得见、点不到,也滚不动。所以加了一个 `ResizeObserver(() => syncHitTest())` 观察 `#panel`(不可用时跳过,不影响页面)。
- **流式续写本来就跟着滚**:`stage()` 里已有 `nearBottom` 判断,块消息到齐后 `transcript.scrollTop = scrollHeight`,所以长回答在 420 的帽子上会一直停在最新一行;卡片在长高阶段是整块往上长(底边钉住),不需要额外滚动。
- **测试**:`panel-bubble.test.ts` 的断言跟着改——`--bubble-min-height` 76 / `--bubble-max-height` 420、`--bubble-height` 必须彻底消失(而不是被遮挡)、`#panel` 是 `height: auto`、`expand-up` 用底边锚、提问卡用 `--bubble-asking-height`、`#transcript` 是 `0 1 auto` + `min-height: 0`、帽高必须装得进窗口(`≤ 520 - 12`),以及 `ResizeObserver(() => syncHitTest())` 这行必须在页面里。`panel-bubble` + `bubble-line` + `geometry` 三个文件 58 例全过。
- **静态实测**:装配后的 html+css 走无头 Chromium 三张图——单行「我在。」量成 320×86 的矮条;六段回答长到约 320×300,没有空白也没有滚动条;二十段回答停在 420 并出现滚动条(第 9 段只露出半行,说明是被裁而不是被拉伸)。
- **装配**:`pnpm build` → `assemble.mjs` → `pack_and_install.py`(`INSTALL VERIFIED`)→ `restart_helper.py` 重载球页面。

## 18. 气泡里的一左一右：把字幕变成对话记录(2026-11-20)

上一节把气泡做成"有多少字就多高"，这一轮用户把它推到了终点：**我和它的对话要同时显示在这个框里，像微信那样一左一右。**

原来那张卡里只有一条字幕，只能记住"最近一句话"，而且谁的都行——它说"我在"、你说一句、它回一句，三条挤在同一行里轮流出现，读起来像状态栏而不是对话。改法是把"一行字幕"换成"一份对话记录"：

- **结构**：`#bubble-line`（`<p>`）换成 `#bubble-log`（`<div role="log" aria-live="polite" hidden>`），行由 `shell.js` 动态插入，没有静态子节点；空的时候 `hidden`，所以球安静时卡片外观未变。每行是 `.bubble-msg[data-role]` 套一层 `.bubble-text`：`ball` 靠左、浅灰底，`me` 靠右、蓝底白字，`system` 居中、灰色小字。靠说话人的那个圆角切成 5px，当作最省事的"气泡尾巴"。
- **正文让位**：`#transcript` 改成 `display: none`。它是同一批字的原始排版（还有工具卡片），气泡里要的是重排后的两列，留着就会出现“同一句话上下各一份”。**没有删**——`shell.js` 启动时要解析 60 多个 id、`stage()` 整条路径和提问卡的布局都还在用它，删掉就是整页 TypeError。这与第 15 节隐藏聊天件是同一条原则：能藏不能删。
- **三种文字都进对话**：唤醒应答 `pushBubble('ball', messages.wakeAck)`（"我在。"），听写结果 `pushBubble('me', text)`（你说的那句靠右），回复 `pushBubble('ball', text)`（在朗读开关之前，所以关掉朗读也看得见）。跨会话那路（主窗口在写字）原本是 `appendBubbleStream`，现在它往**同一个气泡里追加**，而不是每条增量推一个新气泡——一次回答是一个气泡，字在里面长。
- **状态行另算**：`showBubbleStatus`（"正在听你说…"、"正在识别…"、"没听清"）是**一行有且只有一行**，新的替换旧的，`hold` 是它自己消失的时间（0 = 等到被替换，因为录音和识别都没有本页能计时的终点）。任何真实消息进来都会把它摘掉——状态活得比它描述的那句话长，就是在撒谎。
- **两种重复被挡住**：① 一次回答既走跨会话流、又走 `speakReply` 的完成回调，同一句会画两遍；`settleBubbleStream` 记下最后落定的文本与时刻，`pushBubble('ball', …)` 在 5 秒内遇到同一句就丢弃第二份（`BUBBLE_TWIN_MS`）。② 流还没结束，用户又说了一句：`pushBubble` 第一件事就是 `settleBubbleStream()`，否则新的碎片会继续落进上一条气泡里。
- **上限与滚动**：最多留 12 条（`BUBBLE_LOG_ROWS`），超出丢最旧的；单条超过 1200 字（`BUBBLE_LOG_CHARS`）只留尾部加省略号。每插一条都 `bubbleLog.scrollTop = bubbleLog.scrollHeight`，所以最新的一句永远在视野里。新建会话（`clearTranscript`）顺手清空记录，否则新对话会变成旧聊天下面接着写。
- **高度仍然自适应**：这一节没有推翻第 17 节，只是把 `${#transcript}` 的那套 `flex: 0 1 auto; min-height: 0; overflow-y: auto` 挪到 `#bubble-log` 上，`--bubble-min-height: 76px`／`--bubble-max-height: 420px` 照旧；提问时 `body.asking #bubble-log { display: none }` 让位给 520px 的提问卡。`ResizeObserver(panel) → syncHitTest()` 因此更必要了——每来一条消息卡片都会长高一次。
- **测试**：`bubble-line.test.ts` 重写为 `bubble-log.test.ts`（29 例，用一个能 `append`/`remove` 的假 DOM 直接跑页面函数）：左右分列、顺序、12 条上限、空白折叠、超长只留尾部、空串不画、四种打开条件、状态行替换/被消息摘掉/自己过期/`hold 0` 常驻、流式只有一个气泡、新消息关闭旧流、同一句不画两遍、清空；另有接线断言（唤醒/听写/回复/跨会话）与样式断言（左右规则、自动高度、`#transcript` 不绘制、提问时让位）。`panel-bubble.test.ts` 与 `speech.test.ts` 的断言同步改写（后者把 `showBubbleLine` 桩换成 `pushBubble`）。
- **静态实测**：装配后的真 html+css 无头渲染三张——三轮对话（我在。/ 现在几点了 / 现在是下午三点整。）高度约 190、左右分明；五条长对话卡片长到约 460 的截图框内全部可见；超长回答顶到 420 后被裁。
- **装配**：`pnpm build` → `assemble.mjs --out buildstage\package` → `pack_and_install.py`（`INSTALL VERIFIED`）→ `restart_helper.py`（球窗在、`stream.log` 里 `ready:"complete"`）。

## 19. 气泡里的字要能选中、能复制(2026-11-20)

用户试了一句:这聊天窗口里的文字不能复制。查下来是**两个原因叠在一起**,只修一个还是会觉得"没反应":

- **文字根本选不中**。整页的基础规则是 `html, body { user-select: none }`——球是一个盖在别人桌面上的半透明浮层,一次误拖就把背后的标签选上,确实像 bug。但对话记录里的字是用户自己的东西,该按 `#transcript` 从前的待遇来:所以 `#bubble-log, .bubble-text` 单独声明 `user-select: text` / `-webkit-user-select: text` / `cursor: text`。光标形状也是说明的一部分,不加提示的话没人知道这里能拖。
- **右键没有菜单**。`src/main.ts` 的 `context-menu` 处理器在 `hasSelection` 时直接 `return`,注释写的预期是"原生菜单会出来"。**Electron 不提供默认右键菜单**:渲染进程没有自己的菜单,主进程不 `popup` 就什么都不会出现。于是即便选中了字,右键也是死的那一下。现在选中状态会显式给一个菜单——`role: 'copy'` / `role: 'selectAll'`,走 Chromium 自己的编辑命令,和 Ctrl+C 是同一条路,所以两者行为一致。`electron.d.ts` 的 `MenuItemOptions` 相应补上 `role`,否则类型检查会挡。
- **右键即选中这一条**。裸右键原本打开球自己的菜单(复制不到东西)。现在 `#bubble-log` 上挂 `pickBubbleMessage`:右键落在某条消息上时,先把这条消息的 `.bubble-text` 选中(`range.selectNodeContents`),再让主进程按"有选中"给出复制菜单。于是"右键一条消息就复制这一条"成立;而已经拖选过的情况不覆盖选择——右键照旧复制你拖的那一段,而不是整条。
- **选中时卡片不许自己收**。卡片本来会在消息过后 `COLLAPSE_MS` 自动收起,而拖选正是发生在"读这几行"的时候——收起来就把正在拖的字抽走了。`scheduleCollapse` 的定时器到点时先问 `bubbleHasSelection()`:选着就重新排一次,松手后照旧收。判断看的是 `anchorNode` 是否落在 `#bubble-log` 里、且 selection 未 collapsed——collapse 那条很关键,单击留下的是个光标,把它当选中会让卡片再也不收。
- **测试**:`bubble-log.test.ts` 增到 34 例。`bubbleHasSelection` 是真跑页面函数(假 selection + 假 DOM 的 `contains`/`parentNode`),覆盖"没选/光标/选区在消息里/选区在消息元素上/选区在别处"五种;另加四条断言级:样式里有 `user-select: text`、`pickBubbleMessage` 的三个关键动作与 `contextmenu` 接线、`scheduleCollapse` 的让路分支、`main.ts` 里 `hasSelection → 菜单(role: copy / selectAll)`。
- **装配**:`pnpm build` → `assemble.mjs` → `pack_and_install.py`(`INSTALL VERIFIED`)→ `restart_helper.py`;`tsc --noEmit -p packages/helper` 通过。
- **仍由真机验收的**:拖选是否顺手、右键菜单是否只出一次(渲染进程的 `contextmenu` 与主进程的 `context-menu` 事件谁先到,决定了"先选中再出菜单"是否稳定;若不稳,症状是弹出球自己的菜单,和改动前一样,不会更糟)。

## 20. 气泡里的过程文字折叠起来 (2026-11-20)
- **问题**:用户看到气泡里"有些冗余的、类似于思考过程的文字",要求"那些都折叠起来就行了"。先说清楚不是推理泄漏:`speakWhenFinished` 明写 `if (block?.kind !== 'assistant') return`,`speakTurnReply` 也只收 assistant 的 key;跨会话那条受 `news.kind === 'typing'` 门控,而 `streamNews` 把 `reasoning-delta` 归 `'thinking'`、`text-delta` 才归 `'typing'`。四条 push 路径都不带推理。
- **真正的原因**:一轮不是一个消息。会用工具的答复先旁白"我准备做什么",再旁白"我找到了什么",最后才给答案——`settleTurnReply`/`speakReply` 一个 assistant 块落一条气泡;主窗口每次 attempt 也各自旁白一遍,跨会话一个 turn 里多次 attempt 各自 settle 成一条。于是卡片读起来像模型在自言自语,答案被压在最底下。
- **判定规则**:同一轮里被后一条球侧消息取代的那条 = 过程叙述。`pushBubble` 收到 `role === 'ball'` 时登记行,`registerBubbleRow` 先把上一批折起来再把自己记成这一轮的最新一条;`appendBubbleStream` 新建流式气泡时同样登记(新的 attempt 意味着上一次 attempt 的旁白已经过去)。用户自己的话不折——`pushBubble('me')` 是**换成**新一轮(`beginBubbleTurn`),所以上一轮的答案不会被下一句话折掉;唤醒应答也是新一轮,`applyWakeStatus` 里在 push 前显式 `beginBubbleTurn()`,否则被唤醒的球会把刚答完的那句折起来。
- **折叠不删除**:两行、暗灰、无气泡形状,下面一个"展开"按钮,点了显示全文并变"收起"(`data-folded` / `data-open`,`aria-expanded` 同步)。删掉更省事,但卡片就会谎称答案是从天上掉下来的;过程有时候正是用户要回头看的东西。
- **按钮而不是点气泡**:气泡里的字现在是可选中的(`#bubble-log` 的 `user-select: text`),而"点一下折起来"与"点一下放光标"是同一个手势,必有一个要输。所以折叠只由按钮触发,并且 `stopPropagation`,不让点击漏到选中逻辑上。
- **高度**:展开/收起是高度变化,`#panel` 上的 `ResizeObserver` 已经在 `syncHitTest`(见第 19 节那条),所以这里不额外调用——否则等于两处都管同一件事。
- **测试**:`bubble-log.test.ts` 45 例。新增 9 例:前一条被折、上一轮答案不被新一轮折、一个 turn 内被取代的 attempt 被折、半截流式答复不折、自己的话不折、按钮开合与 `aria-expanded` 与文案切换、同一条只折一次、`clear` 后不残留旧行;另有接线断言(`applyWakeStatus` 里 `beginBubbleTurn()` 的位置、`pushBubble` 的 `me`/`ball` 分支、`appendBubbleStream` 的登记)与样式断言(列向排布、12.5px、两行裁切、按钮 `cursor: pointer`)。`FakeNode` 因此补了 `attrs`/`hasAttribute`/`setAttribute`/`toggleAttribute`/`addEventListener`/`fire`,用例是真去点那个按钮,不是断言它存在。
- **静态验证**:`bubble-preview/fold.py` 用仓库自己的 css 画一条折着、一条展开的过程行(截图 `chat-fold.png`),确认暗灰无框、两行带省略、按钮位置对。
- **装配**:`pnpm build` → `assemble.mjs` → `pack_and_install.py`(`INSTALL VERIFIED`)→ `restart_helper.py`;`tsc --noEmit -p packages/helper` 通过;全量 675 例 671 过,4 条既有红不变(`continuous-conversation` 的 import 断言、`speak-frame` 三例 `running is not defined`)。
- **仍由真机验收的**:一轮里折几条才刚好——工具多的答复可能连着折三四条,若显得太空,把规则收紧到"只折最后一条之前的那一条"是一行改动。

## 21. 第二段唤醒应答的字少了「呢」 (2026-11-20)
- **用户听出来的**:唤醒应答有一段的音频说的是「我在呢」,气泡里的字幕却是「我在」。字幕不是写死在页面里的一句话,而是按"哪一段 clip 在放"去 `WAKE_VOICE_TEXTS` 里查表(见第 16 节的由来);所以错的是表里那一格,不是显示逻辑。
- **先测再改**:三段 clip 是 24 kHz,而宿主的 speechToText 只收 16 kHz 单声道 PCM16(直接喂报 `Invalid speech WAV`),所以先把 `assets/voices/c1..c3.wav` 重采样成 16 kHz,再用 DSH 自己的 worker(`dsh_orb/stt-test.mjs`,本机 SenseVoice int8)逐段读回来: c1「我在。」、c2「我在呢。」、c3「我在你说。」(识别把「听」吞了,按已知的合成文本记作「我在听你说。」)。表原来写的是 `['我在。','我在。','我在听你说。']`——第二格是从另外两格推出来的,没人听过。
- **改法**:`WAKE_VOICE_TEXTS` 第二格改成「我在呢。」,并把"这三句是测出来的、不是猜的;重录一段要重新听一遍"写进注释。`messages.wakeAck: '我在。'` 保持不动——它只是"一段 clip 都没放出来、只响了提示音"时的兜底,不是任何一段的字幕。
- **测试**:`wake-voice.test.ts` 新增一例,逐格钉住三个 take 的字(长度与 `WAKE_VOICES` 对齐、三格都不为空、第二格必须是「我在呢。」)。以后再有人按另外两格"顺手统一"就会被这条例挡住。
- **装配**:`pnpm build` → `assemble.mjs` → `pack_and_install.py`(`INSTALL VERIFIED`)→ `restart_helper.py`;装好的 `dist/helper/assets/wake.js` 里已是 `['我在。','我在呢。','我在听你说。']`,页面 `ready:"complete"`。

## 22. 唤醒词从「一个」变成「可选几个」 (2026-11-20)
- **诉求**:用户先说「再训练几个提示词」随即自己纠正成唤醒词,点了名:小弟小弟、小慧小慧、大成大成,并要求「让这些唤醒词作为可选项」。这不是加三个字符串,而是三个 openWakeWord 分类器加一个能切换它们的入口。
- **一个词为什么不能只是字符串**:页面按 `<keyword>.onnx` 取模型(`wake.ts` 的 `keywordFile`,`hey_jarvis` 是版本化的例外),模型自己决定它认哪一个音节序列;helper 的 `serveWakeAssets` 还按**当前那一个** keyword 生成白名单(`allowedFiles`),所以新词必须是新文件,不能是旧文件的别名。`RING_SLOTS` 沿用默认 28:先用 8 条 smoke 正样本跑 `features --phrase xiaodi`,打印「phrase needs 10..11 of the ring's 28 slots」,高于 `MIN_PHRASE_SLOTS=9`,前缀窗口也有 10–11 个可退,所以 `wake_features.WINDOW_FRAMES` 和页面槽位都不用动。
- **训练链路复用大肥鱼的骨架**:`wake_phrases.py` 加 `PROFILES`/`DISPLAY_NAMES`,每个两字叠词按同一套家族展开——说一遍 22 种形状、漏音节 4 条、两半之间插话 7 条、同音字各写各的(小弟→小迪/小笛/小敌/小底/小递/小弟弟/小妹妹/晓弟,小慧→小会/小惠/小灰/小辉/小回/小绘/晓慧/小慧慧,大成→大城/大诚/大程/大呈/大橙/大乘/达成/大成成)。`wake_dataset.py`/`wake_train.py`/`wake_eval.py` 都加 `--phrase`:目录走 `data/phrases/<keyword>/{positives,negatives}`,特征与 folds 走 `<keyword>-` 前缀,`dafeiyu` 保持无前缀老路径,这样已经上线的模型仍可复现。缺文件就大声失败,不去读别人的数据。
- **网格取舍**:新词默认 `COMPACT_RATES`(-15%/0/+15%)只叠 +0Hz 音高 → 210 条正样本、1722 条近似负样本;大肥鱼那套 `--full`(1470/4018)留着,要用得接受约三倍合成时间。理由是语速才是「人累了/急了」真正变的东西,音高只是同一声源的滤波变化,而声音已经 14 个。
- **filler 不属于任何一个词**:「今天天气不错」对哪个唤醒词都不是目标,所以 `link_shared_filler()` 把 `data/negatives/filler-*.wav` 硬链接(不是复制)进新词的 negatives,每词省下约四十分钟合成。
- **TTS 链路先修**:`wake_tts.py` 原先把 `edge_server.py` 源码 exec 成模块取 `WSS/TOKEN`,而该服务 2026-11-16 被重写、协议搬进 vendored `edge_tts`,于是合成第一步就 `AttributeError`。改成 `sys.path` 前置 `D:\tools\edgetts\vendor` 直接 `import edge_tts`,与朗读服务同一份库、同一份声音 id;空音频抛错而不是写出 0 字节 wav。
- **并发**:8 并发会同时握手,端点回一部分空音频,于是重试风暴(两分钟只写 61 条);`WORKERS` 降到 4,吞吐相同、重试消失。
- **一条只信退出码的流水线**:`dsh_orb/train_new_words.ps1` 按 `wake_retrain.sh` 的规矩逐段跑 synth → features → train → eval,每段整份输出进 `new-words-chain.log`,退出码决定是否继续——合成阶段是破坏性的(开跑前先清空这一组),`tail` 吃过一次亏:管道退出码是最后一条命令的,失败被藏在已经滚过去的输出里。另外数据已齐时**跳过** synth:重跑会把四十分钟做出来的 210 条正样本删掉,症状只是数据集悄悄少了一半。
- **部署这一步要能指定名字**:`wake_deploy.py` 的目标文件名原本取 `orb-wake.json` 里**当前配置的** keyword,几词并存时那会把小弟的模型写成 `dafeiyu.onnx`,顺手毁掉正在工作的那个。所以加 `--as`,目标 = `<as>.onnx`,备份名仍按被替换的文件走。
- **入口在右键菜单**:唤醒那一行从单个 checkbox 变成子菜单——上面是开关,分隔线下面是唤醒词单选组(`menu.ts` 的 `WakeKeywordOption[]`)。`ContextMenuState` 因此多两个字段 `wakeKeyword`(用来跟单选态比对)与 `wakeKeywords`(名字 + `available`);`available` 在 helper 侧按 `existsSync(join(assetDirectory, keywordFile(keyword)))` 现算,所以刚部署的模型不必重启就出现在菜单里,而半训练的词显示成「（模型未训练）」并置灰——看得见地缺,而不是点下去什么也不发生。没有模型目录时,整行连子菜单一起禁用。
- **换词必须重拉 helper,这是唯一一个不能就地生效的开关**:页面 `assets/wake.js` 的 `load()` 有 `if (this.models !== undefined) return` 的缓存守卫,ONNX 只在启动时载入一次;白名单也按单个 keyword 生成。所以 host 的 `setWakeKeyword` = 写文件 → `publishChrome()` → `halt()` + `start()`——复用「停用悬浮球」的那一对,而不是再发明一种重拉。代价是球消失约一秒、本轮记录丢失,这一点写进方法注释。keyword 没变时什么都不做,点当前那一行不该闪一下。
- **两份名字表仍然要一致**:`WAKE_SPOKEN_NAMES`(`src/wake-names.ts`)与页面 `KEYWORD_NAMES`(`assets/shell.js`)现在各五个词,由 `tests/wake-names.test.ts` 钉住。名字是「说一遍不行、要说两遍」的提示语,少一个字就把用户送到一个模型训练时特意当负样本的词上。
- **测试**:`menu.test.ts` 8 例,新增的是子菜单结构(开关 + 分隔线 + 单选组)、当前词打勾、缺模型的行 `enabled === false`、点一个词把 keyword 交给 `setWakeWord`、以及没有模型目录时开关与每个词一起禁用。
- **装配**:`pnpm build` → `assemble.mjs` → `pack_and_install.py`(`INSTALL VERIFIED`);host 侧改了 `orb.ts`/`preferences.ts`,所以要 `restart_dsh.py` 让插件重新加载。`tsc --noEmit` 两个包都干净;全量 676 例 672 过,4 条既有红不变。
- **训练是一条链,评估是另一条**:第一次跑完,xiaodi 的报告是「held-out AUC 0.78,任何阈值都只召回 15%」,看起来是数据不够。其实是两个 bug 叠在一起:① `wake_eval.py` 里按 phrase 解析出 `model`,但真正建 session 的那行还写着模块常量 `MODEL`(`dafeiyu.onnx`),于是两次不同训练的小弟模型打出**一模一样**的报告——每个数字都对,每个数字都在说另一个文件(这正是 `wake_deploy.py` 存在要防的那类错);② 紧凑网格把一个正样本和四千多条负样本放在一起,正样本权重还是 1.0,模型学到的是「对什么也别响应」。修法:session 用 `model`;`wake_train.py` 的 `POSITIVE_WEIGHT` 从常数改成按网格规模的规则(不到一千条正样本给 6.0,大肥鱼的 1470 条仍是 1.0),`--positive-weight` 可覆盖。修完小弟: AUC 0.9975,正样本 p50 1.000,0.999 阈值下召回 100%、近似词误报 5%、填充句 0%、每小时 0 次误报。
- **阈值跟着模型走**:`orb-wake.json` 只有一个 `threshold`,几个词并存时它属于「最后选中的那个」。小弟测出来是 0.999、小慧是 0.75、大肥鱼是 0.95,拿别人的数去跑不是更松就是更紧,而松的那一侧正好是「近似词误触发」。所以 `wake_deploy.py` 部署完在模型旁边写 `<keyword>.json`(内容 `{threshold}`,取自 `features/<keyword>-eval.json` 的 `chosen`),host 换词时读它、`store.setWakeThreshold` 写回;没有这个副文件就沿用当前值,不猜。
- **仍由真机验收的**:切换后第一次唤醒要不要额外提示「正在换词」——现在只有球消失一秒这唯一的反馈。

## 23. 第三段唤醒应答是「我在，你说。」不是「我在听你说。」 (2026-11-20)
- **听出来的**:用户说字幕写成了「我在听你说」,不对,应该是「我在,你说」。这正是第 21 节那条修法的反面:当时为了让字幕跟音频对上,把三段 clip 拿 ASR 读回来,`c3` 读成「我在你说」,于是按语义补成了「我在听你说。」——补进去的是一个**并没被说出来的字**。
- **识别器丢的是标点,不是词**:那一段真正说的是「我在,你说。」(我在这儿,你说吧),ASR 把停顿吃掉了,`我在你说` 就是这句话去掉逗号。听感上的「一口气说完」和书写上的缺一个逗号,当时看成了「少了『听』字」。改法只动字幕,不动音频:clip 里没有「听」可删,只需要把逗号放回去。
- **改法**:`WAKE_VOICE_TEXTS` 第三格 `'我在听你说。'` → `'我在，你说。'`,并在表头注释里写清这条教训——把 ASR 的一行原样读回人类句子时,不要替它补词,只补它必然会丢的标点。
- **测试**:`wake-voice.test.ts` 那条「describes every take」把第三格钉成 `'我在，你说。'`,注释里记下这次是补了词而不是补标点。
- **装配**:`pnpm build` → `assemble.mjs` → `pack_and_install.py`(`INSTALL VERIFIED`)→ `restart_helper.py`;9 例全过。

## 24. 删掉很早版本的「内置动图」头像 (2026-11-20)
- **是谁的**:设置页里那 6 张 GIF(指点/干饭/比心/欢呼/托腮/微笑)是早期加的,用户看图后才想起来:「这个相关的代码没有删掉啊,前端还是有这些选项,都删掉吧……动图,前端,后端,相关的都删掉。」
- **删的是整条链,不是藏按钮**:前端删掉选择组(`presetGallery`、`avatarBuiltin`/`avatarPresetNames` 两份文案、`.dsh-orb-set-preset*` 的 CSS);后端删掉 `avatar-presets.ts`(整份)、`helper-path.ts` 的 `presetAvatarDir`、设置快照里的 `avatarPresets`/`avatarPresetId`、`GET /.dsh-orb/avatar/preset/:id` 与 `POST /.dsh-orb/avatar/preset` 两条路由、`ProfileStore.selectAvatarPreset`;helper 删掉 `AvatarChoice` 的 `preset` 分支与 `loadAvatar` 里那条路径;资源删掉 `assets/avatars/`(6 个 GIF,约 12 MB),装配树里也不再带它。
- **保留的**:上传自定义图片(`POST /.dsh-orb/avatar`)、恢复默认(`POST /.dsh-orb/avatar/restore`)、以及 `avatarMessage` 的 `default`/`custom` 两态。头像功能还在,只是不再有那 6 张存货。
- **老档案不迁移**:装过那版的档案里 `orb-avatar.json` 还写着 `{kind:'preset',preset:...}`。`avatarSelection()` 直接忽略这个记录——有上传图就是上传图,没有就是自带 GIF。不做迁移脚本:一个已经删掉的功能不该让人开机时卡在它留下的状态上,测试里专门钉了这一条。
- **helper 也不认这个 kind 了**:`readAvatarChoice` 现在只返回 `default` 或 `custom`。`preset` 送进来一律当 `default`,因为那些 GIF 已经不在包里、路由也删了——让页面去加载一个不存在的相对路径,不如落到自带图。
- **测试**:host 的路由测试改成断言两条旧路由都是 404、快照里没有这两个字段;`preferences` 的用例改成「旧档案读成 default」;`runtime` 的 avatar 用例改走 `writeAvatar`;helper 的 `avatar.test.ts` 增加一条「preset 也读成 default」;设置页的 `section.test.mjs` 断言页面上没有那组缩略图、也不会发出 `/avatar/preset` 请求。
- **一处环境限制**:`packages/bundle/tests/install.test.mjs` 在本机跑不起来,原因是 `symlinkSync` 报 `EPERM`(Windows 未开开发者模式/无管理员权限),与本次改动无关——它连临时目录里的 `node_modules` 都软链不了。
- **装配**:`pnpm build` → `assemble.mjs`(确认 `dist/helper/assets/avatars` 已不在产物里)→ `pack_and_install.py`(`INSTALL VERIFIED`)→ 重启 DSH;两个包 `tsc` 干净,全量 675 例 671 过、4 条既有红不变,设置页 42 例全过。

## 25. 「小弟小弟」在真机上唤不醒：阈值没有余量，判定窗口也多要了一个 (2026-11-20)
- **现象**:三个新词里,用户两次反馈「小 D 小 D(小弟小弟)和小慧小慧一次都没唤醒成功」。配置侧全部正常:`orb-wake.json` 的 `keyword` 是 `xiaodi`、`enabled` 为真,`stream.log` 里有正常的 `wake turn:` 交接行,没有任何模型加载或 404。也就是说引擎在跑、麦克风在通,问题出在**分数**上。
- **为什么训练报告看不出这个问题**:`xiaodi-eval.json` 的 0.999 阈值召回 100%、误唤醒 0 次/小时,但那批留出集是 14 个 TTS 音色的合成音频。嗓子、房间噪声、音量电平这三件事在合成语料里一件都不存在,报告里的余量是真机上的零余量。
- **四次实测,四次降阈值**:0.999 时十几次一次没醒;0.55 十几次醒一次;0.45 约五成;0.35 六七成;0.30 加两窗口规则后十次全中。这条曲线说明真机上 `小弟小弟` 的峰值分数大致在 0.3–0.5 之间,而不是训练集里的 0.99。
- **还差的那一半不是分数,是窗口数**:`CONSECUTIVE_WINDOWS` 从 3 改成 **2**。原来的 3 是在 TTS 上量出来的——合成音把分数顶住五个窗口,第三个窗口一分钱不花;真人的两字叠词说得稍快一点只顶住两到三个窗口,于是「分数够了但第三窗掉下去」的那一遍就成了漏唤醒。少一个窗口顺带把唤醒延迟从约 0.39 s 降到约 0.26 s(窗口步长 128 ms)。
- **代价写在明面上**:真机阈值 0.30 对应 TTS 评测里约 8.6 次/小时误唤醒、近似词误报 18%,再叠上少一个窗口,只会更高。所以这是一个「先能用」的值,不是终值;若误唤醒变多,正确的回调方向是阈值回到 0.4、窗口数保持 2,而不是继续降阈值。
- **实测记录**:2026-11-20 14:47:59–14:53:03 连续 13 次 `wake: the ball handed a turn`,间隔 10–20 秒,与用户自述「十次都能唤醒」一致;此后约 5 分钟空闲期无自发唤醒。空闲不误醒不等于有人说话时不误醒,那条要靠用户放视频/聊天来验。
- **阈值现在由副文件管**:`dsh-voice-dialog/assets/xiaodi.json` 与 `orb-wake.json` 同步为 `{threshold: 0.30}`。只改一边会被 `applyKeywordThreshold` 在下次换词时覆盖回去——这正是这次踩到的坑:诊断期间直接把 `orb-wake.json` 写成 0.55,菜单里点过一次「大肥鱼大肥鱼」之后 `keyword` 和 `threshold` 一起被换掉,界面立刻报「语音唤醒（未找到本地模型）」(其实是 `assetDirectory` 也被写成空串)。
- **顺手留下的工具**(不进包、不参与装配):`dsh_orb/wake_probe.py` 用 `OrbFeatures(scale=1.0)`(与 `wake.js` 同一条前端)给一段 wav 逐窗口打分,并以 128 ms 步长打印曲线;`dsh_orb/wake_capture.py` 按 `rms>0.01` 触发自动切段,省掉「等我喊开始」这种对不齐的配合。两者抓到的默认设备音频峰值只有 0.065(基本是底噪),所以真机分数是从「能不能醒」反推的,不是直接量到的。
- **诊断日志为什么一条都没打出来**:`runModels` 里加的 `console.log('wake <keyword>: score ...')` 依赖页面 console 转发,而 `stream.log` 里的 `page:` 前缀只来自主窗口;球自己的渲染进程 console 根本不到日志。这一行现在是死代码,下次动 `wake.js` 时一并删掉。
- **没做的事**:没有用真实录音重训,也没有做加噪/变速增强。当前结论只对 `xiaodi` 成立,`xiaohui`(0.75)与 `dacheng`(0.85)仍是 TTS 上选出来的阈值,大概率要各自重走一遍这条曲线。
- **装配**:`pnpm build` → `assemble.mjs` → `pack_and_install.py`(`INSTALL VERIFIED`)→ `restart_helper.py`(阈值与窗口数都在 helper 侧,换词必须重启,因为 `wake.js` 的 `load()` 有 `this.models !== undefined` 的缓存守卫)。
