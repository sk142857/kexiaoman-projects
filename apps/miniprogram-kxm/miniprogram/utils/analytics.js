/**
 * 课小满 - 会话画像采集（user_sessions）
 * 冷启动静默上报一次，经 /api/lp/collectSession（LP JWT 身份），失败静默不影响用户
 */
import { analytics } from './api';

function uuid() {
  const hex = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}`;
}

function safe(fn, fallback) {
  try { return fn(); } catch (_) { return fallback; }
}

function getNetworkType() {
  return new Promise((resolve) => {
    safe(() => wx.getNetworkType({ success: (r) => resolve(r.networkType || 'unknown'), fail: () => resolve('unknown') }), 'unknown');
  });
}

/** 采集并上报会话画像 */
export function collectSession() {
  getNetworkType().then((network) => {
    const base = safe(() => wx.getAppBaseInfo(), {});
    const dev = safe(() => wx.getDeviceInfo(), {});
    const win = safe(() => wx.getWindowInfo(), {});
    const acct = safe(() => wx.getAccountInfoSync(), {});
    const launch = safe(() => wx.getLaunchOptionsSync(), {});
    const auth = safe(() => wx.getAppAuthorizeSetting(), {});
    const battery = safe(() => wx.getBatteryInfoSync(), { level: -1, charging: false });

    const session = {
      session_id: uuid(),
      // 设备画像
      brand: dev.brand || '',
      model: dev.model || '',
      system: dev.system || '',
      platform: dev.platform || '',
      cpu_type: dev.cpuType || '',
      wechat_version: base.version || '',
      sdk_version: base.SDKVersion || '',
      renderer: base.renderer || '',
      network_type: network,
      env_version: (acct.miniProgram && acct.miniProgram.envVersion) || '',
      app_version: base.appVersion || '',
      launch_scene: launch.scene || 0,
      model_level: safe(() => (wx.getDeviceBenchmarkInfo ? wx.getDeviceBenchmarkInfo().modelLevel : '') || '', ''),
      referrer_info: launch.referrerInfo ? JSON.stringify(launch.referrerInfo) : '',
      // 权限
      auth_notification: auth.notificationAuthorized === 'authorized',
      auth_album: auth.albumAuthorized === 'authorized',
      auth_camera: auth.cameraAuthorized === 'authorized',
      auth_location: auth.locationAuthorized === 'authorized',
      auth_mic: auth.microphoneAuthorized === 'authorized',
      // 屏幕 / 深色 / 电池
      dark_mode: base.theme === 'dark',
      screen_w: win.screenWidth || 0,
      screen_h: win.screenHeight || 0,
      battery_level: battery.level != null ? battery.level : -1,
      is_charging: !!battery.charging,
      created_at: new Date(),
    };

    analytics.collectSession(session).catch(() => {});
  });
}
