# -*- coding: utf-8 -*-
"""把 signal（AI 算力次日倾向）模块移到 holdings（AI 算力芯片）下方。
先 dry-run 验证切块能无损还原原文，再按目标顺序写出。"""
import re
import sys

PATH = 'pages/index/index.wxml'

# 目标顺序：signal 紧跟 holdings
TARGET = [
    'hkTech', 'hkb', 'aflow', 'agame', 'verify',
    'futures', 'bgacc', 'usgame', 'holdings', 'signal',
    'watch', 'cross', 'reward'
]

lines = open(PATH, encoding='utf-8').read().split('\n')

# 顶层模块起点：4 空格缩进的 <view class="card..." 或 <view class="hero"
starts = [i for i, l in enumerate(lines) if re.match(r'^    <view class="(card|hero)["\s>]', l)]
print('顶层模块起点数:', len(starts))


def block_end(s):
    depth = 0
    for i in range(s, len(lines)):
        opens = len(re.findall(r'<view[\s>]', lines[i]))
        closes = len(re.findall(r'</view>', lines[i]))
        depth += opens - closes
        if depth == 0 and i > s:
            return i
    raise RuntimeError('no end for block starting at line %d' % (s + 1))


blocks = []
for s in starts:
    e = block_end(s)
    body = '\n'.join(lines[s:e + 1])
    m = re.search(r'data-key="(\w+)"', body)
    key = m.group(1) if m else '???'
    bs = s
    if s - 1 >= 0 and re.match(r'^    <!--', lines[s - 1]):
        bs = s - 1
    blocks.append({'key': key, 'bs': bs, 'e': e, 'text': lines[bs:e + 1]})

keys = [b['key'] for b in blocks]
print('识别模块:', ' -> '.join(keys))

if len(keys) != len(TARGET) or set(keys) != set(TARGET):
    print('ERROR: 模块 key 与目标不一致!')
    print('  多出:', set(keys) - set(TARGET), ' 缺少:', set(TARGET) - set(keys))
    sys.exit(1)

# 验证切块 + 空行能无损还原原文
head = lines[:blocks[0]['bs']]
tail = lines[blocks[-1]['e'] + 1:]
reconstructed = list(head)
for idx, b in enumerate(blocks):
    if idx > 0:
        reconstructed.append('')
    reconstructed.extend(b['text'])
reconstructed.extend(tail)
orig = open(PATH, encoding='utf-8').read()
rec = '\n'.join(reconstructed)
if rec != orig:
    print('ERROR: 切块无法还原原文')
    ol = orig.split('\n')
    for i in range(min(len(ol), len(reconstructed))):
        if ol[i] != reconstructed[i]:
            print('  首个差异 line %d: orig=%r rec=%r' % (i + 1, ol[i], reconstructed[i]))
            break
    sys.exit(1)
print('切块还原验证: OK（完全一致）')

# 按目标顺序重组
order_map = {b['key']: b for b in blocks}
new_lines = list(head)
for idx, k in enumerate(TARGET):
    if idx > 0:
        new_lines.append('')
    new_lines.extend(order_map[k]['text'])
new_lines.extend(tail)
new_content = '\n'.join(new_lines)

if '--write' in sys.argv:
    open(PATH, 'w', encoding='utf-8').write(new_content)
    print('已写入', PATH)
    print('新顺序:', ' -> '.join(TARGET))
else:
    print('DRY-RUN 模式：未写入。目标顺序预览:')
    print('  ' + ' -> '.join(TARGET))
