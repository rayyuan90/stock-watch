/**
 * 自选列表：手动添加的股票 / ETF / 期货，存本机
 * 结构：[{ sec, code, name, type }]
 */

var KEY = 'kanpan:watch';
var META_KEY = 'kanpan:watchMeta';
var MAX = 20;

function normalize(item) {
    if (!item) return null;
    var sec = String(item.sec || '').trim();
    if (!sec || sec.indexOf('.') < 0) return null;
    return {
        sec: sec,
        code: String(item.code || sec.split('.')[1] || ''),
        name: String(item.name || sec),
        type: String(item.type || '')
    };
}

function load() {
    var raw = wx.getStorageSync(KEY);
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
        var it = normalize(raw[i]);
        if (it) out.push(it);
    }
    return out;
}

function save(list, quiet) {
    var out = [];
    for (var i = 0; i < (list || []).length; i++) {
        var it = normalize(list[i]);
        if (it && !has(out, it.sec)) out.push(it);
    }
    var sliced = out.slice(0, MAX);
    wx.setStorageSync(KEY, sliced);
    // quiet=true 表示这次是云端回写，不算本地改动
    if (!quiet) {
        var m = {};
        try {
            m = wx.getStorageSync(META_KEY) || {};
        } catch (e) {
            m = {};
        }
        m.dirty = true;
        m.localAt = Date.now();
        try { wx.setStorageSync(META_KEY, m); } catch (e2) { /* ignore */ }
    }
    return sliced;
}

function has(list, sec) {
    for (var i = 0; i < list.length; i++) {
        if (list[i].sec === sec) return true;
    }
    return false;
}

/** 返回 { ok, list, message } */
function add(item) {
    var it = normalize(item);
    if (!it) return { ok: false, list: load(), message: '标的无效' };
    var list = load();
    if (has(list, it.sec)) return { ok: false, list: list, message: '「' + it.name + '」已在自选里' };
    if (list.length >= MAX) return { ok: false, list: list, message: '最多添加 ' + MAX + ' 个' };
    list.unshift(it);
    return { ok: true, list: save(list), message: '已添加 ' + it.name };
}

function remove(sec) {
    var list = load();
    var out = [];
    for (var i = 0; i < list.length; i++) {
        if (list[i].sec !== sec) out.push(list[i]);
    }
    return save(out);
}

function secs() {
    return load().map(function (x) {
        return x.sec;
    });
}

module.exports = {
    KEY: KEY,
    META_KEY: META_KEY,
    MAX: MAX,
    load: load,
    save: save,
    add: add,
    remove: remove,
    secs: secs
};
