# dsh-plugin-micro

DeepSeek Harness 插件：把 **Work Louder “Codex Micro” HID 小键盘**（agent 宏键盘）接成 Harness 的原生输入设备。
设置面板按 OpenAI Codex 桌面版的 Codex Micro 页面复刻：布局、键帽编辑器、智能体键分配、摇杆/旋钮编辑器、官方中文文案。

> 非官方项目，与 OpenAI、Work Louder 均无关联；HID 协议为独立实现，未包含任何第三方专有代码。

## 安装

**不需要编译，不需要 `pnpm approve-builds`，不需要本机装 Node 工具链。**
（设备桥是个 `node` 子进程，用的是宿主自己带的运行时；在 Electron 宿主里它由 `ELECTRON_RUN_AS_NODE=1` 拉起，见「已知偏离」。）

在 Harness 里装（插件市场搜索 `dsh-plugin-micro`），或命令行：

```bash
dsh plugin --profile desktop add dsh-plugin-micro
```

安装完成后插件即可用：`cordis.patch.yml` 是纯 `insert`，市场会**热挂载**，无需重启整套 Harness。

| 项 | 要求 |
|---|---|
| DeepSeek Harness | `>= 0.2.1-rc.3`（清单里的 `engines.dsh` 由市场与安装闸门用来判定兼容性；官方 installer 本身不强制这个字段，所以老宿主装得上但可能跑不对） |
| Node | `^22.19.0 || >= 24.0.0`（宿主自带的运行时，插件不下载 node） |
| 系统 | Windows 10+ / macOS / Linux（HID 运行时自带各平台预编译产物） |

**为什么装起来这么干净**：HID 运行时（node-hid）已经内联在本包里（`lib/vendor/`，MIT/BSD，见 `lib/vendor/NOTICE.md`），
所以本包**没有任何生产依赖**。这一点是刻意的 —— 带 `install` 脚本的依赖会让 pnpm 11 直接把整个 profile 安装判为失败
（`ERR_PNPM_IGNORED_BUILDS`，退出码 1），而 `@deepseek-ai/*` 这类宿主包一旦进了 `dependencies`，提升后会覆盖宿主自带的版本，
启动时报 `1 required plugin did not activate`。

## 功能

- **设备层**：独立 `node` 子进程 + 内置 HID 运行时，自动发现/重连（1/2/5/10 s 退避）；VID `0x303A`、usagePage `0xFF00`、PID 33632 / 33431 / 33432；读取固件/电量/层信息；断线时拒绝在途请求、拔线后立即释放接口。
- **动作模型**：绑定值是带前缀的动作字符串 —— `command:<id>`（命令）、`text:<文本>`、`url:<链接>`、`skill:<技能名>`、`ptt`（按住说话）、`noop`。无前缀的旧私有动词（`session.new`、`effort.up` 等）继续兼容。
- **39 款键帽，34 款有可执行动作**：键帽的默认动作直接由原版 `original` 描述推导；剩下 5 款是空白键（`EMPT1`–`EMPT5`，原版就是 `custom-shortcut`），装上后保持未绑定。找不到宿主能力时给出「此操作在此处不可用」提示，而不是静默失效。
- **硬件映射**：6 个智能体键、8 个命令键、宽 MIC 键、摇杆四方向、旋钮旋转/单击/长按。
- **旋钮四模式**：输入区导航（合成 `ComposerNavigation` / 方向键）、对话滚动（±160 px）、推理强度（顺时针降低、逆时针提高）、自定义（左右旋转/单击/长按四个手势独立绑定）；500 ms 长按在非自定义模式跳到设置页。
- **摇杆**：四扇区几何、死区 0.1 / 触发阈值 0.5、边沿触发、有输入区时 220 ms 延迟防误触，可在设置里整体关闭。
- **智能体键**：350 ms 双击打开聊天、`单击即切换` 开关、空绑定双击新建并绑定、一个聊天只占一个键、非自定义模式禁止逐键编辑。
- **按住说话**：350 ms 双击闩锁状态机（轻按开始、再按结束、长按按住说话）；宿主没有语音通道时明确提示。
- **键帽编辑器**：草稿式编辑（点「保存」才落盘，取消零副作用）、同名键帽自动换位、`text:` 动作带文本框、搜索含动作名、空结果提示。
- **灯光**：随会话状态实时刷新（工作中/未读/空闲/待审批/等待响应/错误/关闭），亮度与自动调暗持久化，重连后自动重发最近一次灯光模型，自动调暗同时关闭氛围灯。
- **多窗口安全**：localStorage 租约 + BroadcastChannel 选举主控窗口，硬件输入只执行一次。
- **模型工具 `codex_micro`**：智能体可查询设备、点灯、发 RPC。
- **调试接口**：`/codex-micro/state`、`/codex-micro/diag`、`/codex-micro/events`（SSE）、`/codex-micro/action`。

## 使用

1. 插上 Codex Micro，关闭其它占用 HID 的程序（键盘重映射工具等）。
2. Harness →「设置 → Codex Micro」。
3. 「布局」中：点键帽编辑；点智能体键分配聊天（需先切到「自定义分配」）；点摇杆/旋钮编辑手势；「重置布局」只恢复键帽，不动智能体键分配。
4. 硬件按键触发对应动作；旋钮长按进设置页；智能体键双击打开聊天。

![设置页](docs/settings.png)
![键帽编辑器](docs/editor.png)

## 出问题时

| 现象 | 说明 |
|---|---|
| 面板显示「驱动不可用」 | 内置 HID 运行时没能加载。行内有「重试」按钮；仍然失败就重装一次插件（`lib/vendor/` 可能被杀软或残缺的 git 检出破坏）。 |
| 显示「已检测到」但点「连接」没反应 | 接口被别的程序占着（键盘重映射、厂商驱动、另一个 Harness 窗口）。先退出它们。 |
| 点过「移除」后不再自动连 | 这是设计行为：移除会写入 `autoConnect: false` 并停止扫描，重启也不会自己连回来。点「连接」恢复。 |
| 面板显示「已连接，功能受限」 | 设备连上了，但灯光 RPC 没通（固件版本差异）。按键照常工作。 |
| 想看宿主这边的错误 | `%TEMP%/dsh-codex-micro.log`（Windows）或 `$TMPDIR/dsh-codex-micro.log`。 |

插件对宿主是**只增不减**的：`apply()` 全程有 try/catch，桥接进程崩溃有退避上限（连续 5 次快速退出后停止重试并上报状态），
监听器与子进程都在 `ctx.effect` 的 disposer 里释放。任何一半出问题都不应该拖垮 Harness 的启动。

## 目录结构

```
lib/index.js     宿主插件：工具、HTTP 路由、持久化、灯光状态机、桥接进程管理
lib/client.js    渲染端 bundle：设置面板 + 硬件事件 → 动作的运行时
lib/bridge.cjs   HID 子进程：帧解析、请求队列、自动重连
lib/hid.cjs      HID 运行时加载器：内置副本 → 用户自装副本 → 明确降级
lib/vendor/      内联的 node-hid 运行时（MIT/BSD，见 NOTICE.md）
locale/          插件清单文案 + 面板文案字典（meta.title / meta.description + 434 条词条），en + zh
icon.svg         插件列表与设置页的图标
cordis.patch.yml bundle 叠加层（纯 insert，可热挂载）
test/            冒烟测试：面板渲染、运行时行为、设备层、降级启动、真机宿主
tools/           开发用工具：词条编译（`npm run i18n`）
```

## 遵循的 DSH 插件规范

清单里的每个字段都对应官方 `cordis-plugin-development` 技能与各包 README 的要求，不是照抄社区插件的写法：

| 要求 | 本插件的做法 |
|---|---|
| `dsh.bundle.patch` + 唯一 entry id | `cordis.patch.yml` 是纯 `insert`（`id: codex-micro`），市场可热挂载；带 `config:` 的行只能重启生效 |
| 显示元数据 | `locale/{en,zh}.json` 提供 `meta.title` / `meta.description`；`exports` 暴露 `./locale/*.json` 与 `./icon` |
| 图标 | 原创 `icon.svg`（< 256 KiB），清单顶层 `icon` 字段指向它 |
| `dsh.manifestVersion` | `1` |
| 客户端加载时机 | `dsh.client.immediately: true`——面板不在设置页打开时才加载，键盘绑定必须随页面启动 |
| 客户端注入顺序 | `dsh.client.inject` 只列宿主真实存在的包（`immediately` 只排序激活，不改变解析） |
| 不重复打包宿主 | `dependencies` 为空；宿主包只由 profile 提供。原生模块（node-hid）内联在 `lib/vendor/`，不触发 pnpm 的 `strictDepBuilds` |
| 资源归 context 所有 | 宿主侧子进程 / 定时器 / HTTP 路由 / SSE 响应都在 `ctx.effect` 的 disposer 里释放；渲染端样式表同样注册为 effect |
| 样式只用主题令牌 | 面板容器、文字、边框、控件读 `--dsw-alias-*`（经 `--cm-*` 间接映射，令牌缺失时有回退）；键帽、旋钮、摇杆、状态灯属于设备渲染，保留字面色。`test/tokens.mjs` 断言每个引用都在宿主主题真实定义的 349 个令牌里——写错一个名字时浏览器会静默丢属性，渲染测试抓不到 |
| UI 文案走 locale 服务 | 全部 434 条文案（面板、按钮、状态、提示、手势说明、诊断日志）都经 `t()`；`ctx.locale.register("codex-micro", { en, zh })` 注册扁平字典，取不到服务时回退内置中文。渲染端无裸中文字面量，`npm test` 会断言 |
| 不替换应用根 | 面板只注册进 `settings.section`；toast 由 `ToastHost` 在 slot 内渲染，不向 `document.body` 追加节点 |
| 不写组件外 DOM | **有例外**：composer 的文本插入 / 提交 / 滚动 / 导航要直接操作宿主输入区。这是规范明确不建议的做法，但没有可用替代，见「已知偏离」 |

### 已知偏离（及其原因）

官方 `cordis-plugin-development` 规范里有三条本插件做不到，都是**宿主没给入口**而不是图省事。写在这里，是为了让下一个维护者知道这是判断，不是疏忽：

1. **操作宿主 composer**（`practices.md`：“Do not write DOM outside your component”）。键盘的文本插入、发送、滚动、输入区导航只能落在宿主输入框上：`0.2.1-rc.5` 没有“把文本放进草稿框”的 Host 入口，`ctx.remote` 的转发 allowlist 是宿主编译期写死的，`host.call` 只发给动态（运行时求值）插件——静态 bundle 的工厂拿到的只有 `require`，见 `dsh-cordis-client-runner` 的 `guardedSurface`。所以这层只能在 DOM 上做，并且刻意做得很窄：
   - 只认当前焦点元素和 `textarea` / `contenteditable`，命中不到就返回 `false`，动作变成「此操作在此处不可用」；
   - 焦点在面板自己（`.cm-root`）里时一律不动，避免把按键打进自己的控件；
   - 宿主改版导致选择器失效时是**功能降级**，不是崩溃。

2. **自建 HTTP/SSE 通道**。同上：静态 bundle 没有 `host.call`，`ctx.remote` 只转发固定事件表，设备状态没有现成投影。于是客户端通过 `/codex-micro/{state,events,action}` 直连宿主半。写接口做了三道防护（`Sec-Fetch-Site` 非 same-origin 拒绝、无该头时校验 `Origin`/`X-Forwarded-Host`、只接受 `application/json`），并按 op 白名单执行；任意固件方法的转发**没有**暴露在这条通道上（面板从不调用它，只有模型工具走，且工具侧拦掉 bootloader/erase/reboot）。

3. **没有 `export const Config`**。规范建议可调项走 `Config` 以便在 `cordis.patch.yml` 里改。本插件的可调项（亮度、自动熄屏、旋钮模式、摇杆开关…）是**运行时用户偏好**，在设置面板里改并立刻生效，不是部署配置；加 `Config` 需要 `@deepseek-ai/schemastery` 的 schema 对象，而这个包刻意保持零依赖——一旦解析不到，整个插件行激活失败，代价远大于收益。

4. **绑定与偏好写在 `~/.dsh/codex-micro-bindings.json`**，而不是 `ctx.storageDomain`。宿主确实提供 `storageDomain`，但它要求 composition 里挂上 `storage` + 后端 + `storage-domain` 三行，desktop profile 不一定有；而这份数据在 `apply` 阶段就要同步读到（否则面板首帧是空的），一个可能缺席的异步服务换不掉一个原子写入的同步文件。文件本身做了三点保护：临时文件 + rename 的原子写、体积上限、读入时形状与版本校验（`version: 2`），坏文件按默认值重建而不是让插件启动失败。

### 文案是怎么组织的

`t()` 的查找顺序是 **宿主 locale 服务 → 内置中文字典 → key 本身**。key 是扁平的点分路径（`editor.actionNoResults`、`catalog.approval.allow.label`），因为宿主是按 key 直接索引字典的，嵌套对象会让每条文案都退化成一个裸 key。

真源是 `tools/i18n-strings.mjs`（`key: [中文, English]`）。改完文案跑：

```bash
npm run i18n     # 编译进 lib/client.js，并重写 locale/{zh,en}.json
npm test         # 断言三份副本一致、英文不含中文、占位符两侧对齐
```

`npm test` 还会扫描 bundle，确认字典之外没有硬编码中文——漏掉一条就失败，不会悄悄只显示一种语言。

有一类文案必须留在模块级常量里（键帽表、旋钮手势表）：它们在 `apply` 绑定 locale 之前就求值了，直接调 `t()` 会被永久冻结成导入时的语言。这些表存的是 key，由渲染处翻译。

持久化文件：`~/.dsh/codex-micro-bindings.json`（原子写：先写 `.tmp` 再 rename；读入前校验体积与形状）

```jsonc
{
  "version": 2,
  "bindings": { "ACT06": "FAST", "AG00": "session.open:0", "STICK_UP": "plan.toggle" },
  "overrides": { "FAST": "command:composer.toggleFastMode" },
  "agentSlots": ["sessionId|null", "...共 6 项"],
  "settings": { "brightness": 100, "autoOff": "3-minutes", "encoderMode": "composer-navigation",
                "agentSource": "recent", "splitMic": false, "singleTapAgentKeys": false,
                "voiceButtonMode": "push-to-talk", "joystickDisabled": false, "autoConnect": true }
}
```

0.1/0.2 的扁平映射文件会在读取时自动迁移。

为什么用子进程：Harness 跑在 Electron 内，原生模块 ABI 与预编译包可能不匹配，所以 HID 放在独立 `node` 进程中，
通过 stdin/stdout 的 JSON 行协议通信；子进程崩溃不会影响 Harness，父进程退出时子进程会释放接口自杀。

## 测试

```bash
npm install          # 只为 test/ 装 react + react-dom，运行时没有依赖
npm test             # 面板渲染 + 运行时 + 主题令牌 + 设备层 + 降级启动 + 字典一致性
npm run test:host    # 真机：连接、落盘、灯光写固件、agent-slots、重置语义、移除设备
```

`npm run test:host` 会先把 `HOME`/`USERPROFILE` 指向临时目录再启动，不会读写你真实的
`~/.dsh/codex-micro-bindings.json`。直接用 `node test/host-smoke.mjs` 跑则会命中真实配置——
"移除设备"那步会把 `autoConnect` 写成 `false`，之后每次启动都连不上，看起来像驱动坏了。

`npm test` 全部在无设备的情况下也能跑（真在场时顺带验证枚举）。
`npm run test:host` 需要插着设备，且会读写 `~/.dsh`，建议用临时 HOME：

```bash
USERPROFILE=/tmp/cm-home npm run test:host
```

想验证「没有 HID 运行时」的降级路径：`DSH_CODEX_MICRO_HID=off node test/degraded-smoke.mjs`。

## 协议

- 64 字节 HID 报文：`[0]=6, [1]=channel(2=RPC), [2]=len(≤61), [3..]=UTF-8 JSON`
- JSON-RPC 私有方言：`{id, method, params}`，**没有** `jsonrpc` 字段，id 0–998，单飞 + 50 ms 冷却
- 通知 `v.oai.hid`(k/act/ag)、`v.oai.rad`(a/d)；灯光 `v.oai.thstatus`、`v.oai.rgbcfg`
- `device.status` → `version/profile_index/layer_index/battery/is_charging`

`act`：`0` 松开、`1` 按下、`2` 重复（仅旋钮）。按键必须处理 `0`，否则无法实现长按、双击与按住说话。

## 已知限制

- 宿主未暴露的命令（`git.*`、`toggleTerminal` 等）只会给出「此操作在此处不可用」，不会静默假装成功。
- 按住说话依赖宿主的语音服务（`voice` / `remote.voice` / `dictation`）；没有时不录音，只提示。
- 命令面板的 182 个原版 commandId 只接入能在 Harness 落地的那部分。
- **浅色主题没有在真实浏览器里逐项目检过**。所有颜色都取自宿主令牌（`test/tokens.mjs` 守住），但对比度、间距、悬停态没有截图验证；这条不算通过，只是没有已知问题。

## License

MIT。内联的 node-hid 运行时为 MIT / BSD-3-Clause，见 `lib/vendor/NOTICE.md`。
