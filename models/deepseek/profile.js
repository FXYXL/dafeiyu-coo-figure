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
  extraExpressions: {
    // 键名会被当作可写的词，必须符合 Coo 的 id 规则（小写字母/数字/连字符）
    'circle-eyes': 'dizzy',    // 圈圈眼
    'dark-face': 'dark',       // 黑脸
    'wry-face': 'smug',        // 屑屑眼
    'glasses-face': 'glasses', // 黑框眼镜
    'monocle-face': 'monocle', // 单片眼镜
    'pan-face': 'pan',         // 钢盆
  },
  // 参数动作：用模型自己的参数做透视姿态，由 frame.gesture 的进度驱动。
  // LeanInput 是模型的"前倾输入"：负值往镜头靠（物理会据此联动身体），正值后退。
  paramActs: {
    // 探身贴近镜头：负值往前靠，物理会联动身体透视（最像 VTS 里的前倾）
    'lean-in':   { params: [{ id: 'LeanInput', to: -30 }] },
    'lean-back': { params: [{ id: 'LeanInput', to: 30 }] },
    // 探身鞠躬：比整体旋转自然，是上半身真的往前压
    bow:         { params: [{ id: 'LeanInput', to: -24 }] },
    // 侧身：身体绕竖轴偏过去
    side:        { params: [{ id: 'ParamBodyAngleZ', to: 24 }] },
    // 斜着凑近：前倾 + 侧身，最生动
    peek:        { params: [{ id: 'LeanInput', to: -22 }, { id: 'ParamBodyAngleZ', to: 14 }] },
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
    mouthOpen: {"targets":["ParamMouthOpenY"],"space":[0,1],"default":0},
    mouthForm: {"targets":["ParamMouthForm"],"space":[-1,1],"default":0},
    eyeBallX: {"targets":["ParamEyeBallX"],"space":[-1,1],"default":0},
    eyeBallY: {"targets":["ParamEyeBallY"],"space":[-1,1],"default":0},
    angleX: {"targets":["ParamAngleX"],"space":[-1,1],"default":0},
    angleY: {"targets":["ParamAngleY"],"space":[-1,1],"default":0},
    angleZ: {"targets":["ParamAngleZ"],"space":[-1,1],"default":0},
    bodyX: {"targets":["ParamBodyAngleX"],"space":[-1,1],"default":0},
    breath: {"targets":["ParamBreath"],"space":[0,1],"default":0},
  },
  expression: {
    happy: {"browY":0.35,"mouthForm":0.8},
    wink: {"browY":0.2,"mouthForm":0.4},
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
