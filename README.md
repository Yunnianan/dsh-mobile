# dsh-mobile

在手机上直接用 DSH——不需要投屏，也不需要把电脑画面传到手机。

电脑上的 DSH 跑这个插件，把界面发布出来；手机装一个 APK 打开它。
插件**没有任何第三方依赖**（QR 编码器是内置的），装完即用。

---

## 先装哪个？

| 你是… | 从这里开始 |
|---|---|
| 只想用起来 | **[快速开始](features/QUICKSTART.md)**（三步） |
| 想搞清原理 / 排错 | **[安装指南](features/INSTALL.md)**（完整版，含 Tailscale 与常见问题） |
| 想改代码 | 下面的[安装](#安装)与[测试](#测试) |

**手机端 APK**：从 [`dist/`](dist) 取最新版本，或看 [Releases](../../releases)。

| 版本 | 文件 | 大小 | SHA-256（前 16 位） |
|---|---|---|---|
| 9.5 | [`dist/dsh-mobile-9.5.apk`](dist/dsh-mobile-9.5.apk) | 529.5 KB | `0CECD2A50164765A` |

APK 是自签名应用，覆盖安装即可升级（签名指纹见文末），**配对状态保留**。

---

## 这个仓库包含什么

| 路径 | 说明 |
|---|---|
| `lib/index.js` | 插件本体：配对面板、QR 生成、一次性令牌、设备门控、隧道托管 |
| `lib/widget.js` | 手机端配对面板（浏览器侧，贴在桌面 DSH 左下角） |
| `lib/qr.js` | 手机端 QR 渲染 |
| `lib/qr-vendor/` | 内置的 QR 编码器（MIT，来自 `qrcode`，见 `LICENSE-qrcode`） |
| `cordis.patch.yml` | 插件自带的补丁层 |
| `install.mjs` | 一键安装（声明依赖 + 加进 bundles + 建联接） |
| `dist/` | 编译好的 Android 客户端 APK |
| `features/` | [快速开始](features/QUICKSTART.md) 与 [安装指南](features/INSTALL.md) |
| `test/` | 全部测试与量测脚本（不需要网络） |
| `github-upload.mjs` | 用 REST API 把本目录上传到 GitHub（不需要装 git） |

`dist/` 里的 APK 是在本仓库之外构建的：安卓客户端是一份独立的 Java 源码
（无第三方框架，只依赖 vendored 的 `zxing-core`），构建脚本为
`aapt2 → javac → d8 → zipalign → apksigner`，不依赖 Gradle。编译好的产物按版本放进
`dist/`，源码本身暂未纳入本仓库。

---

## 它做什么

1. **手机配对面板**：在桌面 DSH 界面左下角贴一个小面板，显示二维码与一次性配对密钥。
   面板可以贴边收起成一个小标签，点一下再展开。
   手机端扫码时既可以对着屏幕拍，也可以**从相册选图识别**（截图、别人发的图都行）。
2. **一次性令牌 + 长期密钥**：二维码里是一次性令牌（用过即废）；
   另有一把长期密钥，供已经配对过的设备在会话失效时自动重新配对。
3. **设备门控**：把 `/api` 下面的流量挡在"已配对设备"之后。
4. **公网隧道**（可选）：托管 `ssh` 或 `cloudflared` 快速隧道，让你在外面也能连。
5. **局域网发现**：手机端 APK 通过端口探测自动找到宿主，不用手输地址。

### 路由

| 路由 | 用途 |
|---|---|
| `GET /m/pair?t=…&secret=…` | 配对入口：校验一次性令牌，种下设备 cookie，跳到界面 |
| `GET /m/widget.js` | 桌面右下角面板的脚本（颜色明暗跟随系统） |
| `GET /m/api/qr.svg` | 二维码图片 |
| `POST /m/api/get-code` | 取当前配对码（仅本机可调） |
| `POST /m/api/mint` | 只用一次、可指定 TTL 的配对链接（仅本机可调） |
| `GET /m/api/auto-pair?s=…` | 用长期密钥换一条新的配对链接 |
| `GET /m/api/status` | 隧道状态、设备数等 |
| `GET /m/api/session` | 当前设备会话信息 |
| `POST /m/api/tunnel` | 隧道控制（仅本机可调） |
| `DELETE /m/api/devices` | 撤销全部已配对设备（仅本机可调） |

---

## 安装

插件是一个普通 Node 包，**不需要 `npm install`**。

### 一键安装（推荐）

```bash
node install.mjs
```

它会做 DSH 读取插件所必需的**三件事**，然后检查结果：

1. 在 profile 的 `package.json` 里声明依赖（`link:` 指向本目录）
2. 把插件名加进同文件的 `dsh.profile.bundles`（**漏掉这步不会挂载**）
3. 建 `node_modules/dsh-mobile-public` 的目录联接（Windows 用 junction，无需管理员）

```bash
node install.mjs --dry-run           # 先看会改什么，不动任何文件
node install.mjs --profile <目录>    # 装到别的 profile（默认 ~/.dsh/profiles/desktop）
```

装完**完全退出 DSH 再打开**——插件只在宿主启动时挂载。
然后访问 `http://127.0.0.1:19387/m/api/status`，返回 JSON（含 `profile` / `tunnel` /
`deviceCount`）就成功了。

脚本是幂等的（重复运行只报告 `already correct`），也**不会覆盖**同名的真实目录
——那可能是别人的安装，它会明确报错让你自己处理。

### 手工安装（脚本做不了时）

1. 把本仓库放到一个不会被临时清理的位置，例如 `C:\Users\<你>\dsh-mobile-plugin`。

2. 编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：

   * `dependencies`：

     ```json
     "dsh-mobile-public": "link:C:/Users/<你>/dsh-mobile-plugin"
     ```

   * `dsh.profile.bundles`：

     ```json
     "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-mobile-public"]
     ```

3. 建目录联接：

   ```
   cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-mobile-public" "C:\Users\<你>\dsh-mobile-plugin"
   ```

   （`mklink` 是 cmd 内部命令，PowerShell 里要 `cmd /c` 包一层。）

4. **完全退出 DSH 再打开**，再按上面的地址验证。

5. 手机要能连上，网页服务必须监听局域网地址：在 `cordis.patch.yml` 里确认
   `webserver` 的 `host` 是 `'0.0.0.0'`（默认 `127.0.0.1` 只允许本机），改完重启 DSH。

> 手机访问必须用 **IP 地址**，不能用主机名：宿主只信任网卡上的 IPv4 字面量，
> 用主机名会出现"网页能打开、但每次操作都 403"。

---

## 测试

全部在 `test/` 下，**都不需要网络**，也不动你真实的配对记录：

```bash
node test/selftest.mjs            # 配对存储、两种隧道提供方
node test/integration.mjs         # 真实 HTTP 服务、路由、重定向
node test/origin-check.mjs        # 请求来源判定（内网请求留在内网）
node test/widget-edge-test.cjs    # 配对面板的贴边行为与明暗
node test/panel-geometry-test.cjs # 面板在 7 种屏幕尺寸下的位置
node test/diag-selfcheck.cjs      # 手机端诊断脚本的自检
node test/geometry-probe.cjs      # 把面板几何打印出来（改代码前先看数）
node test/flow-probe.cjs          # 按操作顺序逐步打印坐标
```

`test/MEASURING.md` 说明了量测工具为什么这样写——面板几何曾经"推理"错三次，
所以现在的规矩是**先量、再改、把量到的值钉成断言**。

---

## 设计取舍（为什么是这样）

* **门控放在 `/api` 前缀上**。`cloudflared` 是从回环地址连过来的，所以宿主自己的
  "非本机"防护看不到隧道请求——没有这层门控，发布端口等于把整个宿主 API 交给
  任何拿到 URL 的人。
* **令牌一次性、密钥长期**。一次性令牌被消费后必然失效，所以它绝不被持久化；
  长期密钥用于已配对设备在会话失效后自动换一条新链接。
* **面板明暗跟随系统**，二维码区域**故意保持白底**（反色会让部分扫码器读不出来）。
* **没有运行时依赖**：QR 编码器内置，`mklink` + `link:` 即可安装。

---

## 许可

MIT，见 `LICENSE`。内置的 QR 编码器来自 `qrcode`（MIT），其许可见
`lib/qr-vendor/LICENSE-qrcode`。
