/**
 * 自选跨设备同步
 * - 本地永远是第一渲染源（没登录/没网也能用）
 * - 登录后用云端 watchlist 表（按账号一行）做双向同步：
 *   1) 本设备从没同步过（无 userId）→ 本地并入云端（首次上传/合并）
 *   2) 本设备有未推送的改动（dirty）→ 云端 + 本地取并集，回写两边
 *   3) 本地干净 → 以云端为准覆盖本地（换设备/别的设备改过）
 * - 添加 / 移除后立即 push（失败保留 dirty，下次再推）
 */
var watch = require('./watch');
var cloudData = require('./cloudData');

var META = watch.META_KEY;

function readMeta() {
    var m = null;
    try {
        m = wx.getStorageSync(META);
    } catch (e) {
        m = null;
    }
    if (!m || typeof m !== 'object') m = {};
    return {
        dirty: !!m.dirty,
        userId: m.userId || '',
        syncedAt: Number(m.syncedAt) || 0
    };
}

function writeMeta(patch) {
    var m = readMeta();
    var key;
    for (key in patch) {
        if (patch.hasOwnProperty(key)) m[key] = patch[key];
    }
    try {
        wx.setStorageSync(META, m);
    } catch (e) { /* ignore */ }
    return m;
}

function markDirty() {
    writeMeta({ dirty: true });
}

/** 并集：本地新增的排前面，同名只留一条，最多 MAX */
function merge(local, remote) {
    var out = [];
    var seen = {};
    function push(list) {
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            if (!it || !it.sec || seen[it.sec]) continue;
            seen[it.sec] = 1;
            out.push(it);
        }
    }
    push(local || []);
    push(remote || []);
    return out.slice(0, watch.MAX);
}

function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
        if (a[i].sec !== b[i].sec || a[i].name !== b[i].name) return false;
    }
    return true;
}

/** 把本地自选推到云端；返回 { ok, error } */
function push() {
    var list = watch.load();
    return cloudData.saveWatchlist(list).then(function (res) {
        if (res.ok) {
            writeMeta({ dirty: false, syncedAt: Date.now() });
            return { ok: true, error: '' };
        }
        return { ok: false, error: res.error || '同步失败' };
    }).catch(function (e) {
        return { ok: false, error: (e && e.message) || '同步失败' };
    });
}

/**
 * 拉取并合并云端自选（需登录）
 * 返回 Promise<{ ok, reason, list?, changed, error? }>
 * reason: nologin | empty | pushed | merged | pulled | error
 */
function sync() {
    return cloudData.getSession().then(function (session) {
        if (!session) {
            return { ok: false, reason: 'nologin', changed: false, error: '未登录' };
        }
        var user = session.user || {};
        var uid = String(user.id || user.user_id || user.email || 'me');
        return cloudData.loadWatchlist().then(function (res) {
            if (!res.ok) {
                return { ok: false, reason: 'error', changed: false, error: res.error || '读取云端自选失败' };
            }
            var local = watch.load();
            var meta = readMeta();

            // 云端还没有这一行
            if (!res.data) {
                if (!local.length) {
                    writeMeta({ userId: uid, dirty: false, syncedAt: Date.now() });
                    return { ok: true, reason: 'empty', changed: false, list: local };
                }
                return cloudData.saveWatchlist(local).then(function (w) {
                    if (w.ok) writeMeta({ userId: uid, dirty: false, syncedAt: Date.now() });
                    return { ok: true, reason: 'pushed', changed: false, list: local };
                });
            }

            var remote = res.data.items || [];
            var firstSync = !meta.userId;
            var sameAccount = meta.userId === uid;
            var localDirty = sameAccount && meta.dirty;

            // 首次在这台设备同步，或本地有未推送改动 → 并集后回写两边
            if (firstSync || localDirty) {
                var merged = merge(local, remote);
                var changed = !sameList(merged, local);
                watch.save(merged, true);
                return cloudData.saveWatchlist(merged).then(function (w) {
                    if (w.ok) writeMeta({ userId: uid, dirty: false, syncedAt: Date.now() });
                    else writeMeta({ userId: uid });
                    return {
                        ok: true,
                        reason: 'merged',
                        changed: changed,
                        list: merged,
                        error: w.ok ? '' : (w.error || '')
                    };
                });
            }

            // 换了账号：云端为准，避免把上个账号的自选带给新账号
            var replaced = watch.save(remote, true);
            writeMeta({ userId: uid, dirty: false, syncedAt: Date.now() });
            return {
                ok: true,
                reason: 'pulled',
                changed: !sameList(replaced, local),
                list: replaced
            };
        });
    }).catch(function (e) {
        return { ok: false, reason: 'error', changed: false, error: (e && e.message) || '同步失败' };
    });
}

/** 首页 / 自选页展示用的同步状态文案 */
function statusText() {
    var m = readMeta();
    if (m.dirty) return '待同步';
    if (m.syncedAt) return '已云同步';
    return '仅本机';
}

module.exports = {
    sync: sync,
    push: push,
    markDirty: markDirty,
    statusText: statusText,
    readMeta: readMeta,
    merge: merge
};
