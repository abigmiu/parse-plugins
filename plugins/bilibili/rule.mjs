// @source https://github.com/hotier/MediaGet
// @file packages/parse-core/src/lib/bilibiliCore.js
// @license MIT
// @commit 17603b8a5404b4dc7408b5c44dae441ea9d2996f
// @adapted fetchWithTimeout -> ctx.http.request; getConfigOrEnv(BILIBILI_COOKIE) ->
//   ctx.cookies.header; 模块级 cookiePool/buvid 缓存 -> 每次 parse 的局部 state;
//   logger -> ctx.log; { code, msg, data } -> RuleResult; 新增按 URL ?p= 选择分 P
//   并只返回对应 P（上游返回全部分 P 的 data 数组）。Node crypto（仅 wbi 签名使用）
//   随 wbi 一并省略，因此无需 ctx.crypto。
// @omitted wbi 签名 + UP主空间统计（关注/粉丝/获赞/简介）与 opus 收藏数：RuleResult
//   没有对应字段，且这些请求只服务于展示；Cookie 失效告警状态机与 nav 健康探测同样省略
//   （纯日志）。buvid3/buvid4、view/detail、playurl、清晰度逐档请求与字段路径保持上游原样。
//
// 纯函数拆分：bilibili-opus.mjs（上游 bilibili-opus.js）、bilibili-cookie-guard.mjs
// （上游 bilibili-cookie-guard.js 的失败归类部分）。http.ts / api-utils.js 只提供
// 超时常量与 UA，已内联为常量。

import { classifyOpusDetail } from "./bilibili-opus.mjs";
import {
  classifyBiliFailure,
  hasSessdataCookie,
} from "./bilibili-cookie-guard.mjs";

export const meta = {
  id: "bilibili",
  name: "哔哩哔哩",
  types: ["video", "image"],
  match: {
    hosts: ["bilibili.com", "b23.tv"],
    // 裸 BV 号（没有 URL）也属于 B 站；识别在规则里，不在 Go 的 URL 提取器里。
    patterns: ["\\bBV[0-9A-Za-z]{10}\\b"],
  },
  version: "0.1.0",
  source: "https://github.com/hotier/MediaGet",
  license: "MIT",
  proxy: [
    {
      hosts: ["bilibili.com", "bilivideo.com", "bilivideo.cn", "hdslb.com"],
      referer: "https://www.bilibili.com/",
    },
  ],
};

// 与上游 lib/http.ts 的 TIMEOUT.DEFAULT / TIMEOUT.SHORT 保持一致。
const TIMEOUT_DEFAULT_MS = 8000;
const TIMEOUT_SHORT_MS = 5000;

// 上游 bilibiliCore.js 的默认 UA（逐个踩坑调出来的平台专用值，不要统一成 ctx.ua）。
const BILIBILI_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.81 Safari/537.36";

// 上游 MODERN_USER_AGENT = UA_CHROME_WIN126；opus/detail 用旧 UA 会被 -352 风控。
const MODERN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// B站按请求出口 IP 分配 CDN 节点：海外出口拿到 akamaized.net，大陆用户无法播放。
// 直链签名（upsig/uparams）不绑定 host，归一化到国内镜像节点即可。
const BILI_CN_HOST = "upos-sz-mirrorbd.bilivideo.com";

// set-cookie 里这些是属性而不是 Cookie 名，吸收时跳过。
const COOKIE_ATTRIBUTES = new Set([
  "expires",
  "path",
  "domain",
  "max-age",
  "secure",
  "httponly",
  "samesite",
]);

/** 每次 parse 独立的可变状态，替代上游的模块级 cookiePool / buvidCache。 */
function createState(ctx) {
  return {
    ctx,
    // B站按请求出口 IP + Cookie 决定是否放行：把响应 set-cookie（buvid3/buvid4 等）
    // 累积起来，后续请求统一带上，作为匿名「风控通行证」。
    cookiePool: {},
    buvidCache: null,
    biliCookie: String(ctx.cookies.header || ""),
  };
}

/** 吸收响应 set-cookie。ctx.http 的 headers key 小写、多值以 ", " 连接。 */
function absorbSetCookies(response, state) {
  try {
    const headers = (response && response.headers) || {};
    const raw = headers["set-cookie"] || headers["Set-Cookie"] || "";
    if (!raw) return;
    // Set-Cookie 的 Expires 里也有逗号，只在下一个 "name=" 前切分。
    for (const piece of String(raw).split(/,\s*(?=[A-Za-z0-9_-]+\s*=)/)) {
      const pair = piece.split(";")[0].trim();
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      if (!name || COOKIE_ATTRIBUTES.has(name.toLowerCase())) continue;
      state.cookiePool[name] = pair;
    }
  } catch {
    // 忽略吸收失败，不影响主流程
  }
}

/** 合并多段 Cookie，同名以最后传入者为准（等价浏览器「最近设置者覆盖」） */
function buildCookieString(...parts) {
  const map = {};
  for (const arg of parts) {
    if (!arg) continue;
    for (const seg of String(arg).split(";")) {
      const kv = seg.trim();
      if (!kv) continue;
      const name = kv.split("=")[0];
      if (name) map[name] = kv;
    }
  }
  return Object.values(map).join("; ");
}

function pooledCookie(state) {
  return Object.values(state.cookiePool).join("; ");
}

function normalizeCdnHost(ctx, url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith(".akamaized.net")) {
      parsed.hostname = BILI_CN_HOST;
      return parsed.toString();
    }
  } catch (error) {
    ctx.log.error(
      "Error normalizing CDN host: " +
        (error && error.message ? error.message : String(error))
    );
  }
  return url;
}

function cleanUrlParameters(ctx, url) {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    return parsed.toString();
  } catch (error) {
    ctx.log.error(
      "Error cleaning URL: " + (error && error.message ? error.message : String(error))
    );
    return url;
  }
}

// B站 API 返回的图片（头像 face / 封面 pic）协议不稳定，部分为 http://，
// 在 https 页面直链会被混合内容拦截导致破图；只做数据层 https 升级。
function toHttps(url) {
  if (!url) return "";
  return String(url).replace(/^http:\/\//i, "https://");
}

// B站部分无简介视频的 desc 为 "-" 或纯空白，归一化为空串。
function normalizeDesc(desc) {
  if (typeof desc !== "string") return "";
  const t = desc.trim();
  if (!t || t === "-") return "";
  return desc;
}

/** 读取 ?p= 分 P 序号（1-based），非法或缺失视为第 1 P。 */
function readPageParam(parsedUrl) {
  const raw = parsedUrl.searchParams.get("p");
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

async function bilibiliRequest(ctx, state, url, headers = {}) {
  // 无 Cookie 出口被 WAF 拦成 HTML 时，首次请求的 set-cookie 已吸收进池，
  // 用池内 Cookie 自动重试一次即可放行（最多 2 次）。
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const outgoing = {
        ...headers,
        // 允许调用方指定 UA（如 opus/detail 需现代浏览器 UA 规避风控）
        "User-Agent": headers["User-Agent"] || BILIBILI_USER_AGENT,
        // 补齐浏览器请求特征头，降低被风控误判的概率
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Referer: headers.Referer || "https://www.bilibili.com/",
      };
      // 允许调用方传 Cookie（如拼接 buvid3 规避风控），同名以调用方为准
      const cookie = buildCookieString(
        pooledCookie(state),
        state.biliCookie,
        headers.Cookie
      );
      if (cookie) outgoing.Cookie = cookie;

      const response = await ctx.http.request({
        url,
        headers: outgoing,
        redirect: true,
        timeoutMs: TIMEOUT_DEFAULT_MS,
      });
      // 先把 set-cookie（buvid3 等）吸收进池，供重试与后续请求使用
      absorbSetCookies(response, state);

      const contentType =
        (response.headers && response.headers["content-type"]) || "";
      if (contentType.includes("application/json")) {
        try {
          return ctx.json.parse(response.body);
        } catch {
          return null;
        }
      }
      // 非 JSON：多半是 WAF/风控 HTML 页。截取片段便于诊断；首次被拦时重试。
      const snippet = String(response.body || "")
        .slice(0, 200)
        .replace(/\s+/g, " ");
      ctx.log.warn(
        "bilibili " +
          new URL(url).pathname +
          " got status=" +
          response.status +
          " " +
          contentType +
          ": " +
          snippet
      );
      if (attempt === 1) continue;
      return null;
    } catch (error) {
      if (error && error.code === "PARSE_TIMEOUT") throw error;
      ctx.log.error(
        "Error making bilibili request (attempt " +
          attempt +
          "): " +
          (error && error.message ? error.message : String(error))
      );
      if (attempt === 1) continue;
      return null;
    }
  }
  return null;
}

/** 获取 buvid3/buvid4（B站公开接口的风控通行证，未登录也返回），每次 parse 内缓存。 */
async function getBuvid(ctx, state) {
  if (state.buvidCache) return state.buvidCache;
  try {
    const spi = await bilibiliRequest(
      ctx,
      state,
      "https://api.bilibili.com/x/frontend/finger/spi",
      {}
    );
    const b3 = (spi && spi.data && spi.data.b_3) || "";
    const b4 = (spi && spi.data && spi.data.b_4) || "";
    // 写入 Cookie 池，让后续所有接口请求默认携带 buvid 通行证
    if (b3) state.cookiePool.buvid3 = `buvid3=${b3}`;
    if (b4) state.cookiePool.buvid4 = `buvid4=${b4}`;
    state.buvidCache = { b3, b4 };
  } catch (error) {
    if (error && error.code === "PARSE_TIMEOUT") throw error;
    state.buvidCache = { b3: "", b4: "" };
  }
  return state.buvidCache;
}

export async function parse(ctx) {
  let url = ctx.request.url || "";
  if (!url) {
    // meta.match.patterns 命中了裸 BV 号；由规则补成标准视频链接。
    const bare = String(ctx.request.text || "").match(/BV[0-9A-Za-z]{10}/);
    if (bare) url = `https://www.bilibili.com/video/${bare[0]}`;
  }
  if (!url) {
    return ctx.fail("URL_NOT_FOUND", "未找到B站链接");
  }

  const state = createState(ctx);

  try {
    const sourceUrl = new URL(url);
    const parsedUrl = new URL(cleanUrlParameters(ctx, url));
    let pathname;
    let page = readPageParam(sourceUrl);

    if (parsedUrl.hostname === "b23.tv") {
      // 短链：跟随重定向后取最终 pathname；最终 URL 里可能带 ?p=。
      const response = await ctx.http.request({
        url,
        redirect: true,
        timeoutMs: TIMEOUT_SHORT_MS,
      });
      const redirectUrl = new URL(response.url || url);
      pathname = redirectUrl.pathname;
      if (redirectUrl.searchParams.get("p")) {
        page = readPageParam(redirectUrl);
      }
    } else if (
      parsedUrl.hostname === "www.bilibili.com" ||
      parsedUrl.hostname === "m.bilibili.com"
    ) {
      pathname = parsedUrl.pathname;
    } else {
      return ctx.fail("INVALID_TEXT", "视频链接好像不太对！");
    }

    // 图文动态（/opus/<id>、/dynamic/<id>）：先于视频校验分流。
    const opusMatch = pathname.match(/\/(?:opus|dynamic)\/(\d+)/);
    if (opusMatch) {
      return await parseOpus(ctx, state, opusMatch[1]);
    }

    if (!pathname.includes("/video/")) {
      return ctx.fail("INVALID_TEXT", "好像不是视频链接");
    }

    // 提取 BV 号：b23.tv 重定向后 pathname 形如 /video/BV.../（带尾斜杠），
    // 残留 "/" 会让 view 接口返回 -400，这里统一去掉。
    const bvidMatch = pathname.match(/\/(video|bilibili)\/([A-Za-z0-9_]+)\/?/);
    const bvid = (bvidMatch ? bvidMatch[2] : pathname).replace(/\/+$/, "");
    ctx.log.debug("Processing bilibili video, bvid: " + bvid);

    const headers = { "Content-Type": "application/json;charset=UTF-8" };

    // 数据中心/海外出口无 Cookie 直调 view 接口常被 WAF 拦成 HTML，
    // 先取 spi 的 buvid 写入 Cookie 池，再请求视频信息。
    await getBuvid(ctx, state);

    const videoInfo = await bilibiliRequest(
      ctx,
      state,
      `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
      headers
    );

    if (!videoInfo || videoInfo.code !== 0) {
      ctx.log.warn("Failed to fetch video info, response: " + JSON.stringify(videoInfo));
      const failure = classifyBiliFailure({
        cookieConfigured: hasSessdataCookie(state.biliCookie),
        jsonCode: videoInfo ? videoInfo.code : null,
      });
      return ctx.fail(failure.code, failure.msg);
    }

    const pages = Array.isArray(videoInfo.data.pages) ? videoInfo.data.pages : [];
    if (pages.length === 0) {
      return ctx.fail("UPSTREAM_CHANGED", "解析失败：视频分 P 数据缺失");
    }
    // 分 P：?p=N 选中对应分 P；越界回退到第 1 P。
    const pageData = pages[Math.min(page, pages.length) - 1] || pages[0];

    // 请求选中分 P 的播放地址。qn=112 先拿 accept_quality，再逐档请求清晰度直链。
    const playUrlBase = `https://api.bilibili.com/x/player/playurl?otype=json&fnver=0&fnval=3&player=3&qn=112&bvid=${bvid}&cid=${pageData.cid}&platform=html5&high_quality=1`;
    const playUrl = await bilibiliRequest(ctx, state, playUrlBase, headers);

    if (!playUrl || !playUrl.data || !playUrl.data.durl || !playUrl.data.durl[0] || !playUrl.data.durl[0].url) {
      return ctx.fail("MEDIA_NOT_FOUND", "解析失败：未找到可播放的视频地址");
    }

    // 可用清晰度：accept_quality（如 [64,16]）与 accept_description 一一对应
    const qualityIds = Array.isArray(playUrl.data.accept_quality)
      ? playUrl.data.accept_quality
      : [playUrl.data.quality != null ? playUrl.data.quality : 64];
    const descByQuality = {};
    (playUrl.data.accept_quality || []).forEach((q, i) => {
      descByQuality[q] =
        (playUrl.data.accept_description && playUrl.data.accept_description[i]) ||
        `${q}P`;
    });

    // 逐档请求拿对应直链（无大会员时多档会返回相同 url，去重后保留高档描述）
    const qualityResponses = await Promise.all(
      qualityIds.map((qn) =>
        bilibiliRequest(ctx, state, playUrlBase.replace("qn=112", `qn=${qn}`), headers)
      )
    );
    const qualities = [];
    const seenUrls = new Set();
    for (let i = 0; i < qualityIds.length; i++) {
      const qn = qualityIds[i];
      const resp = qualityResponses[i];
      if (resp && resp.data && resp.data.durl && resp.data.durl[0] && resp.data.durl[0].url) {
        const url = normalizeCdnHost(ctx, resp.data.durl[0].url);
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          qualities.push({
            quality: qn,
            label: descByQuality[qn] || `${qn}P`,
            url,
          });
        }
      }
    }

    // 主直链取最高可用清晰度（与历史行为一致）。
    const videoUrl =
      (qualities[0] && qualities[0].url) ||
      normalizeCdnHost(ctx, playUrl.data.durl[0].url);
    if (!videoUrl) {
      return ctx.fail("MEDIA_NOT_FOUND", "解析失败：未找到可播放的视频地址");
    }

    const owner = videoInfo.data.owner || {};
    const cover = toHttps(videoInfo.data.pic);
    const duration =
      Number(pageData.duration) || Number(videoInfo.data.duration) || 0;

    ctx.log.info(
      "Successfully parsed bilibili video, bvid: " +
        bvid +
        ", p: " +
        (pageData.page || page)
    );

    return {
      type: "video",
      title: videoInfo.data.title || "",
      desc: normalizeDesc(videoInfo.data.desc),
      author: {
        nickname: owner.name || "",
        id: owner.mid != null ? String(owner.mid) : "",
        avatar: toHttps(owner.face),
      },
      cover,
      media: [
        {
          kind: "video",
          url: videoUrl,
          duration,
          cover: pageData.pic ? toHttps(pageData.pic) : cover,
          title: pageData.part || "",
        },
      ],
      raw: {
        bvid,
        p: pageData.page || page,
        qualities: qualities.map((q) => ({ quality: q.quality, label: q.label })),
        accept: playUrl.data.accept_description || [],
      },
    };
  } catch (error) {
    if (error && error.code) throw error;
    ctx.log.error(
      "Error parsing bilibili video: " +
        (error && error.message ? error.message : String(error))
    );
    return ctx.fail("UPSTREAM_ERROR", "解析失败！");
  }
}

/**
 * 图文/文字动态（/opus/<id>、/dynamic/<id>）。
 * detail 接口带 buvid 即可匿名访问；非纯图文类型由 classifyOpusDetail 给出针对性提示。
 */
async function parseOpus(ctx, state, opusId) {
  // 数据中心/海外出口无 Cookie 直调会被 WAF 拦成 HTML，先取 buvid 写入 Cookie 池
  await getBuvid(ctx, state);
  const headers = {
    "Content-Type": "application/json;charset=UTF-8",
    "User-Agent": MODERN_USER_AGENT,
  };
  const detail = await bilibiliRequest(
    ctx,
    state,
    `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${opusId}&features=itemOpusStyle`,
    { ...headers, Referer: `https://www.bilibili.com/opus/${opusId}` }
  );
  if (!detail || detail.code !== 0 || !detail.data || !detail.data.item) {
    ctx.log.warn("Failed to fetch opus detail, response: " + JSON.stringify(detail));
    if (!detail) {
      const failure = classifyBiliFailure({
        cookieConfigured: hasSessdataCookie(state.biliCookie),
        jsonCode: null,
      });
      return ctx.fail(failure.code, failure.msg);
    }
    return ctx.fail("UPSTREAM_ERROR", "解析失败！");
  }

  const outcome = classifyOpusDetail(detail);
  if (!outcome.ok) {
    return ctx.fail("MEDIA_NOT_FOUND", outcome.msg);
  }
  const data = outcome.data;
  // RuleResult 的 media 不能为空；纯文字动态没有可下载媒体，契约不允许返回。
  if (data.type !== "image" || !Array.isArray(data.images) || data.images.length === 0) {
    return ctx.fail("MEDIA_NOT_FOUND", "该动态是纯文字内容，暂无可解析的媒体");
  }

  ctx.log.info(
    "Successfully parsed bilibili opus " +
      opusId +
      ", images: " +
      data.images.length
  );

  return {
    type: "image",
    title: data.title || "",
    desc: data.desc || "",
    author: {
      nickname: data.author || "",
      id: data.authorId || "",
      avatar: data.avatar || "",
    },
    cover: data.cover || data.images[0] || "",
    media: data.images.map((imageUrl, index) => ({
      kind: "image",
      url: imageUrl,
      cover: index === 0 ? data.cover || imageUrl : "",
    })),
    raw: { opusId, time: data.time, stat: data.stat },
  };
}
