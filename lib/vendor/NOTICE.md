# 内联的第三方运行时

本目录下的文件不是本项目原创代码，随包分发只为让插件在**不编译、不审批构建脚本**的前提下可用。

## node-hid 3.4.0

- 来源：npm `node-hid@3.4.0`（<https://github.com/node-hid/node-hid>）
- 许可证：MIT；其中 `prebuilds/` 内的二进制由 HIDAPI 编译而成，HIDAPI 为 BSD-3-Clause / GPL-2.0 双许可 + 原创例外，见 `node-hid/LICENSE-bsd.txt`
- 改动：仅 `nodehid.js` 第 18 行，把 `require("pkg-prebuilds/bindings")` 改为 `require("../prebuild-bindings.cjs")`（内联同名实现），其余文件与上游逐字节一致
- 保留文件：`nodehid.js`、`binding-options.js`、`prebuilds/**`（各平台各架构的 Node-API v4 预编译产物）

## pkg-prebuilds 1.1.0

- 来源：npm `pkg-prebuilds@1.1.0`（<https://github.com/julusian/pkg-prebuilds>），其 `bindings.js` 与 `lib/prebuild.js` 为 MIT
- 改动：拆成 `prebuild-bindings.cjs`（原 `bindings.js`，去掉 webpack/Electron 分支）与 `prebuild.cjs`（原 `lib/prebuild.js`，逐字节一致）

## 为什么要内联

`node-hid` 带 `install` 脚本。pnpm 11 在 `strictDepBuilds` 默认开启时会把「未审批的构建脚本」当作**安装失败**（`ERR_PNPM_IGNORED_BUILDS`，退出码 1），
而它的预编译产物本来就在包里、根本不需要编译。把运行时放进本包后，安装过程完全不涉及原生构建，用户也不需要执行 `pnpm approve-builds`。
