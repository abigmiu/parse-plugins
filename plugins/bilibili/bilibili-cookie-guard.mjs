// @source https://github.com/hotier/MediaGet
// @file packages/parse-core/src/lib/bilibili-cookie-guard.js
// @license MIT
// @commit 17603b8a5404b4dc7408b5c44dae441ea9d2996f
// @adapted 失败归类纯函数原样复制；额外把归类映射到规则契约错误码（code 字段）。
// @omitted createBiliCookieGuard 连续失败状态机与 createBiliHealthProbe nav 健康探测：
//   两者只产出日志/告警，RuleResult 没有对应字段；规则也不保留模块级可变状态。

/** 失败归类枚举 */
export const BILI_FAILURE = {
  OK: "ok",
  NOT_FOUND: "not_found", // 稿件不存在/已删除（-404），与 Cookie 无关
  NO_CONFIG: "no_config", // 未配置 Cookie 被风控 → 提示稍后重试
  COOKIE_STALE: "cookie_stale", // 已配置 Cookie 仍被风控 → Cookie 疑似失效
  OTHER: "other", // 其余失败（参数错/服务器异常等）
};

/** 各归类对访问者展示的 msg（文案刻意简短；详细运维提示走日志） */
export const BILI_FAILURE_MSG = {
  [BILI_FAILURE.NO_CONFIG]: "B站接口被风控拦截，请稍后重试",
  [BILI_FAILURE.COOKIE_STALE]:
    "B站接口被风控拦截（服务器 Cookie 疑似失效），请稍后重试",
  [BILI_FAILURE.NOT_FOUND]: "视频不存在或已删除",
  [BILI_FAILURE.OTHER]: "解析失败！",
};

/** 规则契约错误码映射（docs/rule-contract.md §5） */
export const BILI_FAILURE_CODE = {
  [BILI_FAILURE.NOT_FOUND]: "MEDIA_NOT_FOUND",
  [BILI_FAILURE.NO_CONFIG]: "RISK_CONTROL",
  [BILI_FAILURE.COOKIE_STALE]: "RISK_CONTROL",
  [BILI_FAILURE.OTHER]: "UPSTREAM_ERROR",
};

/** 宿主注入的 Cookie 里是否包含登录态 SESSDATA（等价上游 hasBiliCookie 判定） */
export function hasSessdataCookie(cookie) {
  return Boolean(cookie && /SESSDATA=[^;]+/.test(String(cookie)));
}

/**
 * 把一次失败响应归类。
 * @param {{ cookieConfigured?: boolean, jsonCode?: number|null }} input
 *        jsonCode 为 null 表示响应非 JSON（WAF HTML / -412 形态，bilibiliRequest 返回 null）。
 * @returns {{ kind: string, cookieStale: boolean, msg: string, code: string }}
 */
export function classifyBiliFailure({
  cookieConfigured = false,
  jsonCode = null,
} = {}) {
  const stale = () => ({
    kind: BILI_FAILURE.COOKIE_STALE,
    cookieStale: true,
    msg: BILI_FAILURE_MSG[BILI_FAILURE.COOKIE_STALE],
    code: BILI_FAILURE_CODE[BILI_FAILURE.COOKIE_STALE],
  });
  const noConfig = () => ({
    kind: BILI_FAILURE.NO_CONFIG,
    cookieStale: false,
    msg: BILI_FAILURE_MSG[BILI_FAILURE.NO_CONFIG],
    code: BILI_FAILURE_CODE[BILI_FAILURE.NO_CONFIG],
  });

  // 非 JSON（WAF HTML 拦截）：配置了 Cookie 仍被拦 → 大概率 Cookie 失效/被标记
  if (jsonCode === null) {
    return cookieConfigured ? stale() : noConfig();
  }

  switch (jsonCode) {
    // 稿件不存在/已删除。实测非法/不存在的 BV 会返回 -400（上游归入 other），
    // 宿主契约下同样按“内容不存在”处理，给出 404 而不是 500。
    case -404:
    case -400:
      return {
        kind: BILI_FAILURE.NOT_FOUND,
        cookieStale: false,
        msg: BILI_FAILURE_MSG[BILI_FAILURE.NOT_FOUND],
        code: BILI_FAILURE_CODE[BILI_FAILURE.NOT_FOUND],
      };
    case -101: // 未登录（带失效 SESSDATA 也会触发）
      return cookieConfigured ? stale() : noConfig();
    case -352: // 风控校验失败（环境/凭证不被信任）
    case -412: // 请求被拦截（偶发以 JSON 形态返回）
    case -799: // 空间类接口风控，需登录
      return cookieConfigured ? stale() : noConfig();
    default:
      return {
        kind: BILI_FAILURE.OTHER,
        cookieStale: false,
        msg: BILI_FAILURE_MSG[BILI_FAILURE.OTHER],
        code: BILI_FAILURE_CODE[BILI_FAILURE.OTHER],
      };
  }
}
