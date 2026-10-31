# 大肥鱼 · Coo 桌宠形象包

把「DeepSeek 免费公皮」（原本是 VTube Studio 生态的 Live2D 模型）改造成 [Coopanion](https://coopanion.com) 桌面宠物可用的形象包。

> 原画 / 建模：**神宫凉子**
> 作者授权：允许练习建模、做衍生内容、剪视频；**公开使用需署名**；**禁止转发 PSD 原件、禁止二次销售**
> 本项目为非商业同人衍生，遵循上述条款。若不希望被二次分发，请联系我删除。

## 安装

1. 下载本仓库（或 Release 里的 zip）
2. 整个目录放进：

```
<Coopanion 数据目录>/home/companion/data/figures/
```

Windows 上通常是：

```
C:\Users\<你>\AppData\Roaming\Coopanion\data\home\companion\data\figures\
```

3. 重启 Coopanion → 形象面板里选「大肥鱼」

目录里必须有 `figure.json`，Coo 靠它识别形象。

## 这个包比原皮多了什么

| 能力 | 说明 |
|---|---|
| 服装 | 长裙装 / 短裙装 / 搞怪装（短裙 + 钢盆 + 黑框眼镜） |
| 大小 | 默认 / 稍小 / Q 版，三档各自对齐地面（Q 版是独立身形，取景单独算过） |
| 表情 | 模型自带的 exp3 已接入：常规情绪自动用，夸张表情做成独立词 |
| 待机 | 模型的 `IDLE` 动作在循环（泪花、闪光等微特效） |
| 清晰度 | 画布 512 → 1024，贴图打包时预缩到 2048 长边（包体 82 MB → 45 MB） |
| 遮罩 | 该模型有网格叠了 16 层遮罩，低精度路径裁不干净，已强制走高精度遮罩 |

## 可用词表

**自动情绪**（会自己出现）：

| 词 | 表情 |
|---|---|
| happy / excited | 笑眼张嘴 |
| love | 爱心眼 |
| shy / flustered | 脸红 |
| sad / cry | 流泪 |
| worried | 流冷汗 |

**专属表情**（只在被点名时做，平时不会自动出现）：

| 写法 | 效果 |
|---|---|
| `<圈圈眼>` / `<circle-eyes>` | 白圈眼 |
| `<黑脸>` / `<dark-face>` | 整张脸暗下来 |
| `<屑屑眼>` / `<wry-face>` | 半眯眼嫌弃 |
| `<黑框眼镜>` / `<glasses-face>` | 戴上黑框眼镜 |
| `<单片眼镜>` / `<monocle-face>` | 戴上单片眼镜 |
| `<钢盆>` / `<pan-face>` | 头顶扣钢盆 |

词表定义在 `figure.json` 的 `vocab` 里。Coo 的校验规则：id 只能是小写字母 / 数字 / 连字符（`/^[a-z0-9][a-z0-9-]{0,31}$/`），`id` 与任一别名不能重复，`names` 里不能有空格、逗号、`<>`、`【】`。

## 动作

这几个是 kit（木偶引擎）层的**整体姿态动作**——倾斜、旋转、缩放、位移。点名才做：

| 写法 | 效果 | 实测幅度 |
|---|---|---|
| `<鞠躬>` / `<bow>` | 探身欠身（参数版，见下） | 前倾 + 闭眼 |
| `<挥手>` / `<wave>` | 侧倾打招呼 | 倾斜 4.2° |
| `<跳舞>` / `<dance>` | 扭动 | 倾斜 2~3° 波动 |
| `<跳一下>` / `<jump>` | 起跳 | 位移 + 纵向挤压 |
| `<转圈>` / `<spin>` | 原地转 | 水平收缩做透视 |
| `<点头>` / `<nod>`、`<摇头>` / `<shake>` | 点头 / 摇头 | 小幅摆动 |
| `<发抖>` / `<shiver>` | 抖一下 | 小幅抖动 |
| `<张望>` / `<look>` | 左右看 | 位移 |

### 参数动作（模型自身参数驱动）

这些不是 kit 的整体变换，而是写模型自己的参数，由物理联动身体 / 直接驱动头部。
**这才是 VTS 面捕用的那批参数**——注意不是标准 Cubism 的 `ParamAngleX`（那个只有 0.01%），
而是模型自定义的 `AngleX/Y/Z`（cdi3 里叫 OX/OY/OZ）。

**静态姿态**（进入 0.3 → 保持 0.4 → 退出 0.3）：

| 写法 | 参数 | 效果 |
|---|---|---|
| `<凑近>` / `<lean-in>` | `LeanInput -30` | 上半身探向镜头，脸变大 |
| `<后仰>` / `<lean-back>` | `LeanInput +30` | 往后仰、拉开距离 |
| `<鞠躬>` / `<bow>` | `LeanInput -24` | 探身欠身 + 闭眼 |
| `<侧身>` / `side` | `ParamBodyAngleZ 30` + `AngleX 12` + `AngleZ 6` | 身体侧转、头跟着转 |
| `<斜凑>` / `peek` | `LeanInput -22` + `ParamBodyAngleZ 18` + `AngleZ 10` | 斜着凑近，最生动 |
| `<歪头>` / `tilt` | `AngleZ 28` | 头歪向一边 |

**波形动作**（按正弦连续摆动，两端淡入淡出）：

| 写法 | 参数 | 效果 |
|---|---|---|
| `<点头>` / `<nod>` | `AngleY` 正弦，0.7s | 头上下点 |
| `<摇头>` / `<shake>` | `AngleX` 正弦，0.7s | 头左右摇 |
| `<扭腰>` / `<wiggle>` | 胸腔 + 盆骨左右摆（1Hz），头歪与转头慢一倍跟上 | 走 `postWaves`，见下 |

实现：`backends/live2d.js` 的 `applyParamActs()` 读 `frame.gesture.k`，
静态动作按进度推目标值，波形动作按 `k × dur` 走正弦；配置全在 `profile.paramActs`。

**几个坑**：
- `dance` 不能改：kit 里 dance 走 `setMode`，不给 pulse，拿不到进度，所以参数版另起名 `wiggle`。
- `nod`/`shake` 的时长必须对齐 kit 的 0.7 秒，否则动作会被 kit 提前掐断。
- `LeanInput` 单独只改 1%，必须靠物理联动；`ParamBodyAngleZ` 之类的物理输出参数会被覆盖，写不进去。
- 头部只有 `AngleX/Y/Z` 能动，`ParamAngleX/Y/Z` 是死的。

**注意**：这些动的是整个人，不是手臂。这个模型的手臂是单层绘制的，没有可动骨骼——`LArm`/`LForearm`/`Movement1~3` 这些参数实测都驱动不了可见手臂（它们对应模型里隐藏的另一套手臂，在 VTS 里靠 exp3 切换部件才看得到）。想让它真正抬手，只能在 Cubism Editor 里重新建模。

## 物理：头发 / 尾巴 / 裙摆 / 胸

模型自带 `physics3.json`（131 条链）本来就在跑，但在桌宠里它们几乎没有输入 ——
没有面捕，`PositionX/Y/Z`、`AngleX/Y/Z` 都是常量，物理算出来就一直是 0。
现在分两层处理：

**1. 动作时的大幅甩动（物理原生）**

`AngleX/Y/Z` 现在同时写到两处：绘制用模型自定义的 `AngleX`，前发物理用标准的 `ParamAngleX`。
所以一转头，头发、尾巴、帽带就跟着甩 —— 实测摇头时：

| 参数 | 静止 | 摇头中 |
|---|---|---|
| `FrontHairX1`（前发） | +0.05 | **−0.29** |
| `LateHairX1`（后发） | +0.05 | −0.25 |
| `ShortPonytailX1`（尾巴） | +0.01 | **−0.39** |
| `Hat_XA`（帽带） | 0 | −0.37 |

**2. 静止时的呼吸级微摆（`idlePhysics`）**

给物理的**源头输入**叠一层很慢的正弦，让物理持续有活干：

```js
idlePhysics: {
  ParamBreath: { hz: 0.25, amp: 0.45, base: 0.5 },  // 呼吸 → 胸 / 裙摆 Y
  PositionX:   { hz: 0.11, amp: 3.2 },               // 重心左右 → 身体角度 → 胸 / 裙
  PositionZ:   { hz: 0.09, amp: 2.4, phase: 0.3 },   // 重心前后 → 胯 → 裙摆层
  PositionY:   { hz: 0.17, amp: 1.6, phase: 0.4 },   // 轻微起伏 → 胸 / 裙下垂
}
```

**只写源头参数**。`ParamBodyAngleX/Z`、`HipAngleX/Z` 本身是物理的**输出**，写进去会被
下一次 `evaluate()` 覆盖（这也是它们一直读回 0 的原因）。

**3. 裙摆 / 胸的幅度补强（`physicsWaves`）**

这两组的物理链很"硬"：输入拉满也只输出 3~4%（参数范围 ±1），桌宠尺寸下看不见。
所以在 `physics.evaluate()` **之后**再叠一层同频正弦，把幅度提到 8~14%：

```js
physicsWaves: [
  { prefix: 'SkirtX', amp: 0.14, hz: 0.11, spread: 0.05 },
  { prefix: 'ChestX', amp: 0.10, hz: 0.11, phase: 0.03, spread: 0.03 },
  ...
]
```

`spread` 是同组内的相位差，让摆动从根部往梢部传，而不是整块平移。
写在物理之后意味着是当帧最终值；基准在物理之前已存，所以不会累积。

想调幅度就改 `amp`（相对参数范围 ±1 的百分比），想调快慢改 `hz`（每秒几次）。

**4. 动作要写物理输出参数：`postWaves`**

`ParamBodyAngleZ`（胸腔 Z）、`HipAngleZ`（盆骨 Z）是物理的**输出**——写在 `physics.evaluate()`
之前会被当场算回 0。所以动作里想驱动它们，得声明在 `postWaves`，由 `applyActPostWaves()`
在物理之后写：

```js
wiggle: {
  dur: 3.6,
  postWaves: [
    { id: 'ParamBodyAngleZ', amp: 22, freq: 1 },                  // 胸腔先动
    { id: 'HipAngleZ', amp: 13, freq: 1, phase: 0.12 },           // 盆骨慢半拍
    { id: 'ParamBodyAngleRZ', amp: 12, freq: 1, phase: 0.06 },    // 身体位移，物理不管，最显眼
  ],
  waves: [ /* 头歪、转头：写在物理之前，走普通通道 */ ],
}
```

前两者参数范围都是 ±30，`amp` 22 约 73%；`ParamBodyAngleRZ` 物理既不读也不写，可以自由驱动。

## 目录结构

```
figure.json              清单：id / 三条轴 / 词表 / 缩略图
figure.js                入口：按 scheme 选模型，交给 backends
backends/live2d.js       渲染后端：Cubism 初始化、参数分层、动作与表情
models/index.js          模型注册表（动作、表情文件清单）
models/deepseek/profile.js   ★ 定制层：role 表、服装方案、情绪映射、词表别名
models/deepseek/motions/     待机动作（base64）
models/deepseek/expressions/ 模型自带 exp3 表情
models/deepseek/*.moc3, textures/   模型与贴图
sdk/                     Live2D Cubism SDK（Core + framework + 着色器）
vendor/                  kit 依赖（木偶引擎由宿主提供，这里只带必要部分）
thumb/                   形象与各选项的缩略图
port-custom.py           重新打包后恢复定制层的脚本
LICENSES.txt             三块代码各自的许可说明
```

## 参数分层的坑（改这个包之前请读）

每帧的写入顺序是有讲究的，动错一层就会出现「表情残留」「眼镜不显示」「换大小后悬空」这类问题：

```
loadParameters        载入上一帧基准
applyFrame            角色姿势（role 层：眼、嘴、呼吸、情绪）
applyCleanParams      清理值
applySchemeParams     服装 / 大小（状态量，会写 key9~12）
saveParameters        把上面三层存成下一帧基准
stepMotion            模型动作
stepExpression        表情（临时覆盖，优先级最高）
applyPartOpacity
physics / pose
update
```

- `applySchemeParams` 必须排在 `stepExpression` **之前**：否则服装方案把 `key9~12` 按回 0，眼镜、钢盆永远出不来。
- `saveParameters` 必须在 `stepExpression` **之前**：否则表情参数被存成基准，表情停了也回不去（表现为圈圈眼/白眼常驻）。
- 换 scheme 时要 `extent = null` 重新取景，否则会沿用上一套缩放（Q 版切回默认变巨大半身像）。

## 重新打包后如何恢复

插件的 `convert.mjs` 每次会重新生成 `profile.js` 和 `figure.json`，上面的定制会被清空。

```bash
python port-custom.py <本仓库目录> <新打好的包目录>
```

它会覆盖 `profile.js`、`models/index.js`、`motions/`、`expressions/`、`thumb/`，并合并 `figure.json` 的 `axes` / `vocab` / `about` / `version`，其余字段保留新包自己的。

渲染层（`backends/live2d.js`）的改动已同步进插件模板，重新打包不会丢。

## 许可

```
figure.js、backends/        AGPL-3.0-or-later（Live2D Simple Workbench，作者 as124da1231）
sdk/                        Live2D Cubism SDK，见 sdk/LICENSE-*.txt（Core 为 Redistributable Code，原样分发）
vendor/soullink/            Apache-2.0
模型、贴图、moc3             版权归原画作者，不在上述许可范围内
profile.js 的定制配置        随本仓库以 AGPL-3.0-or-later 发布
```

完整说明见 `LICENSES.txt`。

## 已知限制

- **兔牙做不出来**：`key9` 参数能写、模型里也有 `Part75 大牙` 这个部件，但该部件不响应参数（强制不透明度也不显示），属于模型导出时缺少绑定，已从词表移除。要补只能在 Cubism Editor 里改 `.cmo3` 再导出。
- 原皮的 6 段手势动作（举手、竖手指、狗尾草）驱动的是模型里隐藏的第二套手臂，在这个运行时看不到，所以没有接。
- 「稍小」「Q 版」的取景是写死的数值（`zoom` / `offset`），换模型不通用。
- `models/deepseek/moc3.js`（21 MB，moc3 的 base64 副本）是旧沙箱不能 fetch 二进制时的兜底，多数环境用不到；想瘦身可以删，但失败时没有回退。

## 致谢

- 原画 / 建模：神宫凉子
- 形象包运行时：Live2D Simple Workbench（as124da1231）
- 木偶引擎：Coo / coo-kit
- SoulLink 情绪引擎
