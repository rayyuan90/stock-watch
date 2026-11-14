var fmt = require('../../utils/format');
var cloudData = require('../../utils/cloudData');
var watchSync = require('../../utils/watchSync');
var market = require('../../utils/market');

var CONFIG_KEY = 'kanpan:config';
var HISTORY_KEY = 'kanpan:posHistory';
var MAX_HISTORY = 60;

Page({
    data: {
        form: {
            cost513310: '',
            shares513310: '',
            cost159995: '',
            shares159995: '',
            posNetShort: '',
            posTotalOi: '',
            posDate: ''
        },
        posSide: 'short',
        posAmount: '',
        today: '',
        tip: '',
        cloudUser: '',
        cloudLabel: '未登录云账号',
        loggingIn: false,
        loginError: '',
        diag: null,
        diagRunning: false
    },

    /** 逐个探测域名，判断是不是被白名单拦了 */
    runDiag: function () {
        var self = this;
        if (this.data.diagRunning) return;
        this.setData({ diagRunning: true, diag: null });
        market.probeDomains().then(function (list) {
            self.setData({ diag: list, diagRunning: false });
            var bad = list.filter(function (x) { return !x.ok; });
            if (bad.length) {
                wx.showToast({
                    title: bad.length + ' 个域名被拦截',
                    icon: 'none',
                    duration: 2000
                });
            } else {
                wx.showToast({ title: '全部域名通畅', icon: 'none' });
            }
        }).catch(function () {
            self.setData({ diagRunning: false });
            wx.showToast({ title: '检测失败', icon: 'none' });
        });
    },

    onLoad: function () {
        var saved = wx.getStorageSync(CONFIG_KEY) || {};
        var netShort = saved.posNetShort === '' || saved.posNetShort === undefined
            ? ''
            : Number(saved.posNetShort);
        var side = 'short';
        var amount = '';
        if (isFinite(netShort) && saved.posNetShort !== '') {
            side = netShort < 0 ? 'long' : 'short';
            amount = String(Math.abs(netShort));
        }
        var today = fmt.dayText(new Date());
        this.setData({
            form: {
                cost513310: saved.cost513310 || '',
                shares513310: saved.shares513310 || '',
                cost159995: saved.cost159995 || '',
                shares159995: saved.shares159995 || '',
                posNetShort: saved.posNetShort || '',
                posTotalOi: saved.posTotalOi || '',
                posDate: saved.posDate || today
            },
            posSide: side,
            posAmount: amount,
            today: today
        });
        this.checkCloud();
    },

    checkCloud: function () {
        var self = this;
        if (!cloudData.available) {
            this.setData({ cloudLabel: cloudData.initError || '云服务未就绪' });
            return;
        }
        var app = getApp();
        var ready = (app && app.authReady) || Promise.resolve({ data: null });
        ready.then(function () {
            return cloudData.getSession();
        }).then(function (session) {
            if (!session) {
                self.setData({ cloudUser: '', cloudLabel: '未登录云账号' });
                return;
            }
            var name = (session.user && session.user.name) || '已登录';
            self.setData({ cloudUser: name, cloudLabel: '云同步 · ' + name });
            // 登录后顺手把自选同步一次（换设备后这里最该生效）
            watchSync.sync().catch(function () { });
            return null;
        }).catch(function () {
            self.setData({ cloudLabel: '云端连接失败' });
        });
    },

    login: function () {
        var self = this;
        if (!cloudData.available) {
            this.setData({ loginError: cloudData.initError || '云服务未就绪' });
            return;
        }
        this.setData({ loggingIn: true, loginError: '' });
        cloudData.signIn().then(function (res) {
            var err = res && res.error;
            var cancelled = err && (err.code === 'cancelled' || err.code === 'access_denied');
            self.setData({
                loggingIn: false,
                loginError: (err && !cancelled) ? (err.message || '登录失败') : ''
            });
            if (!err) setTimeout(function () { self.checkCloud(); }, 400);
        }).catch(function (e) {
            self.setData({ loggingIn: false, loginError: (e && e.message) || '登录失败' });
        });
    },

    onInput: function (e) {
        var field = e.currentTarget.dataset.f;
        var value = e.detail.value;
        if (field === 'posAmount') {
            this.setData({ posAmount: value });
            return;
        }
        var patch = {};
        patch['form.' + field] = value;
        this.setData(patch);
    },

    onSide: function (e) {
        this.setData({ posSide: e.currentTarget.dataset.side });
    },

    onDate: function (e) {
        this.setData({ 'form.posDate': e.detail.value });
    },

    save: function () {
        var form = this.data.form;
        var amount = Number(this.data.posAmount);
        var netShort = '';
        if (this.data.posAmount !== '' && isFinite(amount)) {
            netShort = this.data.posSide === 'long' ? -Math.abs(amount) : Math.abs(amount);
            netShort = String(netShort);
        }

        var cfg = {
            cost513310: form.cost513310 || '',
            shares513310: form.shares513310 || '',
            cost159995: form.cost159995 || '',
            shares159995: form.shares159995 || '',
            posNetShort: netShort,
            posTotalOi: form.posTotalOi || '',
            posDate: form.posDate || this.data.today
        };

        wx.setStorageSync(CONFIG_KEY, cfg);

        // 已登录时同步到云端；未登录则只保留本机数据
        if (cloudData.available) {
            var posDate = cfg.posDate || this.data.today;
            var posNet = Number(cfg.posNetShort);
            var posOi = cfg.posTotalOi === '' ? null : Number(cfg.posTotalOi);
            cloudData.getSession().then(function (session) {
                if (!session) return null;
                return cloudData.savePortfolio(cfg).then(function () {
                    if (cfg.posNetShort === '' || !isFinite(posNet)) return null;
                    return cloudData.saveFuturesDay(posDate, posNet, isFinite(posOi) ? posOi : null);
                });
            }).catch(function () { });
        }

        if (cfg.posNetShort !== '') {
            var list = wx.getStorageSync(HISTORY_KEY);
            if (!Array.isArray(list)) list = [];
            var date = cfg.posDate;
            var filtered = [];
            for (var i = 0; i < list.length; i++) {
                if (list[i] && list[i].date !== date) filtered.push(list[i]);
            }
            filtered.push({
                date: date,
                netShort: Number(cfg.posNetShort),
                totalOi: Number(cfg.posTotalOi) || 0
            });
            if (filtered.length > MAX_HISTORY) {
                filtered = filtered.slice(filtered.length - MAX_HISTORY);
            }
            wx.setStorageSync(HISTORY_KEY, filtered);
        }

        var ch = this.getOpenerEventChannel && this.getOpenerEventChannel();
        if (ch && ch.emit) ch.emit('saved', cfg);

        wx.showToast({ title: '已保存', icon: 'success', duration: 800 });
        setTimeout(function () {
            wx.navigateBack();
        }, 500);
    }
});
