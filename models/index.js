// 由 tools/convert.mjs 生成；换模型只改这里和 models/<id>/profile.js
export const models = {
  "deepseek": {
    "id": "deepseek",
    "model": "model3.js",
    "moc": "model.moc3",
    "mocFallback": "moc3.js",
    "physics": "physics.js",
    "textures": [
      "textures/texture_00.png",
      "textures/texture_01.png",
      "textures/texture_02.png",
      "textures/texture_03.png",
      "textures/texture_04.png"
    ],
    "motions": [
      {"id": "idle", "file": "motions/idle.js", "duration": 5.98, "loop": true},
      {"id": "exit-finger-point", "file": "motions/pointOut.js", "duration": 1.3},
      {"id": "exit-chest-hand", "file": "motions/lower.js", "duration": 1.0},
      {"id": "exit-grass-hand", "file": "motions/grassOut.js", "duration": 1.1}
    ],
    "idle": [{"id": "idle"}],
    "expressions": [
      {"id":"blush","file":"expressions/blush.js"},
      {"id":"bodyA","file":"expressions/bodyA.js"},
      {"id":"bodyB","file":"expressions/bodyB.js"},
      {"id":"bodyC","file":"expressions/bodyC.js"},
      {"id":"dark","file":"expressions/dark.js"},
      {"id":"dizzy","file":"expressions/dizzy.js"},
      {"id":"fang","file":"expressions/fang.js"},
      {"id":"glasses","file":"expressions/glasses.js"},
      {"id":"lean","file":"expressions/lean.js"},
      {"id":"loading","file":"expressions/loading.js"},
      {"id":"love","file":"expressions/love.js"},
      {"id":"monocle","file":"expressions/monocle.js"},
      {"id":"noTail","file":"expressions/noTail.js"},
      {"id":"pan","file":"expressions/pan.js"},
      {"id":"pointOff","file":"expressions/pointOff.js"},
      {"id":"pointOn","file":"expressions/pointOn.js"},
      {"id":"smile","file":"expressions/smile.js"},
      {"id":"smug","file":"expressions/smug.js"},
      {"id":"sweat","file":"expressions/sweat.js"},
      {"id":"tears","file":"expressions/tears.js"}
    ]
  }
};
