// @source https://github.com/hotier/MediaGet
// @file packages/parse-core/src/lib/xhsCore.js
// @license MIT
// @commit 17603b8a5404b4dc7408b5c44dae441ea9d2996f
// @adapted fetchWithTimeout/fetch(redirect:"manual") -> ctx.http.request（宿主
//   Cookie jar 自动保存 Set-Cookie 并跟随重定向）; getConfigOrEnv("xhsCookie") ->
//   ctx.cookies.header; 日志 -> ctx.log; logger/console -> ctx.log; 返回
//   { code, msg, data } -> RuleResult + ctx.fail 错误码。
// @adapted 请求头只保留 User-Agent / Accept / Accept-Language / Cookie，并显式发送
//   空的 Accept-Encoding。上游完整的 sec-ch-ua / sec-fetch-* / Cache-Control 头在
//   非中国大陆出口会被小红书判成爬虫；另外 Go Transport 默认会补上
//   `Accept-Encoding: gzip`，小红书对带该头的请求直接 302 到 /login。
//   把值设为单个空格可阻止 Go 自动补 gzip，服务端收到的等价于空头。
//   实测回归结果见 README。
// @omitted 博主主页统计与 profile token（RuleResult 没有对应字段）、互动统计、
//   模块级 Cookie 池 / 主页缓存（宿主每次解析使用独立 Cookie jar，不跨请求共享）。
// @extended 实况图 live_photo_url：从 noteData.imageList[i].stream 提取，上游未处理。
//
// 请求顺序、字段路径、__INITIAL_STATE__ 清洗和视频档位选择均保持上游原样；
// 纯提取逻辑在同目录 xhs-extract.mjs。改这些属于重写。

import {
  TIMEOUT,
  XHS_USER_AGENT,
  normalizeXhsUrl,
  safeGet,
  detectXhsBlockedPage,
  resolveNotePayload,
  sanitizeInitialStateJson,
  extractInitialStateJson,
  buildVideoMedia,
  buildImageMedia,
} from "./xhs-extract.mjs";

export const meta = {
  id: "xiaohongshu",
  name: "小红书",
  types: ["video", "image"],
  match: {
    hosts: ["xiaohongshu.com", "xhslink.com", "xhslink.cn"],
    patterns: [],
  },
  version: "0.1.0",
  source: "https://github.com/hotier/MediaGet",
  license: "MIT",
  proxy: [
    { hosts: ["xiaohongshu.com", "xhscdn.com"], referer: "https://www.xiaohongshu.com/" },
  ],
};

const ACCEPT_HTML =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3";

/** 小红书会校验请求特征，缺 Accept 时也会被送进登录页；见文件头 @adapted。 */
function xhsHeaders(cookie) {
  const headers = {
    "User-Agent": XHS_USER_AGENT,
    Accept: ACCEPT_HTML,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    // 不能用空字符串：Go 的 Header.Get 返回 "" 时会自动补 gzip；
    // 单个空格能阻止自动补头，服务端按空 Accept-Encoding 处理。
    "Accept-Encoding": " ",
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/**
 * 短链与笔记页：宿主自动跟随重定向并保存 Set-Cookie，因此不再手写 Location
 * 循环；首次链路失败/被风控时，沿用上游逻辑用已保存的 Cookie 重试一次。
 */
async function fetchXhsNoteHtml(ctx, url, attempt = 1) {
  const target = normalizeXhsUrl(url);
  const cookie = String(ctx.cookies.header || "");

  try {
    const response = await ctx.http.request({
      url: target,
      headers: xhsHeaders(cookie),
      timeoutMs: TIMEOUT.PAGE,
    });
    const html = response.body || "";
    const finalUrl = response.url || target;

    // 已落到小红书域但缺页面数据：多半是首次无 Cookie 被风控，
    // 用宿主 Cookie jar 里已保存的 Cookie 整条重试一次。
    if (
      attempt === 1 &&
      !html.includes("__INITIAL_STATE__") &&
      /xiaohongshu\.com|xhslink\.(com|cn)/.test(finalUrl)
    ) {
      ctx.log.info("xhs retry with absorbed cookies, finalUrl: " + finalUrl);
      return fetchXhsNoteHtml(ctx, url, 2);
    }

    return { html, finalUrl };
  } catch (error) {
    // 整次解析超时 / 规则主动抛错不要吞掉，交给宿主统一映射。
    if (error && error.code && error.code !== "UPSTREAM_ERROR") throw error;
    if (attempt === 1) {
      ctx.log.info(
        "xhs fetch error, retry once: " + (error && error.message ? error.message : String(error))
      );
      return fetchXhsNoteHtml(ctx, url, 2);
    }
    throw error;
  }
}

export async function parse(ctx) {
  const url = ctx.request.url || "";
  if (!url) {
    return ctx.fail("URL_NOT_FOUND", "未找到小红书链接");
  }

  try {
    const { html, finalUrl } = await fetchXhsNoteHtml(ctx, url);

    ctx.log.info("xhs finalUrl: " + finalUrl + ", html length: " + (html ? html.length : 0));

    if (!html) {
      return ctx.fail("UPSTREAM_ERROR", "请求失败，未获取到小红书页面内容");
    }

    // 短链没有落到笔记页：重定向失败（上游同款判定）。
    if (
      (finalUrl.includes("xhslink.com") || finalUrl.includes("xhslink.cn")) &&
      !html.includes("__INITIAL_STATE__")
    ) {
      return ctx.fail("UPSTREAM_ERROR", "短链重定向失败，请尝试复制小红书 App 内的分享链接");
    }

    if (
      !finalUrl.includes("xiaohongshu.com") &&
      !html.includes("__INITIAL_STATE__")
    ) {
      return ctx.fail("UPSTREAM_ERROR", "无法打开小红书笔记页，请确认短链有效或使用 App 分享链接");
    }

    // 登录墙 / 404 / 安全验证页同样带 __INITIAL_STATE__，先判定再解析。
    const blocked = detectXhsBlockedPage(finalUrl);
    if (blocked) {
      ctx.log.warn("xhs blocked page, finalUrl: " + finalUrl);
      return ctx.fail(blocked.code, blocked.message);
    }

    let jsonRaw = extractInitialStateJson(html);
    if (!jsonRaw) {
      if (/安全验证|请完成验证|__AC_NONCE__|geetest|verify|captcha/i.test(html)) {
        ctx.log.warn("xhs blocked by safety check, finalUrl: " + finalUrl);
        return ctx.fail("RISK_CONTROL", "小红书触发了安全验证，请稍后重试，或配置有效的 Cookie");
      }
      ctx.log.warn("xhs HTML preview: " + String(html).slice(0, 500));
      return ctx.fail("UPSTREAM_CHANGED", "未找到页面数据，小红书可能更新了页面结构");
    }

    jsonRaw = sanitizeInitialStateJson(jsonRaw);

    let decoded;
    try {
      decoded = JSON.parse(jsonRaw);
    } catch (error) {
      ctx.log.warn("xhs JSON parse error: " + (error && error.message ? error.message : String(error)));
      return ctx.fail("UPSTREAM_CHANGED", "小红书页面数据解析失败");
    }

    if (!decoded || typeof decoded !== "object") {
      return ctx.fail("UPSTREAM_CHANGED", "小红书页面数据格式错误");
    }

    const noteData = resolveNotePayload(decoded);
    if (!noteData || typeof noteData !== "object") {
      ctx.log.warn("xhs decoded keys: " + Object.keys(decoded).join(","));
      return ctx.fail("UPSTREAM_CHANGED", "数据结构不匹配，请检查链接是否为有效的小红书内容");
    }

    const author = {
      nickname:
        safeGet(noteData, "user.nickName") ||
        safeGet(noteData, "user.nickname") ||
        safeGet(noteData, "user.name") ||
        "",
      // 小红书号（自定义号）：上游只填 redId，绝不回退内部 userId。
      id: safeGet(noteData, "user.redId") || "",
      avatar:
        safeGet(noteData, "user.avatar") ||
        safeGet(noteData, "user.avatarUrl") ||
        "",
    };
    const title = noteData.title || "";
    const desc = noteData.desc || noteData.description || "";
    const raw = { noteId: noteData.noteId || "", finalUrl };

    // 视频笔记：上游优先取 h264，再按分辨率排序取最高档。
    const videoMedia = await buildVideoMedia(ctx, noteData);
    if (videoMedia) {
      ctx.log.info("xhs videoUrl: " + videoMedia.url);
      return {
        type: "video",
        title,
        desc,
        author,
        cover: videoMedia.cover,
        media: [videoMedia],
        raw,
      };
    }

    // 图文笔记：实况图在 media[].live_photo_url 保留（相对上游的扩展）。
    const imageMedia = await buildImageMedia(ctx, noteData);
    if (imageMedia.length > 0) {
      return {
        type: "image",
        title,
        desc,
        author,
        cover: imageMedia[0].url,
        media: imageMedia,
        raw,
      };
    }

    return ctx.fail("MEDIA_NOT_FOUND", "该内容不包含视频或图片");
  } catch (error) {
    if (error && error.code) throw error;
    ctx.log.error(
      "Error in xiaohongshu rule: " + (error && error.message ? error.message : String(error))
    );
    return ctx.fail("UPSTREAM_ERROR", "小红书解析失败");
  }
}
