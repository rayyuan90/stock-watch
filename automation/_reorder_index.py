# -*- coding: utf-8 -*-
"""按模块边界切分 index.wxml 并重新排序。先 dry-run 验证切块能还原原文。"""
import re
import sys

PATH = 'pages/index/index.wxml'

# 目标顺序（模块 data-key）
TARGET = [
    'hkTech', 'hkb', 'signal', 'aflow', 'agame', 'verify',
    'futures', 'bgacc', 'usgame', 'holdings', 'hero', 'watch',
    'cross', 'reward'
]

lines = open(PATH, encoding='utf-8').read().split('\n')

# 1. 找所有顶层模块起点：4空格缩进的 <view class="card..." 或 <view class="hero"
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

blocks = []  # (key, start_line, end_line, text_lines)
for s in starts:
    e = block_end(s)
    body = '\n'.join(lines[s:e + 1])
    m = re.search(r'data-key="(\w+)"', body)
    key = m.group(1) if m else '???'
    # 注释行并入块
    bs = s
    if s - 1 >= 0 and re.match(r'^    <!--', lines[s - 1]):
        bs = s - 1
    text = lines[bs:e + 1]
    blocks.append({'key': key, 'bs': bs, 'e': e, 'text': text})

print('识别到的模块 key（原顺序）:')
for b in blocks:
    print('  %-10s lines %d-%d' % (b['key'], b['bs'] + 1, b['e'] + 1))

keys = [b['key'] for b in blocks]
if len(keys) != len(TARGET) or set(keys) != set(TARGET):
    print('ERROR: 模块 key 与目标不一致!')
    print('  多出:', set(keys) - set(TARGET), ' 缺少:', set(TARGET) - set(keys))
    sys.exit(1)

# 2. 验证切块 + 空行能还原原文
head = lines[:blocks[0]['bs']]
tail = lines[blocks[-1]['e'] + 1:]
reconstructed = list(head)
for idx, b in enumerate(blocks):
    if idx > 0:
        reconstructed.append('')  # 模块间空行
    reconstructed.extend(b['text'])
reconstructed.extend(tail)
orig = open(PATH, encoding='utf-8').read()
rec = '\n'.join(reconstructed)
if rec != orig:
    print('ERROR: 切块无法还原原文（差异出现）')
    # 找第一处差异
    ol = orig.split('\n')
    for i in range(min(len(ol), len(reconstructed))):
        if ol[i] != reconstructed[i]:
            print('  首个差异 line %d:' % (i + 1))
            print('    orig:', repr(ol[i]))
            print('    rec :', repr(reconstructed[i]))
            break
    sys.exit(1)
print('切块还原验证: OK（完全一致）')

# 3. 按目标顺序重组
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
else:
    print('DRY-RUN 模式：未写入。目标顺序预览:')
    print('  ' + ' -> '.join(TARGET))
