# DSH 手机端 · Android 客户端源码

这是 `dist/` 里那个 APK 的源码。纯 Java,**没有第三方框架**,唯一的外部依赖是
内置的二维码解码库 `libs/zxing-core-3.5.3.jar`(Apache-2.0)。

构建不使用 Gradle,只用 Android SDK 的命令行工具串起来:

```
aapt2 compile/link  →  javac  →  d8  →  zipalign  →  apksigner
```

---

## 目录

| 路径 | 内容 |
|---|---|
| `AndroidManifest.xml` | 包名、版本号、权限(仅 INTERNET / ACCESS_NETWORK_STATE / CAMERA) |
| `src/com/dshmobile/app/MainActivity.java` | 主壳:WebView、配对流程、顶栏、手势、地址探测 |
| `src/com/dshmobile/app/ScanActivity.java` | 扫码页(内置 zxing,不依赖任何扫码 App) |
| `src/com/dshmobile/app/LanScanner.java` | 局域网发现 + 端口探测 |
| `src/com/dshmobile/app/SplashView.java` | 启动页 |
| `res/` | 布局、颜色、字符串、图标(含 values-night 深色) |
| `assets/diag.js` | 注入页面用于自检的脚本 |

---

## 构建前置

仓库里**不含** SDK 和 JDK(体积大、且 JDK 有分发许可问题),需要你自己准备:

1. **JDK**(能跑 `javac` / `d8` / `apksigner` 即可)
2. **Android SDK**,需要两样:
   - `build-tools/34.0.0/`(提供 `aapt2` `d8` `zipalign` `apksigner`)
   - `platforms/android-36/android.jar`

   最省事的办法是装 Android Studio 的 **SDK Manager**,勾选
   *Android SDK Build-Tools 34* 与 *Android 16 (API 36) SDK Platform*;
   或者只下 command-line tools + `sdkmanager`:

   ```
   sdkmanager "build-tools;34.0.0" "platforms;android-36"
   ```

---

## 构建

在本仓库根目录执行:

```powershell
pwsh -File .\build-apk.ps1 -VersionName 16.9.1 -VersionCode 140
```

默认路径约定(都能用参数覆盖):

```
<仓库>/android/           源码(默认 -Proj)
<仓库>/libs/              zxing jar
<仓库>/out/               产物
<仓库>/keystore/          签名密钥(不在 git 里,见下)
<仓库>/../sdk             -Sdk 默认值
<仓库>/../jdk             -Jdk 默认值
```

如果你的 SDK/JDK 在别处:

```powershell
pwsh -File .\build-apk.ps1 `
  -Sdk 'C:\Android\sdk' -Jdk 'C:\Program Files\Java\jdk-17' `
  -VersionName 16.9.1 -VersionCode 140
```

产物:`out/dsh-mobile-16.9.1.apk`

### ⚠️ 版本号必须改**两处**

踩过的坑:`aapt2` 的 `--version-code` / `--version-name` **只在 manifest 没有声明该属性时才注入**,
而这个 manifest 一直是写死的。所以只改命令行参数是**无效的**,会静默产出旧版本号的包
(表现为 Android 拒绝安装,提示降级)。

必须**同时**改:

1. `android/AndroidManifest.xml` 里的 `android:versionCode` / `android:versionName`
2. 构建命令行的 `-VersionCode` / `-VersionName`(只影响输出文件名)

---

## 签名密钥

构建脚本用的是 `keystore/dshmobile.jks`(**没有**提交到仓库,`.gitignore` 已排除)。

- **没有密钥时**:脚本会自动新建一把自签名密钥,构建照常成功。
  但这样签出来的 APK **无法覆盖安装在官方包之上** —— Android 要求升级包签名一致。
  自己用完全没问题,首次安装即可。
- **有官方密钥时**:签出来的包可以直接覆盖安装,配对状态保留。

签名指纹(SHA-256),可用于核对:

```
45:30:01:7A:FC:17:74:0B:0A:A6:B1:99:58:97:C6:F3:
FA:3C:9B:B9:10:9B:DB:B6:D8:01:1D:36:21:BB:33:3B
```

> 为什么密钥不入库:持有它就能签出一个被 Android 当作"官方升级"接受的包。
> 跟着源码一起公开等于把这条路径交给任何人。

---

## 已知行为(改代码前值得一读)

- **文件上传**靠 WebView 的 `onShowFileChooser` 实现。没实现它时,页面里的
  "附件 / 上传图片"点了不会有任何反应,而且**不报错** —— 历史版本栽在这里。
  App 不申请 `MANAGE_EXTERNAL_STORAGE`,只能读用户在系统选择器里主动选中的文件。
- **横向滑动回主页的手势已移除**(用户反馈会误触,把会话顶掉)。
  回配对菜单请用顶栏齿轮,或系统返回手势。
  顶部下拉退出沉浸模式的手势**保留**,否则沉浸模式没有出口。
- **Android 13+ 的返回事件**走 `OnBackInvokedDispatcher`,同时保留 `onBackPressed()`;
  两者都指向同一个 `handleBack()`,否则同一个手势在不同机器上行为不一致。
- **WebView 缓存**有上限(超 400MB 自动清理),升级后旧资源会被裁掉。
- **配对状态**存在 App 私有存储里,覆盖安装保留,**卸载会丢**。
