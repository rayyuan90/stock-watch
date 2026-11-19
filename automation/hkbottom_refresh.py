# -*- coding: utf-8 -*-
"""
港股科技底部研判 · 低频输入自动刷新
==================================================================
职责（对应「算力看盘」小程序首页港股底部提醒）：
  1. 抓腾讯最新季报主要指标（营收增速/净利率/经营现金流/投资现金流/PE/PB）
  2. 抓南向资金历史，聚合本月/上月/YTD/同比（作为前端实时抓取失败时的兜底）
  3. 检测「换季 / 换月 / 换年 / 新季报发布」四类事件，推进报告期与 asOf
  4. 输出一条 upsert SQL（写云端表 hk_bottom_input），由 automation agent 执行

设计要点：
  - 有接口的硬数据（财报、南向）自动刷新；无免费接口的研报细项（资本开支
    单季值、外资持仓、估值分位、ETF折价、美债）保留快照，但报告期标签随事件推进。
  - 状态源为本地 _hkb_state.json（本任务固定在同一台机器运行），并记录云端上一次
    写入的财报报告期，用于判断「新季报发布」。
  - 每次都是全量 upsert（幂等），脚本自身不连数据库，SQL 夹在标记之间供 agent 取用。

用法：
  python hkbottom_refresh.py            # 正式：抓取并生成 SQL
  python hkbottom_refresh.py --check    # 只检测+抓取，不更新本地状态、不写 SQL 文件
"""
import sys
import os
import json
import math
import urllib.request
import urllib.parse
import datetime
import re

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(HERE, '_hkb_state.json')
SEED_FILE = os.path.join(HERE, '_manual_seed.json')
SQL_FILE = os.path.join(HERE, '_hkb_refresh.sql')

DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}

CHECK = '--check' in sys.argv


def log(*a):
    print(*a)


def http_json(url, timeout=20):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def num(v, dflt=None):
    try:
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return dflt
        return f
    except (TypeError, ValueError):
        return dflt


def r1(v, dflt=None):
    f = num(v)
    return None if f is None else round(f, 1)


def r2(v, dflt=None):
    f = num(v)
    return None if f is None else round(f, 2)


# ---------------- 抓取 ----------------

def fetch_finance():
    """腾讯最新季报主要指标（累计口径）"""
    flt = urllib.parse.quote('(SECUCODE="00700.HK")')
    url = (DC + '?reportName=RPT_HKF10_FN_MAININDICATOR&columns=ALL'
           + '&filter=' + flt + '&pageNumber=1&pageSize=1'
           + '&sortTypes=-1&sortColumns=REPORT_DATE')
    data = (http_json(url).get('result') or {}).get('data') or []
    if not data:
        raise RuntimeError('财报数据为空')
    r = data[0]
    return {
        'reportType': r.get('REPORT_TYPE') or '',
        'reportDate': (r.get('REPORT_DATE') or '')[:10],
        'revenueYoy': r2(r.get('OPERATE_INCOME_YOY')),
        'holderProfitYoy': r2(r.get('HOLDER_PROFIT_YOY')),
        'netMargin': r2(r.get('NET_PROFIT_RATIO')),
        'operateCash': num(r.get('NETCASH_OPERATE')),   # 元
        'investCash': num(r.get('NETCASH_INVEST')),     # 元
        'peTtm': r2(r.get('PE_TTM')),
        'pbTtm': r2(r.get('PB_TTM')),
    }


def fetch_south(days=300):
    """南向净买入历史，返回 [{date, val}]，val 单位百万港元"""
    flt = urllib.parse.quote('(MUTUAL_TYPE="006")')
    url = (DC + '?reportName=RPT_MUTUAL_DEAL_HISTORY'
           + '&columns=TRADE_DATE,NET_DEAL_AMT&filter=' + flt
           + '&pageNumber=1&pageSize=' + str(days)
           + '&sortTypes=-1&sortColumns=TRADE_DATE')
    data = (http_json(url).get('result') or {}).get('data') or []
    out = []
    for row in data:
        v = num(row.get('NET_DEAL_AMT'))
        if v is None:
            continue
        out.append({'date': (row.get('TRADE_DATE') or '')[:10], 'val': v})
    out.reverse()
    return out


def south_monthly(series):
    """由带日期的南向序列算：本月/上月/YTD/去年同期（亿港元），与 hkbottom.southMonthly 同口径"""
    rows = [x for x in series if x.get('date') and x.get('val') is not None]
    if not rows:
        return None
    last = rows[-1]
    y, m = int(last['date'][:4]), int(last['date'][5:7])
    cur = '%04d-%02d' % (y, m)
    pm = m - 1 if m > 1 else 12
    py = y if m > 1 else y - 1
    prev = '%04d-%02d' % (py, pm)
    cur_sum = prev_sum = ytd = ytd_prev = 0.0
    for x in rows:
        d, v = x['date'], x['val'] / 100.0  # 亿港元
        if d.startswith(cur):
            cur_sum += v
        if d.startswith(prev):
            prev_sum += v
        if d.startswith('%04d-' % y):
            ytd += v
        ly = y - 1
        if d.startswith('%04d-' % ly) and d[5:7] <= '%02d' % m:
            ytd_prev += v
    # 连续净流入天数（从末尾往前数）
    consecutive = 0
    for x in reversed(rows):
        if x['val'] > 0:
            consecutive += 1
        else:
            break
    in_days = sum(1 for x in rows if x['val'] > 0)
    return {
        'year': y, 'month': m,
        'curYi': r1(cur_sum), 'prevYi': r1(prev_sum),
        'ytdYi': r1(ytd), 'ytdPrevYi': r1(ytd_prev),
        'ytdRatio': round(ytd / ytd_prev, 3) if ytd_prev > 0 else None,
        'lastDate': last['date'],
        'consecutive': consecutive, 'inDays': in_days, 'totalDays': len(rows)
    }


# ---------------- 报告期推进 ----------------

def quarter_of(dt):
    return (dt.month - 1) // 3 + 1


def quarter_from_report(report_type):
    """从「2026年三季报」解析季度数字；年报=4"""
    mp = {'一': 1, '二': 2, '三': 3, '四': 4, '1': 1, '2': 2, '3': 3, '4': 4}
    hit = re.search(r'([一二三四1-4])季', report_type or '')
    if hit:
        return mp.get(hit.group(1))
    if '年报' in (report_type or ''):
        return 4
    return None


def load_state():
    if os.path.exists(STATE_FILE):
        try:
            return json.load(open(STATE_FILE, encoding='utf-8'))
        except Exception:
            pass
    return {}


def save_state(s):
    json.dump(s, open(STATE_FILE, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)


def load_manual():
    """从种子文件读 MANUAL 基线；每次以它为底做增量更新，保证只动该动的字段"""
    return json.load(open(SEED_FILE, encoding='utf-8'))


def detect_events(fin, state, now):
    """返回 (事件列表, 触发原因)。对比「上次写入状态」与「本次抓到的现实」"""
    events = []
    last_report = state.get('finance_report', '')
    last_asof = state.get('as_of', '')
    last_q = state.get('quarter')
    last_m = state.get('month')
    last_y = state.get('year')

    cur_report = fin.get('reportType', '')
    if cur_report and cur_report != last_report:
        events.append('new_report:%s' % cur_report)

    if last_y is not None and now.year != last_y:
        events.append('year_rollover:%d' % now.year)
    if last_q is not None and quarter_of(now) != last_q:
        events.append('quarter_rollover:Q%d' % quarter_of(now))
    if last_m is not None and now.month != last_m:
        events.append('month_rollover:%d月' % now.month)
    if not last_asof:
        events.append('initial')
    return events


def apply_updates(manual, fin, sm, now, events):
    """把能自动更新的字段刷进 MANUAL 副本；无接口研报细项保留快照值"""
    m = json.loads(json.dumps(manual))  # deep copy
    m['asOf'] = now.strftime('%Y-%m-%d')

    # 叙事底：营收增速来自财报（累计口径），报告季度随财报推进
    fq = quarter_from_report(fin.get('reportType'))
    if fq:
        m['narrative']['reportQuarter'] = fq
    if fin.get('revenueYoy') is not None:
        m['narrative']['tencentRevenueYoy'] = fin['revenueYoy']

    # 估值底：恒科指数的 PE/PB 历史分位无免费接口，保留研报快照不动。
    # 财报接口的 PE_TTM/PB_TTM 是「腾讯个股」口径，与恒科指数不可混用，
    # 只写进 finance 字段作旁证，绝不覆盖 MANUAL.valuation。
    # 资金底：南向美元快照（southYtdUSD 等）为研报口径，保留不动；
    # 实时聚合值写进 south jsonb，前端实时接口可用时以实时为准。

    return m


def sql_lit(s):
    return "'" + str(s).replace("'", "''") + "'"


def build_sql(as_of, report_quarter, narrative_quarter, manual, fin, south_agg, reason, note):
    # south 只存聚合摘要（前端南向明细走实时接口；这里供其失败时兜底）
    manual_s = json.dumps(manual, ensure_ascii=False).replace("'", "''")
    fin_s = json.dumps(fin, ensure_ascii=False).replace("'", "''")
    south_s = json.dumps(south_agg, ensure_ascii=False).replace("'", "''")
    return (
        "INSERT INTO hk_bottom_input "
        "(id, as_of, report_quarter, narrative_quarter, manual, finance, south, trigger_reason, note, updated_at) "
        "VALUES (1, " + sql_lit(as_of) + ", " + sql_lit(report_quarter) + ", "
        + (str(int(narrative_quarter)) if narrative_quarter else 'NULL') + ", "
        + sql_lit(manual_s) + ", " + sql_lit(fin_s) + ", " + sql_lit(south_s) + ", "
        + sql_lit(reason) + ", " + sql_lit(note) + ", now()) "
        "ON CONFLICT (id) DO UPDATE SET "
        "as_of=EXCLUDED.as_of, report_quarter=EXCLUDED.report_quarter, "
        "narrative_quarter=EXCLUDED.narrative_quarter, manual=EXCLUDED.manual, "
        "finance=EXCLUDED.finance, south=EXCLUDED.south, "
        "trigger_reason=EXCLUDED.trigger_reason, note=EXCLUDED.note, updated_at=now();"
    )


def main():
    now = datetime.datetime.now()
    state = load_state()
    log('=== 港股底部研判 · 低频输入刷新 ===')
    log('运行时间:', now.strftime('%Y-%m-%d %H:%M:%S'))

    fin = None
    south = []
    try:
        fin = fetch_finance()
        log('[财报] %s | 报告日 %s | 营收同比 %s%% | 净利率 %s%% | 经营现金流 %.0f亿 | 投资现金流 %.0f亿 | PE %s | PB %s' % (
            fin['reportType'], fin['reportDate'], fin['revenueYoy'], fin['netMargin'],
            (fin['operateCash'] or 0) / 1e8, (fin['investCash'] or 0) / 1e8,
            fin['peTtm'], fin['pbTtm']))
    except Exception as e:
        log('[财报] 抓取失败:', e)

    try:
        south = fetch_south(300)
        sm = south_monthly(south)
        if sm:
            log('[南向] 截至 %s | %d月净流入 %s亿 | 上月 %s亿 | YTD %s亿 | 同比 %s' % (
                sm['lastDate'], sm['month'], sm['curYi'], sm['prevYi'], sm['ytdYi'],
                ('%.0f%%' % (sm['ytdRatio'] * 100)) if sm['ytdRatio'] is not None else '--'))
    except Exception as e:
        sm = None
        log('[南向] 抓取失败:', e)

    if not fin:
        log('❌ 财报抓取失败且无缓存，中止本次刷新（不写脏数据）')
        return 1

    events = detect_events(fin, state, now)
    log('[检测] 触发事件:', ('、'.join(events) if events else '无（数据未变化）'))

    manual = load_manual()
    manual = apply_updates(manual, fin, sm, now, events)

    # 报告期标签：年份取财报报告日所属年（跨年不串年份），季度取财报季度
    fq = quarter_from_report(fin.get('reportType')) or quarter_of(now)
    fin_year = int(fin['reportDate'][:4]) if fin.get('reportDate') else now.year
    report_quarter = '%d Q%d' % (fin_year, fq)

    reason = ' | '.join(events) if events else 'routine_refresh'
    note = ('自动刷新：财报/南向硬数据来自东财接口；估值分位、外资持仓、资本开支单季值、'
            'ETF折价、美债为研报快照（无免费接口），报告期标签随事件推进。')

    sql = build_sql(now.strftime('%Y-%m-%d'), report_quarter, fq, manual, fin, sm, reason, note)
    log('[SQL] 已生成 upsert 语句，长度 %d 字符' % len(sql))

    if not CHECK:
        with open(SQL_FILE, 'w', encoding='utf-8') as f:
            f.write(sql)
        save_state({
            'as_of': now.strftime('%Y-%m-%d'),
            'finance_report': fin.get('reportType', ''),
            'finance_report_date': fin.get('reportDate', ''),
            'quarter': quarter_of(now),
            'month': now.month,
            'year': now.year,
            'last_reason': reason,
        })
        log('[状态] 已更新本地状态 ->', STATE_FILE)
        log('-----BEGIN-SQL-----')
        log(sql)
        log('-----END-SQL-----')
    else:
        log('[CHECK] 仅检测模式：未写状态、未输出 SQL')
    return 0


if __name__ == '__main__':
    sys.exit(main())
