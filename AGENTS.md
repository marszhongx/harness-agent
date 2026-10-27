# harness-agent — Electron 壳 + pi agent loop

本地优先的桌面 agent：Electron 管窗口和会话，agent 循环全部交给 pi（`@earendil-works/pi-coding-agent`）子进程。不做云端、不做服务端、没有 HTTP/WS 服务器。

## 常用命令

- `pnpm dev` — 构建渲染层再启动（最常用）
- `pnpm dev:ui` — Vite HMR；另跑 `HARNESS_UI_DEV_URL=http://127.0.0.1:5173 pnpm exec electron .` 让窗口连它
- `pnpm verify` — `tsc --noEmit` + `biome check` + `vitest --coverage`，提交前必跑
- `pnpm test` / `pnpm test:watch` — 单测 + 组件测试（happy-dom）
- `pnpm smoke:electron` / `smoke:host` / `smoke:resume` — 真起 pi 的集成检查
- `pnpm pack:dir` — 构建 + 打包成 `.app`（未签名，`--asar=false`）

**坑**：`pnpm exec electron .` 不会重建渲染层。改了 `src/renderer/**` 必须先 `pnpm build:ui`，否则测的是旧 bundle。

## 硬约束

**进程与分层**

- `src/host/` 里**不许 import `electron`**。这是 `scripts/smoke*.ts` 能在纯 node 下跑真实链路的前提；需要 Electron API 的代码只能待在 `src/main/`。
- 渲染层只能通过 preload 暴露的 `window.agent` 访问外部，不许引 node、不许 `require`。
- 中断只作用于当前会话：`abort` 走 `hosts.get(sessionId)?.abort()`，只有那个 worker 收得到，后台会话继续跑。UI 上停止入口只在会话内的 composer（运行中发送键变停止），没有全局停止。
- 一个会话 = 一个 `AgentHost` = 一个 worker = 一个 pi 进程（`hosts: Map<sessionId, AgentHost>`，不设上限）。会话之间没有共享进程，也不做进程重绑。
- 切换会话是**纯前端**：transcript 从磁盘读，进程在第一次发消息时才创建。不要为「切换」加 IPC 或 spawn。
- 全局状态只有一件：`App` 里的 `sessionId`（`null` = 新对话页）。transcript 行、模型/思考等级、审批对话框都是**会话/组件级**状态，分别归 `store/transcript.ts`（每个会话一个 store）、`store/run-config.ts`、`ChatPage`。不要为了省事再把它们塞回一个全局 store。
- 事件按 `sessionId` 分流：`store/transcript.ts` 用一个共享的 `agent().onEvent` 订阅把消息路由到对应会话的 store，后台会话继续流式推进而不触发当前视图重渲染。
- 状态库只有 zustand（vanilla store，不挂在 React 树上的 Provider 里）：跨组件数据才进 store，组件自己的东西仍是 `useState`。不要为一个使用者建 store。
- `store/` 一个模块一个 `create()` store，state + getter + action 全在 store 里。按会话分的数据放 store 里的 `Map`，key 是 sessionId（`""` 是还没签发的草稿页），不要为每个会话造一个 store。
- 拿值用单个 field 的选择器：`useTranscripts((s) => s.getItems(id))`、`useSessions((s) => s.list)`。要两个值就写两次订阅。不要写返回新对象的选择器（`(s) => ({ a: s.a, b: s.b })`），也不要拿 `useShallow` 去补——那说明该拆 store 了。
- 命令式访问统一走 `export const getX = useX.getState`（`getTranscripts()` / `getSessions()` / `getRunConfig()`），不要在模块级另造一批 `setXxx()` 包装。
- 改 Map 一律 copy-on-write（`new Map(prev)` 再 `set`），否则 zustand 的浅比较看不到变化。
- 每个 store 配一个 `useXSync()` 挂 `agent().onEvent`；它按组件引用计数装卸（`store/agent-stream.ts`），不要在模块顶层订阅。

**会话身份**

- 会话 id 由我们签发（`mintSessionId()` 返回纯 UUID）。pi 只看到 `<品牌>-<uuid>`，转换只允许走 `src/host/session-id.ts`，不要在其他地方拼字符串。
- 品牌名来自 `app.setName()`，不要写死。

**谁拥有什么文件**

- 我们写：`<userData>/sessions.json`、`settings.json`。
- 我们写：`<userData>/logs/`（只记后台：主进程和 worker，`tag` 列区分）。活跃文件是 `application.log`，跨天时改名成 `application-YYYY-MM-DD.log`，只留 7 天；`HARNESS_DEBUG=1` 才记 debug。
- **渲染层不进日志文件**：它的报错看前台控制台（devtools）就行。别为了「方便」把渲染层的 console 转发进来——日志文件是查后台问题的，混进前台的噪声只会让定位更慢。
- pi 写：`<userData>/sessions/*.jsonl`（transcript）、`~/.pi/agent/{models.json,settings.json,auth.json}`。
- transcript 我们**只读**（`src/host/transcript-file.ts`），唯一例外是用户删会话时：`agent:deleteSession` 会先杀进程、从索引摘掉，再删除对应的 `.jsonl`（用户明确要求过）。；`models.json` / pi 的 `settings.json` 允许写，但必须保留不认识的键、写前备份 `.bak`。
- 所有落盘写操作走 `tmp + rename`。

**会话状态的语义**

- 草稿（点了「新对话」但没发消息）不写索引、不起进程、不出现在列表里；第一条消息才落地。
- 只有一个草稿：「新对话」页就是那张空草稿。已经在空草稿页时再点「新对话」不重造 id；发出第一条消息后它变成历史会话，页面重新空出来。
- 「新对话」的高亮条件是 `view === "chat" && isDraft`：显示历史会话时高亮的是列表项，不是它。
- `entry.sessionFile` 只在文件真实存在时记录（pi 会提前报一条计划路径）。
- 历史来自 transcript 文件的活动分支（从最后一条沿 `parentId` 回溯），不是「所有行按顺序」。

## 样式规范

- `src/renderer/styles/tokens.css` 是唯一的取值来源，命名照 Ant Design 的 `default.less`（`--primary-color`、`--text-color-secondary`、`--border-color-base`、`--border-color-split`、`--padding-md`、`--font-size-sm`、`--border-radius-lg`、`--height-base`、`--shadow-2`、`--zindex-modal`）。颜色存 HSL 三元组，可以带透明度：`hsl(var(--text-color) / 0.06)`。
- 组件 CSS 只写 token，不写数字字面量。需要新值时先加 token，别就地发明一个 px。
- 间距只有 2/4/8/12/16/24 这几档；字号只有 xxs/xs/sm/base/lg/title；圆角只有 sm/base/lg/xl/pill。凑不上说明设计在飘，先改设计。
- `*.module.css` 一个页面一组，公共件（`.cardList`、`.setting-row`、`.btn`、`.icon-btn`、`.path-button`）放 `ui.module.css`，别再往页面里抄一份。

## 代码约定

- 所有新行为都要有测试：`src/host/*.test.ts`（纯 node）、`src/renderer/*.test.tsx`（happy-dom + Testing Library）。覆盖率门槛在 `vitest.config.ts`，会挡 CI。
- 组件测试用 role / label / `data-testid` / 文本查询。CSS Modules 类名是哈希的，禁止用类名选择器。
- 渲染层不要用 `window.confirm`：它阻塞渲染线程。
- 中文注释写「为什么」，不写「做了什么」；文件头部注释说明这个模块的地位和边界。

## 不要做

- 不要动 `~/.pi` 下的会话文件，也不要清理用户数据目录；需要清理时只报路径。
- 不要给 `src/main/` 或 `src/preload/` 引入构建步骤（它们靠 Node 的类型擦除直接跑）。
- 不要在没有确认的情况下删除或重写 `sessions.json` 的结构。
- 不要用 `pkill -9` 之外的手段假设进程已退出；改完生命周期代码要跑 `smoke:host`（它包含真 SIGKILL 后的恢复检查）。

## 验证 UI 的方式

- **日常验证走开发模式**：`nohup pnpm dev:ui &` 起 Vite，再 `HARNESS_UI_DEV_URL=http://127.0.0.1:5173 pnpm exec electron .`。窗口连开发服务，改完界面保存即生效，截图/点击都用 CDP 打这个窗口。
- 只有改 **preload** 或 **src/main** 才需要重启应用（启动时读一次）。改完界面记得确认窗口地址是 `http://127.0.0.1:5173`，不是 `app://bundle` —— 否则你验的是旧产物。
- 发布形态另说：`pnpm smoke:electron` / `pack:dir` 用构建产物，dev 模式带 React 开发版和 HMR 运行时，不等同于打包后的样子。
- 验证完**不要退出应用**：用户会接着用手上那个窗口。用 `nohup pnpm exec electron . &` 起，验完保持运行。
- 收进程只认我们自己的二进制：`pgrep -f "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"`。**不要 `pkill -f Electron`** —— 那个模式会连 VS Code、其他 Electron 应用一起杀掉。
- **验证界面就截图看**：`pnpm exec electron . --shot=/tmp/x.png --shot-size=980x720 [--shot-state=/tmp/state.js]`。截图走 `webContents.capturePage()`，不要用 `screencapture`（会抢焦点）。
- **要什么状态就改状态，不要点过去**：`--shot-state` 在 dev 构建里执行一段脚本，`window.__harness` 暴露了 store，直接 `setState` 出「12 条会话 + 第一条正在回答」这种场景。数据被异步刷新覆盖时，顺手把 `refresh` 也换成固定返回。
- 只有想确认「这个按钮是否真的接通」时才点一次；不要写长的交互脚本模拟整条流程。
- 需要读 DOM 文本、模拟按键、切深色时才开 `--remote-debugging-port`，用完把 `Emulation` 清掉。
