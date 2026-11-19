# -*- coding: utf-8 -*-
"""生成初始种子行的 INSERT SQL，并做 SQL 转义。输出 sqlBase64 供工具传参。"""
import json, base64, os

HERE = os.path.dirname(os.path.abspath(__file__))
manual = json.load(open(os.path.join(HERE, '_manual_seed.json'), encoding='utf-8'))
manual_s = json.dumps(manual, ensure_ascii=False).replace("'", "''")

sql = (
    "INSERT INTO hk_bottom_input (id, as_of, report_quarter, narrative_quarter, manual, finance, south, trigger_reason, note) "
    "VALUES (1, '2026-11-19', '2026 Q3', 3, '" + manual_s + "', NULL, NULL, 'initialized', '初始种子：来自 hkbottom.js 的研报快照，待定时任务更新') "
    "ON CONFLICT (id) DO NOTHING;"
)
open(os.path.join(HERE, '_seed.sql'), 'w', encoding='utf-8').write(sql)
print(base64.b64encode(sql.encode('utf-8')).decode('ascii'))
