# 听歌集成补丁 · 2026-11-26

本目录是 `../patch-pet-kit.mjs` 的资源源文件，随标准版 / HD 包分发。
形象侧实现位于 `../../backends/live2d.js` 和 `../../backends/music/`。
本次为本地开发提交，未升级发布版本，未出包、推送或部署 Coo。

## 内容与机制

- `music-ear.ts`：有 WebSocket 订阅者才启动采集；最后一人退出后停止，超时/退出退避重试，每包附服务器采样时间。
- `probe.ps1` / `NAudio.dll`：Windows WASAPI loopback，输出音量、频谱、应用电平；不保存音频。采集器来自 dsh-whale-pulse（MIT），NAudio 1.10.0（MIT）。
- `backends/music/analysis.js`：DeepFish Beat.cs / Tempo.cs / Music.cs 算法移植，BPM 决定下一句长度，不以音量驱动动作幅度。
- `backends/music/transform.js`：模型矩阵转 SVG 坐标，处理 Y 轴符号、体型锚点、Reach 与模型缩放。
- `backends/music/face.js`：音乐脸的累计计时与不重复轮换，最终仍写现有 `layers[]`。
- 物理每帧仅调用一次 `evaluate(dt)`，由 SDK 处理内部固定步长和插值；移除导致待机手指微抖的外层混合分步。
- kit 最终旋转保留5位小数，解决0.1度量化导致的头部/上半身微抖。
- 音频从 server → `/music` → body-host → iframe → kit → figure；音乐会话状态反向回传，供主窗口提帧。
- ear=off 或不含 ear 轴的形象不订阅音频；三档强度可通过 `figure.setDanceStrength('soft'|'normal'|'strong')` 调整，默认 soft。本次不新增产品设置页。

## 补丁命令

从形象包根目录运行：

```powershell
node tools/patch-pet-kit.mjs --dir="C:/你的/Coo安装目录" --check
node tools/patch-pet-kit.mjs --dir="C:/你的/Coo安装目录"
node tools/patch-pet-kit.mjs --dir="C:/你的/Coo安装目录" --revert
```

`--check` 检查最终补丁及资源字节内容，缺失返回非0；apply 先预检全部目标，任何失败均不写文件。
`.petkit-transaction.json` 保存首次应用前的文件快照，重复执行不覆盖它；revert 恢复原文件，删除仅由本次补丁新建的资源，保留原来已有资源。
回退到本次应用前状态，不代表移除所有历史补丁。没有事务快照时只使用旧 `.bak-petkit`，不会删除未知资源。

## 本地验证

```powershell
node tools/test-pet-kit-patch.mjs --engine="只读引擎源码目录" --out="隔离测试输出目录"
node tools/test-music-ear.mjs "隔离测试输出目录"
node tools/test-music-bridge.mjs "已打补丁的隔离引擎目录"
```

已验证：当前安装引擎与2026-11-23历史快照可应用、重复执行、check、同大小资源损坏检测、精确回退、已有资源保留、锚点缺失时不写文件。
真实 PowerShell 子进程验证订阅、时间戳、多客户端、最后释放与重新启动；使用假特征源，不据此宣称歌曲估速已在 Coo 真机通过。
执行实际 patched body-host 模块及 figure-frame tick 分支，验证音频转发、会话反馈、ear off/on、旧 socket 回调与关闭释放；DOM/WS 在此测试中为替身。
两包实际模型 + 隔离补丁 kit 浏览器检查通过，HTTP 源码覆盖关闭：原始音频特征→BPM、四档筛选、单句调度、拖拽让位、音乐脸真实眼开度、强度和关闭。
Beat/Tempo 共5600样本与原始 C# 对照通过；矩阵675组最大误差约1.27e-13，表情计时/中断/轮换通过；两包词表自检通过。

用户已在测试台验收音乐、交互打断和两处微抖修正。Coo 真机集成、系统歌曲、隐藏/恢复、HD观感仍留给部署后的最后验收。
工作区证据位于 `test-runs/2026-11-26-patch/`；工作区工具与文档不属于这两个独立的形象包 Git 仓库。
