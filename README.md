# plugin-micro

DeepSeek Harness 插件：把 **Work Louder “Codex Micro” HID 小键盘**（agent 宏键盘）接成 Harness 的原生输入设备。
设置面板按 OpenAI Codex 桌面版的 Codex Micro 页面复刻：布局、键帽编辑器、智能体键分配、摇杆/旋钮编辑器、官方中文文案。

> 非官方项目，与 OpenAI、Work Louder 均无关联；HID 协议为独立实现，未包含任何第三方专有代码。

## 功能

- **设备层**：独立 `node` 子进程 + node-hid，自动发现/重连；VID `0x303A`、PID `0x8360`、usagePage `0xFF00`；读取固件/电量/层信息。
- **硬件映射**：6 个智能体键、8 个命令键、宽 MIC 键、触摸盘、摇杆四方向、旋钮旋转/按下。
- **动作**：审批（批准/拒绝）、分叉会话、新建会话、上/下一个会话、计划模式、推理强度 ±、技能引用等。
- **智能体键**：按「已置顶 / 最近的聊天 / 优先聊天 / 自定义分配」自动分配最近 6 个会话并持久化；可单独分配聊天 / 快捷键 / 键帽 / 技能。
- **键帽编辑器**：37 个原版键帽（原始 SVG 几何）、每个键帽可自定义动作（含「使用键帽默认设置」）。
- **摇杆 / 旋钮编辑器**：方向与手势（左旋/右旋/点击/长按）独立绑定；提示卡按原版排版。
- **灯光**：六个智能体键状态灯（工作中/未读/空闲/待审批/等待响应/错误）、亮度、自动调暗。
- **模型工具 `codex_micro`**：智能体可查询设备、点灯、发 RPC。
- **调试接口**：`/codex-micro/state`、`/codex-micro/diag`、`/codex-micro/events`（SSE）、`/codex-micro/action`。

## 安装

要求：DeepSeek Harness 桌面版、Node ≥ 20（Windows / macOS）。

```bash
git clone https://github.com/zjhxxxx/plugin-micro.git
cd plugin-micro
npm install
```

在 Harness profile 中挂载（任选其一）：

**A. 作为 bundle（推荐）** —— 编辑 `~/.dsh/profiles/<profile>/package.json`：

```json
{
  "dependencies": { "plugin-micro": "link:/absolute/path/to/plugin-micro" },
  "dsh": { "profile": { "bundles": ["plugin-micro"] } }
}
```

然后在 profile 目录执行 `npm install`（或把 `node_modules/plugin-micro` 做成指向本目录的 junction），重启 Harness。

**B. 作为插件行** —— 在 profile 的 `cordis.patch.yml` 中 `insert` 一行（见仓库内 `cordis.patch.yml`）：

```yaml
- insert:
    - id: plugin-micro
      name: plugin-micro
      config: { autoConnect: true, brightness: 1, autoOffMs: 180000 }
```

然后重启 Harness。

> 命名：Harness 生态的第三方插件习惯使用 `dsh-plugin-<name>` 前缀；本仓库按作者要求使用 `plugin-micro`，如需严格遵循社区约定，只需把 `package.json` 的 `name` 与 `lib/client.js` 的 loader `id` 同步改为 `dsh-plugin-micro`（profile 里也同步）即可。

## 使用

1. 插上 Codex Micro，关闭其它占用 HID 的程序（键盘重映射工具等）。
2. Harness →「设置 → Codex Micro」。
3. 「布局」中：点键帽编辑；点智能体键分配聊天；点摇杆/旋钮编辑手势；「重置布局」恢复默认。
4. 硬件按键触发对应动作；审批请求会点亮 APPR/REJ，可直接在设备上应答。

![设置页](docs/settings.png)
![键帽编辑器](docs/editor.png)

## 目录结构

```
lib/index.js     宿主插件：工具、HTTP 路由、持久化、桥接进程管理
lib/client.js    渲染端 bundle：设置面板（classic script + ModuleLoader）
lib/bridge.cjs   HID 子进程：帧解析、请求队列、自动重连
cordis.patch.yml bundle 叠加层
```

持久化文件：`~/.dsh/codex-micro-bindings.json`（键帽绑定 / 动作覆盖 / 6 个智能体键的会话分配）。

为什么用子进程：Harness 跑在 Electron 内，原生模块 ABI 与 node-hid 预编译包不匹配，所以 HID 放在独立 `node` 进程中，通过 stdin/stdout 的 JSON 行协议通信；子进程崩溃不会影响 Harness。

## 协议

- 64 字节 HID 报文：`[0]=6, [1]=channel(2=RPC), [2]=len(≤61), [3..]=UTF-8 JSON`
- JSON-RPC 2.0（紧凑字段），id 0–998；通知 `v.oai.hid`(k/act/ag)、`v.oai.rad`(a/d)；灯光 `v.oai.thstatus`、`v.oai.rgbcfg`
- `device.status` → `version/profile_index/layer_index/battery/is_charging`

## License

MIT
