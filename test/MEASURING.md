# 配对面板的量测与测试

这里的东西存在的唯一理由：**这块几何我"推理"过三轮，三轮都是错的**。
先量、再改、把量到的值钉成断言 —— 顺序不能反。

## 三个文件，各司其职

| 文件 | 作用 | 什么时候用 |
|---|---|---|
| `widget-stub.cjs` | 共享的 DOM 桩。模拟浏览器里 widget.js 会碰到的东西：元素、类名、内联样式、**由样式推导的 `offsetTop`/`offsetLeft`（不含 transform）**、**随收起类变化的高度**、`max-height` 压缩、`getComputedStyle` 返回布局变量、可手动触发的 `ResizeObserver` | 被下面几个文件 import，不放断言 |
| `geometry-probe.cjs` | **把几何打印出来**。先跑它，再动手改代码。`--matrix`（7 设备矩阵）、`--rooms`（room 的中间值） | 任何涉及位置/尺寸的改动之前 |
| `flow-probe.cjs` | **按用户的操作顺序**逐步打印坐标。单看状态看不出转移过程中的 bug，这个能 | 交互类问题的第一站 |
| `panel-geometry-test.cjs` | 把 probe 量到的值**钉成断言**（含 7 台设备的适配矩阵） | 改动之后，以及回归 |

**组件自己也会报告状态**：`window.__dshMobilePanelState`
（`panel`/`strip`/`homeLeft`/`homeBottom`/`atHome`/`collapsed`/`parked`）。
DOM 只能看到结果，**决定结果的值在这里** —— 这次就是靠它一眼看出"家"被算成了收起态的坐标。

## 位置模型：两个形态，一个 top

`state.panel` 是**用户记住的位置**（持久化），`state.strip` 是**当前显示的位置**。

* **展开从记忆的 top 开始**（顶边对齐），所以"放到 672 点开就是 672 往下长"。
* 480px 的面板放在 672 会超出屏幕，所以**显示时**夹进屏内；**记忆值绝不改写** ——
  改写它就会让"收起"回到被夹后的位置（672 变 229），下一次展开又是另一个值，来回跳。
* 把两个形态混成一个字段，是"第二次展开跳回屏幕顶部"的根因。

**实测（`flow-probe.cjs`，375×723）**：

```
收起 672 → 展开 229（从 672 往下长，被夹进屏内）→ 收起 672 → 再展开 229    ← 无漂移
```

## 面板怎么适配设备（四条规则）

## 用法

```bash
cd dsh-mobile/plugin

node geometry-probe.cjs            # 单设备：收起 → 展开 → 拖动 → 收起 → 再展开
node geometry-probe.cjs --matrix   # 7 台设备：是否放得下、上下安全区是否满足
node geometry-probe.cjs --rooms    # 把 room 的中间值打出来（算术对不上时用这个）
node panel-geometry-test.cjs       # 断言（期望值必须来自上面的实测）
```

`--matrix` 现在是这样的（**结果**，不是意图）：

```
device                  viewport    room  openH stripTop openTop openBottom stripFits openFits
small phone 320x568     320x568      546    480      517      74        554       yes      yes
phone 375x667           375x667      645    480      616     173        653       yes      yes
phone 375x723 (tested)  375x723      701    480      672     229        709       yes      yes
large 430x932           430x932      870    480      861     418        898       yes      yes
landscape 812x375       812x375      339    339      317      15        354       yes      yes
notched 390x844         390x844      735    480      773     330        810       yes      yes
tiny 280x480            280x480      458    458      429       8        466       yes      yes
```

## 面板怎么适配设备（四条规则）

1. **位置从 CSS 变量读，不写死**。`--dshm-home-left/bottom = 14px + env(safe-area-inset-*)`，
   `layoutMetrics()` 用 `getComputedStyle` 读回来。写死 `left:14px;bottom:14px` 在刘海屏/横屏上会
   把面板压到圆角或手势条下面。
2. **宽度受视口限制**：`width:min(248px, 100vw - 24px)`。窄屏上 248px 的面板根本放不下。
3. **高度受 room 限制**：`--dshm-room = 100vh − insetTop − insetBottom − homeBottom − 8px`。
   这里**必须减去 homeBottom**：漏掉它时，横屏会把面板压到 360px 高，而底部还要求留 21px 安全区 ——
   两个各自合理的约束互相冲突，面板就溢出 10px。
4. **尺寸变化后重新贴家**：`ResizeObserver`。因为高度是被 CSS 压过的，位置若按压缩前的高度算，
   就会挂到屏幕外。`state.atHome` 保证只重算"家"的位置，**用户拖到的位置不被覆盖**。

## ⚠️ 三个把几何算错的原因（都是"两个合理的东西互相打架"）

| # | 症状 | 真因 |
|---|---|---|
| 1 | 小标签总跑到屏幕下方 | **"家"被存成了 `top` 值**，而面板有收起/展开两个高度 → 只有一个是对的。改成存 **距屏幕底边的距离**，`top` 由当前高度现场推导 |
| 2 | 展开后面板比预期低 10px | `homeTopFor` 用 `−14`，而 `clampPosition` 用另一个常量 `−4`（`MARGIN_PX`）把结果夹回去了。**两处边距必须同源** |
| 3 | 横屏下面板被钉在 y=44 | `clampPosition` 把 **`marginLeft`（横屏 44）当成了纵向下限**：`Math.max(marginLeft, top)` 把 15 顶成 44。纵向下限应为 0，顶部安全区由 `roomFor` 负责 |

另外：**位置要按"面板能有多高"（`effectiveHeight`）算，而不是当时量到的 `offsetHeight`** ——
短屏上后者可能还是未压缩的设计高度，等 observer 回填就会有一帧错位。

## 桩为什么要这么写（都是踩过的坑）

* **`offsetTop`/`offsetLeft` 必须由 `style.top`/`style.left` 推导**。静态属性会让断言读到 14px，
  而设备真实边距是 44px —— 我看过好几轮"测试过了但真机不对"，根因都在桩而不是组件。
* **`offsetHeight` 必须随收起类变化**，并且 `max-height` 生效。否则"小屏放不下"这类问题永远测不出来。
* **`ResizeObserver` 要能被手动触发**。不提供它，组件会走"不支持"分支，
  那条分支在真机上才是常用的。
* **`tap()` 是 `pointerdown` + `pointerup`**：展开/收起绑在 `pointerup` 上（为了区分点击与拖动），
  只发 `pointerup` 不会触发。
* **拖动终点要显式给出**：桩不做布局，无法把指针位移换算成新坐标；`drag(handle, left, top)` 后半段
  是"陈述结果"，被测的是**拖动之后发生什么**。

## 真机核对（量测的最终裁判）

```bash
adb shell am start -a android.intent.action.VIEW -d 'dshmobile://diag'
adb logcat -d -s DSHMobile:V | Select-String "diag: panel"
```

期望（375×723 的机器）：`panel.rect=0,672 30x37` —— 视口 723 − 标签高 37 − 边距 14 = 672。
