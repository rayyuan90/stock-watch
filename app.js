var cloudMod = require('./utils/cloud');

App({
    globalData: {
        appName: '算力看盘',
        refreshMs: 3000,
    },

    onLaunch: function () {
        this.authReady = Promise.resolve({ data: null, error: null });
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
});
