/**
 * 云服务客户端（唯一实例，全项目共享）
 * 初始化参数来自 workbuddy_cloud_service 返回的 publicConfig，不要硬编码其他地址。
 *
 * 注意：SDK 依赖小程序 npm 构建产物。若当前运行环境没有完成构建，
 * require 会抛错，这里降级为 cloud = null，看盘主体功能不受影响。
 */
var publicConfig = {
    endpoint: 'https://mp-api.app.workbuddy.host',
    publishableKey: 'wbpk_BuC6ir54lMo3Eq21Bvfx98_36w3wFfo3qxD1DdP98GufFRzrWsDWnvG',
    workBuddyOAuthClientId: 'cb_jq6QyEPkOkJXPcpz0JxS_wbapp_BuC6ir54lMo3Eq21Bvfx98'
};

var cloud = null;
var initError = '';

/** 优先走 npm 解析，失败再走本地构建产物，两条路都取官方 miniprogram 入口 */
function loadSdk() {
    try {
        return require('@tencent-ai/workbuddy-cloud-sdk/miniprogram');
    } catch (e1) {
        // ignore
    }
    try {
        return require('../miniprogram_npm/@tencent-ai/workbuddy-cloud-sdk/miniprogram.js');
    } catch (e2) {
        return null;
    }
}

try {
    var sdk = loadSdk();
    if (!sdk) throw new Error('云服务 SDK 未构建');
    var diagnostics = require('./workbuddy-cloud-diagnostics');
    cloud = sdk.createMiniProgramWorkBuddyCloud({
        endpoint: publicConfig.endpoint,
        publishableKey: publicConfig.publishableKey,
        workBuddyOAuthClientId: publicConfig.workBuddyOAuthClientId,
        wx: diagnostics.createDiagnosticWx(wx)
    });
} catch (e) {
    initError = (e && e.message) || '云服务 SDK 未就绪';
}

module.exports = {
    cloud: cloud,
    publicConfig: publicConfig,
    initError: initError,
    available: !!cloud
};
