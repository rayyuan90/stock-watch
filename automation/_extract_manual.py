# -*- coding: utf-8 -*-
"""从 utils/hkbottom.js 抽取 MANUAL 对象为 JSON（一次性工具）"""
import re, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, 'utils', 'hkbottom.js'), encoding='utf-8').read()

# 先去掉块注释和行注释（在整体上去，避免括号配对时被注释里的引号干扰）
src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
src = re.sub(r'//[^\n]*', '', src)

i = src.index('var MANUAL =')
s = src.index('{', i)
d = 0
ins = False
esc = False
e = None
for k in range(s, len(src)):
    c = src[k]
    if esc:
        esc = False
        continue
    if c == '\\':
        esc = True
        continue
    if c in ('\'', '"'):
        ins = not ins
        continue
    if ins:
        continue
    if c == '{':
        d += 1
    elif c == '}':
        d -= 1
        if d == 0:
            e = k + 1
            break
block = src[s:e]
# JS 单引号字符串 -> JSON 双引号（MANUAL 里的字符串值均不含引号字符，安全）
block = re.sub(r"'([^']*)'", r'"\1"', block)
block = re.sub(r'([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:', r'\1"\2":', block)
block = re.sub(r',\s*([}\]])', r'\1', block)
m = json.loads(block)
print('KEYS', list(m.keys()))
print('asOf', m['asOf'], 'reportQuarter', m['capital']['reportQuarter'], 'nq', m['narrative']['reportQuarter'])
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_manual_seed.json')
open(out, 'w', encoding='utf-8').write(json.dumps(m, ensure_ascii=False))
print('SEED_OK ->', out)
