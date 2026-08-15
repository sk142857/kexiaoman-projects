/**
 * Admin 通用 CRUD 引擎
 * 为业务表生成统一的管理接口：list / detail / create / update / delete
 * 权限：readonly 模块所有人只读；其余模块登录后可写（系统仅单一管理员账号）
 */
const express = require("express");
const bcrypt = require("bcryptjs");
const { db } = require("../db");
const { ok, fail } = require("../response");
const { nowSql } = require("../utils");
const { logStaffEvent, tableCn } = require("../staffAudit");
const { sanitize } = require("../trace");

/**
 * 生成某张表的 CRUD 路由
 * @param {object} opts
 *  - table: 表名
 *  - pk: 主键列名
 *  - writable: 数组，可写字段（create/update 允许的列）
 *  - search: 数组，列表可搜索字段（模糊匹配）
 *  - readonly: 是否只读（所有人不可写）
 *  - passwordFields: 数组，其中字段在非空时写入并做 bcrypt 哈希（如 staff_password）
 *  - blankKeep: 数组，其中字段在空白（''/null/undefined）时不写入（编辑留空保持原值），非哈希（如 app_secret）
 *  - exclude: 数组，列表/详情响应中剔除的字段（如密码哈希）
 *  - filters: 数组，列表可等值过滤的字段白名单（如 instance_id/trace_status，防注入）
 *  - timeField: 时间范围过滤字段（默认 created_at），配合查询参数 startTime/endTime
 *  - orderField: 列表排序字段（默认 pk，如 request_id 无序时用 created_at 按创建时间倒序）
 *  - enrichUsers: 是否按 openid 关联用户信息（附加 _userId/_userNickname/_userAvatar 等）
 *  - userField: 关联字段（默认 openid）
 *  - enrich: (rows) => Promise<rows> 列表/详情后附加关联字段（如任务状态）
 *  - scopeFn: (req) => ({ field, value }|null) 写范围：创建/更新/删除时按请求做数据隔离（如非管理员只能改自己创建的）
 *  - readScopeFn: (req) => ({ field, value }|null) 读范围：列表/详情按请求过滤（缺省时等同 scopeFn）
 *  - pkGenerator: (req) => string，主键无自增时的生成器
 *  - defaults: (req) => object，新增时合并进 values（如创建人自动取当前登录 staff_id）
 *  - protectSelf: 布尔，禁止操作自己的记录（如后台员工不能删除/禁用自己，避免锁死后台）
 *  - appField: 小程序维度列名（如 app_id）。设置后列表/详情强制按 req.appId 过滤、
 *    新增自动写入 req.appId、更新/删除限定在 req.appId 内（多小程序后台隔离核心）
 */
function crudRouter(opts) {
  const {
    table, pk, writable = [], search = [], readonly = false,
    passwordFields = [], blankKeep = [], exclude = [], filters = [], timeField = "created_at", orderField = null,
    enrichUsers = false, userField = "openid", scopeFn = null, readScopeFn = null, pkGenerator = null,
    enrich = null, defaults = null, protectSelf = false, appField = null,
    // 业务事件钩子（fire-and-forget 记录业务时间轴等，失败静默）
    onAfterCreate = null, onAfterUpdate = null, onAfterDelete = null,
    // 写前校验钩子：async (req, oldRecord, values) => string|null，返回错误信息则拦截（如已完成任务禁改/禁删）
    onBeforeUpdate = null, onBeforeDelete = null,
    // 新增前钩子：async (req, values) => string|null，可改写 values（如自动生成编码/补齐字段），返回错误信息则拦截
    onBeforeCreate = null,
  } = opts;
  const router = express.Router();

  const cleanRow = (row) => {
    if (!row || exclude.length === 0) return row;
    const o = { ...row };
    for (const k of exclude) delete o[k];
    return o;
  };

  /** 按 openid 批量附加用户信息（user_id/昵称/头像），供后台列表与详情展示 */
  const attachUsers = async (rows) => {
    const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
    if (list.length === 0) return list;
    const openids = [...new Set(list.map(r => r[userField]).filter(Boolean))];
    if (openids.length === 0) return list;
    let userMap = {};
    try {
      const { data: users, error } = await db.from("users")
        .select("openid, user_uid, nickname, avatar, avatar_emoji")
        .in(userField, openids)
        .limit(openids.length);
      if (!error && Array.isArray(users)) {
        userMap = {};
        users.forEach(u => {
          userMap[u.openid] = u;
        });
      }
    } catch (_) { /* 忽略，无用户信息也可展示 */ }
    return list.map(r => {
      const u = userMap[r[userField]] || {};
      const nick = u.nickname || "用户";
      const ch = String(nick).charAt(0);
      return {
        ...r,
        _userId: u.user_uid || "",
        _userNickname: u.nickname || "",
        _userAvatar: u.avatar || "",
        _userAvatarChar: /[a-z]/.test(ch) ? ch.toUpperCase() : ch,
      };
    });
  };

  /** 写权限校验：只读模块一律拒绝 */
  const canWrite = (req, res) => {
    if (readonly) {
      res.json(fail("该模块只读", 403));
      return false;
    }
    return true;
  };

  /** 构建可写字段，密码类字段仅在非空时写入并 bcrypt 哈希 */
  // 注意：undefined 与 null 均跳过，避免 NOT NULL 列收到显式 NULL 报错（如 images 无图时）
  const buildValues = (body) => {
    const values = {};
    writable.forEach(k => {
      if (blankKeep.includes(k) && (body[k] === undefined || body[k] === null || String(body[k]).trim() === "")) return;
      if (body[k] !== undefined && body[k] !== null) values[k] = body[k];
    });
    for (const k of passwordFields) {
      const v = body[k];
      if (v === undefined || v === null || String(v) === "") {
        delete values[k];
      } else {
        values[k] = bcrypt.hashSync(String(v), 10);
      }
    }
    return values;
  };

  // ==================== 列表 ====================
  router.get("/list", async (req, res) => {
    try {
      const { page = 1, pageSize = 20, keyword, order = "desc", startTime, endTime } = req.query;
      // 上限 500：供动态下拉（派发学生/归属账号/绑定用户等 optionsSource）整批加载；分页列表本身受 20/50/100 控制
      const size = Math.min(Number(pageSize) || 20, 500);
      const pageNo = Math.max(1, Number(page) || 1);
      const offset = (pageNo - 1) * size;
      const scope = (readScopeFn || scopeFn) ? (readScopeFn || scopeFn)(req) : null;

      // 过滤条件构建（关键字模糊 + 白名单等值 + 时间范围 + 数据隔离），供列表与总数复用
      // 注意：RDB 查询链必须先 .select() 后才能调用 .eq/.or/.gte/.lte 等；
      // 因此 count 查询单独用 select(pk, { count }) 作为链首调用，避免二次 select 丢失 count 选项
      const applyFilters = (q) => {
        if (appField && req.appId) q = q.eq(appField, req.appId);
        if (scope) q = q.eq(scope.field, scope.value);
        if (keyword && search.length > 0) {
          // 多字段 OR 模糊匹配；过滤 or() 注入危险字符
          const safeKw = String(keyword).replace(/[(),]/g, "").slice(0, 100);
          q = q.or(search.map(f => `${f}.ilike.%${safeKw}%`).join(","));
        }
        // 等值过滤（仅白名单字段）
        for (const f of filters) {
          const v = req.query[f];
          if (v !== undefined && v !== null && v !== "") {
            q = q.eq(f, String(v).slice(0, 200));
          }
        }
        // 时间范围过滤（timeField 白名单，默认 created_at）
        if (startTime) q = q.gte(timeField, String(startTime));
        if (endTime) q = q.lte(timeField, String(endTime));
        return q;
      };

      // 排序字段白名单：仅允许 pk（忽略客户端传入的其他排序字段，防 SQL 注入）
      // 优先用 PostgREST range(offset, offset+size-1) 服务端分页（offset/limit，无 2000 行硬上限）；
      // 网关不支持时回退为拉取 offset+size 行后内存切片实现分页（沿用旧逻辑，确保功能不倒退）
      const sortField = orderField || pk;
      const fetchPage = async () => {
        const rangeRes = await applyFilters(db.from(table).select())
          .order(sortField, { ascending: order !== "desc" })
          .range(offset, offset + size - 1);
        if (!rangeRes.error) return rangeRes.data || [];
        const fetchLimit = Math.min(offset + size, 2000);
        const { data: rows, error } = await applyFilters(db.from(table).select())
          .order(sortField, { ascending: order !== "desc" })
          .limit(fetchLimit);
        if (error) throw error;
        return (rows || []).slice(offset, offset + size);
      };
      // 总数：优先 PostgREST exact count（select(pk, { count }) 必须是链首调用，limit(1) 不影响 count 精确度，避免拉全量主键）；
      // 异常或网关不返回 Content-Range 时回退为拉取全量主键计数，保证分页总条数准确
      const fetchTotal = async () => {
        try {
          const { count, error: cErr } = await applyFilters(db.from(table).select(pk, { count: "exact" })).limit(1);
          if (!cErr && typeof count === "number" && count >= 0) return count;
          const { data: all, error: allErr } = await applyFilters(db.from(table).select(pk)).limit(10000);
          if (!allErr && Array.isArray(all)) return all.length;
          return -1;
        } catch (_) {
          return -1;
        }
      };
      const [paged, exactTotal] = await Promise.all([fetchPage(), fetchTotal()]);
      const total = exactTotal >= 0 ? exactTotal : paged.length;

      const cleaned = paged.map(cleanRow);
      let list = enrichUsers ? await attachUsers(cleaned) : cleaned;
      if (enrich) list = await enrich(list);
      res.json(ok({ list, total, page: pageNo, pageSize: size }));
    } catch (e) {
      console.error(`[admin:${table}] list error`, e);
      res.json(fail("服务异常", 500));
    }
  });

  // ==================== 详情 ====================
  router.get("/detail", async (req, res) => {
    try {
      const { id } = req.query;
      if (!id) return res.json(fail("缺少 ID"));
      const scope = (readScopeFn || scopeFn) ? (readScopeFn || scopeFn)(req) : null;
      let q = db.from(table).select().eq(pk, id);
      if (appField && req.appId) q = q.eq(appField, req.appId);
      if (scope) q = q.eq(scope.field, scope.value);
      const { data: rows, error } = await q.limit(1);
      if (error) throw error;
      let record = cleanRow((rows && rows[0]) || null);
      if (record && enrichUsers) record = (await attachUsers([record]))[0];
      if (record && enrich) record = (await enrich([record]))[0];
      logStaffEvent({ req, staff: req.staff, eventType: "detail", eventName: `查看${tableCn(table)}详情`, module: table, apiPath: `/api/${table}/detail`, bizId: id });
      res.json(ok({ record }));
    } catch (e) {
      console.error(`[admin:${table}] detail error`, e);
      res.json(fail("服务异常", 500));
    }
  });

  // ==================== 新增 ====================
  router.post("/create", async (req, res) => {
    try {
      if (!canWrite(req, res)) return;
      for (const k of passwordFields) {
        const v = req.body[k];
        if (v === undefined || v === null || String(v) === "") {
          return res.json(fail("请填写密码"));
        }
      }
      const values = buildValues(req.body);
      if (Object.keys(values).length === 0) return res.json(fail("无有效字段"));
      if (defaults) Object.assign(values, typeof defaults === "function" ? defaults(req) : defaults);
      if (onBeforeCreate) {
        const err = await onBeforeCreate(req, values);
        if (err) return res.json(fail(err, 400));
      }
      const scope = scopeFn ? scopeFn(req) : null;
      if (scope) values[scope.field] = scope.value;
      if (appField && req.appId && !values[appField]) values[appField] = req.appId;
      if (pkGenerator && !values[pk]) values[pk] = await pkGenerator(req);
      values.created_at = nowSql();
      values.updated_at = nowSql();
      const { error } = await db.from(table).insert(values);
      if (error) throw error;
      if (onAfterCreate) onAfterCreate(req, values, values[pk]);
      logStaffEvent({ req, staff: req.staff, eventType: "create", eventName: `创建${tableCn(table)}`, module: table, apiPath: `/api/${table}/create`, bizId: values[pk], extra: sanitize(values) });
      res.json(ok(null, "创建成功"));
    } catch (e) {
      console.error(`[admin:${table}] create error`, e);
      res.json(fail("服务异常", 500));
    }
  });

  // ==================== 更新 ====================
  router.post("/update", async (req, res) => {
    try {
      if (!canWrite(req, res)) return;
      const { id } = req.body;
      if (!id) return res.json(fail("缺少 ID"));
      // 自我保护：禁止修改自己的账号（如禁用自己的登录），避免锁死后台
      if (protectSelf && String(id) === String((req.staff && req.staff.staff_id) || "")) {
        return res.json(fail("不能修改自己的账号", 403));
      }
      const values = buildValues(req.body);
      if (Object.keys(values).length === 0) return res.json(fail("无有效字段"));
      values.updated_at = nowSql();
      // 业务事件钩子需要旧记录（如判断任务是否完成/记录修改前后值）
      let oldRecord = null;
      if (onAfterUpdate || onBeforeUpdate) {
        const { data: pre, error: preErr } = await db.from(table).select().eq(pk, id).limit(1);
        if (!preErr && pre && pre.length > 0) oldRecord = pre[0];
      }
      if (onBeforeUpdate && oldRecord) {
        const err = await onBeforeUpdate(req, oldRecord, values);
        if (err) return res.json(fail(err, 403));
      }
      const scope = scopeFn ? scopeFn(req) : null;
      // 写范围命中检测：非管理员（如学生）只能修改自己创建的数据
      if (scope) {
        const { data: exist, error: exErr } = await db.from(table).select()
          .eq(pk, id).eq(scope.field, scope.value).limit(1);
        if (exErr) throw exErr;
        if (!(exist && exist.length > 0)) return res.json(fail("无权操作该数据", 403));
      }
      let q = db.from(table).update(values).eq(pk, id);
      if (appField && req.appId) q = q.eq(appField, req.appId);
      if (scope) q = q.eq(scope.field, scope.value);
      const { error } = await q;
      if (error) throw error;
      if (onAfterUpdate && oldRecord) onAfterUpdate(req, values, id, oldRecord);
      logStaffEvent({ req, staff: req.staff, eventType: "update", eventName: `更新${tableCn(table)}`, module: table, apiPath: `/api/${table}/update`, bizId: id, extra: sanitize(values) });
      res.json(ok(null, "更新成功"));
    } catch (e) {
      console.error(`[admin:${table}] update error`, e);
      res.json(fail("服务异常", 500));
    }
  });

  // ==================== 删除 ====================
  router.post("/delete", async (req, res) => {
    try {
      if (!canWrite(req, res)) return;
      const { id } = req.body;
      if (!id) return res.json(fail("缺少 ID"));
      // 自我保护：禁止删除自己的账号，避免锁死后台
      if (protectSelf && String(id) === String((req.staff && req.staff.staff_id) || "")) {
        return res.json(fail("不能删除自己的账号", 403));
      }
      const scope = scopeFn ? scopeFn(req) : null;
      // 写范围命中检测：非管理员（如学生）只能删除自己创建的数据
      if (scope) {
        const { data: exist, error: exErr } = await db.from(table).select()
          .eq(pk, id).eq(scope.field, scope.value).limit(1);
        if (exErr) throw exErr;
        if (!(exist && exist.length > 0)) return res.json(fail("无权操作该数据", 403));
      }
      // 业务事件钩子需要被删记录（如删除任务的快照信息）
      let delRecord = null;
      if (onAfterDelete || onBeforeDelete) {
        const { data: pre, error: preErr } = await db.from(table).select().eq(pk, id).limit(1);
        if (!preErr && pre && pre.length > 0) delRecord = pre[0];
      }
      if (onBeforeDelete && delRecord) {
        const err = await onBeforeDelete(req, delRecord);
        if (err) return res.json(fail(err, 403));
      }
      let q = db.from(table).delete().eq(pk, id);
      if (appField && req.appId) q = q.eq(appField, req.appId);
      if (scope) q = q.eq(scope.field, scope.value);
      const { error } = await q;
      if (error) throw error;
      if (onAfterDelete && delRecord) onAfterDelete(req, delRecord, id);
      logStaffEvent({ req, staff: req.staff, eventType: "delete", eventName: `删除${tableCn(table)}`, module: table, apiPath: `/api/${table}/delete`, bizId: id });
      res.json(ok(null, "已删除"));
    } catch (e) {
      console.error(`[admin:${table}] delete error`, e);
      res.json(fail("服务异常", 500));
    }
  });

  return router;
}

module.exports = { crudRouter };
