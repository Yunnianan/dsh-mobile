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
| 10.8 | [`dist/dsh-mobile-10.8.apk`](dist/dsh-mobile-10.8.apk) | 413.4 KB | `30DDE06C70018D8E` |

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
5. **局域网发现 + 端口自适应**：手机端 APK 通过端口探测自动找到宿主，不用手输地址；
   宿主端口被改过也能自己找出来（见[端口](#端口宿主说自己在哪)）。
6. **请求桌面批准**：手机找不到宿主密钥时可以直接请求配对，你在电脑面板上点一下「允许」
   即可，不用回头扫二维码。

### 路由

| 路由 | 用途 |
|---|---|
| `GET /m/pair?t=…&secret=…` | 配对入口：校验一次性令牌，种下设备 cookie，跳到界面 |
| `GET /m/widget.js` | 桌面右下角面板的脚本（颜色明暗跟随系统） |
| `GET /m/api/qr.svg` | 二维码图片 |
| `POST /m/api/get-code` | 取当前配对码（仅本机可调） |
| `POST /m/api/mint` | 只用一次、可指定 TTL 的配对链接（仅本机可调） |
| `GET /m/api/auto-pair?s=…` | 用长期密钥换一条新的配对链接 |
| `POST /m/api/pair-request` | 手机请求配对（只带设备名，不含任何凭据；有频率限制） |
| `GET /m/api/pair-request/status?id=…` | 手机轮询批准结果（凭随机 id；链接只交付一次） |
| `GET/POST /m/api/pair-requests` | 面板查询待批准请求 / 批准或拒绝（**仅本机可调**） |
| `GET /m/api/status` | 隧道状态、设备数、**监听端口**等 |
| `GET /m/api/session` | 当前设备会话信息 |
| `POST /m/api/tunnel` | 隧道控制（仅本机可调） |
| `DELETE /m/api/devices` | 撤销全部已配对设备（仅本机可调） |

---

## 使用方法

三步：**装插件（电脑）→ 装 APK（手机）→ 配对**。安装细节见[下一节](#安装)，
这里说的是装完之后怎么用。

### 1. 配对（只需一次）

打开 App，第一次会先看到引导（Tailscale 安装说明 → 怎么用），跟着点完。

配对有四条路，任选一条：

| 方式 | 怎么做 | 适合 |
|---|---|---|
| **扫码**（推荐） | 手机点「扫码 / 配对链接」→ 扫**电脑左下角**面板上的二维码 | 第一次配，且在同一 WiFi |
| **从相册选图** | 扫码页点「从相册选图」→ 选那张二维码截图 | 二维码是截图或别人发的图 |
| **Tailscale 配对** | 手机点「Tailscale 配对」 | **人在外地**，或不想扫码 |
| **手输地址** | 点「Tailscale 配对」，它找不到地址时会进到手输界面；也可直接填地址 + 端口 | 自动发现不工作、或放在反代后面 |

> **Tailscale 配对为什么不用密钥、也不用点同意**：宿主会问自己的 tailnet
> "这个地址是谁的"，**只有属于你账号的设备**才被自动批准。依据是"这台设备在你的
> tailnet 里"——Tailscale 在协议层就挡住了外人，这比"它在某个网段里"强得多
> （后者可以伪造）。没装 Tailscale 时这条路径自动关闭，绝不会变成"信任所有人"。
>
> **手输地址为什么被收起来了**：同一 WiFi 下「自动发现」基本都能找到，而在外面用
> Tailscale 配对也不需要它。它没有消失——Tailscale 按钮找不到地址时会进去。

> **桌面一键批准**的信任依据是"你能操作这台电脑"，不是"请求来自同一网段"——
> 同一 WiFi 上每台设备都在那个网段里，后者证明不了什么。所以恶意请求最多只能让面板
> 弹一个提示，拿不到任何东西，除非你亲手点「允许」。

配对状态会一直保留：以后升级 APK **直接覆盖安装即可，不用重新配**。

### 2. 日常使用

手机打开 APK 就直接进 DSH 界面。地址优先用**内网**（同一 WiFi 下最快），
不在同一网络时自动回退到 **Tailscale**，再不行用**公网隧道**。

界面里的操作：

| 想要 | 怎么做 |
|---|---|
| 换地址 / 改端口 | 点底部地址栏 → 回设置 → 填新地址 |
| 回上一级 | 返回手势或返回键：网页界面 → 设置 → IP 界面 → 配对页 → 退出 |
| 调字号 / 主题 / 全屏 | 设置页里，改完立刻生效，重开也记得 |
| 再看一遍首启引导 | `adb shell am start -a android.intent.action.VIEW -d 'dshmobile://onboard'` |

**返回不再"撤销网页里的点击"**：DSH 界面是单页应用，如果返回走网页历史，
按几次才退到设置是说不准的——现在返回只走 App 自己的界面层级。

### 3. 换电脑 / 换网络

| 情况 | 怎么做 |
|---|---|
| 电脑 IP 变了 | 手机点「自动发现」，或手填新地址 |
| 换了台电脑 | 在新电脑上装插件，然后重新配对一次 |
| 想在外面用 | 装 [Tailscale](features/INSTALL.md#0-tailscale-是什么什么时候要装)，或启用公网隧道 |

---

## 端口：宿主说自己在哪

宿主的端口是可配置的（profile 的 `cordis.patch.yml` 里 `webserver.port`，默认 `19387`）。
手机端的「自动发现」要在不知道端口的情况下扫局域网，所以：

* **宿主会自己上报端口** —— `/m/api/status` 里带 `port` 字段。
* **手机自己读出并填入** —— 扫描沿端口阶梯探测（记忆的端口 → `19387` → `8080/3000/8000`），
  每个地址先试完所有端口再换下一个，所以宿主偏好的端口仍然优先。一旦拿到响应，
  就以响应里声明的端口为准，**自动填进 App 的端口输入框并记住**。
* **全量扫描只跑偏好端口** —— 每个端口都全扫一遍要几分钟，而端口阶梯已经覆盖了常见情况。

所以你**改了端口也不用在手机上改什么**，点「自动发现」就行。想确认它学到了哪个端口，
看手机日志里的 `discover: adopted port N`。

IP 界面上那个「端口」输入框平时不用碰——它存在的理由有点特别：**端口错了这件事
否则完全不可见**。扫描只会说"没找到宿主"，和"这个网络里真的没有电脑"长得一模一样。
手动指定端口时（比如放在反代后面），填在这里。

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
node test/lan-address-test.cjs    # 内网地址选路（VPN 网卡不能冒充内网）
node test/pair-request-test.cjs   # 请求批准的完整流程与安全断言
node test/widget-request-test.cjs # 面板「允许 / 拒绝」按钮发送的决定
node test/image-decode-test.cjs   # 相机图 / 相册图的解码
node test/widget-edge-test.cjs    # 配对面板的贴边行为与明暗
node test/panel-geometry-test.cjs # 面板在 7 种屏幕尺寸下的位置
node test/diag-selfcheck.cjs      # 手机端诊断脚本的自检
node test/qr-selftest.mjs         # 内置 QR 编码器与参考实现比对
node test/geometry-probe.cjs      # 把面板几何打印出来（改代码前先看数）
node test/flow-probe.cjs          # 按操作顺序逐步打印坐标
```

`node --test test/` 或 `npm test` 会跑其中一组核心套件。

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
* **让宿主自报端口，而不是让用户填**。端口可配置这件事只有宿主机知道；手机扫描必须在
  不知道端口的情况下扫，于是"端口错了"和"这个网络里没有电脑"完全无法区分——这是最难
  排查的一类问题。加一个 `port` 字段就没有这个盲区了：**任何**能拿到响应的端口都能让宿主
  说出正确端口，App 再据此重新探测并把值记住。
* **网络位置不算身份**。桌面一键批准的依据是"有人能操作这台电脑"，不是"请求来自同一网段"
  ——后者证明不了什么，同一 WiFi 上每台设备都在那个网段里。所以批准必须由本机（loopback）
  发起，请求本身不带任何凭据，且链接在**批准时**才生成、只交付一次。撤销同理：只能本机调。
* **内网地址按客观依据挑，不按网卡名**。网卡名是本地化的（`WLAN` / `以太网`）、每家 VPN
  自己起名，而且误判会**静默丢掉唯一可用的地址**。改用：系统默认路由网卡 + RFC1918 +
  排除 `198.18/15` 保留段。排序只是偏好——调用方把全部候选交给手机逐个探测，
  所以猜错只损失一次探测，不是配对失败。
* **没有运行时依赖**：QR 编码器内置，`mklink` + `link:` 即可安装。

---

## 许可

MIT，见 `LICENSE`。内置的 QR 编码器来自 `qrcode`（MIT），其许可见
`lib/qr-vendor/LICENSE-qrcode`。
