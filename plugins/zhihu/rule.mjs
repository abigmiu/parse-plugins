// @source https://github.com/frostming/fxzhihu
// @file src/answer.ts
// @file src/article.ts
// @file src/question.ts
// @file src/status.ts
// @file src/lib.ts
// @file src/zhihu-sign.ts
// @license MIT
// @commit 24403bfe80a07f6299ea6fba5374b2f2dcec2ff1
// @adapted fetch -> ctx.http.request; env.Z_C0/D_C0/ZSE_CK -> ctx.cookies.header;
//   HTMLRewriter / HTML 模板 -> zhihu-extract.mjs + RuleResult（content/format=html，
//   ADR-0002）；logger -> ctx.log。
// @extended answer 在缺少 z_c0 时回退到浏览器匿名 Cookie（__zse_ck/d_c0）并签名；
//   question 请求同时发送 Cookie + x-zse-96（上游未签名，实测无签名 403 10003）；
//   article/question 在 d_c0 存在时签名；content 超过 1 MiB 时截断。
// @omitted HTML 页面模板、参考文献列表、origin_pin 转发渲染、专栏信息卡片；
//   /zvideo/ 交给 ytdlp 规则，/column/ 不是单条内容，均不匹配本规则。
//
// 请求顺序（与上游一致）：
//   answer: GET /api/v4/answers/<id>?include=...；有 z_c0 时 UA "node"、只带 z_c0、
//     不签名（上游行为）；没有 z_c0 时发浏览器匿名 Cookie（__zse_ck/d_c0），
//     有 d_c0 时签名；
//   article: GET /api/v4/articles/<id>，UA "Mozilla/5.0"，全量 Cookie + x-zse-96；
//   question: GET /api/v4/questions/<id>?include=...，UA "node"，全量 Cookie + x-zse-96；
//   pin: GET /api/v4/pins/<id>，UA "Mozilla/5.0"，不带 Cookie。

import {
  buildAnswerResult,
  buildArticleResult,
  buildPinResult,
  buildQuestionResult,
} from "./zhihu-extract.mjs";
import {
  buildZhihuCookie,
  getCookieValue,
  getSignedZhihuHeaders,
} from "./zhihu-sign.mjs";

export const meta = {
  id: "zhihu",
  name: "知乎",
  types: ["richtext", "video", "image"],
  match: {
    // 不要改成 hosts: ["zhihu.com"]：那会抢占 /zvideo/，让 ytdlp 兜底永远不执行。
    // 该正则只匹配回答/问题/专栏/想法，排除 /zvideo/ 与 /column/。
    hosts: [],
    patterns: [
      "(?i)^https?://(?:[a-z0-9-]+\\.)*zhihu\\.com/(?:question/\\d+(?:/answer/\\d+)?|answer/\\d+|p/\\d+|pin/\\d+)(?:[/?#]|$)",
    ],
  },
  version: "0.1.0",
  source: "https://github.com/frostming/fxzhihu",
  license: "MIT",
  proxy: [{ hosts: ["zhimg.com", "vzuu.com"], referer: "https://www.zhihu.com/" }],
};

const REQUEST_TIMEOUT_MS = 10000;
// 上游对 answer/question 使用 "node" UA，对 article/pin 使用 "Mozilla/5.0"。
const UA_NODE = "node";
const UA_BROWSER = "Mozilla/5.0";

function firstURL(ctx) {
  const direct = String(ctx.request.url || "").trim();
  if (direct) return direct;
  const text = String(ctx.request.text || "");
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0] : "";
}

/** 只按 pathname 分派；query 不参与识别。 */
function classify(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "zhihu.com" && !host.endsWith(".zhihu.com")) return null;

  const path = String(parsed.pathname || "").replace(/\/+$/, "") || "/";
  let match;
  if ((match = path.match(/^\/question\/(\d+)\/answer\/(\d+)$/))) {
    return { kind: "answer", id: match[2] };
  }
  if ((match = path.match(/^\/answer\/(\d+)$/))) {
    return { kind: "answer", id: match[1] };
  }
  if ((match = path.match(/^\/question\/(\d+)$/))) {
    return { kind: "question", id: match[1] };
  }
  if ((match = path.match(/^\/p\/(\d+)$/))) {
    return { kind: "article", id: match[1] };
  }
  if ((match = path.match(/^\/pin\/(\d+)$/))) {
    return { kind: "pin", id: match[1] };
  }
  return null;
}

async function request(ctx, url, headers) {
  try {
    return await ctx.http.request({ url, headers, timeoutMs: REQUEST_TIMEOUT_MS });
  } catch (error) {
    if (error && error.code) throw error;
    ctx.log.error("Error requesting zhihu: " + (error && error.message ? error.message : String(error)));
    return ctx.fail("UPSTREAM_ERROR", "知乎接口请求失败");
  }
}

function parseJSON(ctx, res) {
  try {
    return ctx.json.parse(res.body);
  } catch {
    return null;
  }
}

function errorInfo(data) {
  return data && data.error ? data.error : null;
}

function isLoginPage(res) {
  const finalURL = String(res.url || "");
  if (/\/(?:signin|account\/unhuman)/i.test(finalURL)) return true;
  const contentType = String((res.headers || {})["content-type"] || "");
  const body = String(res.body || "").trim();
  return contentType.includes("text/html") && body.startsWith("<");
}

function isNotFound(error) {
  return Boolean(error) && Number(error.code) === 4041;
}

/** article/question 共用：403/10003 都视为需要 Cookie；404/4041 为不存在。 */
function handleSignedResponse(ctx, res, label) {
  if (isLoginPage(res) || res.status === 401 || res.status === 403) {
    return ctx.fail("COOKIE_REQUIRED", `知乎${label}需要登录 Cookie（z_c0 + d_c0）`);
  }
  if (res.status === 404) {
    return ctx.fail("MEDIA_NOT_FOUND", `知乎${label}不存在或已删除`);
  }
  if (res.status < 200 || res.status >= 300) {
    const error = errorInfo(parseJSON(ctx, res));
    if (isNotFound(error)) {
      return ctx.fail("MEDIA_NOT_FOUND", `知乎${label}不存在或已删除`);
    }
    return ctx.fail("UPSTREAM_ERROR", `知乎接口请求失败 (${res.status})`);
  }
  const data = parseJSON(ctx, res);
  if (!data) {
    return ctx.fail("UPSTREAM_CHANGED", `知乎${label}响应解析失败`);
  }
  const error = errorInfo(data);
  if (error) {
    if (error.need_login) {
      return ctx.fail("COOKIE_REQUIRED", `知乎${label}需要登录 Cookie（z_c0 + d_c0）`);
    }
    if (isNotFound(error)) {
      return ctx.fail("MEDIA_NOT_FOUND", `知乎${label}不存在或已删除`);
    }
    return ctx.fail("UPSTREAM_CHANGED", `知乎${label}返回错误：${error.message || error.code || "unknown"}`);
  }
  return data;
}

async function parseAnswer(ctx, id) {
  const cookie = buildZhihuCookie(ctx.cookies.header);
  const zc0 = getCookieValue(cookie, "z_c0");
  const dC0 = getCookieValue(cookie, "d_c0");
  const zseCk = getCookieValue(cookie, "__zse_ck");
  // 浏览器不登录也能看回答：它执行知乎的 zse-ck 挑战脚本拿到 __zse_ck，
  // 之后请求带上这份匿名 Cookie。没有 z_c0 时按匿名会话处理。
  if (!zc0 && !zseCk && !dC0) {
    return ctx.fail(
      "COOKIE_REQUIRED",
      "知乎回答需要浏览器 Cookie（z_c0，或匿名会话 d_c0/__zse_ck）；未发送请求"
    );
  }
  const url = `https://www.zhihu.com/api/v4/answers/${id}?include=content,excerpt,voteup_count,comment_count,question.detail`;
  // 有 z_c0 时与上游一致：只发 z_c0、UA "node"、不签名。
  // 没有 z_c0 时使用浏览器匿名 Cookie，并在有 d_c0 时补 x-zse-96。
  const headers = zc0
    ? {
        "User-Agent": UA_NODE,
        Cookie: `z_c0=${zc0}`,
      }
    : {
        "User-Agent": UA_BROWSER,
        Cookie: cookie,
        ...(dC0 ? getSignedZhihuHeaders(url, dC0) : {}),
      };
  const res = await request(ctx, url, headers);

  if (isLoginPage(res) || res.status === 401 || res.status === 403) {
    return ctx.fail(
      "COOKIE_REQUIRED",
      "知乎回答需要浏览器 Cookie（z_c0，或匿名会话 d_c0/__zse_ck）"
    );
  }
  if (res.status === 404) {
    return ctx.fail("MEDIA_NOT_FOUND", "知乎回答不存在或已删除");
  }
  if (res.status < 200 || res.status >= 300) {
    const error = errorInfo(parseJSON(ctx, res));
    if (isNotFound(error)) {
      return ctx.fail("MEDIA_NOT_FOUND", "知乎回答不存在或已删除");
    }
    return ctx.fail("UPSTREAM_ERROR", `知乎接口请求失败 (${res.status})`);
  }

  const data = parseJSON(ctx, res);
  if (!data) {
    return ctx.fail("UPSTREAM_CHANGED", "知乎回答响应解析失败");
  }
  const error = errorInfo(data);
  if (error) {
    if (error.need_login) {
      return ctx.fail(
        "COOKIE_REQUIRED",
        "知乎回答需要浏览器 Cookie（z_c0，或匿名会话 d_c0/__zse_ck）"
      );
    }
    if (isNotFound(error)) {
      return ctx.fail("MEDIA_NOT_FOUND", "知乎回答不存在或已删除");
    }
    return ctx.fail("UPSTREAM_CHANGED", `知乎回答返回错误：${error.message || error.code || "unknown"}`);
  }

  const result = buildAnswerResult(data, id);
  if (!result) {
    return ctx.fail("MEDIA_NOT_FOUND", "知乎回答没有可解析的正文或媒体");
  }
  return result;
}

async function parseArticle(ctx, id) {
  const cookie = buildZhihuCookie(ctx.cookies.header);
  const dC0 = getCookieValue(cookie, "d_c0");
  const url = `https://www.zhihu.com/api/v4/articles/${id}`;
  const headers = {
    "User-Agent": UA_BROWSER,
    ...(cookie ? { Cookie: cookie } : {}),
    ...(dC0 ? getSignedZhihuHeaders(url, dC0) : {}),
  };
  const res = await request(ctx, url, headers);
  const data = handleSignedResponse(ctx, res, "专栏文章");

  const result = buildArticleResult(data, id);
  if (!result) {
    return ctx.fail("MEDIA_NOT_FOUND", "知乎专栏文章没有可解析的正文或媒体");
  }
  return result;
}

async function parseQuestion(ctx, id) {
  const cookie = buildZhihuCookie(ctx.cookies.header);
  const dC0 = getCookieValue(cookie, "d_c0");
  const url = `https://www.zhihu.com/api/v4/questions/${id}?include=detail,excerpt,author,answer_count`;
  const headers = {
    "User-Agent": UA_NODE,
    ...(cookie ? { Cookie: cookie } : {}),
    ...(dC0 ? getSignedZhihuHeaders(url, dC0) : {}),
  };
  const res = await request(ctx, url, headers);
  const data = handleSignedResponse(ctx, res, "问题");

  const result = buildQuestionResult(data, id);
  if (!result) {
    return ctx.fail("MEDIA_NOT_FOUND", "知乎问题没有可解析的正文或媒体");
  }
  return result;
}

async function parsePin(ctx, id) {
  const url = `https://www.zhihu.com/api/v4/pins/${id}`;
  const res = await request(ctx, url, { "User-Agent": UA_BROWSER });

  if (res.status === 403) {
    return ctx.fail("RISK_CONTROL", "知乎想法触发风控，请稍后重试");
  }
  if (res.status === 404) {
    return ctx.fail("MEDIA_NOT_FOUND", "知乎想法不存在或已删除");
  }
  if (res.status < 200 || res.status >= 300) {
    const error = errorInfo(parseJSON(ctx, res));
    if (isNotFound(error)) {
      return ctx.fail("MEDIA_NOT_FOUND", "知乎想法不存在或已删除");
    }
    return ctx.fail("UPSTREAM_ERROR", `知乎接口请求失败 (${res.status})`);
  }

  const data = parseJSON(ctx, res);
  if (!data) {
    return ctx.fail("UPSTREAM_CHANGED", "知乎想法响应解析失败");
  }
  const error = errorInfo(data);
  if (error) {
    if (isNotFound(error)) {
      return ctx.fail("MEDIA_NOT_FOUND", "知乎想法不存在或已删除");
    }
    return ctx.fail("UPSTREAM_CHANGED", `知乎想法返回错误：${error.message || error.code || "unknown"}`);
  }

  const result = buildPinResult(data, id);
  if (!result) {
    return ctx.fail("MEDIA_NOT_FOUND", "知乎想法没有可解析的正文或媒体");
  }
  return result;
}

export async function parse(ctx) {
  const input = firstURL(ctx);
  if (!input) {
    return ctx.fail("URL_NOT_FOUND", "未找到知乎链接");
  }

  const target = classify(input);
  if (!target) {
    return ctx.fail(
      "PLATFORM_NOT_SUPPORTED",
      "不支持的知乎链接类型：仅支持回答、问题、专栏文章和想法"
    );
  }

  try {
    let result;
    if (target.kind === "answer") {
      result = await parseAnswer(ctx, target.id);
    } else if (target.kind === "article") {
      result = await parseArticle(ctx, target.id);
    } else if (target.kind === "question") {
      result = await parseQuestion(ctx, target.id);
    } else {
      result = await parsePin(ctx, target.id);
    }

    if (!result || !result.type) {
      // ctx.fail 已经抛出；这里只兜住异常返回值。
      return ctx.fail("UPSTREAM_CHANGED", "知乎解析结果为空");
    }

    ctx.log.info(
      "解析知乎 " +
        target.kind +
        " " +
        target.id +
        " 成功（" +
        result.type +
        (result.title ? "：" + String(result.title).slice(0, 30) : "") +
        "）"
    );
    return result;
  } catch (error) {
    if (error && error.code) throw error;
    ctx.log.error(
      "Error in zhihu rule: " + (error && error.message ? error.message : String(error))
    );
    return ctx.fail("UPSTREAM_ERROR", "知乎解析失败");
  }
}
