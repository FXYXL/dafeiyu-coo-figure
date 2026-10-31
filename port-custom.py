#!/usr/bin/env python3
"""
把「大肥鱼成品包」里的定制移植到一份新打好的包上。

为什么需要它：插件的 convert.mjs 每次都重新生成 profile.js 和 figure.json，
里面手写的 schemes（服装/大小取景）、expressions（情绪映射）、extraExpressions
（圈圈眼等独立词）、vocab 补丁都会被清空。后端 backends/live2d.js 的改动已经
同步进插件模板，不需要这里处理。

用法：
    python port-custom.py <成品包目录> <新包目录>

只覆盖"定制层"文件，不动 moc3 / 贴图 / sdk。
"""
import json
import shutil
import sys
from pathlib import Path

# 成品包里属于"定制"、需要整体搬过去的文件（相对 models/<id>/）
CUSTOM_FILES = ['profile.js']
CUSTOM_DIRS = ['motions', 'expressions']


def load(p):
    return json.load(open(p, encoding='utf-8'))


def main(src_root, dst_root):
    src_root, dst_root = Path(src_root), Path(dst_root)
    src_manifest = load(src_root / 'figure.json')
    model_id = src_manifest['id']
    dst_model = dst_root / 'models' / model_id
    src_model = src_root / 'models' / model_id

    if not dst_model.exists():
        sys.exit(f'新包里没有 models/{model_id}，先确认两个包是同一个模型')

    # 1) profile.js（role 表之上的全部定制：schemes / expressions / extraExpressions / motion.native）
    for name in CUSTOM_FILES:
        shutil.copy2(src_model / name, dst_model / name)
        print(f'  覆盖 models/{model_id}/{name}')

    # 2) 表情与动作素材
    for d in CUSTOM_DIRS:
        if (src_model / d).is_dir():
            shutil.rmtree(dst_model / d, ignore_errors=True)
            shutil.copytree(src_model / d, dst_model / d)
            print(f'  复制 models/{model_id}/{d}/')

    # 3) models/index.js：动作与表情的注册表
    shutil.copy2(src_root / 'models' / 'index.js', dst_root / 'models' / 'index.js')
    print('  覆盖 models/index.js')

    # 4) figure.json：只搬定制字段，保留新包自己的 id / license / 入口
    dst_manifest_path = dst_root / 'figure.json'
    dst_manifest = load(dst_manifest_path)
    for key in ('axes', 'vocab', 'about', 'name', 'thumb', 'version'):
        if key in src_manifest:
            dst_manifest[key] = src_manifest[key]
    open(dst_manifest_path, 'w', encoding='utf-8').write(
        json.dumps(dst_manifest, ensure_ascii=False, indent=2) + '\n')
    print('  合并 figure.json（axes / vocab / about / version）')

    # 5) 缩略图
    if (src_root / 'thumb').is_dir():
        shutil.rmtree(dst_root / 'thumb', ignore_errors=True)
        shutil.copytree(src_root / 'thumb', dst_root / 'thumb')
        print('  复制 thumb/')

    print(f'\n完成：{dst_root}')
    print(f'  vocab {len(dst_manifest.get("vocab", []))} 条，'
          f'axes {[a["id"] for a in dst_manifest.get("axes", [])]}')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
