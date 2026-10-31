# 大肥鱼 · Coo 桌宠形象包

把「DeepSeek 免费公皮」（原本是 VTube Studio 生态的 Live2D 模型）改造成 [Coopanion](https://coopanion.com) 桌面宠物可用的形象包。

> 原画 / 建模：**神宫凉子**
> 作者授权：允许练习建模、做衍生内容、剪视频；**公开使用需署名**；**禁止转发 PSD 原件、禁止二次销售**
> 本项目为非商业同人衍生，遵循上述条款。若不希望被二次分发，请联系我删除。

## 安装

1. 下载本仓库（或 Release 里的 zip）
2. 把整个目录放进 Coopanion 的 `data/home/companion/data/figures/` 下

具体位置看你的安装方式：

- **便携版**：`<解压 Coopanion 的目录>\data\home\companion\data\figures\`
- **安装版**：`C:\Users\<你>\AppData\Roaming\Coopanion\data\home\companion\data\figures\`

不确定的话，直接在机器上找已有的 `figures` 目录（里面会有别的形象包），把这份放进去同级就行。

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
