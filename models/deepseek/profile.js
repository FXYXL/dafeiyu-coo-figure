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
  expressionCombos: {
    'aggrieved':  ['tears', 'blush'],    // 委屈：流泪 + 脸红
    'speechless': ['dark', 'dizzy'],     // 无语：黑脸 + 圈圈眼
    'mad':        ['dark', 'smug'],      // 生气：黑脸 + 屑屑眼
    'guilty':     ['sweat', 'blush'],    // 心虚：流冷汗 + 脸红
  },

  extraExpressions: {
    // 键名会被当作可写的词，必须符合 Coo 的 id 规则（小写字母/数字/连字符）
    'circle-eyes': 'dizzy',    // 圈圈眼
    'dark-face': 'dark',       // 黑脸
    'wry-face': 'smug',        // 屑屑眼
    'glasses-face': 'glasses', // 黑框眼镜
    'monocle-face': 'monocle', // 单片眼镜
    'pan-face': 'pan',         // 钢盆
    'loading-face': 'loading', // 加载中（原皮 key8）
    'aggrieved': 'aggrieved',   // 委屈（流泪+脸红）
    'speechless': 'speechless', // 无语（黑脸+圈圈眼）
    'mad': 'mad',               // 生气（黑脸+屑屑眼）
    'guilty': 'guilty',         // 心虚（冷汗+脸红）
  },
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

  // 待机时会随机切到这些手臂姿势（1=狗尾草 2=抚胸 3=竖食指），每次 4 秒。
  // 对应 VTS 的 Auto Idle：闲置久了就自己换个手势，不然一直一个姿势很死。
  idlePoses: [2, 3],

  idlePhysics: {
    // 只写"源头参数"。ParamBodyAngleX / HipAngleX / ParamBodyAngleZ 本身是物理的
    // 输出，写进去会被下一步覆盖（这也是它们一直读回 0 的原因）。
    // 链条：PositionX → ParamBodyAngleX → 胸/裙；PositionX+Z → HipAngleX → 裙摆层；
    //       PositionY → 胸/裙的下垂；ParamBreath → 胸起伏。
    ParamBreath: { hz: 0.25, amp: 0.45, base: 0.5 },
    PositionZ:   { hz: 0.09, amp: 2.4, phase: 0.3 },
    PositionY:   { hz: 0.17, amp: 1.6, phase: 0.4 },
  },

  paramActs: {
    // —— 静态姿态（进入 → 保持 → 退出）——
    // 探身贴近镜头：负值往前靠，物理会联动身体透视（最像 VTS 里的前倾）
    'lean-in':   { params: [{ id: 'LeanInput', to: -30 }] },
    'lean-back': { params: [{ id: 'LeanInput', to: 30 }] },
    // 探身鞠躬：上半身真的往前压，配合 kit 自带的闭眼
    bow:         { params: [{ id: 'LeanInput', to: -24 }] },
    // 侧身：身体侧转 + 头跟着转一点，单靠身体参数幅度太小吃不出来
    side:        { params: [{ id: 'ParamBodyAngleZ', to: 30 }, { id: 'AngleX', to: 12 }, { id: 'AngleZ', to: 6 }] },
    // 斜着凑近：前倾 + 侧身 + 歪头
    peek:        { params: [{ id: 'LeanInput', to: -22 }, { id: 'ParamBodyAngleZ', to: 18 }, { id: 'AngleZ', to: 10 }] },
    // —— 手臂姿势（模型自带的三只"备用手"）——
    // Movement1/2/3 不是骨骼，是"切换哪只手显示"的开关：
    // 1=狗尾草、2=抚胸、3=竖食指。参数一开，对应手臂就替换掉默认手。
    // 必须把另外两个显式归零，否则切回来时会叠在一起。
    'finger-point': { dur: 4, params: [{ id: 'Movement1', to: 0 }, { id: 'Movement2', to: 0 }, { id: 'Movement3', to: 1 }] },
    'chest-hand':   { dur: 4, params: [{ id: 'Movement1', to: 0 }, { id: 'Movement2', to: 1 }, { id: 'Movement3', to: 0 }] },
    'grass-hand':   { dur: 4, params: [{ id: 'Movement1', to: 1 }, { id: 'Movement2', to: 0 }, { id: 'Movement3', to: 0 }] },

    // —— 脸部小动作（参数直驱，实测鼓腮最明显）——
    'puff-cheek': { dur: 3, params: [{ id: 'CheeckPuff', to: 1 }] },
    'pout-lips':  { dur: 3, params: [{ id: 'Mouthpucker', to: 1 }] },
    'dazed':      { dur: 4, params: [{ id: 'Param11', to: 6 }] },

    // 歪头
    tilt:        { params: [{ id: 'AngleZ', to: 28 }] },

    // —— 波形动作（连续摆动）——
    // 点头：头上下点几下
    nod:   { dur: 0.7, waves: [{ id: 'AngleY', amp: 9, freq: 2.5, base: -4 }] },   // kit 的 nod 只有 0.7 秒；base 偏低才像点头而非仰头
    // 摇头：头左右摇
    shake: { dur: 0.7, waves: [{ id: 'AngleX', amp: 15, freq: 2 }] },
    // 跳舞：腰扭 + 头摆 + 歪头 + 身体前后，四条不同频率叠起来才像在跳
    // 扭腰：腰 + 头 + 歪头 + 身体前后，四条不同频率叠起来才像在跳
    // （不能叫 dance：kit 里 dance 走 setMode，不给 pulse，拿不到进度）
    wiggle: {
      dur: 3.6,
      // 腰的左右摆：ParamBodyAngleZ / HipAngleZ 是物理的**输出**参数，
      // 写在物理前面会被当场算回 0（这就是之前"腰没动、只剩前后晃"的原因）。
      // postWaves 放在 physics.evaluate() 之后写，才是当帧最终值。
      postWaves: [
        // 胸腔先动，盆骨慢半拍跟上（从腰往上带的感觉）
        { id: 'ParamBodyAngleZ', amp: 22, freq: 1 },
        { id: 'HipAngleZ', amp: 13, freq: 1, phase: 0.12 },
        // ParamBodyAngleRZ 是"身体位移RZ"，物理既不读也不写，可以自由驱动，
        // 它让整个身体一起摆，比只转胸腔明显得多。
        { id: 'ParamBodyAngleRZ', amp: 12, freq: 1, phase: 0.06 },
      ],
      // 头和上半身跟着同一拍，速度慢一点，形成"腰先动、头后跟"
      waves: [
        // PositionX 是物理的输入：身体重心左右移 → 物理推出胸/胯/裙摆/头发
        // 一起动，比单纯转胸腔自然得多（这也是 3.0.0 里 bodyX 的做法）
        { id: 'PositionX', amp: 9, freq: 1 },
        { id: 'AngleZ', amp: 8, freq: 1, phase: 0.1 },
        { id: 'AngleX', amp: 6, freq: 0.5, phase: 0.3 },
        { id: 'LeanInput', amp: -3, freq: 1, phase: 0.25 },
      ],
    },
  },

  expressions: {
    happy: 'smile', excited: 'smile', love: 'love',
    shy: 'blush', flustered: 'blush',
    sad: 'tears', cry: 'tears', worried: 'sweat',
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
    outfit: {
      // 旧版 scheme 只有两段（deepseek-default），落到这里当作长裙，避免沿用模型自带的短裙默认值
      default: { params: { Clothes1: 0, Clothes3: 0, Clothes4: 0, key9: 0, key10: 0, key11: 0, key12: 0 } },
      long:  { params: { Clothes1: 0, Clothes3: 0, Clothes4: 0, key9: 0, key10: 0, key11: 0, key12: 0 } },
      short: { params: { Clothes1: 1, Clothes3: 0, Clothes4: 0, key9: 0, key10: 0, key11: 0, key12: 0 } },
      goofy: { params: { Clothes1: 1, Clothes3: 0, Clothes4: 0, key9: 0, key10: 1, key11: 1, key12: 0 } },
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
    angleX: {"targets":["AngleX","ParamAngleX"],"space":[-1,1],"default":0},
    angleY: {"targets":["AngleY","ParamAngleY"],"space":[-1,1],"default":0},
    angleZ: {"targets":["AngleZ","ParamAngleZ"],"space":[-1,1],"default":0},
    bodyX: {"targets":["PositionX"],"space":[-1,1],"default":0},
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
