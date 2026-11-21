/**
 * deepseek 的模型数据（tools/convert.mjs 生成的草稿）。
 *
 * 格式与运行时约定见 README「数据驱动」一节：
 *   role = 语义位 → targets 是真实参数；模型没有的参数自动跳过
 *   space/default 是语义输入，真实取值范围从 moc3 读（不要写进这里）
 *
 * TODO（人工过一遍）：
 *   - 没映射上的 role：eyeSmile, cheek, step, armA, armB
 *   - 值得看一眼的参数：LEGAngleZ2, EyeSmile, BrowInnerUp, ParamBrowRAngleSmoothing, ParamBrowRY2, ParamBrowRY3, REyeSquint, ParamBrowLAngleSmoothing, ParamBrowLY2, ParamBrowLY3, LEyeSquint, MouthX, MouthSmile_L, MouthSmile_R, Mouthpucker, MouthFunnel, MouthPuckerWiden, MouthPressLipOpen, MouthRollUpper, MouthRollLower, REyeball1, REyeball2, REyeball3, REyeLashX1
 *   - extent 由运行时实测（贴图就绪第 3 帧读 alpha 包围盒）；只有实测不准时才在 profile.extent 覆盖
 */
export default {
  fit: { mode: 'contain', anchor: 'bottom', padding: [0.04, 0.02], offset: [0, 0], zoom: 1 },
  // roam：跟随 Coo 的走动偏好；stand：固定站定（后端强制 roam off）
  motion: {"kind":"roam","speed":1,"native":true},
  // kit 的表情词 → 模型自带 exp3。脸部变化比通用配方贴脸得多。
  // null 表示该情绪不换表情（保持 role 层的自然表情），切回时会自动停下上一个。
  // kit 的表情词 → 模型自带 exp3。只映射语义清楚、常驻也不会违和的几种；
  // 圈圈眼(confused) / 黑脸(angry) 这类夸张表情不挂默认情绪，否则容易一直挂着。
  // 模型自带、但挂在常规情绪上会很违和的夸张表情。做成独立词：
  // AI 在回复里写 <circleEyes> / <darkFace> 才会用到，平时不会自动出现。
  // 组合表情：把两个 exp3 的参数并集合并成一个（加载时合成，不增加运行时开销）。
  // 键是组合后的词名，值是要合并的 exp3 id。

  // 参数动作：用模型自己的参数做透视姿态，由 frame.gesture 的进度驱动。
  // LeanInput 是模型的"前倾输入"：负值往镜头靠（物理会据此联动身体），正值后退。
  // 待机物理微驱：头发/裙摆/胸/尾巴这四组都是 physics3 算出来的，
  // 但它们的输入（HipAngleX、ParamBodyAngleX、ParamBreath、PositionY）在桌宠里
  // 是常量 —— 没有面捕，物理就没有输入，于是全部静止。
  // 这里给这几个输入叠一层很慢的正弦，等于"人站着自然呼吸、重心轻微移"，
  // 物理就会把这一点点输入放大成头发/裙摆的持续微摆。
  // 裙摆/胸的物理输出太细（±0.04），物理算完再叠一层，幅度按参数范围 ±1 的百分比给。
  // spread 让同组内逐级延迟，摆动会从根部往梢部传，而不是整块平移。
  physicsWaves: [
    { prefix: 'SkirtX',      amp: 0.14, hz: 0.11, spread: 0.05 },
    { prefix: 'SkirtLayerX', amp: 0.12, hz: 0.11, phase: 0.05, spread: 0.04 },
    { prefix: 'SkirtY',      amp: 0.10, hz: 0.25, phase: 0.50, spread: 0.06 },
    { prefix: 'SkirtLayerY', amp: 0.08, hz: 0.25, phase: 0.55, spread: 0.05 },
    { prefix: 'ChestX',      amp: 0.10, hz: 0.11, phase: 0.03, spread: 0.03 },
    { prefix: 'ChestY',      amp: 0.08, hz: 0.25, phase: 0.10, spread: 0.03 },
    // 头发/尾巴：物理只在头部有角度时才动，静止时给一点很轻的飘动，避免完全僵住。
    // 幅度刻意压小（5~7%），真实的大幅甩动仍由物理跟着转头/动作算出来。
    { prefix: 'FrontHair',   amp: 0.05, hz: 0.13, spread: 0.07 },
    { prefix: 'LateHair',    amp: 0.06, hz: 0.11, phase: 0.2, spread: 0.07 },
    // 尾巴：两组不同频率叠加，慢的那组做整体飘，快的那组做尾梢抖
    { prefix: 'ShortPonytailX', amp: 0.13, hz: 0.14, phase: 0.35, spread: 0.08 },
    { prefix: 'ShortPonytailY', amp: 0.09, hz: 0.19, phase: 0.55, spread: 0.07 },
  ],

  // 待机时会随机切到这些手势（1=狗尾草 2=抚胸 3=竖食指），每个按自己的 dur 播一遍。
  // 对应 VTS 的 Auto Idle：闲置久了就自己换个姿势，不然一直一个姿势很死。
  // 甩草是波形动作，走的是同一套 applyActAt —— 待机里也会真的甩起来。
  // idlePoses / idleMoods 已并入上面的 idleRepertoire（3.9 统一闲时池，触发归 kit decide()）。
  // 4.2 摸摸分区（256 逻辑坐标椭圆：中心 x,y + 半轴 rx,ry）——坐标是估计值，实验后调。
  // head/face 按住 = 完整 rua 模式；其他分区划过 = 摸一下（一次性事件，简单版）。
  touchZones: [
    { id: 'head', x: 128, y: 50, rx: 74, ry: 40 },
    { id: 'face', x: 128, y: 102, rx: 70, ry: 20 },
    { id: 'chest', x: 128, y: 145, rx: 58, ry: 30 },
    { id: 'skirt', x: 128, y: 192, rx: 66, ry: 26 },
    { id: 'legs', x: 128, y: 230, rx: 52, ry: 24 },
    { id: 'tail', x: 192, y: 165, rx: 40, ry: 42 },
  ],

  // 3.9 统一闲时池（2026-11-20 用户定稿）：表情 + 动作一个池子，kit 的 decide() 按权重抽，
  // 抽中后走 doWord 正常入口——音效/爱心/挤压白拿，参数绘制走通道（actWord）。
  // kit 只管走/跑/跳/坐/张望；表情和小动作全部归这里。
  // kind: face=挂着的心情（state 词，life=保持秒数，默认 idleMoodLife）/ act=一次性动作。
  // w = 权重（3 高频 / 2 中 / 1 彩蛋）；kit 原六张随机脸已收编进来（中权重）。
  // 2026-11-20 测试反馈调整：动作类整体上调（用户：随机动作难触发）、tilt 换 tilt-look（放缓+减幅）。
  idleMoodLife: 6,
  idleRepertoire: [
    // —— 表情类 ——
    { word: 'tilt-look', kind: 'face', w: 3 },            // 歪头瞧（一次性，替代原 tilt 挂脸）
    { word: 'dazed', kind: 'face', w: 3, life: 6 },
    { word: 'happy', kind: 'face', w: 2, life: 5 },       // kit 六张脸收编
    { word: 'wink', kind: 'face', w: 2 },                 // kit 原生脸（词表没有 wink 词，走 kit setExpr）
    { word: 'heart-eyes', kind: 'face', w: 2, life: 5 },  // love → 有爱心粒子 + love 音效
    { word: 'eye-half', kind: 'face', w: 2, life: 5 },    // sleepy → yawn 音效
    { word: 'surprised', kind: 'face', w: 2 },            // surprised 音效
    { word: 'blush', kind: 'face', w: 2, life: 5 },       // shy → shy 音效
    { word: 'pout', kind: 'face', w: 2, life: 5 },
    { word: 'smug-face', kind: 'face', w: 2, life: 5 },
    { word: 'bunny-teeth', kind: 'face', w: 1, life: 5 }, // 以下彩蛋权重
    { word: 'tongue-out', kind: 'face', w: 1, life: 5 },
    { word: 'puff-cheek', kind: 'face', w: 1, life: 5 },
    { word: 'tongue-tilt', kind: 'face', w: 1, life: 5 },
    { word: 'wink-tongue', kind: 'face', w: 1 },
    // —— 动作类 ——
    { word: 'glance', kind: 'act', w: 3 },
    { word: 'look-around', kind: 'act', w: 3 },
    { word: 'head-swing', kind: 'act', w: 3 },
    { word: 'slow-tilt', kind: 'act', w: 3 },
    { word: 'hum', kind: 'act', w: 3 },
    { word: 'sigh', kind: 'act', w: 2 },
    { word: 'drowsy-combo', kind: 'act', w: 2, life: 5 },
    { word: 'slow-sway', kind: 'act', w: 2 },
    { word: 'theater-sway-1', kind: 'act', w: 1 },
    { word: 'theater-sway-2', kind: 'act', w: 1 },
    { word: 'grass-hand', kind: 'act', w: 4, life: 4 },   // 手部词上调（用户点名难触发）
    { word: 'chest-hand', kind: 'act', w: 4, life: 4 },
    { word: 'finger-point', kind: 'act', w: 4, life: 4 },
    { word: 'swing', kind: 'act', w: 2 },
  ],

  // 指针跟随身体：光标左右 → 躯干跟着倾。walk 是走路时的倾斜方向（负号=朝行进方向倒，
  // 因为这个模型 PositionX 为正时身体是往左倾的，物理链是反向平衡）。
  // ParamBodyAngleX/Z 是物理的输出参数，后端 applyBodyFollow 会在 physics.evaluate 之后写，
  // 否则会被物理算回 0。x 对应左右，z 对应上下（look 的原始范围约 ±5）。
  // ---------- 通道叠加（P1 试点）----------
  // true = 让形象自己接管下面这些词的参数写入（多词可同时生效）。
  // 出问题改成 false 整条退回 kit 的单槽 pulse。
  useChannels: true,
  // 试点白名单：只放纯姿态类词，它们本来就不带手部动画/退出剪辑，接管风险最小。
  channelWords: [
    "wave", "nod", "shake", "bow", "spin", "dance", "jump", "shiver", "look", "lean-in", "lean-back", "side", "peek", "tilt", "wiggle", "finger-point", "chest-hand", "grass-hand", "swing", "eye-smile", "eye-close", "eye-half", "eye-wide", "wink-left", "wink-right", "brow-frown", "brow-up", "brow-knit", "mouth-smile", "mouth-pout", "mouth-open", "blush",
    "bitter-smile", "holding-up", "guilty-look", "act-cute",
    "defiant", "holding-tears", "smug-face", "perfunctory",
    "head-down", "head-up", "face-front", "stand-straight", "squint", "smirk",
    "press-lips", "sweat", "shrug",
    "circle-eyes", "heart-eyes", "xx-eyes", "wry-face", "dark-face", "tears",
    "loading-face", "bunny-teeth", "pan-face", "glasses-face", "monocle-face",
  ],

  bodyFollow: { x: 16, z: 11, walk: -14, k: 42, c: 9.5 },

  // 走神只靠鼠标唤回：光标停住 3.6 秒（或盯 8 秒）后再酝酿 1.5 秒开始飘，
  // 一直飘到鼠标动为止（span: 0 = 不过期；想加保质期就写秒数，比如 120~180）。
  // fade = 收回速度（越大越快，0.6 大约两秒收干净）；resume = 回神速度（0.9 比收回稍快，像人反应过来）
  gazeFollow: { idleSec: 3.6, holdSec: 8, onset: 1.5, fade: 0.5, resume: 10, movePx: 3, span: 0, spanJitter: 0, wake: 1.2 },

  idlePhysics: {
    // 只写"源头参数"。ParamBodyAngleX / HipAngleX / ParamBodyAngleZ 本身是物理的
    // 输出，写进去会被下一步覆盖（这也是它们一直读回 0 的原因）。
    // 链条：PositionX → ParamBodyAngleX → 胸/裙；PositionX+Z → HipAngleX → 裙摆层；
    //       PositionY → 胸/裙的下垂；ParamBreath → 胸起伏。
    ParamBreath: { hz: 0.25, amp: 0.45, base: 0.5 },
    // 呼吸不只动胸：头也跟着极轻地起伏（Cubism 官方呼吸就是这么联动的，
    // 只写 ParamBreath 会显得"薄"）。ParamAngleY 是物理输入，会顺带推一点身体，
    // 幅度压到 1.2 度，站着不动时刚好，走路时被 kit 的姿态盖过去。
    ParamAngleY: { hz: 0.25, amp: 1.2, phase: 0.12 },
    PositionZ:   { hz: 0.09, amp: 2.4, phase: 0.3 },
    PositionY:   { hz: 0.17, amp: 1.6, phase: 0.4 },
  },

  // 动作的中文名 → 词 id。kit 的词表只认 id，但 AI 习惯写中文（说明书就是中文的），
  // 所以 figure 在 baseWord 里先做一次别名转换。这份表由 figure.json 的 vocab 生成，
  // 加新动作词后重跑一次生成脚本即可。
  wordAlias: {
    '圈圈眼': 'circle-eyes',
    '蚊香眼': 'circle-eyes',
    '黑脸': 'dark-face',
    '阴沉': 'dark-face',
    '屑屑眼': 'wry-face',
    '嫌弃': 'wry-face',
    '黑框眼镜': 'glasses-face',
    '单片眼镜': 'monocle-face',
    '钢盆': 'pan-face',
    '扣盆': 'pan-face',
    '挥手': 'wave',
    '招手': 'wave',
    '点头': 'nod', '叹气': 'sigh', '大笑': 'laugh', '眼泪': 'tears', '挑一下眉': 'brow-raise-once', '歪一下头': 'tilt-once', '晃头': 'head-swing', '慢歪头': 'slow-tilt', '缩一下': 'cower', '吓一跳': 'startle', '左右张望': 'look-around', '摇摆一': 'sway-1', '剧场摇摆一': 'theater-sway-1', '剧场摇摆二': 'theater-sway-2', '慢摇': 'slow-sway', '摇摆二': 'dance', '看过来': 'face-front', '看你': 'face-front', '看左边': 'look-left', '看右边': 'look-right', '看上面': 'look-up', '看下面': 'look-down', '转头': 'turn-head', '前倾': 'lean-forward', '单眨眼': 'wink-hold', '眨单眼': 'wink-keep', '快眨左': 'wink-left', '快眨右': 'wink-right', '高兴': 'happy-burst', '偷笑': 'snicker', '傻眼': 'dumbstruck', '得瑟': 'gloating', '抓狂': 'frantic', '犯困': 'drowsy-combo', '感动': 'touched', '鬼点子': 'sly-idea', '得救': 'rescued', '警觉': 'alert-combo', '瞟一眼': 'glance', '竖手指': 'finger-point', '快眨单眼': 'wink-left', '放下手': 'put-hand-down',
    '摇头': 'shake',
    '鞠躬': 'bow',
    '转圈': 'spin',
    '跳舞': 'dance',
    '跳一下': 'jump',
    '蹦': 'jump',
    '发抖': 'shiver',
    '哆嗦': 'shiver',
    '张望': 'look',
    '凑近': 'lean-in',
    '探身': 'lean-in',
    '后仰': 'lean-back',
    '后退': 'lean-back',
    '侧身': 'side',
    '斜凑': 'peek',
    '歪着凑近': 'peek',
    '歪头': 'tilt',
    // 跳舞通道版（2.3 配套，2026-11-19）：复刻他们家 6 拍摇摆（Body.cs:118-135，用户亲自指导的
    // 「身体左右转、头往相反方向转且晚 0.14 秒、头走小拱形」），拍长 0.53s。
    '扭腰': 'wiggle',
    '扭一扭': 'wiggle',
    '竖食指': 'finger-point',
    '抚胸': 'chest-hand',
    '狗尾草': 'grass-hand',
    '加载中': 'loading-face',
    '转圈圈': 'loading-face',
    '甩草': 'swing',
    '甩狗尾草': 'swing',
    '笑眼': 'eye-smile',
    '眼睛笑': 'eye-smile',
    '闭眼': 'eye-close',
    '半睁': 'eye-half',
    '半睁眼': 'eye-half',
    '睁大': 'eye-wide',
    '睁大眼': 'eye-wide',
    '单眨左': 'wink-left',
    '左眼闭': 'wink-left',
    '单眨右': 'wink-right',
    '右眼闭': 'wink-right',
    '八字眉': 'brow-frown',
    '挑眉': 'brow-up',
    '皱眉': 'brow-knit',
    '微笑': 'mouth-smile',
    '瘪嘴': 'mouth-pout',
    '张嘴': 'mouth-open',
    '脸红': 'blush',
    '脸红红': 'blush',
    '恢复': 'restore',
    '委屈': 'aggrieved',
    '无语': 'speechless',
    '阴险': 'mad',
    '心慌': 'guilty',
    // —— 日常情绪词（2026-11-19 通道化）：zh 和 en id 双向映射，
    // 【】里的词 script.ts 已解析成 en id（走 en 键），pet_act 的中文（走 zh 键）
    '开心': 'happy', '兴奋': 'happy', 'happy': 'happy', 'excited': 'happy',
    '害羞': 'blush', 'shy': 'blush',
    '慌张': 'guilty', 'flustered': 'guilty',
    '难过': 'tears', 'sad': 'tears',
    '哭': 'tears', 'cry': 'tears',
    '生气': 'angry', 'angry': 'angry',
    '喜欢': 'heart-eyes', 'love': 'heart-eyes',
    '担心': 'sweat', 'worried': 'sweat',
    '惊讶': 'surprised', 'scared': 'scared',
    '害怕': 'scared',
    '困倦': 'eye-half', 'sleepy': 'eye-half',
    '思考': 'thinking', 'thinking': 'thinking',
    '神气': 'smug-face', 'smug': 'smug-face',
    '嘟嘴': 'mouth-pout', 'pout': 'mouth-pout',
    '坚定': 'determined', 'determined': 'determined',
    '困惑': 'confused', 'confused': 'confused',
    '发呆': 'dazed', '放空': 'dazed',
    '鼓腮': 'puff-cheek', '鼓脸': 'puff-cheek',
    '撅嘴': 'pout-lips',
    '吐舌': 'tongue-out',
    '吐舌头': 'tongue-out',
    '苦笑': 'bitter-smile',
    '强撑': 'holding-up',
    '嘴硬': 'holding-up',
    '心虚': 'guilty-look',
    '撒娇': 'act-cute',
    '不服': 'defiant',
    '忍着不哭': 'holding-tears',
    '忍哭': 'holding-tears',
    '得意': 'smug-face',
    '敷衍': 'perfunctory',
    '低头': 'head-down',
    '抬头': 'head-up',
    '正视': 'face-front',
    '站直': 'stand-straight',
    '斜眼': 'squint',
    '眯眼': 'squint',
    '坏笑': 'smirk',
    '抿嘴': 'press-lips',
    '冷汗': 'sweat',
    '冒冷汗': 'sweat',
    '耸肩': 'shrug',
    '耸耸肩': 'shrug',
    '爱心眼': 'heart-eyes',
    '流泪': 'tears',
    '含泪': 'tears',
    '紧闭眼': 'xx-eyes',
    '使劲闭眼': 'xx-eyes',
    '兔牙': 'bunny-teeth',
    // —— 3.8 俏皮搞怪批（2026-11-20）——
    '打哈欠': 'yawn',
    '哈欠': 'yawn',
    '打喷嚏': 'sneeze',
    '喷嚏': 'sneeze',
    '狐疑': 'suspicious',
    '怀疑': 'suspicious',
    '吐舌歪头': 'tongue-tilt',
    '眨眼吐舌': 'wink-tongue',
    '哼歌': 'hum',
    '歪眉': 'brow-tilt',
    '挑一边眉': 'brow-tilt',
    '歪头瞧': 'tilt-look',
    '歪头看看': 'tilt-look',
  },

  paramActs: {
    // —— 静态姿态（进入 → 保持 → 退出）——
    // 探身贴近镜头：负值往前靠，物理会联动身体透视（最像 VTS 里的前倾）
    'lean-in':   { params: [{ id: 'LeanInput', to: -30 }] },
    'lean-back': { params: [{ id: 'LeanInput', to: 30 }] },
    // 探身鞠躬：上半身真的往前压，配合 kit 自带的闭眼
    bow:         { params: [{ id: 'LeanInput', to: -24 }] },
    // 侧身：身体侧转 + 头跟着转一点，单靠身体参数幅度太小吃不出来
    side:        { params: [{ id: 'PositionX', to: 22 }, { id: 'AngleX', to: 12 }, { id: 'AngleZ', to: 6 }] },
    // 斜着凑近：前倾 + 侧身 + 歪头
    peek:        { params: [{ id: 'LeanInput', to: -22 }, { id: 'PositionX', to: 16 }, { id: 'AngleZ', to: 10 }] },
    // —— 手臂姿势（模型自带的三只"备用手"）——
    // Movement1/2/3 不是骨骼，是"切换哪只手显示"的开关：
    // 1=狗尾草、2=抚胸、3=竖食指。参数一开，对应手臂就替换掉默认手。
    // 必须把另外两个显式归零，否则切回来时会叠在一起。
    // 2026-11-20：三个词全部换回原厂动画时间轴（motions/pointIn|raise|grassIn 解码成 keys）——
    // 当年"动画播完手落回身侧像没做"是因为播完整 motion；现在 keys 播入场段（含到位回弹）
    // 停在终值挂着（state 保持），手感=他们家。
    // 2026-11-20 重做：原厂入场动画时间轴搬回（motions/pointIn.js 解码）——含到位回弹
    // （Param41 0.708→0.698、Param42 -0.058→0.026→0、Param43 -0.164→0.066→0）。
    // 当年注释说动画"播完手落回身侧像没做"是因为播的是完整 motion；现在 keys 播完入场段
    // 停在终值挂着（state 保持），手感=他们家。互斥归零（Movement1）留 params。
    'finger-point': { hand: true, state: true, dur: 4, keys: [
      { id: 'Movement3', t: 0, v: 0 }, { id: 'Movement3', t: 0.35, v: 0 }, { id: 'Movement3', t: 0.37, v: 1 },
      { id: 'Param40', t: 0, v: 0 }, { id: 'Param40', t: 0.38, v: 0 }, { id: 'Param40', t: 0.67, v: 1 },
      { id: 'Param36', t: 0, v: 0 }, { id: 'Param36', t: 0.87, v: 0.004 }, { id: 'Param36', t: 1.05, v: -0.004 }, { id: 'Param36', t: 1.17, v: 0 },
      { id: 'Param39', t: 0, v: 0 }, { id: 'Param39', t: 0.87, v: 0.322 },
      { id: 'Param41', t: 0, v: 0 }, { id: 'Param41', t: 0.03, v: 0 }, { id: 'Param41', t: 0.90, v: 0.708 },
      { id: 'Param41', t: 1.08, v: 0.698 }, { id: 'Param41', t: 1.20, v: 0.702 },
      { id: 'Param42', t: 0, v: 0 }, { id: 'Param42', t: 0.07, v: 0 }, { id: 'Param42', t: 0.93, v: -0.058 },
      { id: 'Param42', t: 1.12, v: 0.026 }, { id: 'Param42', t: 1.23, v: 0 },
      { id: 'Param43', t: 0, v: 0 }, { id: 'Param43', t: 0.10, v: 0 }, { id: 'Param43', t: 0.95, v: -0.164 },
      { id: 'Param43', t: 1.15, v: 0.066 }, { id: 'Param43', t: 1.25, v: 0 },
      { id: 'Param56', t: 0, v: 1 },
    ],
      exit: { dur: 1.25, keys: [
        { id: 'Movement3', t: 0, v: 1 }, { id: 'Movement3', t: 0.65, v: 1 }, { id: 'Movement3', t: 0.67, v: 0 },
        { id: 'Param40', t: 0, v: 1 }, { id: 'Param40', t: 0.33, v: 1 }, { id: 'Param40', t: 0.67, v: 0 },
        { id: 'Param39', t: 0, v: 0.32 }, { id: 'Param39', t: 0.03, v: 0.32 }, { id: 'Param39', t: 1.07, v: 0 },
        { id: 'Param41', t: 0, v: 0.7 }, { id: 'Param41', t: 0.07, v: 0.7 }, { id: 'Param41', t: 0.38, v: 0.762 },
        { id: 'Param41', t: 1.10, v: -0.008 }, { id: 'Param41', t: 1.22, v: 0 }, { id: 'Param41', t: 1.25, v: 0 },
        { id: 'Param42', t: 0, v: 0 }, { id: 'Param42', t: 0.10, v: 0 }, { id: 'Param42', t: 0.42, v: -0.102 },
        { id: 'Param42', t: 1.13, v: 0.136 }, { id: 'Param42', t: 1.25, v: 0 },
        { id: 'Param43', t: 0, v: 0 }, { id: 'Param43', t: 0.12, v: 0 }, { id: 'Param43', t: 0.43, v: -0.14 },
        { id: 'Param43', t: 1.15, v: 0 },
      ] },
    params: [{ id: 'Movement1', to: 0 }] },
    'chest-hand': { hand: true, state: true, dur: 4, keys: [
      // motions/raise.js（默认手切举手 1.13s）：Param59 0→0.516(0.8s)→回落 0.476——
      // 「手到位置了有点回弹」就是这个；终态 0.476/0.86 就是"放在下巴附近"的位置
      { id: 'Movement2', t: 0, v: 0 }, { id: 'Movement2', t: 0.32, v: 0 }, { id: 'Movement2', t: 0.33, v: 1 },
      { id: 'Param59', t: 0, v: 0 }, { id: 'Param59', t: 0.03, v: 0 }, { id: 'Param59', t: 0.80, v: 0.516 }, { id: 'Param59', t: 1.10, v: 0.476 },
      { id: 'Param60', t: 0, v: 0 }, { id: 'Param60', t: 0.07, v: 0 }, { id: 'Param60', t: 0.83, v: 0.88 }, { id: 'Param60', t: 1.13, v: 0.86 },
      { id: 'Param61', t: 0, v: 0 }, { id: 'Param61', t: 0.08, v: 0 }, { id: 'Param61', t: 0.85, v: 0.2 }, { id: 'Param61', t: 1.13, v: 0.002 },
      { id: 'Param62', t: 0, v: 0 }, { id: 'Param62', t: 0.77, v: 0.034 },
      { id: 'Param56', t: 0, v: 1 },
    ],
      exit: { dur: 1.05, keys: [
        { id: 'Movement2', t: 0, v: 1 }, { id: 'Movement2', t: 0.53, v: 1 }, { id: 'Movement2', t: 0.55, v: 0 },
        { id: 'Param62', t: 0, v: 0.03 }, { id: 'Param62', t: 0.82, v: -0.03 }, { id: 'Param62', t: 1.05, v: 0 },
        { id: 'Param59', t: 0, v: 0.48 }, { id: 'Param59', t: 0.82, v: -0.048 }, { id: 'Param59', t: 1.05, v: 0 },
        { id: 'Param60', t: 0, v: 0.86 }, { id: 'Param60', t: 0.82, v: -0.008 }, { id: 'Param60', t: 1.05, v: 0 },
        { id: 'Param61', t: 0, v: 0 }, { id: 'Param61', t: 0.82, v: 0.062 }, { id: 'Param61', t: 1.05, v: 0.001 },
      ] },
    params: [{ id: 'Movement1', to: 0 }, { id: 'Movement3', to: 0 }] },
    'grass-hand': { hand: true, state: true, dur: 4, keys: [
      // motions/grassIn.js（1.23s）：Param41 -0.766→-0.732 回弹、Param42 -0.586→0.266→0 大幅回弹（手腕甩一下）
      { id: 'Movement1', t: 0, v: 0 }, { id: 'Movement1', t: 0.27, v: 0 }, { id: 'Movement1', t: 0.28, v: 1 },
      { id: 'Param36', t: 0, v: 0 }, { id: 'Param36', t: 0.28, v: 0.053 }, { id: 'Param36', t: 0.83, v: 0.068 }, { id: 'Param36', t: 1.15, v: 0.04 }, { id: 'Param36', t: 1.23, v: 0.04 },
      { id: 'Param39', t: 0, v: 0 }, { id: 'Param39', t: 0.83, v: 0.2 },
      { id: 'Param41', t: 0, v: 0 }, { id: 'Param41', t: 0.03, v: 0 }, { id: 'Param41', t: 0.32, v: 0.007 }, { id: 'Param41', t: 0.87, v: -0.766 }, { id: 'Param41', t: 1.18, v: -0.732 },
      { id: 'Param42', t: 0, v: 0 }, { id: 'Param42', t: 0.07, v: 0 }, { id: 'Param42', t: 0.35, v: -0.586 }, { id: 'Param42', t: 0.90, v: 0.266 }, { id: 'Param42', t: 1.22, v: 0 },
      { id: 'Param56', t: 0, v: 1 },
    ],
      exit: { dur: 1.13, keys: [
        { id: 'Movement1', t: 0, v: 1 }, { id: 'Movement1', t: 0.33, v: 1 }, { id: 'Movement1', t: 0.90, v: 1 }, { id: 'Movement1', t: 0.92, v: 0 },
        { id: 'Param36', t: 0, v: 0.04 }, { id: 'Param36', t: 0.35, v: 0.068 }, { id: 'Param36', t: 0.92, v: 0.053 }, { id: 'Param36', t: 1.13, v: 0.001 },
        { id: 'Param39', t: 0, v: 0.2 }, { id: 'Param39', t: 0.35, v: 0.2 }, { id: 'Param39', t: 1.13, v: 0 },
        { id: 'Param41', t: 0, v: -0.732 }, { id: 'Param41', t: 0.35, v: -0.766 }, { id: 'Param41', t: 0.92, v: 0.007 }, { id: 'Param41', t: 1.13, v: 0 },
        { id: 'Param42', t: 0, v: 0 }, { id: 'Param42', t: 0.35, v: 0.266 }, { id: 'Param42', t: 0.92, v: -0.586 }, { id: 'Param42', t: 1.13, v: -0.009 },
      ] },
    params: [{ id: 'Movement3', to: 0 }] },

    // 甩草：真的把手挥起来。
    // 关键不是"参数对不对"，是"时间轴对不对"：桌宠给的 gesture 进度 k 会卡在中途
    // （实测一直停在 0.314），以前按 k 换算秒数，动作只做了开头一小段就定格，
    // 所以看起来跟"举着草站着"一模一样。现在时间轴改由 clockT 自己算（见 backends）。
    // 参数实测：Param41 手臂抬起高度（-0.9 胸口 / -0.55 脸前），
    //           Param42 手腕俯仰即草的指向（0.28 横向 / -0.2 斜上）。
    'swing': { dur: 3.4,
      params: [
        { id: 'Movement1', to: 1 }, { id: 'Movement3', to: 0 },
        { id: 'Param36', to: 0.062 }, { id: 'Param43', to: 0 }, { id: 'Param56', to: 1 },
      ],
      waves: [
        { id: 'Param41', amp: 0.18, freq: 1.05, base: -0.74 },          // 手臂在胸口↔脸侧之间
        { id: 'Param42', amp: 0.18, freq: 1.05, base: 0.10, phase: 0.25 }, // 草跟着翻，稍滞后
        { id: 'Param39', amp: 0.12, freq: 1.05, base: -0.16, phase: 0.12 },
        { id: 'PositionX', amp: 8, freq: 0.53, phase: 0.1 },             // 重心跟着摆，带动物理
        { id: 'AngleZ', amp: 5, freq: 1.05, phase: 0.3 },
        { id: 'AngleX', amp: 3, freq: 0.53, phase: 0.4 },
      ] },

    // —— 脸部小动作（参数直驱，实测鼓腮最明显）——    // 放下手（Body.cs HandDown）：收手动画（motions/lower.js 举手切默认手 1.02s，含反向回弹
    // Param59 0.48→-0.048→0）+ 狗尾草/竖手指的静态归零。keys/params 不放同参数。
    'put-hand-down': { hand: true, state: true, dur: 1.05, keys: [
      { id: 'Movement2', t: 0, v: 1 }, { id: 'Movement2', t: 0.53, v: 1 }, { id: 'Movement2', t: 0.55, v: 0 }, { id: 'Movement2', t: 1.05, v: 0 },
      { id: 'Param56', t: 0, v: 1 }, { id: 'Param56', t: 1.05, v: 1 },
      { id: 'Param62', t: 0, v: 0.03 }, { id: 'Param62', t: 0.82, v: -0.03 }, { id: 'Param62', t: 1.05, v: 0 },
      { id: 'Param59', t: 0, v: 0.48 }, { id: 'Param59', t: 0.82, v: -0.048 }, { id: 'Param59', t: 1.05, v: 0 },
      { id: 'Param60', t: 0, v: 0.86 }, { id: 'Param60', t: 0.82, v: -0.008 }, { id: 'Param60', t: 1.05, v: 0 },
      { id: 'Param61', t: 0, v: 0 }, { id: 'Param61', t: 0.82, v: 0.062 }, { id: 'Param61', t: 1.05, v: 0.001 },
    ], params: [
      { id: 'Movement1', to: 0 }, { id: 'Movement3', to: 0 },
      { id: 'Param36', to: 0 }, { id: 'Param39', to: 0 }, { id: 'Param40', to: 0 }, { id: 'Param41', to: 0 },
      { id: 'Param42', to: 0 }, { id: 'Param43', to: 0 },
    ] },
    'puff-cheek': { state: true, dur: 1.2, params: [{ id: 'CheeckPuff', to: 1 }] },
    'pout-lips':  { state: true, dur: 1.2, params: [{ id: 'Mouthpucker', to: 1 }] },
    'dazed':      { state: true, dur: 1.2, params: [{ id: 'Param11', to: 6 }] },

    // 歪头
    tilt:        { state: true, dur: 1.2, params: [{ id: 'AngleZ', to: 28 }] },

    // —— 波形动作（连续摆动）——
    // 点头：头上下点几下
    nod:   { dur: 1.06,
      // 两连点头（Body.cs:102 Repeat 展开）：点到 -10 停顿回 1，再点一次——顿挫感
      keys: [
        { id: 'AngleY', t: 0, v: 0 }, { id: 'AngleY', t: 0.17, v: -10 }, { id: 'AngleY', t: 0.4, v: 1 },
        { id: 'AngleY', t: 0.63, v: -10 }, { id: 'AngleY', t: 0.86, v: 1 }, { id: 'AngleY', t: 1.06, v: 0 },
      ] },
    // 摇头：头左右摇
    shake: { dur: 1.34,
      // 两连摇头（Body.cs:103 Repeat 展开）：左 -11 停顿右 11，再一轮
      keys: [
        { id: 'AngleX', t: 0, v: 0 }, { id: 'AngleX', t: 0.17, v: -11 }, { id: 'AngleX', t: 0.45, v: 11 },
        { id: 'AngleX', t: 0.73, v: -11 }, { id: 'AngleX', t: 1.01, v: 11 }, { id: 'AngleX', t: 1.34, v: 0 },
      ] },
    // 跳舞：腰扭 + 头摆 + 歪头 + 身体前后，四条不同频率叠起来才像在跳
    // 扭腰：腰 + 头 + 歪头 + 身体前后，四条不同频率叠起来才像在跳
    // （不能叫 dance：kit 里 dance 走 setMode，不给 pulse，拿不到进度）
    wiggle: {
      dur: 4.6,
      // 腰的左右摆：ParamBodyAngleZ / HipAngleZ 是物理的**输出**参数，
      // 写在物理前面会被当场算回 0（这就是之前"腰没动、只剩前后晃"的原因）。
      // postWaves 放在 physics.evaluate() 之后写，才是当帧最终值。
      postWaves: [
        // 胸腔先动，盆骨慢半拍跟上（从腰往上带的感觉）——2026-11-19 柔和化 ×0.6/×0.7
        { id: 'ParamBodyAngleZ', amp: 13, freq: 0.7 },
        // 走路时胯部动的是 HipAngleX（盆骨 X），不是 Z。之前只写 Z 所以胯看着没动。
        { id: 'HipAngleX', amp: 11, freq: 0.7, phase: 0.12 },
        { id: 'HipAngleZ', amp: 5, freq: 0.7, phase: 0.15 },
        // ParamBodyAngleRZ 是"身体位移RZ"，物理既不读也不写，可以自由驱动，
        // 它让整个身体一起摆，比只转胸腔明显得多。
        { id: 'ParamBodyAngleRZ', amp: 7, freq: 0.7, phase: 0.06 },
      ],
      // 头和上半身跟着同一拍，速度慢一点，形成"腰先动、头后跟"
      waves: [
        // PositionX 是物理的输入：身体重心左右移 → 物理推出胸/胯/裙摆/头发
        // 一起动，比单纯转胸腔自然得多（这也是 3.0.0 里 bodyX 的做法）
        { id: 'PositionX', amp: 12, freq: 0.65 },
        { id: 'AngleZ', amp: 5, freq: 0.7, phase: 0.1 },
        { id: 'AngleX', amp: 4, freq: 0.35, phase: 0.3 },
        { id: 'LeanInput', amp: -2, freq: 0.7, phase: 0.25 },
      ],
    },

    // —— 单通道表情（2026-11-18）——
    'eye-smile':   { state: true, dur: 1.2, params: [{ id: 'EyeSmile', to: 1 }, { id: 'ParamEyeLOpen', to: 0.45 }, { id: 'ParamEyeROpen', to: 0.45 }] },
    'eye-close':   { state: true, dur: 1.2, params: [{ id: 'ParamEyeLOpen', to: 0 }, { id: 'ParamEyeROpen', to: 0 }] },
    'eye-half':    { state: true, dur: 1.2, params: [{ id: 'ParamEyeLOpen', to: 0.45 }, { id: 'ParamEyeROpen', to: 0.45 }, { id: 'EyeSmile', to: 0 }] },
    'eye-wide':    { state: true, dur: 1.2, params: [{ id: 'ParamEyeLOpen', to: 1.35 }, { id: 'ParamEyeROpen', to: 1.35 }, { id: 'EyeSmile', to: 0 }] },
    // 快眨单眼·左（Body.cs:76-77 套件）：笑眼渐入 + 左眼闭 0.6s + 歪头 12 同步——
    // 全 keys 版（1.2s 收尾渐回）：dur 到期删条目会让 ROpen 跳回 roles 写入值（眨一下观感）
    'wink-left':   { reflex: true, dur: 1.2,
      keys: [
        { id: 'ParamEyeLOpen', t: 0, v: 1 }, { id: 'ParamEyeLOpen', t: 0.14, v: 0 },
        { id: 'ParamEyeLOpen', t: 0.6, v: 0 }, { id: 'ParamEyeLOpen', t: 0.9, v: 1 }, { id: 'ParamEyeLOpen', t: 1.2, v: 1 },
        { id: 'ParamEyeROpen', t: 0, v: 1 }, { id: 'ParamEyeROpen', t: 0.14, v: 0.45 },
        { id: 'ParamEyeROpen', t: 0.6, v: 0.45 }, { id: 'ParamEyeROpen', t: 0.9, v: 1 }, { id: 'ParamEyeROpen', t: 1.2, v: 1 },
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 0.14, v: 12 },
        { id: 'AngleZ', t: 0.6, v: 12 }, { id: 'AngleZ', t: 0.9, v: 12 }, { id: 'AngleZ', t: 1.2, v: 0 },
        { id: 'EyeSmile', t: 0, v: 0.45 }, { id: 'EyeSmile', t: 0.14, v: 1 },
        { id: 'EyeSmile', t: 0.9, v: 1 }, { id: 'EyeSmile', t: 1.2, v: 0.45 },
      ],
      params: [] },
    // 快眨单眼·右（Body.cs:76-77 镜像）——全 keys 版 1.2s
    'wink-right':  { reflex: true, dur: 1.2,
      keys: [
        { id: 'ParamEyeROpen', t: 0, v: 1 }, { id: 'ParamEyeROpen', t: 0.14, v: 0 },
        { id: 'ParamEyeROpen', t: 0.6, v: 0 }, { id: 'ParamEyeROpen', t: 0.9, v: 1 }, { id: 'ParamEyeROpen', t: 1.2, v: 1 },
        { id: 'ParamEyeLOpen', t: 0, v: 1 }, { id: 'ParamEyeLOpen', t: 0.14, v: 0.45 },
        { id: 'ParamEyeLOpen', t: 0.6, v: 0.45 }, { id: 'ParamEyeLOpen', t: 0.9, v: 1 }, { id: 'ParamEyeLOpen', t: 1.2, v: 1 },
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 0.14, v: -12 },
        { id: 'AngleZ', t: 0.6, v: -12 }, { id: 'AngleZ', t: 0.9, v: -12 }, { id: 'AngleZ', t: 1.2, v: 0 },
        { id: 'EyeSmile', t: 0, v: 0.45 }, { id: 'EyeSmile', t: 0.14, v: 1 },
        { id: 'EyeSmile', t: 0.9, v: 1 }, { id: 'EyeSmile', t: 1.2, v: 0.45 },
      ],
      params: [] },
    // 单眨眼（Body.cs:74）：左眼闭着停 2 秒再开——抛媚眼式
    'wink-hold':   { reflex: true, dur: 2.35,
      keys: [
        { id: 'ParamEyeLOpen', t: 0, v: 1 }, { id: 'ParamEyeLOpen', t: 0.2, v: 0 },
        { id: 'ParamEyeLOpen', t: 2.2, v: 0 }, { id: 'ParamEyeLOpen', t: 2.35, v: 1 },
      ] },
    // 眨单眼（Body.cs:73）：左眼常闭 + 笑眼——保持型
    'wink-keep':   { reflex: true, state: true, dur: 1.2, params: [
      { id: 'ParamEyeLOpen', to: 0 }, { id: 'EyeSmile', to: 1 },
    ] },
    'brow-frown':  { state: true, dur: 1.0, params: [
      { id: 'BrowInnerUp', to: 1 },
      { id: 'ParamBrowLAngle', to: 0.6 }, { id: 'ParamBrowRAngle', to: 0.6 },
    ] },
    'brow-up':     { state: true, dur: 1.0, params: [
      { id: 'ParamBrowLY', to: 0.6 }, { id: 'ParamBrowRY', to: 0.6 }, { id: 'BrowInnerUp', to: 0.4 },
    ] },
    'brow-knit':   { state: true, dur: 1.0, params: [
      { id: 'ParamBrowLY', to: -0.8 }, { id: 'ParamBrowRY', to: -0.8 },
      { id: 'ParamBrowLAngle', to: -1 }, { id: 'ParamBrowRAngle', to: -1 },
    ] },
    'mouth-smile': { state: true, dur: 1.0, params: [{ id: 'ParamMouthForm', to: 1 }] },    // 嘟嘴三件套（Body.cs:86 原样）：漏斗嘴+撅嘴+嘴形负——真嘟嘴
    'pout': { state: true, dur: 1.2, params: [
      { id: 'MouthFunnel', to: 0.7 }, { id: 'Mouthpucker', to: 1 }, { id: 'ParamMouthForm', to: -0.4 },
    ] },
    'mouth-pout':  { state: true, dur: 1.0, params: [{ id: 'ParamMouthForm', to: -1 }] },
    'mouth-open':  { state: true, dur: 1.0, params: [{ id: 'ParamMouthOpenY', to: 0.7 }, { id: 'JawOpen', to: 0.4 }, { id: 'MouthFunnel', to: 0.3 }] },
    // 脸红：原包 脸红.exp3.json 的开关（key7）
    'blush':       { state: true, dur: 1.0, params: [{ id: 'key7', to: 1 }] },
    // 恢复：实际清空在 baseWord 里做；这里占位让 kit 认识它
    'restore':     { dur: 0.5, params: [] },
    // —— 基础词补齐（3.1）——
    'head-down':  { state: true, dur: 1.0, params: [{ id: 'AngleY', to: -18 }] },
    'head-up':    { state: true, dur: 1.0, params: [{ id: 'AngleY', to: 15 }] },
    'face-front': { state: true, dur: 1.0, params: [
      { id: 'AngleX', to: 0 }, { id: 'AngleY', to: 0 }, { id: 'AngleZ', to: 0 },
    ] },
    'stand-straight': { state: true, dur: 1.0, params: [
      { id: 'LeanInput', to: 0 }, { id: 'AngleX', to: 0 }, { id: 'AngleY', to: 0 }, { id: 'AngleZ', to: 0 },
    ] },
    'squint':     { state: true, dur: 1.2, params: [
      { id: 'REyeSquint', to: 1 }, { id: 'LEyeSquint', to: 1 },
      { id: 'ParamEyeLOpen', to: 0.6 }, { id: 'ParamEyeROpen', to: 0.6 },
    ] },
    'smirk':      { state: true, dur: 1.0, params: [
      { id: 'ParamMouthForm', to: 1 }, { id: 'MouthX', to: 0.6 },
    ] },
    'press-lips': { state: true, dur: 1.0, params: [
      { id: 'MouthPressLipOpen', to: -1 }, { id: 'ParamMouthForm', to: -0.5 },
    ] },
    'sweat':      { state: true, dur: 1.0, params: [{ id: 'key13', to: 1 }] },
    'shrug':      { dur: 1.5, keys: [
      { t: 0,    id: 'ShoulderYy', v: 0 },
      { t: 0.25, id: 'ShoulderYy', v: 14 },
      { t: 0.9,  id: 'ShoulderYy', v: 14 },
      { t: 1.5,  id: 'ShoulderYy', v: 0 },
    ] },
    // —— 组合词（通道组合，可继续叠）——
    'bitter-smile': { state: true, dur: 1.2, params: [
      { id: 'ParamMouthForm', to: 0.7 },
      { id: 'ParamBrowLY', to: 0.45 }, { id: 'ParamBrowRY', to: 0.45 },
      { id: 'ParamBrowLAngle', to: -0.55 }, { id: 'ParamBrowRAngle', to: -0.55 },
    ] },
    'holding-up': { state: true, dur: 1.2, params: [
      { id: 'ParamMouthForm', to: 0.7 },
      { id: 'ParamBrowLY', to: 0.45 }, { id: 'ParamBrowRY', to: 0.45 },
      { id: 'ParamBrowLAngle', to: -0.55 }, { id: 'ParamBrowRAngle', to: -0.55 },
      { id: 'key7', to: 1 },
    ] },
    'guilty-look': { state: true, dur: 1.2, params: [
      { id: 'ParamEyeLOpen', to: 0.45 }, { id: 'ParamEyeROpen', to: 0.45 }, { id: 'EyeSmile', to: 0 },
      { id: 'ParamBrowLY', to: 0.45 }, { id: 'ParamBrowRY', to: 0.45 },
      { id: 'ParamBrowLAngle', to: -0.55 }, { id: 'ParamBrowRAngle', to: -0.55 },
      { id: 'key7', to: 1 }, { id: 'ParamMouthForm', to: -0.6 },
    ] },
    // 撒娇（2026-11-19 按他们家 Combos 重写：嘟嘴+歪头+八字眉+慢眨眼）——
    // 嘟嘴三件套（MouthFunnel 0.7 + Mouthpucker 1 + MouthForm -0.4，Body.cs:86 原样）
    // + 歪头 16 + 八字眉 + 慢眨眼两连——3.2s
    'act-cute': { dur: 3.2,
      keys: [
        { id: 'ParamEyeLOpen', t: 0, v: 1 }, { id: 'ParamEyeLOpen', t: 0.6, v: 0.12 },
        { id: 'ParamEyeLOpen', t: 1.2, v: 1 }, { id: 'ParamEyeLOpen', t: 1.9, v: 0.12 },
        { id: 'ParamEyeLOpen', t: 2.6, v: 1 }, { id: 'ParamEyeLOpen', t: 3.2, v: 1 },
        { id: 'ParamEyeROpen', t: 0, v: 1 }, { id: 'ParamEyeROpen', t: 0.6, v: 0.12 },
        { id: 'ParamEyeROpen', t: 1.2, v: 1 }, { id: 'ParamEyeROpen', t: 1.9, v: 0.12 },
        { id: 'ParamEyeROpen', t: 2.6, v: 1 }, { id: 'ParamEyeROpen', t: 3.2, v: 1 },
      ],
      params: [
        { id: 'MouthFunnel', to: 0.7 }, { id: 'Mouthpucker', to: 1 }, { id: 'ParamMouthForm', to: -0.4 },
        { id: 'AngleZ', to: 16 },
        { id: 'ParamBrowLY', to: 0.45 }, { id: 'ParamBrowRY', to: 0.45 },
        { id: 'ParamBrowLAngle', to: -0.55 }, { id: 'ParamBrowRAngle', to: -0.55 },
      ] },
    'defiant': { state: true, dur: 1.2, params: [
      { id: 'ParamBrowLY', to: -0.7 }, { id: 'ParamBrowRY', to: -0.7 },
      { id: 'ParamBrowLAngle', to: -0.9 }, { id: 'ParamBrowRAngle', to: -0.9 },
      { id: 'ParamMouthForm', to: -0.6 },
      { id: 'ParamEyeLOpen', to: 0.45 }, { id: 'ParamEyeROpen', to: 0.45 }, { id: 'EyeSmile', to: 0 },
    ] },
    'holding-tears': { state: true, dur: 1.2, params: [
      { id: 'ParamEyeLOpen', to: 1 }, { id: 'ParamEyeROpen', to: 1 }, { id: 'EyeSmile', to: 0 },
      { id: 'ParamBrowLY', to: 0.45 }, { id: 'ParamBrowRY', to: 0.45 },
      { id: 'ParamBrowLAngle', to: -0.55 }, { id: 'ParamBrowRAngle', to: -0.55 },
      { id: 'ParamMouthForm', to: -0.6 },
    ] },
    'smug-face': { state: true, dur: 1.2, params: [
      { id: 'EyeSmile', to: 1 },
      { id: 'ParamBrowLY', to: 0.7 }, { id: 'ParamBrowRY', to: 0.7 },
      { id: 'ParamBrowLAngle', to: 0 }, { id: 'ParamBrowRAngle', to: 0 },
      { id: 'ParamMouthForm', to: 0.7 },
    ] },
    'perfunctory': { state: true, dur: 1.2, params: [
      { id: 'ParamEyeLOpen', to: 0.45 }, { id: 'ParamEyeROpen', to: 0.45 }, { id: 'EyeSmile', to: 0 },
      { id: 'ParamMouthForm', to: 0.7 },
    ] },
    // —— 原包部件开关（keyN，眼睛组互斥：开一个关其他三个）——
    'circle-eyes': { state: true, dur: 1.0, params: [
      { id: 'key3', to: 1 }, { id: 'key4', to: 0 }, { id: 'key5', to: 0 }, { id: 'key6', to: 0 },
    ] },
    'heart-eyes':  { state: true, dur: 1.0, params: [
      { id: 'key3', to: 0 }, { id: 'key4', to: 1 }, { id: 'key5', to: 0 }, { id: 'key6', to: 0 },
    ] },
    'xx-eyes':     { state: true, dur: 1.0, params: [
      { id: 'key3', to: 0 }, { id: 'key4', to: 0 }, { id: 'key5', to: 1 }, { id: 'key6', to: 0 },
    ] },
    'wry-face':    { state: true, dur: 1.0, params: [
      { id: 'key3', to: 0 }, { id: 'key4', to: 0 }, { id: 'key5', to: 0 }, { id: 'key6', to: 1 },
    ] },
    'dark-face':   { state: true, dur: 1.0, params: [{ id: 'key1', to: 1 }] },
    'tears':       { state: true, dur: 1.0, params: [{ id: 'key2', to: 1 }] },
    'loading-face':{ state: true, dur: 1.0, params: [{ id: 'key8', to: 1 }] },
    'bunny-teeth': { state: true, dur: 1.0, params: [{ id: 'key9', to: 1 }] },
    'pan-face':    { state: true, dur: 1.0, params: [{ id: 'key10', to: 1 }] },
    'glasses-face':{ state: true, dur: 1.0, params: [{ id: 'key11', to: 1 }] },
    'tongue-out': { state: true, dur: 1.0, params: [
      { id: 'TongueOut', to: 1 }, { id: 'ParamMouthOpenY', to: 0.35 },
    ] },
    // 叹气（2.7 整图压扁演示词）：ViewSquash 是虚拟参数（不在模型参数表）——
    // 通道写进虚拟表 → kit custom.squash() 读 → 叠进 sq 弹簧（280/14 自动平滑）。
    // 吸气微拉长 +0.12 → 呼气压扁 -0.18 → 回正；整图（petG 容器）跟着变形。
    // 叹气终版（2026-11-19）：搬他们家 Body.cs:111-113 的完整配方（3.5s 节奏）——
    // 压扁峰值 0.05（用户：再小 1/4）+ 呼气微张嘴 + 双眼慢慢闭上再回开 + 身体后仰前倾 + 头微摇。
    // kit 渲染 sy=1-pet.sq（正值=压扁）；keys 密集中间点缓动防弹簧过冲。
    'sigh': { dur: 3.5,
      keys: [
        { id: 'ViewSquash', t: 0, v: 0 }, { id: 'ViewSquash', t: 0.8, v: 0.04 },
        { id: 'ViewSquash', t: 1.2, v: 0.05 }, { id: 'ViewSquash', t: 2.2, v: 0.02 },
        { id: 'ViewSquash', t: 3.5, v: 0 },
        { id: 'AngleY', t: 0, v: 0 }, { id: 'AngleY', t: 0.8, v: 7 },
        { id: 'AngleY', t: 1.8, v: -8 }, { id: 'AngleY', t: 2.8, v: -7 }, { id: 'AngleY', t: 3.5, v: 0 },
        { id: 'LeanInput', t: 0, v: 0 }, { id: 'LeanInput', t: 0.8, v: 5 },
        { id: 'LeanInput', t: 1.8, v: -6 }, { id: 'LeanInput', t: 2.8, v: -5 }, { id: 'LeanInput', t: 3.5, v: 0 },
        { id: 'ParamEyeLOpen', t: 0, v: 1 }, { id: 'ParamEyeLOpen', t: 0.8, v: 0.5 },
        { id: 'ParamEyeLOpen', t: 1.8, v: 0.3 }, { id: 'ParamEyeLOpen', t: 2.8, v: 0.35 }, { id: 'ParamEyeLOpen', t: 3.5, v: 1 },
        { id: 'ParamEyeROpen', t: 0, v: 1 }, { id: 'ParamEyeROpen', t: 0.8, v: 0.5 },
        { id: 'ParamEyeROpen', t: 1.8, v: 0.3 }, { id: 'ParamEyeROpen', t: 2.8, v: 0.35 }, { id: 'ParamEyeROpen', t: 3.5, v: 1 },
        { id: 'ParamMouthOpenY', t: 0, v: 0 }, { id: 'ParamMouthOpenY', t: 1.1, v: 0 },
        { id: 'ParamMouthOpenY', t: 1.4, v: 0.35 }, { id: 'ParamMouthOpenY', t: 2.2, v: 0.12 },
        { id: 'ParamMouthOpenY', t: 2.8, v: 0 }, { id: 'ParamMouthOpenY', t: 3.5, v: 0 },
        { id: 'MouthFunnel', t: 0, v: 0 }, { id: 'MouthFunnel', t: 1.1, v: 0 },
        { id: 'MouthFunnel', t: 1.4, v: 0.9 }, { id: 'MouthFunnel', t: 2.2, v: 0.6 },
        { id: 'MouthFunnel', t: 2.6, v: 0 }, { id: 'MouthFunnel', t: 3.5, v: 0 },
      ],
      params: [] },
    // ── 3.1/3.3 第一批（2026-11-19，搬他们家 Body.cs 曲线，符号直接照抄——两边 ViewSquash 都是正=压）──
    // 大笑（Body.cs:82）：嘴大张 + 下巴——保持型
    'laugh': { state: true, dur: 1.2, params: [
      { id: 'ParamMouthForm', to: 1 }, { id: 'ParamMouthOpenY', to: 0.6 }, { id: 'JawOpen', to: 0.3 },
    ] },
    // 眼泪（Body.cs:91）：exp3 贴图 key2——保持型
    'tears': { state: true, dur: 1.0, params: [{ id: 'key2', to: 1 }] },
    // 挑一下眉（Body.cs:104-105）：双眉挑 + 眉心——0.7s 一次性
    'brow-raise-once': { dur: 0.7,
      keys: [
        { id: 'ParamBrowLY', t: 0, v: 0 }, { id: 'ParamBrowLY', t: 0.1, v: 0.7 },
        { id: 'ParamBrowLY', t: 0.45, v: 0.7 }, { id: 'ParamBrowLY', t: 0.7, v: 0 },
        { id: 'ParamBrowRY', t: 0, v: 0 }, { id: 'ParamBrowRY', t: 0.1, v: 0.7 },
        { id: 'ParamBrowRY', t: 0.45, v: 0.7 }, { id: 'ParamBrowRY', t: 0.7, v: 0 },
        { id: 'BrowInnerUp', t: 0, v: 0 }, { id: 'BrowInnerUp', t: 0.1, v: 0.5 },
        { id: 'BrowInnerUp', t: 0.45, v: 0.5 }, { id: 'BrowInnerUp', t: 0.7, v: 0 },
      ],
      params: [] },
    // 歪一下头（Body.cs:106）：快速歪 12 度停住再回——0.9s
    'tilt-once': { dur: 0.9,
      keys: [
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 0.2, v: 12 },
        { id: 'AngleZ', t: 0.6, v: 12 }, { id: 'AngleZ', t: 0.9, v: 0 },
      ],
      params: [] },
    // 晃头（Body.cs:107）：左右晃渐渐小——2.0s
    'head-swing': { dur: 2.0,
      keys: [
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 0.3, v: -10 }, { id: 'AngleZ', t: 0.7, v: 10 },
        { id: 'AngleZ', t: 1.1, v: -8 }, { id: 'AngleZ', t: 1.5, v: 6 }, { id: 'AngleZ', t: 2.0, v: 0 },
      ],
      params: [] },
    // 慢歪头（Body.cs:109）：慢慢地左右歪，最后慢慢停下——4.6s
    'slow-tilt': { dur: 4.6,
      keys: [
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 1, v: 8 }, { id: 'AngleZ', t: 2.2, v: -8 },
        { id: 'AngleZ', t: 3.4, v: 6 }, { id: 'AngleZ', t: 4.6, v: 0 },
      ],
      params: [] },
    // 缩一下（Body.cs:110）：快速压扁一下 + 低头缩脖——0.6s（他们 ViewSquash 正=压，与我们一致）
    'cower': { dur: 0.6,
      keys: [
        { id: 'ViewSquash', t: 0, v: 0 }, { id: 'ViewSquash', t: 0.08, v: 0.05 },
        { id: 'ViewSquash', t: 0.3, v: 0.01 }, { id: 'ViewSquash', t: 0.6, v: 0 },
        { id: 'AngleY', t: 0, v: 0 }, { id: 'AngleY', t: 0.08, v: -8 }, { id: 'AngleY', t: 0.6, v: 0 },
      ],
      params: [] },
    // 吓一跳（Body.cs:115-116 适配版）：压扁回弹抖动加大 + 清笑眼（挂着的 EyeSmile 会盖住
    // 惊吓脸——瞪眼写 1 无对比，得把笑眼清成 0）+ 挑眉 + 微张嘴——1.4s
    'startle': { dur: 1.4,
      keys: [
        { id: 'ViewSquash', t: 0, v: 0 }, { id: 'ViewSquash', t: 0.06, v: 0.1 },
        { id: 'ViewSquash', t: 0.18, v: -0.08 }, { id: 'ViewSquash', t: 0.4, v: 0.08 }, { id: 'ViewSquash', t: 0.6, v: 0 },
        { id: 'EyeSmile', t: 0, v: 0 }, { id: 'EyeSmile', t: 1.4, v: 0 },
        { id: 'BrowInnerUp', t: 0, v: 0 }, { id: 'BrowInnerUp', t: 0.08, v: 0.9 },
        { id: 'BrowInnerUp', t: 1.0, v: 0.6 }, { id: 'BrowInnerUp', t: 1.4, v: 0 },
        { id: 'ParamMouthOpenY', t: 0, v: 0 }, { id: 'ParamMouthOpenY', t: 0.08, v: 0.3 },
        { id: 'ParamMouthOpenY', t: 0.8, v: 0.35 }, { id: 'ParamMouthOpenY', t: 1.4, v: 0 },
      ],
      params: [] },
    // 摇摆一（Body.cs:120/125/126/129 曲线，node 重算 Dance/Groove）——12 拍快速左右摇摆（听歌第一段）
    'sway-1': { dur: 7.714,
      // PositionX 前批写（非输出+输入，物理驱动胸晃——铁律）；胸腔 X/Z keysPost 显示
      keys: [
        { id: 'PositionX', t: 0, v: 0 }, { id: 'PositionX', t: 0.321, v: 13 }, { id: 'PositionX', t: 0.964, v: -13 }, { id: 'PositionX', t: 1.607, v: 13 }, { id: 'PositionX', t: 2.25, v: -13 }, { id: 'PositionX', t: 2.893, v: 13 }, { id: 'PositionX', t: 3.536, v: -13 }, { id: 'PositionX', t: 4.179, v: 13 }, { id: 'PositionX', t: 4.821, v: -13 }, { id: 'PositionX', t: 5.464, v: 13 }, { id: 'PositionX', t: 6.107, v: -13 }, { id: 'PositionX', t: 6.75, v: 13 }, { id: 'PositionX', t: 7.393, v: -13 }, { id: 'PositionX', t: 7.714, v: 0 },
        { id: 'AngleX', t: 0, v: 0 }, { id: 'AngleX', t: 0.461, v: -19 }, { id: 'AngleX', t: 1.104, v: 19 }, { id: 'AngleX', t: 1.747, v: -19 }, { id: 'AngleX', t: 2.39, v: 19 }, { id: 'AngleX', t: 3.033, v: -19 }, { id: 'AngleX', t: 3.676, v: 19 }, { id: 'AngleX', t: 4.319, v: -19 }, { id: 'AngleX', t: 4.961, v: 19 }, { id: 'AngleX', t: 5.604, v: -19 }, { id: 'AngleX', t: 6.247, v: 19 }, { id: 'AngleX', t: 6.89, v: -19 }, { id: 'AngleX', t: 7.533, v: 19 }, { id: 'AngleX', t: 7.854, v: 0 },
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 0.461, v: -8 }, { id: 'AngleZ', t: 1.104, v: 8 }, { id: 'AngleZ', t: 1.747, v: -8 }, { id: 'AngleZ', t: 2.39, v: 8 }, { id: 'AngleZ', t: 3.033, v: -8 }, { id: 'AngleZ', t: 3.676, v: 8 }, { id: 'AngleZ', t: 4.319, v: -8 }, { id: 'AngleZ', t: 4.961, v: 8 }, { id: 'AngleZ', t: 5.604, v: -8 }, { id: 'AngleZ', t: 6.247, v: 8 }, { id: 'AngleZ', t: 6.89, v: -8 }, { id: 'AngleZ', t: 7.533, v: 8 }, { id: 'AngleZ', t: 7.854, v: 0 },
        { id: 'AngleY', t: 0, v: 0 }, { id: 'AngleY', t: 0.461, v: -4.5 }, { id: 'AngleY', t: 0.783, v: 9.5 }, { id: 'AngleY', t: 1.104, v: -4.5 }, { id: 'AngleY', t: 1.426, v: 9.5 }, { id: 'AngleY', t: 1.747, v: -4.5 }, { id: 'AngleY', t: 2.069, v: 9.5 }, { id: 'AngleY', t: 2.39, v: -4.5 }, { id: 'AngleY', t: 2.711, v: 9.5 }, { id: 'AngleY', t: 3.033, v: -4.5 }, { id: 'AngleY', t: 3.354, v: 9.5 }, { id: 'AngleY', t: 3.676, v: -4.5 }, { id: 'AngleY', t: 3.997, v: 9.5 }, { id: 'AngleY', t: 4.319, v: -4.5 }, { id: 'AngleY', t: 4.64, v: 9.5 }, { id: 'AngleY', t: 4.961, v: -4.5 }, { id: 'AngleY', t: 5.283, v: 9.5 }, { id: 'AngleY', t: 5.604, v: -4.5 }, { id: 'AngleY', t: 5.926, v: 9.5 }, { id: 'AngleY', t: 6.247, v: -4.5 }, { id: 'AngleY', t: 6.569, v: 9.5 }, { id: 'AngleY', t: 6.89, v: -4.5 }, { id: 'AngleY', t: 7.211, v: 9.5 }, { id: 'AngleY', t: 7.533, v: -4.5 }, { id: 'AngleY', t: 7.854, v: 0 },
      ],
      keysPost: [
        { id: 'ParamBodyAngleX', t: 0, v: 0 }, { id: 'ParamBodyAngleX', t: 0.321, v: 13 }, { id: 'ParamBodyAngleX', t: 0.964, v: -13 }, { id: 'ParamBodyAngleX', t: 1.607, v: 13 }, { id: 'ParamBodyAngleX', t: 2.25, v: -13 }, { id: 'ParamBodyAngleX', t: 2.893, v: 13 }, { id: 'ParamBodyAngleX', t: 3.536, v: -13 }, { id: 'ParamBodyAngleX', t: 4.179, v: 13 }, { id: 'ParamBodyAngleX', t: 4.821, v: -13 }, { id: 'ParamBodyAngleX', t: 5.464, v: 13 }, { id: 'ParamBodyAngleX', t: 6.107, v: -13 }, { id: 'ParamBodyAngleX', t: 6.75, v: 13 }, { id: 'ParamBodyAngleX', t: 7.393, v: -13 }, { id: 'ParamBodyAngleX', t: 7.714, v: 0 },
        { id: 'ParamBodyAngleZ', t: 0, v: 0 }, { id: 'ParamBodyAngleZ', t: 0.321, v: 6.5 }, { id: 'ParamBodyAngleZ', t: 0.964, v: -6.5 }, { id: 'ParamBodyAngleZ', t: 1.607, v: 6.5 }, { id: 'ParamBodyAngleZ', t: 2.25, v: -6.5 }, { id: 'ParamBodyAngleZ', t: 2.893, v: 6.5 }, { id: 'ParamBodyAngleZ', t: 3.536, v: -6.5 }, { id: 'ParamBodyAngleZ', t: 4.179, v: 6.5 }, { id: 'ParamBodyAngleZ', t: 4.821, v: -6.5 }, { id: 'ParamBodyAngleZ', t: 5.464, v: 6.5 }, { id: 'ParamBodyAngleZ', t: 6.107, v: -6.5 }, { id: 'ParamBodyAngleZ', t: 6.75, v: 6.5 }, { id: 'ParamBodyAngleZ', t: 7.393, v: -6.5 }, { id: 'ParamBodyAngleZ', t: 7.714, v: 0 },
      ],
      params: [] },
    // 剧场摇摆一（Body.cs:120/125/126/129 曲线，node 重算 Dance/Groove）——摇摆一的柔和慢速版（小剧场用）
    'theater-sway-1': { dur: 11.02,
      // PositionX 前批写（非输出+输入，物理驱动胸晃——铁律）；胸腔 X/Z keysPost 显示
      keys: [
        { id: 'PositionX', t: 0, v: 0 }, { id: 'PositionX', t: 0.459, v: 9.1 }, { id: 'PositionX', t: 1.378, v: -9.1 }, { id: 'PositionX', t: 2.296, v: 9.1 }, { id: 'PositionX', t: 3.214, v: -9.1 }, { id: 'PositionX', t: 4.133, v: 9.1 }, { id: 'PositionX', t: 5.051, v: -9.1 }, { id: 'PositionX', t: 5.969, v: 9.1 }, { id: 'PositionX', t: 6.888, v: -9.1 }, { id: 'PositionX', t: 7.806, v: 9.1 }, { id: 'PositionX', t: 8.724, v: -9.1 }, { id: 'PositionX', t: 9.643, v: 9.1 }, { id: 'PositionX', t: 10.561, v: -9.1 }, { id: 'PositionX', t: 11.02, v: 0 },
        { id: 'AngleX', t: 0, v: 0 }, { id: 'AngleX', t: 0.599, v: -13.3 }, { id: 'AngleX', t: 1.518, v: 13.3 }, { id: 'AngleX', t: 2.436, v: -13.3 }, { id: 'AngleX', t: 3.354, v: 13.3 }, { id: 'AngleX', t: 4.273, v: -13.3 }, { id: 'AngleX', t: 5.191, v: 13.3 }, { id: 'AngleX', t: 6.109, v: -13.3 }, { id: 'AngleX', t: 7.028, v: 13.3 }, { id: 'AngleX', t: 7.946, v: -13.3 }, { id: 'AngleX', t: 8.864, v: 13.3 }, { id: 'AngleX', t: 9.783, v: -13.3 }, { id: 'AngleX', t: 10.701, v: 13.3 }, { id: 'AngleX', t: 11.16, v: 0 },
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 0.599, v: -5.6 }, { id: 'AngleZ', t: 1.518, v: 5.6 }, { id: 'AngleZ', t: 2.436, v: -5.6 }, { id: 'AngleZ', t: 3.354, v: 5.6 }, { id: 'AngleZ', t: 4.273, v: -5.6 }, { id: 'AngleZ', t: 5.191, v: 5.6 }, { id: 'AngleZ', t: 6.109, v: -5.6 }, { id: 'AngleZ', t: 7.028, v: 5.6 }, { id: 'AngleZ', t: 7.946, v: -5.6 }, { id: 'AngleZ', t: 8.864, v: 5.6 }, { id: 'AngleZ', t: 9.783, v: -5.6 }, { id: 'AngleZ', t: 10.701, v: 5.6 }, { id: 'AngleZ', t: 11.16, v: 0 },
        { id: 'AngleY', t: 0, v: 0 }, { id: 'AngleY', t: 0.599, v: -3.15 }, { id: 'AngleY', t: 1.058, v: 6.65 }, { id: 'AngleY', t: 1.518, v: -3.15 }, { id: 'AngleY', t: 1.977, v: 6.65 }, { id: 'AngleY', t: 2.436, v: -3.15 }, { id: 'AngleY', t: 2.895, v: 6.65 }, { id: 'AngleY', t: 3.354, v: -3.15 }, { id: 'AngleY', t: 3.813, v: 6.65 }, { id: 'AngleY', t: 4.273, v: -3.15 }, { id: 'AngleY', t: 4.732, v: 6.65 }, { id: 'AngleY', t: 5.191, v: -3.15 }, { id: 'AngleY', t: 5.65, v: 6.65 }, { id: 'AngleY', t: 6.109, v: -3.15 }, { id: 'AngleY', t: 6.569, v: 6.65 }, { id: 'AngleY', t: 7.028, v: -3.15 }, { id: 'AngleY', t: 7.487, v: 6.65 }, { id: 'AngleY', t: 7.946, v: -3.15 }, { id: 'AngleY', t: 8.405, v: 6.65 }, { id: 'AngleY', t: 8.864, v: -3.15 }, { id: 'AngleY', t: 9.324, v: 6.65 }, { id: 'AngleY', t: 9.783, v: -3.15 }, { id: 'AngleY', t: 10.242, v: 6.65 }, { id: 'AngleY', t: 10.701, v: -3.15 }, { id: 'AngleY', t: 11.16, v: 0 },
      ],
      keysPost: [
        { id: 'ParamBodyAngleX', t: 0, v: 0 }, { id: 'ParamBodyAngleX', t: 0.459, v: 9.1 }, { id: 'ParamBodyAngleX', t: 1.378, v: -9.1 }, { id: 'ParamBodyAngleX', t: 2.296, v: 9.1 }, { id: 'ParamBodyAngleX', t: 3.214, v: -9.1 }, { id: 'ParamBodyAngleX', t: 4.133, v: 9.1 }, { id: 'ParamBodyAngleX', t: 5.051, v: -9.1 }, { id: 'ParamBodyAngleX', t: 5.969, v: 9.1 }, { id: 'ParamBodyAngleX', t: 6.888, v: -9.1 }, { id: 'ParamBodyAngleX', t: 7.806, v: 9.1 }, { id: 'ParamBodyAngleX', t: 8.724, v: -9.1 }, { id: 'ParamBodyAngleX', t: 9.643, v: 9.1 }, { id: 'ParamBodyAngleX', t: 10.561, v: -9.1 }, { id: 'ParamBodyAngleX', t: 11.02, v: 0 },
        { id: 'ParamBodyAngleZ', t: 0, v: 0 }, { id: 'ParamBodyAngleZ', t: 0.459, v: 4.55 }, { id: 'ParamBodyAngleZ', t: 1.378, v: -4.55 }, { id: 'ParamBodyAngleZ', t: 2.296, v: 4.55 }, { id: 'ParamBodyAngleZ', t: 3.214, v: -4.55 }, { id: 'ParamBodyAngleZ', t: 4.133, v: 4.55 }, { id: 'ParamBodyAngleZ', t: 5.051, v: -4.55 }, { id: 'ParamBodyAngleZ', t: 5.969, v: 4.55 }, { id: 'ParamBodyAngleZ', t: 6.888, v: -4.55 }, { id: 'ParamBodyAngleZ', t: 7.806, v: 4.55 }, { id: 'ParamBodyAngleZ', t: 8.724, v: -4.55 }, { id: 'ParamBodyAngleZ', t: 9.643, v: 4.55 }, { id: 'ParamBodyAngleZ', t: 10.561, v: -4.55 }, { id: 'ParamBodyAngleZ', t: 11.02, v: 0 },
      ],
      params: [] },
    // 剧场摇摆二（Body.cs:120/125/126/129 曲线，node 重算 Dance/Groove）——摇摆二的柔和慢速版（小剧场用）
    'theater-sway-2': { dur: 6.531,
      // PositionX 前批写（非输出+输入，物理驱动胸晃——铁律）；胸腔 X/Z keysPost 显示
      keys: [
        { id: 'PositionX', t: 0, v: 0 }, { id: 'PositionX', t: 0.544, v: 2.8 }, { id: 'PositionX', t: 1.633, v: -2.8 }, { id: 'PositionX', t: 2.721, v: 2.8 }, { id: 'PositionX', t: 3.81, v: -2.8 }, { id: 'PositionX', t: 4.898, v: 2.8 }, { id: 'PositionX', t: 5.986, v: -2.8 }, { id: 'PositionX', t: 6.531, v: 0 },
        { id: 'AngleX', t: 0, v: 0 }, { id: 'AngleX', t: 0.644, v: 6.3 }, { id: 'AngleX', t: 1.733, v: -6.3 }, { id: 'AngleX', t: 2.821, v: 6.3 }, { id: 'AngleX', t: 3.91, v: -6.3 }, { id: 'AngleX', t: 4.998, v: 6.3 }, { id: 'AngleX', t: 6.086, v: -6.3 }, { id: 'AngleX', t: 6.631, v: 0 },
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 0.604, v: 14.7 }, { id: 'AngleZ', t: 1.693, v: -14.7 }, { id: 'AngleZ', t: 2.781, v: 14.7 }, { id: 'AngleZ', t: 3.87, v: -14.7 }, { id: 'AngleZ', t: 4.958, v: 14.7 }, { id: 'AngleZ', t: 6.046, v: -14.7 }, { id: 'AngleZ', t: 6.591, v: 0 },
        { id: 'AngleY', t: 0, v: 0 }, { id: 'AngleY', t: 0.594, v: -2.8 }, { id: 'AngleY', t: 1.138, v: 2.1 }, { id: 'AngleY', t: 1.683, v: -2.8 }, { id: 'AngleY', t: 2.227, v: 2.1 }, { id: 'AngleY', t: 2.771, v: -2.8 }, { id: 'AngleY', t: 3.315, v: 2.1 }, { id: 'AngleY', t: 3.86, v: -2.8 }, { id: 'AngleY', t: 4.404, v: 2.1 }, { id: 'AngleY', t: 4.948, v: -2.8 }, { id: 'AngleY', t: 5.492, v: 2.1 }, { id: 'AngleY', t: 6.036, v: -2.8 }, { id: 'AngleY', t: 6.581, v: 0 },
        { id: 'ShoulderY', t: 0, v: 0 }, { id: 'ShoulderY', t: 0.544, v: 9.8 }, { id: 'ShoulderY', t: 1.633, v: -9.8 }, { id: 'ShoulderY', t: 2.721, v: 9.8 }, { id: 'ShoulderY', t: 3.81, v: -9.8 }, { id: 'ShoulderY', t: 4.898, v: 9.8 }, { id: 'ShoulderY', t: 5.986, v: -9.8 }, { id: 'ShoulderY', t: 6.531, v: 0 },
        { id: 'ShoulderX', t: 0, v: 0 }, { id: 'ShoulderX', t: 0.544, v: 7 }, { id: 'ShoulderX', t: 1.633, v: -7 }, { id: 'ShoulderX', t: 2.721, v: 7 }, { id: 'ShoulderX', t: 3.81, v: -7 }, { id: 'ShoulderX', t: 4.898, v: 7 }, { id: 'ShoulderX', t: 5.986, v: -7 }, { id: 'ShoulderX', t: 6.531, v: 0 },
      ],
      keysPost: [
        { id: 'ParamBodyAngleX', t: 0, v: 0 }, { id: 'ParamBodyAngleX', t: 0.544, v: 2.8 }, { id: 'ParamBodyAngleX', t: 1.633, v: -2.8 }, { id: 'ParamBodyAngleX', t: 2.721, v: 2.8 }, { id: 'ParamBodyAngleX', t: 3.81, v: -2.8 }, { id: 'ParamBodyAngleX', t: 4.898, v: 2.8 }, { id: 'ParamBodyAngleX', t: 5.986, v: -2.8 }, { id: 'ParamBodyAngleX', t: 6.531, v: 0 },
        { id: 'ParamBodyAngleZ', t: 0, v: 0 }, { id: 'ParamBodyAngleZ', t: 0.544, v: 3.5 }, { id: 'ParamBodyAngleZ', t: 1.633, v: -3.5 }, { id: 'ParamBodyAngleZ', t: 2.721, v: 3.5 }, { id: 'ParamBodyAngleZ', t: 3.81, v: -3.5 }, { id: 'ParamBodyAngleZ', t: 4.898, v: 3.5 }, { id: 'ParamBodyAngleZ', t: 5.986, v: -3.5 }, { id: 'ParamBodyAngleZ', t: 6.531, v: 0 },
      ],
      params: [] },
    // 慢摇（Body.cs:120/125/126/129 曲线，node 重算 Dance/Groove）——越摇越慢越小，渐渐停下
    'slow-sway': { dur: 3.857,
      // PositionX 前批写（非输出+输入，物理驱动胸晃——铁律）；胸腔 X/Z keysPost 显示
      keys: [
        { id: 'PositionX', t: 0, v: 0 }, { id: 'PositionX', t: 0.5, v: 4 }, { id: 'PositionX', t: 1.643, v: -2.8 }, { id: 'PositionX', t: 3.071, v: 1.6 }, { id: 'PositionX', t: 3.857, v: 0 },
        { id: 'AngleX', t: 0, v: 0 }, { id: 'AngleX', t: 0.6, v: 9 }, { id: 'AngleX', t: 1.743, v: -6.3 }, { id: 'AngleX', t: 3.171, v: 3.6 }, { id: 'AngleX', t: 3.957, v: 0 },
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 0.56, v: 21 }, { id: 'AngleZ', t: 1.703, v: -14.7 }, { id: 'AngleZ', t: 3.131, v: 8.4 }, { id: 'AngleZ', t: 3.917, v: 0 },
        { id: 'AngleY', t: 0, v: 0 }, { id: 'AngleY', t: 0.55, v: -4 }, { id: 'AngleY', t: 1.121, v: 2.55 }, { id: 'AngleY', t: 1.693, v: -2.8 }, { id: 'AngleY', t: 2.407, v: 1.65 }, { id: 'AngleY', t: 3.121, v: -1.6 }, { id: 'AngleY', t: 3.907, v: 0 },
        { id: 'ShoulderY', t: 0, v: 0 }, { id: 'ShoulderY', t: 0.5, v: 14 }, { id: 'ShoulderY', t: 1.643, v: -9.8 }, { id: 'ShoulderY', t: 3.071, v: 5.6 }, { id: 'ShoulderY', t: 3.857, v: 0 },
        { id: 'ShoulderX', t: 0, v: 0 }, { id: 'ShoulderX', t: 0.5, v: 10 }, { id: 'ShoulderX', t: 1.643, v: -7 }, { id: 'ShoulderX', t: 3.071, v: 4 }, { id: 'ShoulderX', t: 3.857, v: 0 },
      ],
      keysPost: [
        { id: 'ParamBodyAngleX', t: 0, v: 0 }, { id: 'ParamBodyAngleX', t: 0.5, v: 4 }, { id: 'ParamBodyAngleX', t: 1.643, v: -2.8 }, { id: 'ParamBodyAngleX', t: 3.071, v: 1.6 }, { id: 'ParamBodyAngleX', t: 3.857, v: 0 },
        { id: 'ParamBodyAngleZ', t: 0, v: 0 }, { id: 'ParamBodyAngleZ', t: 0.5, v: 5 }, { id: 'ParamBodyAngleZ', t: 1.643, v: -3.5 }, { id: 'ParamBodyAngleZ', t: 3.071, v: 2 }, { id: 'ParamBodyAngleZ', t: 3.857, v: 0 },
      ],
      params: [] },
    // 左右张望（Body.cs:131）：眼珠 + 头同步左右各看一眼——1.9s
    // 瞟一眼（Body.cs Look 系）：快速眼珠瞟一边停一拍再回来——一次性（默认左，
    // :右 走 3.6 镜像）。偷笑组合里的「瞟一眼:左」就是它。
    'glance': { dur: 0.8,
      keys: [
        { id: 'ParamEyeBallX', t: 0, v: 0 }, { id: 'ParamEyeBallX', t: 0.15, v: 0.85 },
        { id: 'ParamEyeBallX', t: 0.55, v: 0.85 }, { id: 'ParamEyeBallX', t: 0.8, v: 0 },
        { id: 'AngleX', t: 0, v: 0 }, { id: 'AngleX', t: 0.15, v: 5 },
        { id: 'AngleX', t: 0.55, v: 5 }, { id: 'AngleX', t: 0.8, v: 0 },
      ] },
    'look-around': { dur: 1.9,
      keys: [
        { id: 'ParamEyeBallX', t: 0, v: 0 }, { id: 'ParamEyeBallX', t: 0.15, v: 0.8 },
        { id: 'ParamEyeBallX', t: 0.75, v: 0.8 }, { id: 'ParamEyeBallX', t: 1.0, v: -0.8 },
        { id: 'ParamEyeBallX', t: 1.6, v: -0.8 }, { id: 'ParamEyeBallX', t: 1.9, v: 0 },
        { id: 'AngleX', t: 0, v: 0 }, { id: 'AngleX', t: 0.15, v: 8 },
        { id: 'AngleX', t: 0.75, v: 8 }, { id: 'AngleX', t: 1.0, v: -8 },
        { id: 'AngleX', t: 1.6, v: -8 }, { id: 'AngleX', t: 1.9, v: 0 },
      ],
      params: [] },
    // ── 3.1 看类（Body.cs:55-65，gaze/turn/lean 都是保持型 state）──
    // 看左边/右边（Body.cs Look 左右）：眼珠 + 头同步——保持型
    'look-left': { state: true, dur: 1.2, params: [
      { id: 'ParamEyeBallX', to: 0.75 }, { id: 'AngleX', to: 7 },
    ] },
    'look-right': { state: true, dur: 1.2, params: [
      { id: 'ParamEyeBallX', to: -0.75 }, { id: 'AngleX', to: -7 },
    ] },
    // 看上面/下面（Body.cs Look 上下）
    'look-up': { state: true, dur: 1.2, params: [
      { id: 'ParamEyeBallY', to: 0.6 }, { id: 'AngleY', to: 4 },
    ] },
    'look-down': { state: true, dur: 1.2, params: [
      { id: 'ParamEyeBallY', to: -0.6 }, { id: 'AngleY', to: -5 },
    ] },
    // 转头（Body.cs:55）：大幅转头 ±20——保持型（默认向左，方向修饰 3.6 待做）
    'turn-head': { state: true, dur: 1.2, params: [{ id: 'AngleX', to: 20 }] },
    // 前倾（Body.cs:59）：lean 通道——保持型（与后仰 lean-back 对称）
    'lean-forward': { state: true, dur: 1.2, params: [{ id: 'LeanInput', to: -14 }] },
    // ── 3.1 组合词单条目（2026-11-19，第四批）——他们家 Combos 展开成单条目跨部位叠加：
    // params 静态部件 + keys 动作部件，**keys 与 params 不放同参数**（params 后写会覆盖 keys 动作）。
    // 高兴（Body.cs Combos：张嘴+眯眼笑+晃头）——2s 一套
    'happy-burst': { dur: 2.0,
      keys: [
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 0.3, v: -10 }, { id: 'AngleZ', t: 0.7, v: 10 },
        { id: 'AngleZ', t: 1.1, v: -8 }, { id: 'AngleZ', t: 1.5, v: 6 }, { id: 'AngleZ', t: 2.0, v: 0 },
      ],
      params: [
        { id: 'ParamMouthOpenY', to: 0.6 }, { id: 'EyeSmile', to: 1 },
        { id: 'ParamEyeLOpen', to: 0.5 }, { id: 'ParamEyeROpen', to: 0.5 },
      ] },
    // 偷笑加长版（2026-11-19 用户：好玩加长）：坏笑立即挂 → 0.5s 后眼珠瞟过去停一会
    // → 1.3s 笑意渐浓（眯眼）——单条目内用 keys 时间轴做出「先后感」——2.8s
    'snicker': { dur: 2.8,
      keys: [
        { id: 'ParamEyeBallX', t: 0, v: 0 }, { id: 'ParamEyeBallX', t: 0.5, v: 0 },
        { id: 'ParamEyeBallX', t: 0.7, v: 0.85 }, { id: 'ParamEyeBallX', t: 1.8, v: 0.85 },
        { id: 'ParamEyeBallX', t: 2.1, v: 0 }, { id: 'ParamEyeBallX', t: 2.8, v: 0 },
        { id: 'EyeSmile', t: 0, v: 0 }, { id: 'EyeSmile', t: 0.9, v: 0 },
        { id: 'EyeSmile', t: 1.3, v: 1 }, { id: 'EyeSmile', t: 2.8, v: 1 },
        { id: 'ParamEyeLOpen', t: 0, v: 1 }, { id: 'ParamEyeLOpen', t: 0.9, v: 1 },
        { id: 'ParamEyeLOpen', t: 1.3, v: 0.45 }, { id: 'ParamEyeLOpen', t: 2.8, v: 0.45 },
        { id: 'ParamEyeROpen', t: 0, v: 1 }, { id: 'ParamEyeROpen', t: 0.9, v: 1 },
        { id: 'ParamEyeROpen', t: 1.3, v: 0.45 }, { id: 'ParamEyeROpen', t: 2.8, v: 0.45 },
      ],
      params: [
        { id: 'ParamMouthForm', to: 0.7 }, { id: 'MouthX', to: 0.5 },
      ] },
    // 傻眼（睁大+张嘴+冷汗）——保持型
    'dumbstruck': { state: true, dur: 1.2, params: [
      { id: 'ParamEyeLOpen', to: 1 }, { id: 'ParamEyeROpen', to: 1 }, { id: 'EyeSmile', to: 0 },
      { id: 'ParamMouthOpenY', to: 0.6 }, { id: 'key13', to: 1 },
    ] },
    // 得瑟（屑屑眼+晃头+后仰）——贴图挂着、身体后仰、头晃
    'gloating': { dur: 2.0,
      keys: [
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 0.3, v: -10 }, { id: 'AngleZ', t: 0.7, v: 10 },
        { id: 'AngleZ', t: 1.1, v: -8 }, { id: 'AngleZ', t: 1.5, v: 6 }, { id: 'AngleZ', t: 2.0, v: 0 },
      ],
      params: [
        { id: 'key6', to: 1 }, { id: 'key1', to: 0 }, { id: 'key3', to: 0 }, { id: 'key4', to: 0 },
        { id: 'key5', to: 0 }, { id: 'LeanInput', to: 9 },
      ] },
    // 抓狂（皱眉+＞＜+张嘴+快摇头×3）——1.7s 三连摇头
    'frantic': { dur: 1.7,
      keys: [
        { id: 'AngleX', t: 0, v: 0 }, { id: 'AngleX', t: 0.17, v: -11 }, { id: 'AngleX', t: 0.5, v: 11 },
        { id: 'AngleX', t: 0.67, v: -11 }, { id: 'AngleX', t: 1.0, v: 11 },
        { id: 'AngleX', t: 1.17, v: -11 }, { id: 'AngleX', t: 1.5, v: 11 }, { id: 'AngleX', t: 1.7, v: 0 },
      ],
      params: [
        { id: 'ParamBrowLY', to: -0.7 }, { id: 'ParamBrowRY', to: -0.7 },
        { id: 'ParamBrowLAngle', to: -0.9 }, { id: 'ParamBrowRAngle', to: -0.9 },
        { id: 'key5', to: 1 }, { id: 'key1', to: 0 }, { id: 'key3', to: 0 },
        { id: 'key4', to: 0 }, { id: 'key6', to: 0 }, { id: 'ParamMouthOpenY', to: 0.6 },
      ] },
    // 犯困（半睁+低头+张嘴）——保持型
    'drowsy-combo': { state: true, dur: 1.2, params: [
      { id: 'ParamEyeLOpen', to: 0.45 }, { id: 'ParamEyeROpen', to: 0.45 }, { id: 'EyeSmile', to: 0 },
      { id: 'AngleY', to: -14 }, { id: 'ParamMouthOpenY', to: 0.2 },
    ] },
    // 感动（八字眉+眼泪+微笑）——保持型
    'touched': { state: true, dur: 1.2, params: [
      { id: 'ParamBrowLY', to: 0.45 }, { id: 'ParamBrowRY', to: 0.45 },
      { id: 'ParamBrowLAngle', to: -0.55 }, { id: 'ParamBrowRAngle', to: -0.55 },
      { id: 'key2', to: 1 }, { id: 'ParamMouthForm', to: 0.7 },
    ] },
    // 鬼点子（挑眉+坏笑+眼珠一转+竖手指）：Movement3 是竖食指部件显示档——
    // keys 竖起 0.3s、末段渐隐收回（默认手自动露出，不残留）——2.6s
    // hand: true + reflex: true（2026-11-20 用户二次反馈手指戳进身体）：手位是坐标不是幅度——
    // 没有 hand 豁免时 keys 被 moodScale/语气缩放（！=×1.2），0.705 变 0.85 手臂就抬过头戳进身体。
    // 两个豁免齐上 effScale 恒为 1，竖手指姿势与正牌 finger-point 完全一致。
    'sly-idea': { dur: 2.6, hand: true, reflex: true, keys: [
        { id: 'ParamEyeBallX', t: 0, v: 0 }, { id: 'ParamEyeBallX', t: 0.2, v: 0.8 },
        { id: 'ParamEyeBallX', t: 0.5, v: -0.8 }, { id: 'ParamEyeBallX', t: 0.8, v: 0.4 },
        { id: 'ParamEyeBallX', t: 1.2, v: 0 },
        // 2026-11-20 二次重做：竖手指段换原厂 pointIn 时间轴（平移 +0.4s 与 Movement3 同拍）——
        // 带到位回弹（Param41 0.708→0.698、Param42/43 微回弹），不再用静态峰值
        { id: 'Movement3', t: 0, v: 0 }, { id: 'Movement3', t: 0.75, v: 0 }, { id: 'Movement3', t: 0.77, v: 1 },
        { id: 'Movement3', t: 2.2, v: 1 }, { id: 'Movement3', t: 2.6, v: 0 },
        { id: 'Movement1', t: 0, v: 0 }, { id: 'Movement1', t: 2.6, v: 0 },
        { id: 'Param40', t: 0.4, v: 0 }, { id: 'Param40', t: 0.78, v: 0 }, { id: 'Param40', t: 1.07, v: 1 },
        { id: 'Param40', t: 2.2, v: 1 }, { id: 'Param40', t: 2.6, v: 0 },
        { id: 'Param41', t: 0.43, v: 0 }, { id: 'Param41', t: 1.30, v: 0.708 }, { id: 'Param41', t: 1.48, v: 0.698 },
        { id: 'Param41', t: 1.60, v: 0.702 }, { id: 'Param41', t: 2.2, v: 0.702 }, { id: 'Param41', t: 2.6, v: 0 },
        { id: 'Param39', t: 0.4, v: 0 }, { id: 'Param39', t: 1.27, v: 0.322 }, { id: 'Param39', t: 2.2, v: 0.322 }, { id: 'Param39', t: 2.6, v: 0 },
        { id: 'Param42', t: 0.47, v: 0 }, { id: 'Param42', t: 1.33, v: -0.058 }, { id: 'Param42', t: 1.52, v: 0.026 },
        { id: 'Param42', t: 1.63, v: 0 }, { id: 'Param42', t: 2.6, v: 0 },
        { id: 'Param43', t: 0.50, v: 0 }, { id: 'Param43', t: 1.35, v: -0.164 }, { id: 'Param43', t: 1.55, v: 0.066 },
        { id: 'Param43', t: 1.65, v: 0 }, { id: 'Param43', t: 2.6, v: 0 },
        { id: 'Param56', t: 0.4, v: 1 }, { id: 'Param56', t: 2.2, v: 1 }, { id: 'Param56', t: 2.6, v: 0 },
      ],
      params: [
        { id: 'ParamBrowLY', to: 0.6 }, { id: 'ParamBrowRY', to: 0.6 }, { id: 'BrowInnerUp', to: 0.4 },
        { id: 'ParamMouthForm', to: 0.7 }, { id: 'MouthX', to: 0.5 },
      ] },
    // 得救（睁大+微笑+叹气）——3.5s 完整松一口气
    'rescued': { dur: 3.5,
      keys: [
        { id: 'ViewSquash', t: 0, v: 0 }, { id: 'ViewSquash', t: 0.8, v: 0.04 },
        { id: 'ViewSquash', t: 1.2, v: 0.05 }, { id: 'ViewSquash', t: 2.2, v: 0.02 }, { id: 'ViewSquash', t: 3.5, v: 0 },
        { id: 'AngleY', t: 0, v: 12 }, { id: 'AngleY', t: 0.8, v: 7 },
        { id: 'AngleY', t: 1.8, v: -8 }, { id: 'AngleY', t: 2.8, v: -7 }, { id: 'AngleY', t: 3.5, v: 0 },
        { id: 'LeanInput', t: 0, v: 0 }, { id: 'LeanInput', t: 0.8, v: 5 },
        { id: 'LeanInput', t: 1.8, v: -6 }, { id: 'LeanInput', t: 2.8, v: -5 }, { id: 'LeanInput', t: 3.5, v: 0 },
      ],
      params: [
        { id: 'ParamEyeLOpen', to: 1 }, { id: 'ParamEyeROpen', to: 1 }, { id: 'ParamMouthForm', to: 0.7 },
      ] },
    // 警觉（正视站直+皱眉+看左边）——保持型（stand-straight 归位值与 look-left 合并成单 params）
    'alert-combo': { state: true, dur: 1.2, params: [
      { id: 'LeanInput', to: 0 }, { id: 'AngleY', to: 0 }, { id: 'AngleZ', to: 0 },
      { id: 'AngleX', to: 7 }, { id: 'ParamEyeBallX', to: 0.75 },
      { id: 'ParamBrowLY', to: -0.7 }, { id: 'ParamBrowRY', to: -0.7 },
      { id: 'ParamBrowLAngle', to: -0.9 }, { id: 'ParamBrowRAngle', to: -0.9 },
    ] },
    // 跳舞通道版（2026-11-19）：复刻他们家 6 拍摇摆（Body.cs:118-135，用户亲自指导的
    // 「身体左右转、头往相反方向转且晚 0.14 秒、头走小拱形」），拍长 0.53s。
    // 胸腔 Z 是物理输出 → keysPost（物理后写）；kit 原版 act('dance') 的 pulse 组变换/holdFace
    // 对骨骼模型不适用（图片式左右摇晃）→ takeover:true 让 actWord 完整接管（kit act 不再执行）。
    // 挥手双轨版：通道肩摆（不受 pulse 单槽影响）+ kit pulse 组摆并存——
    // Movement1 手型是拿狗尾草的姿势（无正常抬手臂形变），弃用；骨骼值域有限（±10）只做小幅
    'wave': { dur: 1.6,
      waves: [
        { id: 'ShoulderZ', base: 10, amp: 8, freq: 2.5 },
        { id: 'RForearm', amp: 6, freq: 2.5 },
        { id: 'AngleX', amp: 3, freq: 1.25 },
      ] },
    'dance': { takeover: true, dur: 3.4,
      // 连续扭（扭腰同款 postWaves，幅度收敛、频率对拍子 1.9）叠在拍子 keys 上 → 「真的在扭」而不是倾斜
      postWaves: [
        { id: 'ParamBodyAngleZ', amp: 10, freq: 0.94 },
        { id: 'HipAngleX', amp: 12, freq: 0.94, phase: 0.12 },
      ],
      keys: [
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 0.67, v: -9 }, { id: 'AngleZ', t: 1.2, v: 9 },
        { id: 'AngleZ', t: 1.73, v: -9 }, { id: 'AngleZ', t: 2.26, v: 9 }, { id: 'AngleZ', t: 2.79, v: -9 },
        { id: 'AngleZ', t: 3.2, v: 0 },
        { id: 'AngleY', t: 0, v: 0 }, { id: 'AngleY', t: 0.27, v: -6 }, { id: 'AngleY', t: 0.8, v: 6 },
        { id: 'AngleY', t: 1.33, v: -6 }, { id: 'AngleY', t: 1.86, v: 6 }, { id: 'AngleY', t: 2.39, v: -6 },
        { id: 'AngleY', t: 2.92, v: 6 }, { id: 'AngleY', t: 3.2, v: 0 },
        { id: 'ShoulderY', t: 0.53, v: 8 }, { id: 'ShoulderY', t: 0.8, v: 0 },
        { id: 'ShoulderY', t: 1.33, v: 8 }, { id: 'ShoulderY', t: 1.6, v: 0 },
        { id: 'ShoulderY', t: 2.13, v: 8 }, { id: 'ShoulderY', t: 2.4, v: 0 },
      ],
      // 物理驱动线（胸晃/朝向的来源）：PositionX 是唯一「非输出+是输入」的重心参数，
      // 必须**物理前写**（waves）——放 postWaves 物理吃不到；ParamBodyAngleX/Z 都是
      // 物理输出，前写会被当场算回（写了白写）。RZ 物理不读不写，自由驱动整体摆。
      waves: [
        { id: 'PositionX', amp: 14, freq: 0.94 },
        { id: 'ParamBodyAngleRZ', amp: 9, freq: 0.94, phase: 0.06 },
      ],
      keysPost: [
        { id: 'ParamBodyAngleZ', t: 0, v: 0 }, { id: 'ParamBodyAngleZ', t: 0.53, v: 22 },
        { id: 'ParamBodyAngleZ', t: 1.06, v: -22 }, { id: 'ParamBodyAngleZ', t: 1.59, v: 22 },
        { id: 'ParamBodyAngleZ', t: 2.12, v: -22 }, { id: 'ParamBodyAngleZ', t: 2.65, v: 22 },
        { id: 'ParamBodyAngleZ', t: 3.2, v: 0 },
      ] },
    'monocle-face':{ state: true, dur: 1.0, params: [{ id: 'key12', to: 1 }] },
    // —— 原 expressionCombos 的组合，翻译成通道版（2026-11-18 统一，全部可叠+自动放松）——
    // 无语 = 黑脸(key1) + 圈圈眼(key3)，其余眼睛关
    // 无语（2026-11-19 按他们家 Combos 重写：斜眼+抿嘴+微摇头）——
    // 斜眼三参数（REyeSquint/LEyeSquint 0.9 + 眼半开 0.7，Body.cs 斜眼原样）+ 抿嘴 + 微摇头两连——2s
    'speechless': { dur: 2.0,
      keys: [
        { id: 'AngleX', t: 0, v: 0 }, { id: 'AngleX', t: 0.3, v: -8 },
        { id: 'AngleX', t: 0.8, v: 8 }, { id: 'AngleX', t: 1.2, v: -6 },
        { id: 'AngleX', t: 1.6, v: 4 }, { id: 'AngleX', t: 2.0, v: 0 },
      ],
      params: [
        { id: 'REyeSquint', to: 0.9 }, { id: 'LEyeSquint', to: 0.9 },
        { id: 'ParamEyeLOpen', to: 0.7 }, { id: 'ParamEyeROpen', to: 0.7 },
        { id: 'MouthPressLipOpen', to: -1 }, { id: 'ParamMouthForm', to: -0.5 },
      ] },
    // 阴险 = 黑脸(key1) + 屑屑眼(key6)
    'mad': { state: true, dur: 1.0, params: [
      { id: 'key1', to: 1 },
      { id: 'key3', to: 0 }, { id: 'key4', to: 0 }, { id: 'key5', to: 0 }, { id: 'key6', to: 1 },
    ] },
    // 委屈 = 流泪(key2) + 脸红(key7)
    'aggrieved': { state: true, dur: 1.0, params: [
      { id: 'key2', to: 1 }, { id: 'key7', to: 1 },
    ] },
    // 心慌 = 冷汗(key13) + 脸红(key7)（原 guilty 组合）
    'guilty': { state: true, dur: 1.0, params: [
      { id: 'key13', to: 1 }, { id: 'key7', to: 1 },
    ] },

    // —— 日常情绪词通道化（2026-11-19 双轨合并第二步）：【开心】这类词原来走 kit 旧表情槽，
    // 不受通道机制管。现在由源词参数合并成通道配方，actWord 直接接管。
    // 参数全部抄自现有词（笑眼/微笑/睁大/挑眉/八字眉/皱眉/抿嘴/半睁/斜眼），值可直接调。
    'happy':     { state: true, dur: 1.2, params: [
      { id: 'EyeSmile', to: 1 }, { id: 'ParamMouthForm', to: 0.7 },
    ] },
    'surprised': { state: true, dur: 1.2, params: [
      { id: 'ParamEyeLOpen', to: 1 }, { id: 'ParamEyeROpen', to: 1 }, { id: 'EyeSmile', to: 0 },
      { id: 'ParamBrowLY', to: 0.7 }, { id: 'ParamBrowRY', to: 0.7 },
      { id: 'ParamMouthOpenY', to: 0.5 },
    ] },
    'thinking':  { state: true, dur: 1.2, params: [
      { id: 'REyeSquint', to: 1 }, { id: 'LEyeSquint', to: 1 },
      { id: 'ParamEyeLOpen', to: 0.6 }, { id: 'ParamEyeROpen', to: 0.6 },
      { id: 'ParamBrowLY', to: 0.7 }, { id: 'ParamBrowRY', to: 0.7 },
    ] },
    'determined':{ state: true, dur: 1.2, params: [
      { id: 'ParamBrowLY', to: -0.7 }, { id: 'ParamBrowRY', to: -0.7 },
      { id: 'ParamBrowLAngle', to: -0.9 }, { id: 'ParamBrowRAngle', to: -0.9 },
      { id: 'MouthPressLipOpen', to: -1 },
    ] },
    'confused':  { state: true, dur: 1.2, params: [
      { id: 'ParamBrowLY', to: 0.45 }, { id: 'ParamBrowRY', to: 0.45 },
      { id: 'ParamBrowLAngle', to: -0.55 }, { id: 'ParamBrowRAngle', to: -0.55 },
      { id: 'ParamEyeLOpen', to: 0.45 }, { id: 'ParamEyeROpen', to: 0.45 }, { id: 'EyeSmile', to: 0 },
    ] },
    // 生气：黑脸 + 浑身抖动——抖动走 figure.faceShake（渲染组级，对齐 kit fc.shake，
    // 身体+头一起抖），不再用参数级 waves（那只抖头，且和组抖叠加会过头）
    'angry':     { state: true, dur: 1.2, params: [{ id: 'key1', to: 1 }] },
    'scared':    { state: true, dur: 1.2,
      params: [
        { id: 'ParamEyeLOpen', to: 1 }, { id: 'ParamEyeROpen', to: 1 }, { id: 'EyeSmile', to: 0 },
        { id: 'ParamBrowLY', to: 0.45 }, { id: 'ParamBrowRY', to: 0.45 },
        { id: 'ParamBrowLAngle', to: -0.55 }, { id: 'ParamBrowRAngle', to: -0.55 },
        { id: 'ParamMouthOpenY', to: 0.3 },
        { id: 'key13', to: 1 },   // 冷汗（kit 旧脸配方 sweat:true 的对应）
      ] },

    // ── 3.8 俏皮搞怪批（2026-11-20，用户挑的七条）——
    // 全部按他们家组合词的工序做：params 静态部件 + keys 时间轴，keys 与 params 不放同参数。
    // 打哈欠（新组合）：头微仰 + 眉挑起 + 眼慢慢闭上再睁开 + 嘴大张（哈欠是吸气，ViewSquash 负=拉长，
    //   与他们家叹气的吸气段同号）——3.2s 一口气
    'yawn': { dur: 3.2,
      keys: [
        { id: 'AngleY', t: 0, v: 0 }, { id: 'AngleY', t: 0.8, v: 6 },
        { id: 'AngleY', t: 1.4, v: 9 }, { id: 'AngleY', t: 2.4, v: 5 }, { id: 'AngleY', t: 3.2, v: 0 },
        { id: 'BrowInnerUp', t: 0, v: 0 }, { id: 'BrowInnerUp', t: 0.8, v: 0.55 },
        { id: 'BrowInnerUp', t: 1.6, v: 0.35 }, { id: 'BrowInnerUp', t: 3.2, v: 0 },
        { id: 'ParamEyeLOpen', t: 0, v: 1 }, { id: 'ParamEyeLOpen', t: 0.9, v: 0.5 },
        { id: 'ParamEyeLOpen', t: 1.5, v: 0.15 }, { id: 'ParamEyeLOpen', t: 2.3, v: 0.1 }, { id: 'ParamEyeLOpen', t: 3.2, v: 1 },
        { id: 'ParamEyeROpen', t: 0, v: 1 }, { id: 'ParamEyeROpen', t: 0.9, v: 0.5 },
        { id: 'ParamEyeROpen', t: 1.5, v: 0.15 }, { id: 'ParamEyeROpen', t: 2.3, v: 0.1 }, { id: 'ParamEyeROpen', t: 3.2, v: 1 },
        { id: 'ParamMouthOpenY', t: 0.6, v: 0 }, { id: 'ParamMouthOpenY', t: 1.5, v: 0.7 },
        { id: 'ParamMouthOpenY', t: 2.3, v: 0.4 }, { id: 'ParamMouthOpenY', t: 3.0, v: 0 }, { id: 'ParamMouthOpenY', t: 3.2, v: 0 },
        { id: 'JawOpen', t: 0.6, v: 0 }, { id: 'JawOpen', t: 1.5, v: 0.35 },
        { id: 'JawOpen', t: 2.3, v: 0.15 }, { id: 'JawOpen', t: 3.2, v: 0 },
        { id: 'ViewSquash', t: 0, v: 0 }, { id: 'ViewSquash', t: 1.2, v: -0.02 },
        { id: 'ViewSquash', t: 2.0, v: -0.015 }, { id: 'ViewSquash', t: 3.2, v: 0 },
      ],
      params: [] },
    // 打喷嚏（新组合）：蓄力（低头缩一下）→ 爆发（仰头+嘴大张+眼闭紧+眉挑）→ 回落小回弹——1.5s
    'sneeze': { dur: 1.5,
      keys: [
        { id: 'ViewSquash', t: 0, v: 0 }, { id: 'ViewSquash', t: 0.4, v: 0.06 },
        { id: 'ViewSquash', t: 0.6, v: -0.07 }, { id: 'ViewSquash', t: 0.95, v: 0.03 }, { id: 'ViewSquash', t: 1.3, v: 0 }, { id: 'ViewSquash', t: 1.5, v: 0 },
        { id: 'AngleY', t: 0, v: 0 }, { id: 'AngleY', t: 0.4, v: -9 },
        { id: 'AngleY', t: 0.6, v: 11 }, { id: 'AngleY', t: 0.95, v: 5 }, { id: 'AngleY', t: 1.3, v: 0 }, { id: 'AngleY', t: 1.5, v: 0 },
        { id: 'ParamEyeLOpen', t: 0, v: 1 }, { id: 'ParamEyeLOpen', t: 0.4, v: 0 },
        { id: 'ParamEyeLOpen', t: 0.85, v: 0 }, { id: 'ParamEyeLOpen', t: 1.25, v: 1 }, { id: 'ParamEyeLOpen', t: 1.5, v: 1 },
        { id: 'ParamEyeROpen', t: 0, v: 1 }, { id: 'ParamEyeROpen', t: 0.4, v: 0 },
        { id: 'ParamEyeROpen', t: 0.85, v: 0 }, { id: 'ParamEyeROpen', t: 1.25, v: 1 }, { id: 'ParamEyeROpen', t: 1.5, v: 1 },
        { id: 'ParamMouthOpenY', t: 0, v: 0 }, { id: 'ParamMouthOpenY', t: 0.4, v: 0.3 },
        { id: 'ParamMouthOpenY', t: 0.6, v: 0.85 }, { id: 'ParamMouthOpenY', t: 0.95, v: 0.25 }, { id: 'ParamMouthOpenY', t: 1.3, v: 0 }, { id: 'ParamMouthOpenY', t: 1.5, v: 0 },
        { id: 'BrowInnerUp', t: 0, v: 0 }, { id: 'BrowInnerUp', t: 0.6, v: 0.85 },
        { id: 'BrowInnerUp', t: 1.0, v: 0.5 }, { id: 'BrowInnerUp', t: 1.5, v: 0 },
      ],
      params: [] },
    // 狐疑（新组合）：单边挑眉（左挑右不动，一边高一边低才像"嗯？"）+ 斜眼 + 眼珠瞟过去停一拍
    //   + 头微转同方向 + 抿一下嘴——2.4s（:右 走 3.6 镜像，眼珠/头自动换边）
    'suspicious': { dur: 2.4,
      keys: [
        { id: 'ParamEyeBallX', t: 0, v: 0 }, { id: 'ParamEyeBallX', t: 0.5, v: 0.85 },
        { id: 'ParamEyeBallX', t: 1.8, v: 0.85 }, { id: 'ParamEyeBallX', t: 2.4, v: 0 },
        { id: 'AngleX', t: 0, v: 0 }, { id: 'AngleX', t: 0.5, v: 5 },
        { id: 'AngleX', t: 1.8, v: 5 }, { id: 'AngleX', t: 2.4, v: 0 },
        { id: 'ParamBrowLY', t: 0, v: 0 }, { id: 'ParamBrowLY', t: 0.4, v: 0.6 },
        { id: 'ParamBrowLY', t: 2.0, v: 0.6 }, { id: 'ParamBrowLY', t: 2.4, v: 0 },
        { id: 'BrowInnerUp', t: 0, v: 0 }, { id: 'BrowInnerUp', t: 0.4, v: 0.35 },
        { id: 'BrowInnerUp', t: 2.0, v: 0.35 }, { id: 'BrowInnerUp', t: 2.4, v: 0 },
      ],
      params: [
        { id: 'REyeSquint', to: 0.9 }, { id: 'LEyeSquint', to: 0.9 },
        { id: 'ParamEyeLOpen', to: 0.65 }, { id: 'ParamEyeROpen', to: 0.65 },
        { id: 'MouthPressLipOpen', to: -0.4 },
      ] },
    // 吐舌歪头（新组合）：吐舌原样 + 歪头收小（14，舌头当主角）+ 眼睛弯弯——保持型
    'tongue-tilt': { state: true, dur: 1.2, params: [
      { id: 'TongueOut', to: 1 }, { id: 'ParamMouthOpenY', to: 0.35 },
      { id: 'AngleZ', to: 14 },
      { id: 'EyeSmile', to: 0.7 }, { id: 'ParamEyeLOpen', to: 0.6 }, { id: 'ParamEyeROpen', to: 0.6 },
    ] },
    // 眨眼吐舌（新组合，Body.cs:76-77 快眨单眼套件 + 吐舌）：左眼闭 0.76s + 歪头 12 同步
    //   + 舌头跟着出来停一会再收回——1.4s
    'wink-tongue': { dur: 1.4,
      keys: [
        { id: 'ParamEyeLOpen', t: 0, v: 1 }, { id: 'ParamEyeLOpen', t: 0.14, v: 0 },
        { id: 'ParamEyeLOpen', t: 0.9, v: 0 }, { id: 'ParamEyeLOpen', t: 1.4, v: 1 },
        { id: 'ParamEyeROpen', t: 0, v: 1 }, { id: 'ParamEyeROpen', t: 0.14, v: 0.45 },
        { id: 'ParamEyeROpen', t: 0.9, v: 0.45 }, { id: 'ParamEyeROpen', t: 1.4, v: 1 },
        { id: 'EyeSmile', t: 0, v: 0.45 }, { id: 'EyeSmile', t: 0.14, v: 1 },
        { id: 'EyeSmile', t: 0.9, v: 1 }, { id: 'EyeSmile', t: 1.4, v: 0.45 },
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 0.14, v: 12 },
        { id: 'AngleZ', t: 0.9, v: 12 }, { id: 'AngleZ', t: 1.4, v: 0 },
        { id: 'TongueOut', t: 0, v: 0 }, { id: 'TongueOut', t: 0.3, v: 1 },
        { id: 'TongueOut', t: 1.0, v: 1 }, { id: 'TongueOut', t: 1.4, v: 0 },
        { id: 'ParamMouthOpenY', t: 0, v: 0 }, { id: 'ParamMouthOpenY', t: 0.3, v: 0.3 },
        { id: 'ParamMouthOpenY', t: 1.0, v: 0.3 }, { id: 'ParamMouthOpenY', t: 1.4, v: 0 },
      ],
      params: [] },
    // 哼歌（新组合）：嘴形跟着旋律小幅开合 + 重心慢摆（PositionX 物理驱动）+ 头同拍轻点
    //   + 哼歌时眼睛弯弯——4s 一段
    'hum': { dur: 4.0,
      waves: [
        { id: 'ParamMouthForm', amp: 0.3, freq: 0.9, base: 0.3 },
        { id: 'PositionX', amp: 5, freq: 0.45 },
        { id: 'AngleZ', amp: 4, freq: 0.45, phase: 0.12 },
        { id: 'AngleY', amp: 3, freq: 0.9, phase: 0.3 },
      ],
      params: [
        { id: 'EyeSmile', to: 0.8 }, { id: 'ParamEyeLOpen', to: 0.6 }, { id: 'ParamEyeROpen', to: 0.6 },
      ] },
    // 歪眉（新组合）：左眉高右眉低（一高一低才是"嗯?"脸）——保持型
    // ── 4.2 摸后档位（2026-11-20，Behavior.cs 摸后失落/不舍/腻歪/融化 配方照抄转换）——
    // rua 松手 1.5 秒后由后端按档位内部触发（不进 vocab，AI 不直接用）。FaceAngleY/X→AngleY/X 同号、
    // FaceAngleZ→AngleZ 原号、FaceAngleX 摆动反号（他们正=屏幕左，我们正=屏幕右）。脸红一路带到档位里。
    'post-stroke-1': { dur: 3.4,   // 摸后失落：眉毛上挑+抿嘴+瘪嘴+眼神下垂，头轻轻摆
      keys: [
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 0.5, v: 3 }, { id: 'AngleZ', t: 1.3, v: -2 },
        { id: 'AngleZ', t: 2.1, v: 3 }, { id: 'AngleZ', t: 3.4, v: 0 },
        { id: 'ViewSquash', t: 0.3, v: 0.004 }, { id: 'ViewSquash', t: 2.8, v: 0.004 }, { id: 'ViewSquash', t: 3.4, v: 0 },
      ],
      params: [
        { id: 'key7', to: 1 }, { id: 'BrowInnerUp', to: 0.7 }, { id: 'MouthPressLipOpen', to: 0.3 },
        { id: 'ParamMouthForm', to: -0.1 }, { id: 'ParamEyeBallY', to: -0.4 }, { id: 'AngleY', to: -5 }, { id: 'AngleZ', to: 4 },
      ] },
    'post-stroke-2': { dur: 4,   // 摸后不舍：笑意没退+八字眉+眼神下垂，身体前倾 -9 又不舍得走
      keys: [
        { id: 'LeanInput', t: 0, v: 0 }, { id: 'LeanInput', t: 0.5, v: -9 }, { id: 'LeanInput', t: 3.3, v: -8 }, { id: 'LeanInput', t: 4, v: 0 },
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 0.7, v: 3 }, { id: 'AngleZ', t: 1.5, v: -3 },
        { id: 'AngleZ', t: 2.3, v: 3 }, { id: 'AngleZ', t: 3.1, v: -2 }, { id: 'AngleZ', t: 4, v: 0 },
        { id: 'ViewSquash', t: 0.4, v: 0.02 }, { id: 'ViewSquash', t: 3.4, v: 0.02 }, { id: 'ViewSquash', t: 4, v: 0 },
      ],
      params: [
        { id: 'key7', to: 1 }, { id: 'EyeSmile', to: 0.45 }, { id: 'BrowInnerUp', to: 0.9 },
        { id: 'MouthPressLipOpen', to: 0.5 }, { id: 'ParamMouthForm', to: 0.2 },
        { id: 'ParamEyeBallY', to: -0.45 }, { id: 'AngleY', to: -8 }, { id: 'AngleZ', to: 7 },
      ] },
    'post-stroke-3': { dur: 4.8,   // 摸后腻歪：笑得合不拢嘴+身体前倾 -15+头身轻轻摆+举手抚胸
      keys: [
        { id: 'LeanInput', t: 0, v: 0 }, { id: 'LeanInput', t: 0.5, v: -15 }, { id: 'LeanInput', t: 3.9, v: -14 }, { id: 'LeanInput', t: 4.8, v: 0 },
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 0.8, v: 3 }, { id: 'AngleZ', t: 1.6, v: -3 },
        { id: 'AngleZ', t: 2.4, v: 3 }, { id: 'AngleZ', t: 3.2, v: -3 }, { id: 'AngleZ', t: 4, v: 2 }, { id: 'AngleZ', t: 4.8, v: 0 },
        { id: 'AngleX', t: 0, v: 0 }, { id: 'AngleX', t: 0.8, v: 4 }, { id: 'AngleX', t: 1.8, v: -4 },
        { id: 'AngleX', t: 2.8, v: 4 }, { id: 'AngleX', t: 3.8, v: -3 }, { id: 'AngleX', t: 4.8, v: 0 },
        { id: 'ViewSquash', t: 0.5, v: 0.03 }, { id: 'ViewSquash', t: 4.1, v: 0.03 }, { id: 'ViewSquash', t: 4.8, v: 0 },
        // 举手抚胸 = raise(0~1.13s 入场含回弹) + 保持 + lower(3.78~4.8s 收手含回弹)，原厂时间轴平移拼接
        { id: 'Movement2', t: 0, v: 0 }, { id: 'Movement2', t: 0.32, v: 0 }, { id: 'Movement2', t: 0.33, v: 1 },
        { id: 'Movement2', t: 4.31, v: 1 }, { id: 'Movement2', t: 4.33, v: 0 }, { id: 'Movement2', t: 4.8, v: 0 },
        { id: 'Param56', t: 0, v: 1 }, { id: 'Param56', t: 4.8, v: 1 },
        { id: 'Param62', t: 0, v: 0 }, { id: 'Param62', t: 0.77, v: 0.034 }, { id: 'Param62', t: 4.6, v: -0.03 }, { id: 'Param62', t: 4.8, v: 0 },
        { id: 'Param59', t: 0, v: 0 }, { id: 'Param59', t: 0.03, v: 0 }, { id: 'Param59', t: 0.80, v: 0.516 }, { id: 'Param59', t: 1.10, v: 0.476 },
        { id: 'Param59', t: 3.78, v: 0.476 }, { id: 'Param59', t: 4.6, v: -0.048 }, { id: 'Param59', t: 4.8, v: 0 },
        { id: 'Param60', t: 0, v: 0 }, { id: 'Param60', t: 0.07, v: 0 }, { id: 'Param60', t: 0.83, v: 0.88 }, { id: 'Param60', t: 1.13, v: 0.86 },
        { id: 'Param60', t: 3.78, v: 0.86 }, { id: 'Param60', t: 4.6, v: -0.008 }, { id: 'Param60', t: 4.8, v: 0 },
        { id: 'Param61', t: 0, v: 0 }, { id: 'Param61', t: 0.08, v: 0 }, { id: 'Param61', t: 0.85, v: 0.2 }, { id: 'Param61', t: 1.13, v: 0.002 },
        { id: 'Param61', t: 3.78, v: 0 }, { id: 'Param61', t: 4.6, v: 0.062 }, { id: 'Param61', t: 4.8, v: 0.001 },
      ],
      params: [
        { id: 'key7', to: 1 }, { id: 'EyeSmile', to: 0.6 }, { id: 'ParamMouthForm', to: 1 },
        { id: 'MouthPressLipOpen', to: 0.4 }, { id: 'BrowInnerUp', to: 0.6 },
        { id: 'AngleY', to: -6 }, { id: 'AngleZ', to: 9 },
      ] },
    'post-stroke-4': { dur: 6,   // 摸后融化：前倾按住 -16 慢慢回+快眨两下眼+举手抚胸——20 秒彩蛋
      keys: [
        { id: 'LeanInput', t: 0, v: 0 }, { id: 'LeanInput', t: 0.8, v: -16 }, { id: 'LeanInput', t: 4.8, v: -16 }, { id: 'LeanInput', t: 6, v: 0 },
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 0.8, v: 5 }, { id: 'AngleZ', t: 2, v: -2 },
        { id: 'AngleZ', t: 3.6, v: 3 }, { id: 'AngleZ', t: 6, v: 0 },
        { id: 'AngleX', t: 0, v: 0 }, { id: 'AngleX', t: 0.7, v: 3 }, { id: 'AngleX', t: 2.2, v: -2 },
        { id: 'AngleX', t: 3.8, v: 2 }, { id: 'AngleX', t: 6, v: 0 },
        { id: 'ParamEyeLOpen', t: 0.2, v: -1 }, { id: 'ParamEyeLOpen', t: 0.28, v: -0.2 }, { id: 'ParamEyeLOpen', t: 0.45, v: 0 },
        { id: 'ParamEyeLOpen', t: 0.95, v: -1 }, { id: 'ParamEyeLOpen', t: 1.03, v: -0.2 }, { id: 'ParamEyeLOpen', t: 1.2, v: 0 }, { id: 'ParamEyeLOpen', t: 6, v: 0 },
        { id: 'ParamEyeROpen', t: 0.2, v: -1 }, { id: 'ParamEyeROpen', t: 0.28, v: -0.2 }, { id: 'ParamEyeROpen', t: 0.45, v: 0 },
        { id: 'ParamEyeROpen', t: 0.95, v: -1 }, { id: 'ParamEyeROpen', t: 1.03, v: -0.2 }, { id: 'ParamEyeROpen', t: 1.2, v: 0 }, { id: 'ParamEyeROpen', t: 6, v: 0 },
        { id: 'ViewSquash', t: 0.6, v: 0.02 }, { id: 'ViewSquash', t: 5.2, v: 0.02 }, { id: 'ViewSquash', t: 6, v: 0 },
        // 举手抚胸 = raise(0~1.13s) + 保持 + lower(4.98~6s)，原厂时间轴
        { id: 'Movement2', t: 0, v: 0 }, { id: 'Movement2', t: 0.32, v: 0 }, { id: 'Movement2', t: 0.33, v: 1 },
        { id: 'Movement2', t: 5.51, v: 1 }, { id: 'Movement2', t: 5.53, v: 0 }, { id: 'Movement2', t: 6, v: 0 },
        { id: 'Param56', t: 0, v: 1 }, { id: 'Param56', t: 6, v: 1 },
        { id: 'Param62', t: 0, v: 0 }, { id: 'Param62', t: 0.77, v: 0.034 }, { id: 'Param62', t: 5.8, v: -0.03 }, { id: 'Param62', t: 6, v: 0 },
        { id: 'Param59', t: 0, v: 0 }, { id: 'Param59', t: 0.03, v: 0 }, { id: 'Param59', t: 0.80, v: 0.516 }, { id: 'Param59', t: 1.10, v: 0.476 },
        { id: 'Param59', t: 4.98, v: 0.476 }, { id: 'Param59', t: 5.8, v: -0.048 }, { id: 'Param59', t: 6, v: 0 },
        { id: 'Param60', t: 0, v: 0 }, { id: 'Param60', t: 0.07, v: 0 }, { id: 'Param60', t: 0.83, v: 0.88 }, { id: 'Param60', t: 1.13, v: 0.86 },
        { id: 'Param60', t: 4.98, v: 0.86 }, { id: 'Param60', t: 5.8, v: -0.008 }, { id: 'Param60', t: 6, v: 0 },
        { id: 'Param61', t: 0, v: 0 }, { id: 'Param61', t: 0.08, v: 0 }, { id: 'Param61', t: 0.85, v: 0.2 }, { id: 'Param61', t: 1.13, v: 0.002 },
        { id: 'Param61', t: 4.98, v: 0 }, { id: 'Param61', t: 5.8, v: 0.062 }, { id: 'Param61', t: 6, v: 0.001 },
      ],
      params: [
        { id: 'key7', to: 1 }, { id: 'EyeSmile', to: 0.55 }, { id: 'ParamMouthForm', to: 0.9 },
        { id: 'MouthPressLipOpen', to: 0.35 }, { id: 'BrowInnerUp', to: 0.5 },
        { id: 'AngleY', to: -4 }, { id: 'AngleZ', to: 4 },
      ] },
    'brow-tilt': { state: true, dur: 1.0, params: [
      { id: 'ParamBrowLY', to: 0.7 }, { id: 'ParamBrowRY', to: -0.45 },
    ] },
    // 歪头瞧（2026-11-20 用户测试反馈：闲时歪头要放缓、幅度减半、歪过去和歪回来感觉不一样）：
    // 歪过去 0.7s 干脆地歪到 16 度再回落 settle 到 14（一点弹性）→ 停住瞧 1.2s → 1.6s 慢慢歪回来
    // （回正是歪过去时间的两倍，渐渐回正）——一次性 3.8s。对话保持型 tilt（28 度）不动。
    'tilt-look': { dur: 3.8,
      keys: [
        { id: 'AngleZ', t: 0, v: 0 }, { id: 'AngleZ', t: 0.7, v: 16 }, { id: 'AngleZ', t: 1.0, v: 14 },
        { id: 'AngleZ', t: 2.2, v: 14 }, { id: 'AngleZ', t: 3.8, v: 0 },
      ],
      params: [] },
  },

  // 互斥组：组内一个词激活时，同组其他词自动让位（参数撤掉）。
  // 「整脸大件」互斥——黑脸/圈圈眼/爱心眼/紧闭眼/屑屑眼/加载/钢盆/无语/阴险都是
  // 换脸级的表达，叠加会怪；流泪/冷汗/脸红/兔牙是"附加层"，不进组（叠加合理）。
  exclusiveGroups: {
    'face-big': ['dark-face', 'circle-eyes', 'heart-eyes', 'xx-eyes', 'wry-face', 'loading-face', 'pan-face', 'speechless', 'mad', 'aggrieved', 'guilty', 'bitter-smile', 'holding-up', 'guilty-look', 'act-cute', 'defiant', 'holding-tears', 'smug-face', 'perfunctory',
      // 日常情绪词通道化后进组：一个情绪一次一张脸（【开心】顶掉【害羞】从这里生效）
      'blush', 'tears', 'sweat', 'happy', 'surprised', 'scared', 'thinking', 'determined', 'confused',
      // 组合情绪脸（2026-11-20 用户定：大跨度情绪脸该互斥，偷笑+感动叠加太怪）——
      // state 词（傻眼/感动/警觉/犯困）每句让位；非 state 的表演词（偷笑/得瑟/抓狂…）
      // 被新情绪触发时中途让位（情绪换情绪语义）
      'happy-burst', 'snicker', 'dumbstruck', 'gloating', 'frantic', 'drowsy-combo', 'touched', 'sly-idea', 'rescued', 'alert-combo',
      // 3.8 狐疑：整脸级的"嗯？"（斜眼+单边挑眉+抿嘴），跟别的情绪脸叠加会怪
      'suspicious'],
  },


  // face → 通道词（2026-11-18 双轨合并：exp3 机制退役，联动走通道，享受互斥/放松/beat 全套机制）
  // happy/excited 不映射（开心 = 中性脸 + roles 配方，无部件效果）
  faceWords: {
    love: 'heart-eyes',
    shy: 'blush', flustered: 'blush',
    sad: 'tears', cry: 'tears',
    worried: 'sweat',
  },

  // 情绪弧度映射（2026-11-19）：词 id → expression 弧度表的名字。
  // expression 表（单数）是按 face 驱动的眉眼嘴"脸型弧度"配方（第三套系统的活着的部分）——
  // 通道化后 frame.face 恒为 neutral，弧度全灭；现在通道条目打 emo 标记，
  // applyFrame 扫描通道取情绪名喂给弧度引擎，条目退场弧度自动消失。
  emotionArc: {
    blush: 'shy', tears: 'sad', sweat: 'worried', 'heart-eyes': 'love',
    'smug-face': 'smug', guilty: 'flustered', 'mouth-pout': 'pout', 'eye-half': 'sleepy',
    angry: 'angry', happy: 'happy', excited: 'excited', surprised: 'surprised',
    scared: 'scared', thinking: 'thinking', determined: 'determined', confused: 'confused',
  },


  // 简易模式不播 motion，但 motion 里的 PartOpacity 是“中性姿势”的一部分：
  // 少了它，hiyori 这类模型会同时显示 PartArmA / PartArmB（四只手）。
  parts: { base: {} },
  // 多轴方案：figure.json 的 axes 选中项会拼成 scheme，这里声明每个选项要写死的参数。
  // 关闭态也要显式写 0，否则从"打开"切回"默认"时旧值会留在参数里。
  schemes: {
    // 每个选项都要把受控参数写全：切回不带配件的选项时，旧值必须显式归零，
    // 否则参数会停留在上一次的状态（模型不会自己复位）。
    body: {
      default: { params: { Clothes2: 0 } },
      type1: { fit: { zoom: 1.449, offset: [0, -0.992], autoFit: false }, params: { Clothes2: 0.4 } },
      type2: { fit: { zoom: 3.97, offset: [0, -5.0], autoFit: false }, params: { Clothes2: 1 } },
    },

    shake: { dur: 1.34,
      // 两连摇头（Body.cs:103 Repeat 展开）：左 -11 停顿右 11，再一轮
      keys: [
        { id: 'AngleX', t: 0, v: 0 }, { id: 'AngleX', t: 0.17, v: -11 }, { id: 'AngleX', t: 0.45, v: 11 },
        { id: 'AngleX', t: 0.73, v: -11 }, { id: 'AngleX', t: 1.01, v: 11 }, { id: 'AngleX', t: 1.34, v: 0 },
      ] },
    // 跳舞：腰扭 + 头摆 + 歪头 + 身体前后，四条不同频率叠起来才像在跳
    // 扭腰：腰 + 头 + 歪头 + 身体前后，四条不同频率叠起来才像在跳
    // （不能叫 dance：kit 里 dance 走 setMode，不给 pulse，拿不到进度）
    wiggle: {
      dur: 3.6,
      waves: [
        { id: 'ParamBodyAngleZ', amp: 17, freq: 2 },
        { id: 'AngleZ', amp: 11, freq: 2, phase: 0.12 },
        { id: 'AngleX', amp: 9, freq: 1, phase: 0.35 },
        { id: 'LeanInput', amp: -9, freq: 2, phase: 0.25 },
      ],
    },
    tilt:        { params: [{ id: 'AngleZ', to: 28 }] },

    // —— 波形动作（连续摆动）——
    // 点头：头上下点几下
    nod:   { dur: 1.06,
      // 两连点头（Body.cs:102 Repeat 展开）：点到 -10 停顿回 1，再点一次——顿挫感
      keys: [
        { id: 'AngleY', t: 0, v: 0 }, { id: 'AngleY', t: 0.17, v: -10 }, { id: 'AngleY', t: 0.4, v: 1 },
        { id: 'AngleY', t: 0.63, v: -10 }, { id: 'AngleY', t: 0.86, v: 1 }, { id: 'AngleY', t: 1.06, v: 0 },
      ] },
    // 摇头：头左右摇
    shake: { dur: 1.34,
      // 两连摇头（Body.cs:103 Repeat 展开）：左 -11 停顿右 11，再一轮
      keys: [
        { id: 'AngleX', t: 0, v: 0 }, { id: 'AngleX', t: 0.17, v: -11 }, { id: 'AngleX', t: 0.45, v: 11 },
        { id: 'AngleX', t: 0.73, v: -11 }, { id: 'AngleX', t: 1.01, v: 11 }, { id: 'AngleX', t: 1.34, v: 0 },
      ] },
    // 跳舞：腰扭 + 头摆 + 歪头 + 身体前后，四条不同频率叠起来才像在跳
    // 扭腰：腰 + 头 + 歪头 + 身体前后，四条不同频率叠起来才像在跳
    // （不能叫 dance：kit 里 dance 走 setMode，不给 pulse，拿不到进度）
    wiggle: {
      dur: 3.6,
      waves: [
        { id: 'ParamBodyAngleZ', amp: 17, freq: 2 },
        { id: 'AngleZ', amp: 11, freq: 2, phase: 0.12 },
        { id: 'AngleX', amp: 9, freq: 1, phase: 0.35 },
        { id: 'LeanInput', amp: -9, freq: 2, phase: 0.25 },
      ],
    },
    'wiggle': {
      dur: 3.6,
      // 腰的左右摆：物理输出参数，postWaves 必须写在 physics.evaluate() 之后
      postWaves: [
        { id: 'ParamBodyAngleZ', amp: 13, freq: 0.7 },
        { id: 'HipAngleX', amp: 11, freq: 0.7, phase: 0.12 },
        { id: 'HipAngleZ', amp: 8, freq: 0.7, phase: 0.15 },
        { id: 'ParamBodyAngleRZ', amp: 7, freq: 0.7, phase: 0.06 },
      ],
      waves: [
        { id: 'ParamBodyAngleZ', amp: 8, freq: 0.7 },
        { id: 'AngleZ', amp: 6, freq: 0.7, phase: 0.12 },
        { id: 'AngleX', amp: 4, freq: 0.35, phase: 0.35 },
        { id: 'LeanInput', amp: -3, freq: 0.7, phase: 0.25 },
      ],
    },
    'bitter-smile': { state: true, dur: 1.2, params: [
      { id: 'ParamMouthForm', to: 0.7 },
      { id: 'ParamBrowLY', to: 0.45 }, { id: 'ParamBrowRY', to: 0.45 },
      { id: 'ParamBrowLAngle', to: -0.55 }, { id: 'ParamBrowRAngle', to: -0.55 },
    ] },
    'holding-up': { state: true, dur: 1.2, params: [
      { id: 'ParamMouthForm', to: 0.7 },
      { id: 'ParamBrowLY', to: 0.45 }, { id: 'ParamBrowRY', to: 0.45 },
      { id: 'ParamBrowLAngle', to: -0.55 }, { id: 'ParamBrowRAngle', to: -0.55 },
      { id: 'key7', to: 1 },
    ] },
    'guilty-look': { state: true, dur: 1.2, params: [
      { id: 'ParamEyeLOpen', to: 0.45 }, { id: 'ParamEyeROpen', to: 0.45 }, { id: 'EyeSmile', to: 0 },
      { id: 'ParamBrowLY', to: 0.45 }, { id: 'ParamBrowRY', to: 0.45 },
      { id: 'ParamBrowLAngle', to: -0.55 }, { id: 'ParamBrowRAngle', to: -0.55 },
      { id: 'key7', to: 1 }, { id: 'ParamMouthForm', to: -0.6 },
    ] },
    'act-cute': { state: true, dur: 1.2, params: [
      { id: 'EyeSmile', to: 1 }, { id: 'ParamMouthForm', to: -0.6 }, { id: 'key7', to: 1 },
    ] },
    'defiant': { state: true, dur: 1.2, params: [
      { id: 'ParamBrowLY', to: -0.7 }, { id: 'ParamBrowRY', to: -0.7 },
      { id: 'ParamBrowLAngle', to: -0.9 }, { id: 'ParamBrowRAngle', to: -0.9 },
      { id: 'ParamMouthForm', to: -0.6 },
      { id: 'ParamEyeLOpen', to: 0.45 }, { id: 'ParamEyeROpen', to: 0.45 }, { id: 'EyeSmile', to: 0 },
    ] },
    'holding-tears': { state: true, dur: 1.2, params: [
      { id: 'ParamEyeLOpen', to: 1 }, { id: 'ParamEyeROpen', to: 1 }, { id: 'EyeSmile', to: 0 },
      { id: 'ParamBrowLY', to: 0.45 }, { id: 'ParamBrowRY', to: 0.45 },
      { id: 'ParamBrowLAngle', to: -0.55 }, { id: 'ParamBrowRAngle', to: -0.55 },
      { id: 'ParamMouthForm', to: -0.6 },
    ] },
    'smug-face': { state: true, dur: 1.2, params: [
      { id: 'EyeSmile', to: 1 },
      { id: 'ParamBrowLY', to: 0.7 }, { id: 'ParamBrowRY', to: 0.7 },
      { id: 'ParamBrowLAngle', to: 0 }, { id: 'ParamBrowRAngle', to: 0 },
      { id: 'ParamMouthForm', to: 0.7 },
    ] },
    'perfunctory': { state: true, dur: 1.2, params: [
      { id: 'ParamEyeLOpen', to: 0.45 }, { id: 'ParamEyeROpen', to: 0.45 }, { id: 'EyeSmile', to: 0 },
      { id: 'ParamMouthForm', to: 0.7 },
    ] },
    'circle-eyes': { state: true, dur: 1.0, params: [
      { id: 'key3', to: 1 }, { id: 'key4', to: 0 }, { id: 'key5', to: 0 }, { id: 'key6', to: 0 },
    ] },
    'heart-eyes':  { state: true, dur: 1.0, params: [
      { id: 'key3', to: 0 }, { id: 'key4', to: 1 }, { id: 'key5', to: 0 }, { id: 'key6', to: 0 },
    ] },
    'xx-eyes':     { state: true, dur: 1.0, params: [
      { id: 'key3', to: 0 }, { id: 'key4', to: 0 }, { id: 'key5', to: 1 }, { id: 'key6', to: 0 },
    ] },
    'wry-face':    { state: true, dur: 1.0, params: [
      { id: 'key3', to: 0 }, { id: 'key4', to: 0 }, { id: 'key5', to: 0 }, { id: 'key6', to: 1 },
    ] },
    'dark-face':   { state: true, dur: 1.0, params: [{ id: 'key1', to: 1 }] },
    'tears':       { state: true, dur: 1.0, params: [{ id: 'key2', to: 1 }] },
    'loading-face':{ state: true, dur: 1.0, params: [{ id: 'key8', to: 1 }] },
    'bunny-teeth': { state: true, dur: 1.0, params: [{ id: 'key9', to: 1 }] },
    'pan-face':    { state: true, dur: 1.0, params: [{ id: 'key10', to: 1 }] },
    'glasses-face':{ state: true, dur: 1.0, params: [{ id: 'key11', to: 1 }] },
    'monocle-face':{ state: true, dur: 1.0, params: [{ id: 'key12', to: 1 }] },

  },



  // 简易模式不播 motion，但 motion 里的 PartOpacity 是“中性姿势”的一部分：
  // 少了它，hiyori 这类模型会同时显示 PartArmA / PartArmB（四只手）。
  parts: { base: {} },
  // 多轴方案：figure.json 的 axes 选中项会拼成 scheme，这里声明每个选项要写死的参数。
  // 关闭态也要显式写 0，否则从"打开"切回"默认"时旧值会留在参数里。
  schemes: {
    // 每个选项只写"自己这根轴"控制的参数，绝不能交叉写别的轴 ——
    // resolveScheme 是多轴 Object.assign 合并，写了别人的参数就会把别人的选择覆盖掉。
    // 顺序必须和 figure.json 的 axes 顺序一致（按位置取 token）。
    body: {
      default: { params: { Clothes2: 0 } },
      type1: { fit: { zoom: 1.449, offset: [0, -0.992], autoFit: false }, params: { Clothes2: 0.4 } },
      type2: { fit: { zoom: 3.97, offset: [0, -5.0], autoFit: false }, params: { Clothes2: 1 } },
    },
    outfit: {
      // Clothes1：0=长裙 1=短裙（模型自带默认是 1，所以默认项要显式写 0）
      default: { params: { Clothes1: 0 } },
      long:    { params: { Clothes1: 0 } },
      short:   { params: { Clothes1: 1 } },
    },
    // 下面这些轴的参数对应关系是从插件生成的包（native-library.json）里读出来的：
    //   脱鞋 Clothes4=1 / 钢盆 key10=1 / 胸口上拉 Clothes3=1 /
    //   尾巴关 Clothes5=0（默认 1 是有尾巴）/ 黑框 key11=1 / 单片 key12=1
    shoe: {
      default: { params: { Clothes4: 0 } },
      off:     { params: { Clothes4: 1 } },
    },
    pan: {
      default: { params: { key10: 0 } },
      on:      { params: { key10: 1 } },
    },
    chest: {
      default: { params: { Clothes3: 0 } },
      up:      { params: { Clothes3: 1 } },
    },
    tail: {
      default: { params: { Clothes5: 1 } },
      off:     { params: { Clothes5: 0 } },
    },
    // 眼镜合成一根轴：黑框和单片互斥，避免同一只眼睛叠两副
    glasses: {
      default: { params: { key11: 0, key12: 0 } },
      black:   { params: { key11: 1, key12: 0 } },
      monocle: { params: { key11: 0, key12: 1 } },
    },
  },
  roles: {
    eyeOpen: {"targets":["ParamEyeLOpen","ParamEyeROpen"],"space":[0,1],"default":1},
    browY: {"targets":["ParamBrowLY","ParamBrowRY"],"space":[-1,1],"default":0},
    browAngle: {"targets":["ParamBrowLAngle","ParamBrowRAngle"],"space":[-1,1],"default":0},
    eyeSmile: {"targets":["EyeSmile"],"space":[0,1],"default":0},
    mouthOpen: {"targets":["ParamMouthOpenY"],"space":[0,1],"default":0},
    mouthForm: {"targets":["ParamMouthForm"],"space":[-1,1],"default":0},
    eyeBallX: {"targets":["ParamEyeBallX"],"space":[-1,1],"default":0},
    eyeBallY: {"targets":["ParamEyeBallY"],"space":[-1,1],"default":0},
    // 只写模型自己的 AngleX。ParamAngleX 是物理的输入，写了物理会拿头部角度去推身体，
    // 和我们用 PositionX 做的身体倾斜抢方向 —— 插件生成的包也是只写 AngleX。
    angleX: {"targets":["AngleX"],"space":[-1,1],"default":0},
    angleY: {"targets":["AngleY"],"space":[-1,1],"default":0},
    angleZ: {"targets":["AngleZ"],"space":[-1,1],"default":0},
    // bodyX 是横向重心（物理输入）。lean 是前倾，单独走 LeanInput —— 两者别混用，
    // 混用会让"往左走"和"前倾"挤在同一个参数上，身体被推错方向。
    bodyX: {"targets":["PositionX"],"space":[-1,1],"default":0},
    lean:  {"targets":["LeanInput"],"space":[-1,1],"default":0},
    breath: {"targets":["ParamBreath"],"space":[0,1],"default":0},
  },
  expression: {
    happy: {"eyeSmile":1,"browY":0.35,"mouthForm":0.8},
    wink: {"eyeSmile":0.7,"browY":0.2,"mouthForm":0.4},
    love: {"browY":0.3,"mouthForm":0.6},
    shy: {"browY":0.45,"mouthForm":0.1},
    surprised: {"browY":0.8,"browAngle":1,"mouthOpen":0.45,"mouthForm":0.25},
    angry: {"browY":-0.75,"browAngle":-1,"mouthForm":-0.6},
    sad: {"browY":0.5,"browAngle":-0.4,"mouthForm":-0.7},
    sleepy: {"eyeOpen":0.45,"browY":0.1,"mouthForm":0.05},
    thinking: {"browY":-0.2,"mouthForm":-0.15},
    smug: {"browY":-0.25,"mouthForm":0.35},
    pout: {"browY":0.3,"mouthForm":-0.45},
    worried: {"browY":0.55,"browAngle":-0.5,"mouthForm":-0.35},
    determined: {"browY":-0.5,"browAngle":0.6,"mouthForm":-0.1},
    flustered: {"browY":0.7,"mouthForm":0.1},
    scared: {"browY":0.75,"browAngle":1,"mouthOpen":0.3,"mouthForm":-0.5},
    excited: {"browY":0.5,"mouthForm":0.6},
    cry: {"browY":0.6,"browAngle":-0.6,"mouthForm":-0.75},
    confused: {"browY":0.25,"browAngle":0.3,"mouthForm":-0.2},
  },
  // 表演层（SoulLink）：情绪词 → 连续参数。不写就用通用默认；
  // 换模型先调这里（强度/过渡），不要改 backends/ 里的渲染代码。
  performance: {
  "tuning": {
    "style": "natural",
    "bodyGain": 1.8,
    "gain": 1.15,
    "accentGain": 0.75
  }
},
};
