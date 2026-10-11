# Baton — HarmonyOS NEXT 壳

把 Baton 的 Web 前端用 ArkWeb (`Web` 组件) 包成纯血鸿蒙 (HarmonyOS NEXT) 应用。
与 `src-tauri/`（Android/iOS/桌面壳）平级，职责完全相同：**只做壳，不含业务逻辑，
服务器地址和 API key 都不写进 App**。

## 架构（对齐现有 Tauri App）

现有原生 App 的做法（见 `web/js/entry-landing.js`）：

1. **前端本地打包进 App**：Tauri 把 `npm run build` 的 `dist/` 作为 `frontendDist`
   打进包里，webview 加载**本地** `landing.html`（origin 非 http），不连某个固定远程地址。
2. **服务器 URL + key 靠「Start URL」带进来**，App 里零硬编码。Start URL 两种形态：
   - `https://<server>/?t=<一次性token>`（install.sh 下发，60 分钟单次有效）
   - `https://<server>/?key=<apiKey>`（setup 页二维码，永久）
3. 获取方式：**扫码**（setup 页的二维码，内容即上面的 Start URL）或**手动粘贴**到登录框。
4. landing 页解析出 server(origin) 和 token/key，token 再 `POST /auth/exchange-token`
   换 apiKey，最后把 **key 存 `_ak`、server URL 存 `_as`**（localStorage）。

鸿蒙壳 100% 照搬这套：本地加载 `rawfile/landing.html`，登录靠扫码/粘贴 Start URL。
ArkWeb 的 `$rawfile` origin 非 http → 前端 `isNativeApp` 自动为 true，走原生登录分支（会存 `_as`）。

> 跨域不是问题：API Gateway 对所有接口返回 `Access-Control-Allow-Origin: *` 且允许
> `x-api-key` 头，鉴权走 header 不走 cookie，所以本地页面(resource origin) 调远程 API 放行。

## 打包前端进 App

```
# macOS / Linux
bash harmony/sync-web.sh
# Windows PowerShell
powershell -ExecutionPolicy Bypass -File harmony\sync-web.ps1
```

脚本做：仓库根 `npm run build` → 清空 `entry/src/main/resources/rawfile/`（保留 `.gitkeep`）
→ 把 `dist/` 全部拷进去。入口页 `rawfile/landing.html`。`rawfile/` 内容已 gitignore。
每次前端更新都要重跑此脚本再出鸿蒙包。需本机已装 Node + npm。

## 在 DevEco Studio 里打开/构建

> ⚠️ **本机是 Linux，无法编译/模拟鸿蒙**。需要装了 DevEco Studio 的 Windows / macOS
> 机器 + HarmonyOS SDK（鸿蒙无跨平台命令行云构建）。

**推荐做法（最稳，避开 SDK 版本 schema 差异）：**

1. DevEco Studio → 新建 **Empty Ability**（ArkTS, Stage 模型, HarmonyOS NEXT）工程。
   这会生成与本地 SDK 匹配的 `build-profile.json5` / `hvigorfile.ts` / `oh-package.json5` /
   app 图标 (`AppScope/resources/.../media`) / 签名配置。
2. 把本目录的**壳源码**合并进去（这些才是有价值的部分）：
   - `entry/src/main/ets/pages/Index.ets`（★ Web 壳，`src = $rawfile('landing.html')`）
   - `entry/src/main/ets/entryability/EntryAbility.ets`
   - `entry/src/main/module.json5` 的 `requestPermissions`（`ohos.permission.INTERNET`）
   - `string.json` / `color.json` 新增条目
3. `bash harmony/sync-web.sh` 把前端打进 `rawfile/`。
4. 构建版本已对齐本机真实可 build 的项目（`/home/ec2-user/data/paging/src/app`）：
   `targetSdkVersion 26.0.0` / `compatibleSdkVersion 6.1.1(24)` / `modelVersion 26.0.0`。
   以你 DevEco 实装 SDK 为准，不符按提示微调。签名 (`signingConfigs`) 已留空——
   由 DevEco 自动签名或填你自己的证书，**切勿把证书/密码提交进仓库**（DevEco 自动签名会
   把证书路径+密码写进 `build-profile.json5`，提交前用 `git checkout harmony/build-profile.json5` 还原）。
   App 图标已内置（品牌徽标 `foreground.png` + 深色底 `background.png` + `layered_image.json`，
   启动图标 `startIcon.png`），无需从模板拷。
5. Run 到真机；Release 用 DevEco 应用签名出 `.hap/.app`，经 AppGallery Connect 上架。

## 登录（粘贴 / 扫码，均已实现）

- **粘贴**：打开 App → landing 页 → 在 Baton setup 页（桌面/网页端 `setup.html`）复制那条
  `https://<server>/?key=...` Start URL → 粘进登录框 → Connect。
- **扫码**：landing 页的扫码按钮经原生 ScanKit 桥完成（见下），直接扫 setup 页的二维码。

### 扫码实现（ScanKit 桥）

- 原生 `Index.ets` 的 `ScanBridge` 经 `Web.javaScriptProxy` 注入 `window.harmonyScanBridge`，
  调 `@kit.ScanKit` 的 `scanBarcode.startScanForResult`（系统自带全屏扫码 UI，含相机权限引导、
  相册、取消），扫到后用 `runJavaScript` 回调 `window.__onHarmonyScan(内容)`。
- 前端 `web/js/entry-landing.js` 检测到 `window.harmonyScanBridge` 时走鸿蒙分支，把扫到的
  Start URL 交给与粘贴/Tauri 相同的 `applyStartUrl` 登录流程。该分支纯增量，桥不存在
  （Tauri/浏览器/桌面）时行为零变化。
- 需要 `ohos.permission.CAMERA`（已在 `module.json5` 声明，首次扫码由 ScanKit UI 引导授权）。

## 兼容性检查表（跑起来后逐项验证）

- [ ] **本地页加载**：`$rawfile('landing.html')` 能渲染，相对资源(js/css)不 404
      （vite `base: './'` 已出相对路径）。
- [ ] **isNativeApp 判定**：确认 `$rawfile` 的 `location.origin` 不以 `http` 开头
      （否则会误判成浏览器模式、不存 `_as`）。
- [ ] **localStorage 持久**：登录后杀进程重进仍免登录（`_ak`/`_as` 没丢）。
- [ ] **跨域 API**：REST 列表/消息能从 resource origin 调通远程 `https://<server>/api/...`。
- [ ] **WebSocket 实时**：发消息、流式 typewriter、权限弹窗实时到达。
- [ ] **前台恢复重连**：锁屏/切后台几分钟再回来，WS 自动重连补消息
      （前端 `web/js/ws.js` 靠 `visibilitychange/pageshow/focus` 触发，需确认 ArkWeb 语义能触发）。
- [ ] **返回键**：有历史时后退、首页时退出（`onBackPress` 已实现）。
- [ ] **安全区**：顶栏不被状态栏/刘海遮挡。

## 已知降级（Tauri 原生能力暂缺，均 feature-detect 不崩）

- opener 外链、iOS 语音输入、文件下载 → 非核心，暂缺。
- 扫码登录已用 ScanKit 实现（见上），不再是降级项。
