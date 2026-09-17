# 皮肤安装说明 · 给 AI 助手的最小版

> 目标读者：被要求"安装这个皮肤包 `<url>`"的任意 AI 助手。
> 前提：这是一台跑 DeepSeek Harness（dsh）的机器，皮肤是 dsh Web GUI 的客户端插件。

## 一句话结论

**把皮肤包放进 `<DSH_HOME>/profiles/web/node_modules/<包名>/` 就够了。** 有皮肤管理器（`@dsh-external/dsh-client-ui-skin-manager`）在时，它会自动发现该包并在 home 层接线，你**不需要**改任何配置文件。

关键路径（`<DSH_HOME>` 默认 `~/.dsh`，Windows 上通常是 `C:\Users\<用户>\.dsh`）：

| 东西 | 位置 |
|---|---|
| 皮肤包放这里 | `<DSH_HOME>/profiles/web/node_modules/@scope/name/`（目录名随意，包名以 `package.json`/`skin.json` 为准） |
| 皮肤管理器的工具 | `<DSH_HOME>/profiles/web/node_modules/@dsh-external/dsh-client-ui-skin-manager/tools/` |
| 管理器托管块 | `<DSH_HOME>/cordis.patch.yml`（home 层，**不要手改**） |
| 用户自己的层 | `<DSH_HOME>/profiles/web/cordis.patch.yml`（profile 层，可追加，别覆盖） |

## 最快路径：一条命令

```sh
node "<DSH_HOME>/profiles/web/node_modules/@dsh-external/dsh-client-ui-skin-manager/tools/install-skin.mjs" <github-url | owner/repo | 本地目录>
```

它会依次完成：下载（**纯 Node，不需要 git / 不需要解压工具**）→ 找到包根 → 放进 profile → 自动打老皮肤兼容补丁 → 检测到皮肤管理器就**不重复接线** → 打印最后一步该做什么。

可选参数：`--dry-run`（只报告不写盘）、`--ref <分支/标签>`、`--name <包名>`、`--no-wire`。
环境变量：`DSH_HOME`（默认 `~/.dsh`）、`DSH_DESKTOP_PROFILE`（默认 `web`）、`GITHUB_TOKEN`（可选，提高 GitHub API 限额）。

## 手动路径（四步）

1. **取得包**：`git clone` 或下载 zip 解压。注意 `lib/client.js` 常有 2–3 MB，下载要完整、别截断。
2. **放进 profile**：拷到 `<DSH_HOME>/profiles/web/node_modules/@dsh-external/<名字>/`，保持包内结构（`package.json`、`skin.json`、`lib/`、`preview/`）。
3. **接线**：
   - 装了皮肤管理器 → **什么都别做**，管理器会自动发现并接入；运行中安装也能被发现（管理器把接入行写进 home 层，loader 重载后即生效）。若列表里那款皮肤显示 **未接入**，让用户**重启一次 DSH** 即可挂载。
   - 没装管理器 → 在 profile 层 `profiles/web/cordis.patch.yml` 里**追加**：
     ```yaml
     - insert:
         - id: ui-skin-xxx          # 取 skin.json 的 wiring.id；没有就用 ui-skin-<skin.json 的 id>
           name: '@dsh-external/dsh-client-ui-skin-xxx'
     - id: ui-skin-xxx
       disabled: false
     ```
     若该文件内容只有 `[]`，请把 `[]` 替换掉（别在 `[]` 后面追列表项）。
4. **生效**：装了管理器 → 让用户刷新页面，在 **设置 → 皮肤** 里选中它（显示"待生效"时重启一次 DSH）；没装管理器 → 重启 DSH（`dsh web`）。

## 装完怎么确认

```sh
# 1) 管理器视角（loopback 免 token；端口默认 3080）
node -e "fetch('http://127.0.0.1:3080/api/dsh-skin-manager/state').then(r=>r.json()).then(j=>console.log(j.skins.map(s=>s.id+':'+(s.wired?'wired':'unwired')+(s.duplicated?' DUPLICATE':''))))"

# 2) 组合配置视角：该 entry id 只应出现一次
dsh --profile web --dump-config | grep -c ui-skin-xxx
```

两者都对，就可以告诉用户：**打开 设置 → 皮肤，点一下即可切换**（切换会自动刷新页面一次）。

## 三条铁律

1. **不要编辑托管块内部**：`# === dsh-skin-manager:begin … end ===` 之间的内容每次都会被管理器重写。它也**只在 home 层**（`<DSH_HOME>/cordis.patch.yml`）。
2. **不要整体重写 `cordis.patch.yml`**：只追加需要的行，保留文件里已有的注释和其他插件的行。
3. **不要为了让皮肤生效而删除管理器的行**（`ui-skin-manager`）：删掉它，设置里的"皮肤"页就没了。别人接好的皮肤行管理器会**收养**（只加启停覆盖、不再插入），所以不会重复接线。

## 老皮肤兼容补丁

皮肤 `lib/index.js` 里若是 `return ctx.webServer.register({...})`（旧 dsh 写法），关闭后再启用会报 `webserver: duplicate exact route "..."`，表现为"关得掉、开不回来"。

```sh
node "<...>/tools/patch-skin-dispose.mjs" "<皮肤包目录>"
```

幂等；`install-skin.mjs` 已自动执行（输出 `shim: patched / already / not-needed / unsupported`，只有 `unsupported` 才需要人工看一眼）。

## 常见坑（本机实测）

- **不要用 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 写 JSON**：它会加 BOM。（管理器的 `skin.json` 解析已容忍 BOM，但其他地方未必。）写文件优先用 Node。
- **`Invoke-WebRequest` / `curl` 可能因 TLS 失败**，`raw.githubusercontent.com` 可能超时：所以 `install-skin.mjs` 走 `codeload` 压缩包与 GitHub API（必要时用 blob API 兜底），不要自己拼 raw 链接。
- **不要动 `<DSH_HOME>/profiles/node_modules`**：那是 harness 自己维护的符号链接镜像。
- 皮肤是**客户端插件**：切换它必然会刷新页面一次才能加载/卸载它的 `client.js`，这是正常的。
- **如果 `dsh` 启动报 `overlay .../cordis.patch.yml must be a top-level YAML array of loader patch entries`**：说明那个 patch 层只剩注释（YAML 里等于 `null`，不是数组）。修（**不需要 dsh 能启动**）：
  ```sh
  node "<...>/dsh-client-ui-skin-manager/tools/repair-patch-layer.mjs" --all
  ```
  以后自己写 patch 层时注意：文件必须是**顶层数组**（空也要写 `[]`，只有注释是无效的）。

## 卸载

删除 `<profile>/node_modules/<包名>` 目录即可；管理器会在下次刷新/重启时把它从托管块里移除。若是没装管理器的手动接线，同时删掉 profile 层里那两行。
