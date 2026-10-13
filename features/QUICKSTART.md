# 快速开始

三步：**装插件（电脑）→ 装 APK（手机）→ 扫码配对**。

详细说明见 [安装指南](INSTALL.md)。遇到问题先看文末的排错。

## 1. 装插件（电脑）

插件是一个普通 Node 包，没有第三方依赖，不需要 `npm install`。

1. 把插件目录（本仓库）放到一个**不会被临时清理**的位置，例如
   `C:\Users\<你的用户名>\dsh-mobile-plugin`。不要放在"下载"里再引用它。

2. 一条命令装好：

   ```bash
   cd C:\Users\<你的用户名>\dsh-mobile-plugin
   node install.mjs --dry-run    # 先看会改什么（不改任何东西）
   node install.mjs              # 真正安装
   ```

   它会做 DSH 读取插件所必需的**三件事**，然后检查结果：

   - 在你的 profile 里声明依赖（`link:` 指向这个目录）
   - 把插件名加进 `dsh.profile.bundles` ← **漏掉这步插件不会挂载**
   - 建 `node_modules\dsh-mobile-public` 的目录联接

   默认装到 `%USERPROFILE%\.dsh\profiles\desktop`；要装到别的 profile 就加
   `--profile <目录>`。

3. **完全退出 DSH 再打开**（插件只在宿主启动时挂载）。

4. 验证：浏览器打开 <http://127.0.0.1:19387/m/api/status>，返回一段 JSON
   （含 `profile`、`tunnel`、`deviceCount`）就成了。

5. 确认网页服务监听局域网（否则手机连不上）：在 profile 目录的 `cordis.patch.yml` 里，
   `webserver` 的 `host` 必须是 `'0.0.0.0'`（默认 `127.0.0.1` 只允许本机），改完重启 DSH。

## 2. 装 APK（手机）

从 [dist/](../dist) 或 [Releases](../../releases) 取 `dsh-mobile-*.apk`，传到手机，点它安装。

这是自签名应用，会提示"未知来源"，允许即可。以后升级直接覆盖安装，配对状态会保留，不用卸载。

## 3. 配对

打开 App，**第一次会先看到引导**（Tailscale 安装说明 → 怎么用），跟着点完即可。

配对走两条路之一：

**A. 扫码（推荐）** —— 电脑上 DSH **左下角**的配对面板有个二维码，手机点「扫码 / 配对链接」扫它。扫完自动配对，不用手抄。

> 二维码是截图、或别人发的图片时：在扫码页点「从相册选图」选那张图即可。

**B. 手输地址** —— 点「输入 IP 地址」→ 填 `http://<电脑IP>:19387` → 下一步 → 填一次性密钥 → 连接。同一 WiFi 下可以点「自动发现」让它自己找。

地址用**内网 IP**（如 `http://192.168.1.5:19387`）最快；不在同一 WiFi 时用 **Tailscale IP**（`http://100.x.x.x:19387`，见 [安装指南第 0 节](INSTALL.md#0-tailscale-是什么什么时候要装)）。

## 出问题先看这里

| 现象 | 先查什么 |
|---|---|
| 手机"连接失败" | 电脑上 DSH 是否在运行、插件是否装好（第 1 步第 4 条）、手机和电脑是否在同一 WiFi（或 Tailscale 开关已打开） |
| 网页能开但操作都 403 | 地址用了主机名，换成 IP 地址 |
| 左下角没有配对面板 | 宿主没重启，或 `bundles` 里漏了插件名（第 1 步第 2 条） |
| 引导想再看一遍 | `adb shell am start -a android.intent.action.VIEW -d 'dshmobile://onboard'` |
