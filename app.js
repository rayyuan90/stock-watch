var cloudMod = require('./utils/cloud');
var vault = require('./utils/vault');

App({
    globalData: {
        appName: '算力看盘',
        refreshMs: 3000,
        vaultBoot: null,
    },

    onLaunch: function () {
        this.authReady = Promise.resolve({ data: null, error: null });
        // 先回灌本机备份文件，再让页面读 storage：
        // 重新发布 / 清缓存 / 换开发版后，复盘、净空单历史、配置、自选都能自动找回
        try {
            this.globalData.vaultBoot = vault.boot();
        } catch (e) {
            this.globalData.vaultBoot = { ok: false, restored: 0, merged: 0 };
        }
    },

    onShow: function (options) {
        var cloud = cloudMod.cloud;
        if (!cloud) {
            this.authReady = Promise.resolve({ data: null, error: null });
            return;
        }
        // 登录回调必须在这里、在任何页面守卫之前处理完
        this.authReady = cloud.auth.handleWorkBuddyMiniProgramCallback(options).then(function (callback) {
            if (callback && callback.error) return callback;
            return cloud.auth.getSession();
        }).catch(function (e) {
            return { data: null, error: { message: (e && e.message) || '登录状态检查失败' } };
        });
    },

    onHide: function () {
        // 切后台时立即落盘，避免防抖窗口内进程被回收
        try { vault.flush('hide'); } catch (e) { /* ignore */ }
    },
});
