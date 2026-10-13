# 手机端表情包不出图：`dsh-meme` 的本地补丁

## 症状

电脑上表情包正常，**手机上全部裂图**（对话里的表情包加载不出来）。

## 根因（两处，都在 `dsh-meme` 里）

`dsh-meme` 的只读图片路由用 `denyNonLoopback()` 把关，而它**只看 `Host` 头里的主机名是否为回环**：

```js
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
```

这个设计本身是对的，注释也写清了理由：原来的判据是
`new URL(origin).host === req.headers.host`，那是**自己跟自己比**——攻击者把自己的域名解析到
`127.0.0.1`（DNS rebinding）就能让两边相等而放行。改看 `Host` 之后，rebinding 时 `Host` 是
攻击者的域名，直接落选。

**但它把手机一并挡掉了**，因为手机用 `http://192.168.31.56:19387` 或
`http://yunannian.tail951e59.ts.net:19387` 打开界面，`Host` 都不是回环：

```
本机     http://127.0.0.1:19387/dsh-memes/…        → 200 ✔
局域网   http://192.168.31.56:19387/dsh-memes/…    → 403 ✖
```

## 补丁

改一处判定，加一个函数 —— 只放宽**只读**的图片路由，写入类接口（上传/改/删/管理 API）
**保持只接受回环**：

```diff
- if (denyNonLoopback(req, res)) return
+ if (denyNonOwnAddress(req, res)) return
```

新增的判定按两步走：

1. **Host 是本机网卡上的某个地址** → 放行（覆盖局域网 IP 与 Tailscale `100.x`）。
2. **Host 是本机的名字** → 放行。用**字符串规则**，不做 DNS 查询：
   * 整名等于 `os.hostname()`（不区分大小写），或
   * 形如 `<主机名>.<tailnet>`，即 `yunannian.tail951e59.ts.net`。

第 2 步是必须的：**手机端会把名字当地址存下来**（名字比隧道地址稳定——换电脑时名字可以沿用，
IP 会静默连到别的机器），所以手机请求的 `Host` 是名字。

## 为什么第 2 步用字符串而不是 DNS

`dns.lookup` 是**回调式**的，而这个判定要在**同步**的路由处理里做；Node 24 **没有
`lookupSync`**（实测确认）。字符串规则反而更直接，也不依赖解析器状态。

**安全含义没有变松**，实测确认：

| Host | 结果 |
|---|---|
| `127.0.0.1` / 局域网 IP / Tailscale IP | 200 ✔ |
| `yunannian` / `yunannian.tail951e59.ts.net` | 200 ✔ |
| `evil.example.com`（rebinding） | **403** ✔ |
| `yunannian.evil.com`（伪成本机名 + 攻击者后缀） | **403** ✔ |
| `8.8.8.8` / 同网段非本机 IP | **403** ✔ |

最后一条是关键：**字符串规则不允许"本机名的前缀 + 任意后缀"**，尾部必须是本机真正的 tailnet 名。

## 应用方式

补丁直接改在 `node_modules` 里（`dsh-meme` 是 npm 包，不是本仓库的一部分）：

```
~/.dsh/profiles/desktop/node_modules/dsh-meme/index.js
```

**注意**：`dsh-meme` 升级或重装会**覆盖掉**这个补丁，症状会重现（手机端再次裂图）。
届时按上面的 diff 重新应用即可。上游若要采纳，需要的是同一个改动 —— 只读路由放宽到
"本机自有地址"，写入路由不动。

## 修复前的排查记录（供参考）

一开始怀疑是 URL 写死 `127.0.0.1` 导致的（插件里确实有
`const host = webServer.host === '0.0.0.0' ? '127.0.0.1' : webServer.host`），
但实测发现前端取图用的是**相对路径** `/dsh-memes/<path>`，浏览器按页面来源解析，
所以在手机上并不会变成 `127.0.0.1`。**真正的拦截点是那个 403。**
