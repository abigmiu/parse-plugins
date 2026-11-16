// @source https://github.com/hotier/MediaGet
// @file packages/parse-core/src/lib/douyinCore.js
// @license MIT
// @commit 17603b8a5404b4dc7408b5c44dae441ea9d2996f
// @adapted guardedFetch/fetchWithTimeout -> ctx.http.request; getConfigOrEnv(DOUYIN_COOKIE)
//   -> ctx.cookies.header; logger -> ctx.log; module-level ttwid cache -> per-request
//   Set-Cookie parsing + host cookie jar; { code, msg, data } -> RuleResult.
// @omitted DoH/IP 直连兜底（依赖 node:https，属于宿主网络能力）；公共解析 API 兜底
//   （会把用户链接发给第三方，默认不启用）；博主主页统计（RuleResult 没有对应字段）。
//
// 纯提取逻辑在同目录 douyin-extract.mjs（对应上游 douyin-extract.js）。
// 请求顺序、UA 轮询、ttwid 二次握手和字段路径均保持上游原样；改这些属于重写。

import {
  hasValidData,
  tryParseEmbedded,
  parseVideoData,
  extractFilterReason,
  isChallengeHtml,
  extractIdFromUrl,
  isUserProfileUrl,
  extractTtwid,
  toRuleResult,
} from "./douyin-extract.mjs";

export const meta = {
  id: "douyin",
  name: "抖音",
  types: ["video", "image"],
  match: {
    hosts: ["douyin.com", "iesdouyin.com"],
    patterns: [],
  },
  version: "0.1.0",
  source: "https://github.com/hotier/MediaGet",
  license: "MIT",
  proxy: [
    {
      hosts: [
        "douyin.com",
        "douyinpic.com",
        "douyinpic.cn",
        "douyinstatic.com",
        "douyinvod.com",
        "iesdouyin.com",
        "byteimg.com",
      ],
      referer: "https://www.douyin.com/",
    },
  ],
};

// 与上游 lib/http.ts 的 TIMEOUT.DEFAULT 保持一致。
const REQUEST_TIMEOUT_MS = 8000;
const SHARE_PAGE_TIMEOUT_MS = 10000;
// 分享页最坏情况 2 轮 × 3 组 UA × 4 个 URL，用 20s 硬预算兜底。
const SHARE_BUDGET_MS = 20000;

const UA_IOS_SAFARI_16_6 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

// 顺序关键：抖音 App UA（aweme/...）实测是唯一会下发 ttwid 的 UA，
// 必须先用它建立 ttwid，再带 ttwid 用其他 UA 请求数据。
const MOBILE_HEADERS = {
  "User-Agent": UA_IOS_SAFARI_16_6,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

const UA_SETS = [
  {
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 aweme/32.7.0 NetType/WIFI Channel/App Store",
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "zh-CN,zh;q=0.9",
  },
  MOBILE_HEADERS,
  {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
  },
];

export async function parse(ctx) {
  const url = ctx.request.url || "";
  if (!url) {
    return ctx.fail("URL_NOT_FOUND", "未找到抖音链接");
  }

  // 上游这里读 process.env.DOUYIN_COOKIE；宿主按平台注入，规则只读。
  const douyinCookie = String(ctx.cookies.header || "");

  try {
    // ---- Step 1: 从短链 / 分享链接中提取视频 ID 和完整重定向 URL ----
    const extractResult = await extractIdAndRedirectUrl(ctx, url);
    if (extractResult && extractResult.type === "user") {
      return ctx.fail(
        "INVALID_TEXT",
        "该链接是抖音用户主页，不是视频链接：请打开具体视频或图文，点「分享」复制链接后再解析"
      );
    }
    if (!extractResult || extractResult.networkError) {
      ctx.log.warn(
        "抖音链接访问失败: " + (extractResult && extractResult.error ? extractResult.error : "无法提取视频 ID")
      );
      return ctx.fail("UPSTREAM_ERROR", "访问抖音短链失败（网络/DNS 异常）：请确认当前网络能打开该链接，或稍后重试");
    }

    const id = extractResult.id;
    const contentType = extractResult.type;
    const redirectUrl = extractResult.redirectUrl || "";
    const sharePath = contentType === "note" ? "note" : "video";

    // 抖音标准 aweme_id 为 19 位数字；17-19 位视为合法，明显非法的伪 ID 不发请求。
    if (!/^\d{17,19}$/.test(id)) {
      ctx.log.warn("Douyin invalid video id format: " + id);
      return ctx.fail("INVALID_TEXT", "解析失败：链接中的视频 ID 格式不正确，请确认链接来自抖音分享");
    }

    // ---- Step 2: 从分享页获取 SSR 数据 ----
    // 优先使用完整重定向 URL（含 share_version / share_sign 等参数）以降低被过滤概率。
    let shareUrl = redirectUrl || "https://www.iesdouyin.com/share/" + sharePath + "/" + id;
    if (shareUrl.includes("www.douyin.com")) {
      const params = shareUrl.includes("?") ? shareUrl.split("?")[1] : "";
      shareUrl =
        "https://www.iesdouyin.com/share/" + sharePath + "/" + id + (params ? "?" + params : "");
    }

    // 抖音二次握手：匿名首次访问只下发 ttwid cookie，带 ttwid 的第二次请求才返回数据。
    // 宿主为每次解析维护独立 Cookie jar，但短链域名和分享页域名不同，仍按上游显式携带。
    const ttwidState = { value: extractResult.ttwid || "" };
    const buildFetchHeaders = (ua) => {
      const headers = Object.assign({}, ua);
      const cookies = [];
      if (ttwidState.value && !douyinCookie.includes("ttwid=")) {
        cookies.push(ttwidState.value);
      }
      if (douyinCookie) {
        cookies.push(douyinCookie);
      }
      if (cookies.length > 0) {
        headers.Cookie = cookies.join("; ");
      }
      return headers;
    };

    // 尝试多个域名 / 路径以应对机房 IP 被反爬的情况。
    const tryUrls = [
      shareUrl,
      "https://www.iesdouyin.com/share/" + sharePath + "/" + id,
      "https://m.douyin.com/share/" + sharePath + "/" + id,
      "https://www.douyin.com/video/" + id,
    ];

    const startTime = ctx.now();
    let videoInfo = null;
    let lastHtml = "";
    // 记录最后一次解析出的 _ROUTER_DATA（即使 item_list 为空）：已删除/不存在的视频
    // 会返回 filter_list 而不是数据，需要据此给准确报错。
    let lastRouterData = null;
    let challengeCount = 0;

    for (let round = 0; round < 2 && !videoInfo; round++) {
      for (const ua of UA_SETS) {
        for (const fetchUrl of tryUrls) {
          if (videoInfo) break;
          if (ctx.now() - startTime > SHARE_BUDGET_MS) break;
          try {
            const response = await ctx.http.request({
              url: fetchUrl,
              headers: buildFetchHeaders(ua),
              timeoutMs: REQUEST_TIMEOUT_MS,
            });
            const html = response.body || "";
            lastHtml = html;

            // 从响应头收集 ttwid（App UA 才会下发），供后续请求使用。
            const freshTtwid = extractTtwid(response);
            if (freshTtwid) {
              ttwidState.value = freshTtwid;
            }

            if (html.includes("tiktok.com") || html.includes("访问受限")) {
              continue;
            }

            // 先解析数据，数据有效即胜出；反爬特征只用于无数据时归类报错。
            const parsed = tryParseEmbedded(html);
            if (parsed) {
              if (hasValidData(parsed)) {
                videoInfo = parsed;
                break;
              }
              lastRouterData = parsed;
            } else if (isChallengeHtml(html)) {
              challengeCount++;
              if (ctx.now() - startTime <= SHARE_BUDGET_MS) {
                await ctx.sleep(800);
              }
            }
          } catch (error) {
            // 整次解析超时不要吞掉，交给宿主统一映射。
            if (error && error.code === "PARSE_TIMEOUT") throw error;
            /* 网络异常跳过该 URL，尝试下一个 */
          }
        }
      }
    }

    if (!videoInfo) {
      const filterReason = extractFilterReason(lastRouterData);
      if (filterReason) {
        ctx.log.warn("解析抖音链接 " + id + " 失败：抖音服务端过滤（" + filterReason + "）");
        return ctx.fail(
          "MEDIA_NOT_FOUND",
          "解析失败：抖音服务端过滤了该内容（" + filterReason + "），视频可能已删除或为隐私内容"
        );
      }
      if (challengeCount > 0) {
        ctx.log.warn("解析抖音链接 " + id + " 失败：抖音风控拦截（" + challengeCount + " 次）");
        return ctx.fail(
          "RISK_CONTROL",
          "解析失败：抖音风控拦截了本次请求（网络出口被限流），请稍后重试，或配置有效的抖音 Cookie"
        );
      }
      const snippet = String(lastHtml).replace(/\s+/g, " ").slice(0, 500);
      ctx.log.warn("解析抖音链接 " + id + " 失败：未获取到页面数据。Response: " + snippet);
      return ctx.fail(
        "MEDIA_NOT_FOUND",
        "解析失败：未能从页面获取视频数据，可能是视频不存在、已删除或页面结构变化"
      );
    }

    if (!videoInfo.loaderData) {
      ctx.log.warn("解析抖音链接 " + id + " 失败：视频数据结构异常");
      return ctx.fail("UPSTREAM_CHANGED", "解析失败：视频数据结构异常，可能是抖音接口发生变化");
    }

    // ---- Step 3: 提取视频 / 图文数据 ----
    const parsed = parseVideoData(videoInfo);
    if (!parsed.ok) {
      if (parsed.reason === "author") {
        return ctx.fail("UPSTREAM_CHANGED", "解析失败：视频作者信息缺失");
      }
      if (parsed.reason === "media") {
        return ctx.fail("MEDIA_NOT_FOUND", "解析失败：未找到可解析的视频或图片内容");
      }
      const filterReason = extractFilterReason(videoInfo);
      if (filterReason) {
        return ctx.fail(
          "MEDIA_NOT_FOUND",
          "解析失败：抖音服务端过滤了该内容（" + filterReason + "），部分视频（如实况图、刚发布的内容）暂不支持解析"
        );
      }
      return ctx.fail(
        "MEDIA_NOT_FOUND",
        "解析失败：未能从页面获取视频数据，可能是页面结构变化、接口受限或视频已被删除"
      );
    }

    const data = parsed.data;
    ctx.log.info(
      "解析抖音链接 " + id + " 成功" + (data.title ? "：《" + String(data.title).slice(0, 30) + "》" : "")
    );

    return toRuleResult(data);
  } catch (error) {
    if (error && error.code) throw error;
    ctx.log.error("Error in douyin rule: " + (error && error.message ? error.message : String(error)));
    return ctx.fail("UPSTREAM_ERROR", "抖音解析失败");
  }
}

/**
 * 从 URL 中提取视频 ID 和完整重定向 URL。
 * 返回 { id, type, redirectUrl, ttwid } / { type: "user" } / { networkError: true }。
 */
async function extractIdAndRedirectUrl(ctx, url) {
  try {
    const response = await ctx.http.request({
      url: url,
      headers: MOBILE_HEADERS,
      redirect: true,
      timeoutMs: SHARE_PAGE_TIMEOUT_MS,
    });
    const finalUrl = response.url || url;

    if (isUserProfileUrl(finalUrl)) {
      return { type: "user" };
    }

    const ttwid = extractTtwid(response);
    const result = extractIdFromUrl(finalUrl);
    if (result) return Object.assign({}, result, { redirectUrl: finalUrl, ttwid: ttwid });

    const html = response.body || "";
    const videoCanonical = html.match(/href="https:\/\/www\.iesdouyin\.com\/share\/video\/(\d+)/);
    if (videoCanonical) {
      return { id: videoCanonical[1], type: "video", redirectUrl: finalUrl, ttwid: ttwid };
    }
    const noteCanonical = html.match(/href="https:\/\/www\.iesdouyin\.com\/share\/note\/(\d+)/);
    if (noteCanonical) {
      return { id: noteCanonical[1], type: "note", redirectUrl: finalUrl, ttwid: ttwid };
    }

    const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/);
    if (canonical) {
      const canonicalResult = extractIdFromUrl(canonical[1]);
      if (canonicalResult) {
        return Object.assign({}, canonicalResult, { redirectUrl: canonical[1], ttwid: ttwid });
      }
    }
    return null;
  } catch (error) {
    if (error && error.code === "PARSE_TIMEOUT") throw error;
    ctx.log.error("Error extracting ID: " + (error && error.message ? error.message : String(error)));
    return { networkError: true, error: error && error.message ? error.message : String(error) };
  }
}
