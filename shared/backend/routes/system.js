/**
 * 系统业务路由（@cloudbase/node-sdk RDB MySQL）
 * 清空数据 / 补全主键编码（开发者维护用）
 */
const express = require("express");
const { db } = require("../db");
const { ok, fail } = require("../response");

const router = express.Router();

// ==================== 清空全部数据 ====================
router.post("/clearAll", async (req, res) => {
  try {
    const tables = ["users", "user_sessions"];
    const cleared = [];
    for (const name of tables) {
      const { error } = await db.from(name).delete().eq("openid", req.openid);
      if (error) throw error;
      cleared.push({ collection: name });
    }
    res.json(ok({ cleared }, "已清空全部数据"));
  } catch (e) {
    console.error("[system] clearAll error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 接口调用日志（最近 50 条） ====================
router.get("/traceList", async (req, res) => {
  try {
    const { data: rows, error } = await db.from("api_trace")
      .select()
      .eq("openid", req.openid)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;

    const list = (rows || []).map(item => ({
      request_id: item.request_id,
      path: item.api_path,
      method: item.api_method,
      server_cost_ms: item.server_cost_ms,
      server_code: item.server_code,
      http_status: item.http_status,
      client_fingerprint: item.client_fingerprint || "",
      client_cost_ms: item.client_cost_ms,
      start_time: item.start_time,
      end_time: item.end_time,
      status: item.trace_status,
      req_params: item.req_params,
      created_at: item.created_at,
    }));
    res.json(ok({ list }));
  } catch (e) {
    console.error("[system] traceList error", e);
    res.json(fail("服务异常", 500));
  }
});

module.exports = router;
