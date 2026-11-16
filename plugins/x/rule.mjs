// @source https://github.com/hotier/MediaGet
// @file packages/parse-core/src/lib/twitterCore.js
// @file packages/parse-core/src/lib/http.ts
// @file packages/parse-core/src/lib/default-mobile-ua.ts
// @file packages/parse-core/src/lib/redirect-location.ts
// @license MIT
// @commit 17603b8a5404b4dc7408b5c44dae441ea9d2996f
// @adapted fetch/fetchWithTimeout/AbortController -> ctx.http.request(timeoutMs);
//   getConfigOrEnv -> ctx.config (twitterFixerServices / twitterFixerRelayUrl);
//   logger -> ctx.log; { code, msg, data } -> RuleResult; durations -> seconds.
// @omitted probeFixerHosts / PROBE_HEADER_PROFILES（/api/health 排障探针，不属于
//   parse 链路）；response.text()/json() -> ctx.http 字符串 + ctx.json。
//
// 请求顺序：
//   t.co 展开 -> 推文 ID -> GraphQL TweetResultByRestId（长推文 note_tweet /
//   X Article，移植自旧 Python 实现）-> fixer 家族并发竞速 -> 阅读器中继 +
//   vxtwitter 并行兜底 -> 官方 cdn.syndication.twimg.com（token 算法）
//   + fetchAuthorProfile 补 tag 直链。
// GraphQL 是唯一能拿到 Article/note_tweet 的路径，失败时静默回落旧链路；
// fixer/syndication 部分保持 MediaGet 上游原样。

import {
  buildFxResult,
  buildVxtwitterResult,
  buildVideoFixTable,
  cleanTweetText,
  extractRelayJson,
  extractTweetId,
  fixTwimgVideoUrl,
  formatSeconds,
  getTwitterToken,
  isSyndicationTombstone,
  num,
  pickBestMp4,
  pickFxTweet,
  pickMp4Qualities,
  pickVxtweet,
  toRuleResult,
} from "./twitter-extract.mjs";
import { parseViaGraphql } from "./twitter-graphql.mjs";

export const meta = {
  id: "x",
  name: "X / Twitter",
  types: ["video", "image", "richtext"],
  match: {
    hosts: ["x.com", "twitter.com", "t.co"],
    patterns: [],
  },
  version: "0.1.0",
  source: "https://github.com/hotier/MediaGet",
  license: "MIT",
  proxy: [{ hosts: ["twimg.com"], referer: "https://x.com/" }],
};

// 与上游 lib/http.ts 的 TIMEOUT.DEFAULT 保持一致。
const REQUEST_TIMEOUT_MS = 8000;
// 上游 default-mobile-ua.ts 的 DEFAULT_MOBILE_UA，用于 t.co 展开。
const DEFAULT_MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

const DEFAULT_FIXER_HOSTS = [
  "api.fxtwitter.com",
  "api.fixupx.com",
  "api.twittpr.com",
  "api.vxtwitter.com",
];

const IS_VXTWITTER = (host) => host === "api.vxtwitter.com";

const FIXER_DEFAULT_TIMEOUT_MS = 6000;
const FIXER_BACKUP_TIMEOUT_MS = 5000;
const FIXER_TIMEOUT_MS = {
  "api.fxtwitter.com": 10000,
  "api.fixupx.com": 5000,
  "api.twittpr.com": 5000,
  "api.vxtwitter.com": 5000,
};

const FIXER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://fxtwitter.com/",
};

const RELAY_DEFAULT_BASE = "https://r.jina.ai/";

/**
 * 读白名单配置；未配置时返回 fallback（对应上游 getConfigOrEnv 的第三个参数）。
 * 与上游一致：注入值即使为空串也优先于 fallback（用于显式关闭中继）。
 */
function configValue(ctx, key, fallback) {
  const cfg = ctx.config || {};
  if (Object.prototype.hasOwnProperty.call(cfg, key) && cfg[key] != null) {
    return String(cfg[key]);
  }
  return fallback;
}

/** TWITTER_FIXER_SERVICES 的规则侧等价物：ctx.config.twitterFixerServices。 */
function fixerHosts(ctx) {
  const cfg = configValue(ctx, "twitterFixerServices", "");
  if (cfg) {
    const hosts = cfg
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (hosts.length > 0) return hosts;
  }
  return DEFAULT_FIXER_HOSTS;
}

/** TWITTER_FIXER_RELAY_URL 的规则侧等价物：ctx.config.twitterFixerRelayUrl。 */
function relayBase(ctx) {
  const raw = configValue(ctx, "twitterFixerRelayUrl", RELAY_DEFAULT_BASE);
  const base = String(raw ?? "").trim();
  if (!base || /^(off|none|false|0)$/i.test(base)) return "";
  return base.endsWith("/") ? base : `${base}/`;
}

/** 带外等待的请求：只把 fetch 换成 ctx.http.request。 */
async function request(ctx, url, headers, timeoutMs) {
  return ctx.http.request({ url, headers, timeoutMs: timeoutMs || REQUEST_TIMEOUT_MS });
}

/**
 * 模拟上游 resty NoRedirectPolicy：取 3xx 的 Location（t.co 短链）。
 * ctx.http.request 的 redirect:false 只取第一跳，headers 的 key 已统一小写。
 */
async function getRedirectLocation(ctx, url, headers, timeoutMs) {
  const res = await request(ctx, url, headers, timeoutMs || REQUEST_TIMEOUT_MS);
  if (res.status >= 300 && res.status < 400) {
    const loc = (res.headers || {})["location"];
    if (loc) {
      try {
        return new URL(loc, url).href;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** 请求单个 fixer 服务，成功返回解析后的 JSON，任何失败返回 null */
async function fetchFixerJson(ctx, host, tweetId, timeoutMs) {
  try {
    const path = IS_VXTWITTER(host)
      ? `i/status/${tweetId}`
      : host === "api.fxtwitter.com"
      ? `2/status/${tweetId}`
      : `status/${tweetId}`;
    const res = await request(ctx, `https://${host}/${path}`, FIXER_HEADERS, timeoutMs);
    if (res.status < 200 || res.status >= 300) return null;
    return ctx.json.parse(res.body);
  } catch (error) {
    // 整体解析超时不要吞掉；单请求超时/网络错误按上游语义返回 null。
    if (error && error.code === "PARSE_TIMEOUT") throw error;
    return null;
  }
}

/** 经阅读器中继读取 fx 的 v2 接口；禁用/失败返回 null。 */
async function fetchFixerJsonViaRelay(ctx, tweetId, timeoutMs) {
  const base = relayBase(ctx);
  if (!base || !tweetId) return null;
  try {
    const res = await request(
      ctx,
      `${base}https://api.fxtwitter.com/2/status/${tweetId}`,
      { "User-Agent": "Mozilla/5.0", Accept: "text/plain" },
      timeoutMs || REQUEST_TIMEOUT_MS
    );
    if (res.status < 200 || res.status >= 300) return null;
    return extractRelayJson(res.body);
  } catch (error) {
    if (error && error.code === "PARSE_TIMEOUT") throw error;
    return null;
  }
}

/** 并发竞速：返回第一批 resolve 为非空值的结果，全部失败返回 null。 */
function firstNonNull(promises) {
  return new Promise((resolve) => {
    let done = 0;
    const total = promises.length;
    if (total === 0) {
      resolve(null);
      return;
    }
    for (const p of promises) {
      Promise.resolve(p).then(
        (v) => {
          if (v) {
            resolve(v);
          } else if (++done === total) {
            resolve(null);
          }
        },
        () => {
          // 单个分支失败（含整体超时）按 null 处理，避免未捕获的 rejection
          // 让竞速永远不 settle；超时最终仍由宿主中断映射。
          if (++done === total) resolve(null);
        }
      );
    }
  });
}

/**
 * fxTwitter 家族并发竞速（带完整性校验）：
 * - 完整结果（有媒体，或带 media 空结构的确认纯文本）任一返回即胜出；
 * - 疑似不完整（type=text 且响应缺 media 字段）仅记为兜底，等所有服务 settle。
 * 返回内部 data 对象或 null。
 *
 * 运行时差异：ctx.http.request 是同步结算的，所以上游的「并发竞速」在这里
 * 表现为按 host 顺序发请求（结果选择逻辑不变）；这是宿主能力边界，不是重写。
 */
async function raceFixerResults(ctx, hosts, tweetId) {
  if (hosts.length === 0) return null;
  return new Promise((resolve) => {
    let settled = 0;
    let fallback = null;
    for (const host of hosts) {
      (async () => {
        try {
          const json = await fetchFixerJson(
            ctx,
            host,
            tweetId,
            Math.min(
              FIXER_TIMEOUT_MS[host] || FIXER_DEFAULT_TIMEOUT_MS,
              FIXER_DEFAULT_TIMEOUT_MS
            )
          );
          const t = json ? pickFxTweet(json) : null;
          const result = t ? buildFxResult(t) : null;
          if (!result) {
            if (++settled === hosts.length) resolve(fallback);
            return;
          }
          if (result.type !== "text" || t.media != null) {
            resolve(result);
            return;
          }
          if (!fallback) fallback = result;
          if (++settled === hosts.length) resolve(fallback);
        } catch {
          // 与 fetchFixerJson 的 null 语义一致：该 host 视为失败。
          if (++settled === hosts.length) resolve(fallback);
        }
      })();
    }
  });
}

/**
 * 用第三方 fixer 补充作者信息（简介/粉丝数/互动统计）和 twimg 带 tag 直链修复表。
 * 全部失败静默返回空对象，不阻塞主解析流程。
 */
async function fetchAuthorProfile(ctx, tweetId) {
  if (!tweetId) return {};
  const hosts = fixerHosts(ctx);
  const fxHosts = hosts.filter((h) => !IS_VXTWITTER(h));
  const vxHost = hosts.find(IS_VXTWITTER);

  const fx = await firstNonNull(
    fxHosts.map(async (host) => {
      const json = await fetchFixerJson(
        ctx,
        host,
        tweetId,
        Math.min(
          FIXER_TIMEOUT_MS[host] || FIXER_BACKUP_TIMEOUT_MS,
          FIXER_DEFAULT_TIMEOUT_MS
        )
      );
      const t = pickFxTweet(json);
      if (!t) return null;
      const author = t.author || {};
      const followers = Number(author.followers);
      const following = Number(author.following);
      return {
        sign: typeof author.description === "string" ? author.description : "",
        followerCount:
          Number.isFinite(followers) && followers > 0 ? followers : undefined,
        followingCount:
          Number.isFinite(following) && following > 0 ? following : undefined,
        like: num(t.likes),
        retweets: num(t.reposts ?? t.retweets),
        replies: num(t.replies),
        views: num(t.views),
        videoFixTable: buildVideoFixTable(t),
      };
    })
  );
  if (fx) return fx;

  if (vxHost) {
    const json = await fetchFixerJson(ctx, vxHost, tweetId, 4000);
    const t = pickVxtweet(json);
    if (t) {
      return {
        like: num(t.likes),
        retweets: num(t.retweets),
        replies: num(t.replies),
        views: num(t.views),
      };
    }
  }
  return {};
}

/**
 * 优先解析：fxTwitter 家族并发竞速；全部失败后阅读器中继与 vxtwitter 并行。
 * 返回内部 data 对象或 null，由调用方降级官方 syndication。
 */
async function parseViaFixer(ctx, tweetId) {
  if (!tweetId) return null;
  const hosts = fixerHosts(ctx);
  const fxHosts = hosts.filter((h) => !IS_VXTWITTER(h));
  const vxHost = hosts.find(IS_VXTWITTER);

  const fx = await raceFixerResults(ctx, fxHosts, tweetId);
  if (fx) return fx;

  const [relayed, vxResult] = await Promise.all([
    fetchFixerJsonViaRelay(ctx, tweetId).then((json) => {
      const t = pickFxTweet(json);
      return t ? buildFxResult(t) : null;
    }),
    vxHost
      ? fetchFixerJson(ctx, vxHost, tweetId, 4000).then((json) => {
          const t = pickVxtweet(json);
          return t ? buildVxtwitterResult(t) : null;
        })
      : null,
  ]);
  return relayed || vxResult || null;
}

/**
 * 官方 syndication 兜底解析：返回正文 + 媒体直链（多视频/图集），
 * 作者简介/粉丝/互动统计由 fetchAuthorProfile 尽力补齐。
 * 失败时通过 ctx.fail 抛出明确错误码。
 */
async function parseViaSyndication(ctx, tweetId) {
  const token = getTwitterToken(tweetId);
  const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${token}`;

  let res;
  try {
    res = await request(
      ctx,
      apiUrl,
      {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
        Referer: "https://platform.twitter.com/",
      },
      REQUEST_TIMEOUT_MS
    );
  } catch (error) {
    if (error && error.code === "PARSE_TIMEOUT") throw error;
    return ctx.fail("UPSTREAM_ERROR", "Twitter 接口请求失败，请稍后重试");
  }
  if (res.status < 200 || res.status >= 300) {
    // 上游把 HTTP 状态直接透出；宿主错误码枚举里 404 对应 MEDIA_NOT_FOUND，
    // 其余状态按上游失败语义归为 UPSTREAM_ERROR。
    if (res.status === 404) {
      return ctx.fail("MEDIA_NOT_FOUND", "该推文不存在或已删除");
    }
    return ctx.fail(
      "UPSTREAM_ERROR",
      `Twitter syndication 请求失败 (${res.status})`
    );
  }

  let json;
  try {
    json = ctx.json.parse(res.body);
  } catch {
    return ctx.fail("UPSTREAM_CHANGED", "Twitter 响应解析失败");
  }

  if (isSyndicationTombstone(json)) {
    return ctx.fail("MEDIA_NOT_FOUND", "该推文已删除或不可见，暂无法解析");
  }

  const authorName = json.user?.name || "";
  const authorScreenName = json.user?.screen_name || "";
  const authorAvatar = json.user?.profile_image_url_https || "";
  const authorId = json.user?.id_str || "";
  const authorUrl = authorScreenName
    ? `https://x.com/${authorScreenName}`
    : authorId
    ? `https://x.com/${authorId}`
    : "";
  const authorHandle = authorScreenName ? `@${authorScreenName}` : authorId;
  const title = cleanTweetText(json.text || "", json.entities);

  const videos = [];
  const images = [];

  const mediaDetails = Array.isArray(json.mediaDetails) ? json.mediaDetails : [];
  for (const media of mediaDetails) {
    const mediaType = media?.type;
    const src = media?.media_url_https || "";
    if (mediaType === "video" || mediaType === "animated_gif") {
      const variants = media?.video_info?.variants;
      const qualities = pickMp4Qualities(variants);
      const mp4 = qualities?.[0]?.url || pickBestMp4(variants);
      if (!mp4) continue;
      const durationMs = media?.video_info?.duration_millis;
      const durationSec =
        durationMs != null && durationMs > 0
          ? Math.round(Number(durationMs) / 1000)
          : undefined;
      videos.push({
        title: "",
        url: mp4,
        ...(qualities ? { qualities } : {}),
        duration: durationSec,
        durationFormat: formatSeconds(durationSec),
        cover: src,
      });
    } else if (mediaType === "photo" && src) {
      images.push(src);
    }
  }

  // 旧结构兜底：部分接口形态 mediaDetails 无视频项，json.video 提供主视频。
  if (videos.length === 0 && Array.isArray(json.video?.variants)) {
    const qualities = pickMp4Qualities(json.video.variants);
    const mp4 = qualities?.[0]?.url || pickBestMp4(json.video.variants);
    if (mp4) {
      const durationMs = json.video?.durationMs ?? json.video?.duration_millis;
      const durationSec =
        durationMs != null && durationMs > 0
          ? Math.round(Number(durationMs) / 1000)
          : undefined;
      videos.push({
        title: "",
        url: mp4,
        ...(qualities ? { qualities } : {}),
        duration: durationSec,
        durationFormat: formatSeconds(durationSec),
        cover: json.video?.poster || "",
      });
    }
  }

  const primary = videos[0];
  const cover = primary?.cover || images[0] || "";
  const type = videos.length > 0 ? "video" : images.length > 0 ? "image" : "text";
  const created = json.created_at ? Date.parse(json.created_at) : NaN;

  const authorProfile = await fetchAuthorProfile(ctx, tweetId);
  // twimg 直链必须带 ?tag= 签名才可播放：用 fxTwitter 同路径的带 tag URL 替换。
  const fixTable = authorProfile.videoFixTable || new Map();
  for (const v of videos) {
    if (v?.url) v.url = fixTwimgVideoUrl(v.url, fixTable);
    if (Array.isArray(v?.qualities)) {
      for (const q of v.qualities) q.url = fixTwimgVideoUrl(q.url, fixTable);
    }
  }

  return {
    title,
    author: authorName || authorScreenName,
    avatar: authorAvatar,
    uid: authorHandle,
    authorUrl,
    sign: authorProfile.sign || undefined,
    followerCount: authorProfile.followerCount,
    followingCount: authorProfile.followingCount,
    like: num(json.favorite_count) ?? authorProfile.like,
    retweets: num(json.retweet_count) ?? authorProfile.retweets,
    replies: num(json.reply_count) ?? authorProfile.replies,
    views: num(json.view_count ?? json.impression_count) ?? authorProfile.views,
    cover,
    url: primary?.url || images[0] || "",
    duration: primary?.duration,
    durationFormat: primary?.durationFormat,
    videos: videos.length > 1 ? videos : undefined,
    qualities: videos.length === 1 ? primary?.qualities : undefined,
    images: images.length > 0 ? images : undefined,
    type,
    time: Number.isFinite(created) ? created : undefined,
  };
}

/**
 * 把 fixer/syndication 的纯文字结果归一成 richtext 正文。
 * 这两条链路的正文放在 title；GraphQL 结果自带 content，不受影响。
 */
function ensureTextContent(data) {
  if (!data || data.type === "video" || data.type === "image") return data;
  if (typeof data.content === "string" && data.content.trim() !== "") return data;
  const text = typeof data.title === "string" ? data.title.trim() : "";
  if (!text) return data;
  data.content = text;
  data.contentFormat = "plain";
  data.title = "";
  return data;
}

/**
 * 解析顺序：GraphQL（长文/Article 的唯一来源）→ fixer 竞速 → 阅读器中继 /
 * vxtwitter → 官方 syndication。GraphQL 失败只返回 null，不阻塞旧链路。
 */
async function parseVideoId(ctx, tweetId) {
  const graphqlResult = await parseViaGraphql(ctx, tweetId);
  if (graphqlResult) return graphqlResult;
  const fixerResult = await parseViaFixer(ctx, tweetId);
  if (fixerResult) return fixerResult;
  return parseViaSyndication(ctx, tweetId);
}

export async function parse(ctx) {
  const input = ctx.request.url || "";
  if (!input) {
    return ctx.fail("URL_NOT_FOUND", "未找到 X/Twitter 链接");
  }

  try {
    let url = input;
    if (url.includes("t.co/")) {
      const loc = await getRedirectLocation(ctx, url, {
        "User-Agent": DEFAULT_MOBILE_UA,
      });
      if (!loc) {
        return ctx.fail("INVALID_TEXT", "t.co 短链解析失败");
      }
      url = loc;
    }

    const tweetId = extractTweetId(url);
    if (!tweetId) {
      return ctx.fail("INVALID_TEXT", "无法从 URL 提取推文 ID");
    }

    const data = ensureTextContent(await parseVideoId(ctx, tweetId));
    if (!data) {
      return ctx.fail("UPSTREAM_CHANGED", "Twitter 响应结构异常");
    }
    // 纯文字/长文/Article 现在走 richtext；只有正文和媒体都为空才拒绝。
    if (
      data.type !== "video" &&
      data.type !== "image" &&
      !(typeof data.content === "string" && data.content.trim() !== "")
    ) {
      return ctx.fail("MEDIA_NOT_FOUND", "该推文没有可解析的正文或媒体");
    }

    ctx.log.info(
      "解析 X 推文 " + tweetId + " 成功（" + data.type + (data.title ? "：" + String(data.title).slice(0, 30) : "") + "）"
    );
    return toRuleResult(data);
  } catch (error) {
    if (error && error.code) throw error;
    ctx.log.error(
      "Error in x rule: " + (error && error.message ? error.message : String(error))
    );
    return ctx.fail("UPSTREAM_ERROR", "Twitter 解析失败");
  }
}
