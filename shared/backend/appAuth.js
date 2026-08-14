/**
 * 多小程序共用登录 / 用户模块（登录逻辑共用）
 *
 * 所有小程序走同一套静默注册与资料逻辑：
 * - openid 以「去 AppID 前缀」后的规范值存储（X-WX-OPENID 在共享环境下可能带 "{AppID}_" 前缀，
 *   这里统一剥离，与历史无前缀数据保持兼容，避免共享环境绑定后老用户数据失联）
 * - users.app_id 记录来源小程序，提供显式隔离与后台筛选维度
 * - 登录/资料修改事件统一经 events.logEvent 入库（带 app_id）
 */
const { db } = require("./db");
const { genUserUid, nowSql } = require("./utils");
const { publicUrl } = require("./storage");
const { logEvent } = require("./events");

/** 头像默认取昵称第一个字符；若为小写字母则转大写 */
function avatarCharFromNickname(nickname) {
  const n = String(nickname || "").trim();
  if (!n) return "微";
  const ch = n.charAt(0);
  return /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
}

/** 生成唯一 10 位数字用户ID（碰撞重试） */
async function genUniqueUserUid() {
  for (let i = 0; i < 5; i++) {
    const uid = genUserUid();
    const { data, error } = await db.from("users").select("user_uid").eq("user_uid", uid).limit(1);
    if (error) throw error;
    if (!data || !data[0]) return uid;
  }
  return genUserUid();
}

/** 组装用户资料返回体 */
function buildProfile(u) {
  return {
    appId: u.app_id || "learning-planet",
    userId: u.user_uid || "",
    nickname: u.nickname || "微信用户",
    avatar: u.avatar || "",          // 128px 相对路径
    avatarHd: u.avatar_hd || "",     // 512px 相对路径
    avatarUrl: u.avatar ? publicUrl(u.avatar) : "",
    avatarHdUrl: u.avatar_hd ? publicUrl(u.avatar_hd) : "",
    avatarChar: avatarCharFromNickname(u.nickname || "微信用户"),
    gender: u.gender != null ? Number(u.gender) : 0,
    profileReviewStatus: u.profile_review_status || "approved",
    nicknamePending: u.nickname_pending || "",
    avatarPending: u.avatar_pending || "",
    genderPending: u.gender_pending != null ? Number(u.gender_pending) : 0,
  };
}

/**
 * 剥离共享环境 openid 前缀：若 raw 形如 "{wechatAppid}_{openid}"，返回 openid；否则原样返回
 * @param {string} rawOpenid  X-WX-OPENID 原值
 * @param {string} wechatAppid 当前小程序的微信 AppID
 */
function normalizeOpenid(rawOpenid, wechatAppid) {
  const raw = String(rawOpenid || "");
  if (wechatAppid && raw.startsWith(`${wechatAppid}_`)) {
    return raw.slice(wechatAppid.length + 1);
  }
  return raw;
}

/**
 * 静默注册/查询用户（所有小程序共用）
 * - 先按 app_id + openid 精确查；查不到再按 app_id + 无前缀 legacy openid 查（兼容迁移期数据）
 * - 都不存在则静默注册新用户（默认昵称「微信用户」）
 * @param {object} app 当前小程序（{ app_id, app_name, wechat_appid }）
 * @param {string} openid 已规范化的 openid
 */
async function ensureUser(app, openid) {
  const appId = (app && app.app_id) || "learning-planet";
  const lookupList = [openid];

  // 若当前传入 openid 仍带前缀（理论上已规范化），补一次去前缀查找；反之亦然
  const wechatAppid = (app && app.wechat_appid) || "";
  if (wechatAppid && String(openid).startsWith(`${wechatAppid}_`)) {
    lookupList.push(String(openid).slice(wechatAppid.length + 1));
  }

  for (const key of lookupList) {
    let q = db.from("users").select().eq("openid", key);
    if (appId) q = q.eq("app_id", appId);
    const { data: rows, error } = await q.limit(1);
    if (error) throw error;
    if (rows && rows.length > 0) {
      const u = rows[0];
      // 存量用户补全 user_uid（兼容旧数据）
      if (!u.user_uid) {
        const uid = await genUniqueUserUid();
        await db.from("users").update({ user_uid: uid }).eq("user_id", u.user_id);
        u.user_uid = uid;
      }
      return u;
    }
  }

  const user = {
    openid,
    app_id: appId,
    user_uid: await genUniqueUserUid(),
    nickname: "微信用户",
    avatar_emoji: "微",
    gender: 0,
    user_status: 1,
  };
  await db.from("users").insert(user);
  return user;
}

/** 记录登录/首次进入事件（登录逻辑共用的埋点） */
function logLoginEvent({ app, openid, userId, pagePath }) {
  const appId = (app && app.app_id) || "learning-planet";
  logEvent({
    appId,
    openid,
    eventType: "login",
    eventName: "登录小程序",
    pagePath: pagePath || "/pages/index/index",
    extra: { isFirst: false, userId: userId || "" },
  });
}

module.exports = { avatarCharFromNickname, genUniqueUserUid, buildProfile, normalizeOpenid, ensureUser, logLoginEvent };
