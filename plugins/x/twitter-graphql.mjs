// @source https://github.com/ZiLing/ParseHub (reference/ParseHub)
// @file src/parsehub/provider_api/twitter.py
// @license MIT
//
// 旧的 Python 解析器通过 X 的 GraphQL TweetResultByRestId 拿完整推文：
// note_tweet（长推文正文）和 article（X Article 富文本）。MediaGet 的
// fixer/syndication 链路没有这两个字段，迁移后长文能力丢失；这里把旧实现
// 移植成 JS 规则，请求参数、features、fieldToggles 和字段路径保持原样。
//
// 失败语义：任何网络/结构错误都返回 null，让 rule.mjs 回落到 fixer 链；
// 只有宿主整体超时（PARSE_TIMEOUT）继续向上抛。

import {
  formatSeconds,
  num,
  pickBestMp4,
  pickMp4Qualities,
} from "./twitter-extract.mjs";
import { renderArticle } from "./twitter-article.mjs";

// 与旧实现相同的公开 Bearer token（X Web 客户端固定值）。
const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// 旧实现里硬编码的 queryId。X 会轮换它；plugin.json 暴露
// twitterGraphqlQueryId 允许不改代码替换，失败时仍会回落到 fixer 链。
const DEFAULT_QUERY_ID = "kPLTRmMnzbPTv70___D06w";

const FEATURES = [
  '"creator_subscriptions_tweet_preview_api_enabled":true',
  '"communities_web_enable_tweet_community_results_fetch":true',
  '"c9s_tweet_anatomy_moderator_badge_enabled":true',
  '"tweetypie_unmention_optimization_enabled":true',
  '"responsive_web_edit_tweet_api_enabled":true',
  '"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true',
  '"view_counts_everywhere_api_enabled":true',
  '"longform_notetweets_consumption_enabled":true',
  '"responsive_web_twitter_article_tweet_consumption_enabled":true',
  '"tweet_awards_web_tipping_enabled":false',
  '"creator_subscriptions_quote_tweet_preview_enabled":false',
  '"freedom_of_speech_not_reach_fetch_enabled":true',
  '"standardized_nudges_misinfo":true',
  '"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true',
  '"tweet_with_visibility_results_prefer_gql_media_interstitial_enabled":false',
  '"rweb_video_timestamps_enabled":true',
  '"longform_notetweets_rich_text_read_enabled":true',
  '"longform_notetweets_inline_media_enabled":true',
  '"rweb_tipjar_consumption_enabled":true',
  '"responsive_web_graphql_exclude_directive_enabled":true',
  '"verified_phone_label_enabled":false',
  '"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false',
  '"responsive_web_graphql_timeline_navigation_enabled":true',
  '"responsive_web_enhance_cards_enabled":false',
].join(",");

const FIELD_TOGGLES =
  '{"withArticleRichContentState":true,"withArticlePlainText":false}';

const GRAPHQL_TIMEOUT_MS = 8000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MONTHS = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

function graphqlQueryId(ctx) {
  const cfg = ctx.config || {};
  const configured = String(cfg.twitterGraphqlQueryId || "").trim();
  return configured || DEFAULT_QUERY_ID;
}

/** Cookie 来自 secret（plugin.json 的 cookie 字段），回退到宿主注入的 header。 */
function cookieHeader(ctx) {
  let cookie = "";
  try {
    cookie = String(ctx.secrets.get("cookie") || "");
  } catch {
    cookie = "";
  }
  if (!cookie) cookie = String(ctx.cookies.header || "");
  return cookie;
}

function cookieValue(raw, name) {
  for (const part of String(raw || "").split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq).trim() === name) return trimmed.slice(eq + 1).trim();
  }
  return "";
}

function withImageName(url, name) {
  if (!url) return "";
  return `${url}${url.includes("?") ? "&" : "?"}name=${name}`;
}

function parseTwitterDate(value) {
  const m = /^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}) (\d{4})$/.exec(
    String(value || "")
  );
  if (!m || MONTHS[m[1]] == null) {
    const fallback = Date.parse(value);
    return Number.isFinite(fallback) ? fallback : undefined;
  }
  const sign = m[6][0] === "-" ? -1 : 1;
  const offsetMin =
    sign * (Number(m[6].slice(1, 3)) * 60 + Number(m[6].slice(3, 5)));
  const utc = Date.UTC(
    Number(m[7]),
    MONTHS[m[1]],
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5])
  );
  return utc - offsetMin * 60000;
}

async function fetchGraphql(ctx, tweetId, cookie) {
  const variables = JSON.stringify({
    tweetId,
    withCommunity: false,
    includePromotedContent: false,
    withVoice: false,
  });
  const url =
    `https://api.twitter.com/graphql/${graphqlQueryId(ctx)}/TweetResultByRestId` +
    `?variables=${encodeURIComponent(variables)}` +
    `&features=${encodeURIComponent(`{${FEATURES}}`)}` +
    `&fieldToggles=${encodeURIComponent(FIELD_TOGGLES)}`;

  const headers = {
    accept: "application/json",
    "accept-language": "zh-CN,zh;q=0.9",
    authorization: `Bearer ${BEARER}`,
    "content-type": "application/json",
    "user-agent": UA,
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "zh-cn",
  };
  if (cookie) {
    headers.Cookie = cookie;
    const csrf = cookieValue(cookie, "ct0");
    if (csrf) headers["x-csrf-token"] = csrf;
  }

  try {
    const res = await ctx.http.request({
      url,
      headers,
      timeoutMs: GRAPHQL_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      ctx.log.warn("x graphql status " + res.status);
      return null;
    }
    return ctx.json.parse(res.body);
  } catch (error) {
    if (error && error.code === "PARSE_TIMEOUT") throw error;
    // 只留一行短原因；宿主错误消息会带上完整 GraphQL URL（约 2 KB）。
    const reason = error && error.message ? String(error.message) : String(error);
    ctx.log.warn("x graphql failed: " + reason.slice(0, 160));
    return null;
  }
}

function pickUser(result, holder) {
  return (
    holder?.core?.user_results?.result ||
    result?.core?.user_results?.result ||
    {}
  );
}

function buildAuthor(user) {
  const core = user.core || {};
  const legacy = user.legacy || {};
  const screenName = core.screen_name || legacy.screen_name || "";
  const name = core.name || legacy.name || "";
  const id = String(user.rest_id || legacy.id_str || "");
  const avatar = String(
    legacy.profile_image_url_https || user.avatar?.image_url || ""
  ).replace(/_normal(\.\w+)$/, "_400x400$1");

  return {
    name,
    screenName,
    id,
    avatar,
    url: screenName ? `https://x.com/${screenName}` : id ? `https://x.com/${id}` : "",
    handle: screenName ? `@${screenName}` : id,
    sign: typeof legacy.description === "string" ? legacy.description : "",
    followers: num(legacy.followers_count ?? user.stats?.followers),
    following: num(legacy.friends_count ?? user.stats?.following),
  };
}

function mediaKey(item) {
  return String(item?.media_key || item?.id_str || item?.media_url_https || "");
}

/**
 * legacy.entities.media + note_tweet.entity_set.media 合并去重。
 * 长推文的媒体有时只出现在 note_tweet 里，旧实现漏掉了这一路。
 */
function collectTweetMedia(legacy, holder, result) {
  const seen = new Set();
  const merged = [];
  const push = (item) => {
    if (!item) return;
    const key = mediaKey(item);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    merged.push(item);
  };
  for (const item of Array.isArray(legacy?.entities?.media) ? legacy.entities.media : []) {
    push(item);
  }
  for (const item of Array.isArray(
    holder?.note_tweet?.note_tweet_results?.result?.entity_set?.media
  )
    ? holder.note_tweet.note_tweet_results.result.entity_set.media
    : []) {
    push(item);
  }
  for (const item of Array.isArray(
    result?.note_tweet?.note_tweet_results?.result?.entity_set?.media
  )
    ? result.note_tweet.note_tweet_results.result.entity_set.media
    : []) {
    push(item);
  }
  return merged;
}

function convertTweetMedia(items) {
  const videos = [];
  const images = [];
  for (const item of items) {
    const type = item?.type;
    if (type === "photo") {
      const url = withImageName(item.media_url_https || "", "orig");
      if (url) images.push(url);
      continue;
    }
    if (type !== "video" && type !== "animated_gif") continue;
    const variants = item?.video_info?.variants;
    const qualities = pickMp4Qualities(variants);
    const mp4 = qualities?.[0]?.url || pickBestMp4(variants);
    if (!mp4) continue;
    const durationMs = Number(item?.video_info?.duration_millis) || 0;
    const duration = durationMs > 0 ? Math.round(durationMs / 1000) : undefined;
    videos.push({
      title: "",
      url: mp4,
      ...(qualities ? { qualities } : {}),
      duration,
      durationFormat: formatSeconds(duration),
      cover: withImageName(item.media_url_https || "", "medium"),
    });
  }
  return { videos, images };
}

function convertArticleMedia(items) {
  const videos = [];
  const images = [];
  for (const item of items) {
    if (item.kind === "image") {
      if (item.url) images.push(item.url);
    } else if (item.kind === "video" && item.url) {
      const duration = Number(item.duration) > 0 ? Math.round(item.duration) : undefined;
      videos.push({
        title: "",
        url: item.url,
        duration,
        durationFormat: formatSeconds(duration),
        cover: item.cover || "",
      });
    }
  }
  return { videos, images };
}

/**
 * 正文里出现的媒体 URL 必须能在 media 里找到，否则客户端持久化后无法
 * 把 Markdown 里的图片替换成自己的存储地址。Article 封面会写进正文，
 * 但 renderArticle 只把内联媒体放进 media，这里补上封面。
 */
function addCoverToMedia(media, content, cover) {
  if (!cover || !content || !content.includes(cover)) return;
  if (media.images.includes(cover)) return;
  if (media.videos.some((v) => v.url === cover || v.cover === cover)) return;
  media.images.push(cover);
}

/**
 * 只接受真正的摘要：为空、与标题相同、或者只剩链接的文本都不算。
 */
function explicitSummary(text, title) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  if (title && trimmed === String(title).trim()) return "";
  const withoutLinks = trimmed.replace(/https?:\/\/\S+/g, "").trim();
  return withoutLinks ? trimmed : "";
}

function buildGraphqlResult(json) {
  if (!json || typeof json !== "object") return null;
  if (Array.isArray(json.errors) && json.errors.length > 0) return null;

  const result = json?.data?.tweetResult?.result;
  if (!result || typeof result !== "object") return null;
  if (result.__typename === "TweetTombstone") return null;

  const holder =
    result.tweet && typeof result.tweet === "object" ? result.tweet : result;
  const legacy = holder.legacy || result.legacy;
  if (!legacy) return null;

  const user = pickUser(result, holder);
  const author = buildAuthor(user);

  const articleRaw =
    holder?.article?.article_results?.result ||
    result?.article?.article_results?.result;
  const article = articleRaw ? renderArticle(articleRaw) : null;

  const noteText =
    holder?.note_tweet?.note_tweet_results?.result?.text ||
    result?.note_tweet?.note_tweet_results?.result?.text ||
    "";
  const fullText = noteText || legacy.full_text || "";
  const tweetMedia = collectTweetMedia(legacy, holder, result);

  let media;
  if (article) {
    media = convertArticleMedia(article.media);
    // Article 没有内联媒体时，旧实现回退到推文媒体。
    if (media.videos.length === 0 && media.images.length === 0) {
      media = convertTweetMedia(tweetMedia);
    }
  } else {
    media = convertTweetMedia(tweetMedia);
  }

  const articleMarkdown = article?.markdown || "";
  const content = article
    ? articleMarkdown || fullText
    : noteText || (media.videos.length === 0 && media.images.length === 0 ? fullText : "");
  if (!content && media.videos.length === 0 && media.images.length === 0) {
    return null;
  }
  addCoverToMedia(media, content, article?.cover || "");

  const primary = media.videos[0];
  const cover = article?.cover || primary?.cover || media.images[0] || "";
  const type =
    article || (media.videos.length === 0 && media.images.length === 0)
      ? "richtext"
      : media.videos.length > 0
      ? "video"
      : "image";
  // richtext（Article）里单视频也要显式放进 videos，否则 toRuleResult
  // 的单视频分支只认 type=video，会把视频漏掉。
  const videosField =
    type === "richtext" || media.videos.length > 1 ? media.videos : [];
  const created = parseTwitterDate(legacy.created_at);
  const views = holder.views?.count ?? legacy.ext_views?.view_count;

  return {
    type,
    // 纯正文结果的正文只放 content/title 一处：richtext 的 title 留给客户端
    // 自己展示，避免 title 和 content 重复整段文本。
    title: article?.title || (type === "richtext" || noteText ? "" : fullText),
    // Article 的推文文本是显式摘要；普通视频/图集仍把推文文本留在 title，
    // 不再自动复制到 desc。
    desc: article ? explicitSummary(fullText, article.title) : "",
    content,
    contentFormat: articleMarkdown ? "markdown" : "plain",
    author: author.name || author.screenName,
    avatar: author.avatar,
    uid: author.handle,
    authorUrl: author.url,
    sign: author.sign || undefined,
    followerCount: author.followers,
    followingCount: author.following,
    like: num(legacy.favorite_count),
    retweets: num(legacy.retweet_count),
    replies: num(legacy.reply_count),
    views: num(views),
    cover,
    url: primary?.url || media.images[0] || "",
    duration: primary?.duration,
    durationFormat: primary?.durationFormat,
    qualities: media.videos.length === 1 ? primary?.qualities : undefined,
    videos: videosField.length > 0 ? videosField : undefined,
    images: media.images.length > 0 ? media.images : undefined,
    time: Number.isFinite(created) ? created : undefined,
  };
}

/**
 * GraphQL 优先解析。匿名请求失败且配置了 Cookie 时，用 Cookie 重试一次；
 * 仍失败返回 null，由调用方回落 fixer/syndication。
 */
export async function parseViaGraphql(ctx, tweetId) {
  if (!tweetId) return null;
  const cookie = cookieHeader(ctx);

  const anonymous = await fetchGraphql(ctx, tweetId, "");
  const first = anonymous ? buildGraphqlResult(anonymous) : null;
  if (first) return first;

  if (cookie) {
    const authed = await fetchGraphql(ctx, tweetId, cookie);
    const second = authed ? buildGraphqlResult(authed) : null;
    if (second) return second;
  }
  return null;
}
