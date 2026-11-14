function isNum(v) {
    return v !== null && v !== undefined && v !== '' && v !== '-' && isFinite(v);
}

function fixed(v, digits) {
    var d = digits === undefined ? 2 : digits;
    if (!isNum(v)) return '--';
    return Number(v).toFixed(d);
}

function pct(v, digits) {
    var d = digits === undefined ? 2 : digits;
    if (!isNum(v)) return '--';
    var n = Number(v);
    return (n > 0 ? '+' : '') + n.toFixed(d) + '%';
}

function group(n) {
    if (!isNum(n)) return '--';
    var neg = n < 0;
    var s = String(Math.abs(Math.round(Number(n))));
    var out = '';
    for (var i = 0; i < s.length; i++) {
        if (i > 0 && (s.length - i) % 3 === 0) out += ',';
        out += s.charAt(i);
    }
    return (neg ? '-' : '') + out;
}

function amount(v) {
    if (!isNum(v)) return '--';
    var n = Number(v);
    if (n >= 1e12) return (n / 1e12).toFixed(2) + '万亿';
    if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return n.toFixed(0);
}

function cls(v) {
    if (!isNum(v)) return 'flat';
    var n = Number(v);
    if (n > 0) return 'up';
    if (n < 0) return 'down';
    return 'flat';
}

function clock(d) {
    var dt = d || new Date();
    function p(n) {
        return n < 10 ? '0' + n : String(n);
    }
    return p(dt.getHours()) + ':' + p(dt.getMinutes()) + ':' + p(dt.getSeconds());
}

function dayText(d) {
    var dt = d || new Date();
    function p(n) {
        return n < 10 ? '0' + n : String(n);
    }
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
}

module.exports = {
    isNum: isNum,
    fixed: fixed,
    pct: pct,
    group: group,
    amount: amount,
    cls: cls,
    clock: clock,
    dayText: dayText,
};
