/**
 * 用户业务路由（@cloudbase/node-sdk RDB MySQL）
 * - 登录逻辑共用：静默注册 / 资料审核 / 埋点统一走 appAuth（多小程序共享）
 * - 静默注册：默认昵称「微信用户」，头像默认取昵称首字符（字母大写）
 * - 用户ID：随机 10 位数字（users.user_uid）
 * - 昵称/头像/性别修改需审核：写入 *_pending + profile_review_status=pending，审核通过后才生效
 */
const express = require("express");
const { db } = require("../db");
const { ok, fail } = require("../response");
const { nowSql } = require("../utils");
const { logEvent } = require("../events");
const { ensureUser, buildProfile, avatarCharFromNickname } = require("../appAuth");

const router = express.Router();

const appIdOf = (req) => (req.appId || (req.app && req.app.app_id) || "learning-planet");

// ==================== 获取用户资料（静默注册 + 登录事件） ====================
router.get("/getProfile", async (req, res) => {
  try {
    // 判断是否首次注册（登录前不存在 → 静默注册新用户）
    const { data: before, error: beforeErr } = await db.from("users")
      .select("user_id").eq("openid", req.openid).eq("app_id", appIdOf(req)).limit(1);
    if (beforeErr) throw beforeErr;
    const isFirst = !before || before.length === 0;

    const u = await ensureUser(req.app, req.openid);
    const profile = buildProfile(u);

    // 登录/首次注册事件入库（fire-and-forget，失败静默）
    logEvent({
      appId: appIdOf(req),
      openid: req.openid,
      eventType: "login",
      eventName: isFirst ? "首次进入小程序" : "登录小程序",
      pagePath: "/pages/index/index",
      extra: { isFirst, userId: u.user_uid || "" },
    });

    res.json(ok({
      ...profile,
      joinDays: Math.floor((Date.now() - new Date(u.created_at).getTime()) / 86400000),
    }));
  } catch (e) {
    console.error("[user] getProfile error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 更新用户资料（昵称/头像/性别 → 审核流程） ====================
router.post("/updateProfile", async (req, res) => {
  try {
    const { nickname, gender, avatar, avatarHd } = req.body;
    const u = await ensureUser(req.app, req.openid);

    const curNick = u.nickname || "";
    const curAvatar = u.avatar || "";
    const curGender = u.gender != null ? Number(u.gender) : 0;

    const newNick = nickname !== undefined ? String(nickname).trim() : curNick;
    const newAvatar = avatar !== undefined ? String(avatar).trim() : curAvatar;
    const newHd = avatarHd !== undefined ? String(avatarHd).trim() : (u.avatar_hd || "");
    const newGender = gender !== undefined ? Number(gender) : curGender;

    const nickChanged = newNick !== curNick;
    const avatarChanged = newAvatar !== curAvatar;
    const genderChanged = newGender !== curGender;

    if (!nickChanged && !avatarChanged && !genderChanged) {
      return res.json(ok(null, "资料未发生变化"));
    }

    // 昵称变更时同步更新头像字符（保持默认头像与昵称一致）
    const emoji = nickChanged ? avatarCharFromNickname(newNick) : (u.avatar_emoji || "");

    const values = { updated_at: nowSql() };
    if (nickChanged) {
      values.nickname_pending = newNick;
      values.avatar_emoji = emoji;
    }
    if (avatarChanged) {
      values.avatar_pending = newAvatar;
      values.avatar_hd_pending = newHd;
    }
    if (genderChanged) values.gender_pending = newGender;
    values.profile_review_status = "pending";
    values.profile_reviewed_at = null;
    values.profile_reviewer = "";

    const { error } = await db.from("users").update(values).eq("openid", req.openid).eq("app_id", appIdOf(req));
    if (error) throw error;

    // 资料修改事件入库
    logEvent({
      appId: appIdOf(req),
      openid: req.openid,
      eventType: "update",
      eventName: "修改用户资料",
      pagePath: "/pages/mine/index",
      extra: { changed: { nickname: nickChanged, avatar: avatarChanged, gender: genderChanged } },
    });

    const fresh = await ensureUser(req.app, req.openid);
    res.json(ok(buildProfile(fresh), "已提交，审核通过后生效"));
  } catch (e) {
    console.error("[user] updateProfile error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 保存昵称（兼容旧接口，走审核流程） ====================
router.post("/saveProfile", async (req, res) => {
  try {
    const { nickname } = req.body;
    if (!nickname) return res.json(fail("昵称不能为空"));

    const u = await ensureUser(req.app, req.openid);
    const values = { updated_at: nowSql(), profile_review_status: "pending" };
    if (String(nickname).trim() !== (u.nickname || "")) {
      values.nickname_pending = String(nickname).trim();
      values.avatar_emoji = avatarCharFromNickname(String(nickname).trim());
    } else {
      delete values.profile_review_status;
    }
    const { error } = await db.from("users").update(values).eq("openid", req.openid).eq("app_id", appIdOf(req));
    if (error) throw error;
    res.json(ok(null, "已提交，审核通过后生效"));
  } catch (e) {
    console.error("[user] saveProfile error", e);
    res.json(fail("服务异常", 500));
  }
});

module.exports = router;
