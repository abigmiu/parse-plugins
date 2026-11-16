// @source https://github.com/hotier/MediaGet
// @file packages/parse-core/src/lib/twitterCore.js
// @file packages/parse-core/src/lib/quality.js
// @license MIT
// @commit 17603b8a5404b4dc7408b5c44dae441ea9d2996f
// @adapted network-free pure helpers only; { code, msg, data } -> plain data
//   object consumed by RuleResult mapping; MediaGet's millisecond `duration`
//   -> seconds (docs/rule-contract.md §3).
// @omitted nothing algorithmically; wrappers (code/msg) and the health probe
//   live in rule.mjs / are omitted there.
//
// 纯函数层：输入 syndication/fixer JSON，输出结构化数据。请求顺序、字段路径、
// 正则和码率选择逻辑保持上游原样。

/** 上游 quality.js 的 buildQualityList，逐字内联。 */
export function buildQualityList(entries) {
  const list = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const url = entry?.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const rawQuality = Number(entry.quality);
    const quality = Number.isFinite(rawQuality) ? rawQuality : 0;
    list.push({
      quality,
      label: String(entry.label || (quality ? `${quality}P` : "默认")),
      url,
    });
  }
  return list.length >= 2 ? list : undefined;
}

/** 视频时长（秒）→ "mm:ss" / "h:mm:ss"，无效返回空串 */
export function formatSeconds(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "";
  const s = Math.round(n);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (x) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** 数值归一：>0 的有限数字返回原值，其余（缺失/0/非法）返回 undefined */
export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 判断官方 syndication 响应是否为 tombstone（推文已删除/受限/敏感内容不可见）。 */
export function isSyndicationTombstone(json) {
  if (!json || typeof json !== "object") return false;
  return json.__typename === "TweetTombstone" || Boolean(json.tombstone);
}

/**
 * 从 variants 里挑最高码率的 mp4 直链（忽略 HLS m3u8 等不可下载格式）。
 * 兼容两种字段命名：syndication 标准结构 { content_type, url, bitrate }，
 * 以及官方顶层 video.variants 的 { type, src, bitrate }。
 */
export function pickBestMp4(variants) {
  if (!Array.isArray(variants)) return "";
  let best = "";
  let maxBitrate = 0;
  for (const v of variants) {
    const ct = v?.content_type || v?.type || "";
    if (!String(ct).includes("mp4")) continue;
    const br = Number(v.bitrate) || 0;
    const u = v?.url || v?.src || "";
    if (u && (br > maxBitrate || !best)) {
      maxBitrate = br;
      best = u;
    }
  }
  return best;
}

/** 从 variant 的尺寸字段 / 直链路径（/1280x720/）里取高度 */
export function variantHeight(v) {
  const direct = Number(v?.height) || 0;
  if (direct) return direct;
  const m = /\/(\d{2,5})x(\d{2,5})\//.exec(String(v?.url || v?.src || ""));
  return m ? Number(m[2]) : 0;
}

/**
 * variants 全档位 → 契约 qualities。
 * 同一档位可能有 avc1/hevc 多条（尺寸相同），按高度归并、保留高码率那条；
 * 高度缺失时退回码率文案（如 "2176kbps"），保证下拉项仍可区分。
 */
export function pickMp4Qualities(variants) {
  if (!Array.isArray(variants)) return undefined;
  const byTier = new Map();
  for (const v of variants) {
    const ct = v?.content_type || v?.type || v?.container || "";
    if (!String(ct).includes("mp4")) continue;
    const url = v?.url || v?.src || "";
    if (!url) continue;
    const bitrate = Number(v.bitrate) || 0;
    const height = variantHeight(v);
    const key = height ? `h:${height}` : `b:${bitrate}`;
    const prev = byTier.get(key);
    if (!prev || bitrate > prev.bitrate) byTier.set(key, { url, bitrate, height });
  }
  const list = [...byTier.values()]
    .sort((a, b) => (b.height || 0) - (a.height || 0) || b.bitrate - a.bitrate)
    .map((tier) => ({
      quality: tier.height || tier.bitrate,
      label: tier.height
        ? `${tier.height}p`
        : `${Math.round(tier.bitrate / 1000)}kbps`,
      url: tier.url,
    }));
  return buildQualityList(list);
}

/**
 * 从 fxTwitter 响应的媒体对象构建「路径 → 带 tag URL」修复表。
 * video.twimg.com 的 mp4 直链必须带 ?tag= 签名参数才可播放。
 */
export function buildVideoFixTable(t) {
  const media = t?.media || {};
  const fixTable = new Map();
  const items = [
    ...(Array.isArray(media.videos) ? media.videos : []),
    ...(Array.isArray(media.all) ? media.all : []),
  ];
  for (const v of items) {
    if (v?.url) {
      try {
        fixTable.set(new URL(v.url).pathname, v.url);
      } catch {
        /* 忽略非法 URL */
      }
    }
    for (const f of Array.isArray(v?.formats) ? v.formats : []) {
      if (f?.url) {
        try {
          fixTable.set(new URL(f.url).pathname, f.url);
        } catch {
          /* 忽略非法 URL */
        }
      }
    }
  }
  return fixTable;
}

/**
 * 修复 video.twimg.com 直链：无 ?tag= 签名时，用 fixTable 中同路径的带 tag URL
 * 替换。已带 tag / 非 twimg 域 / 表中无匹配，均原样返回。
 */
export function fixTwimgVideoUrl(url, fixTable) {
  if (!url || !fixTable || fixTable.size === 0) return url;
  if (!String(url).includes("video.twimg.com/")) return url;
  try {
    const u = new URL(url);
    if (u.searchParams.has("tag")) return url;
    return fixTable.get(u.pathname) || url;
  } catch {
    return url;
  }
}

/** 解码 syndication 文本中的常见 HTML 实体（text 字段是 HTML 转义后的内容） */
export function unescapeHtml(str) {
  return String(str)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/**
 * 清洗推文文本：解码 HTML 实体 + 移除媒体短链占位 + 折叠多余空白。
 */
export function cleanTweetText(text, entities) {
  let cleaned = unescapeHtml(text);
  const shortUrls = [
    ...(Array.isArray(entities?.urls) ? entities.urls : []),
    ...(Array.isArray(entities?.media) ? entities.media : []),
  ];
  for (const u of shortUrls) {
    if (u?.url) cleaned = cleaned.replaceAll(u.url, "");
  }
  const lines = cleaned
    .split("\n")
    .map((line) => line.trim().replace(/[ \t]+/g, " "));
  let trimmed = lines;
  while (trimmed.length > 0 && trimmed[0] === "") trimmed = trimmed.slice(1);
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "")
    trimmed = trimmed.slice(0, -1);
  const result = [];
  for (const line of trimmed) {
    if (line === "" && result[result.length - 1] === "") continue;
    result.push(line);
  }
  return result.filter((line) => !/^>\s*$/.test(line)).join("\n");
}

/** 推文 ID → syndication token（X 前端的公开算法）。 */
export function getTwitterToken(idStr) {
  const n = parseFloat(idStr);
  if (!Number.isFinite(n)) {
    return "";
  }
  const token = (n / 1e15) * Math.PI;
  let tokenStr = token.toString();
  if (tokenStr.includes("e") || tokenStr.includes("E")) {
    tokenStr = token.toFixed(16).replace(/\.?0+$/, "");
  }
  return tokenStr.replace(/0/g, "").replace(/\./g, "");
}

export function extractTweetId(shareUrl) {
  const re = /(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d+)/i;
  const m = String(shareUrl || "").match(re);
  return m?.[1] || "";
}

/**
 * fxTwitter 家族响应取推文对象：兼容旧版 { tweet } 与 v2 { status, author }。
 */
export function pickFxTweet(json) {
  if (!json || typeof json !== "object") return null;
  if (json.tweet && typeof json.tweet === "object") {
    return json.tweet.type === "tombstone" ? null : json.tweet;
  }
  const s = json.status;
  if (s && typeof s === "object" && s.type !== "tombstone") {
    if (json.author && !s.author) s.author = json.author;
    return s;
  }
  return null;
}

/** vxtwitter 顶层可能是数组（历史版本）或对象，统一取推文对象 */
export function pickVxtweet(json) {
  if (Array.isArray(json)) return json[0] || null;
  return json && typeof json === "object" ? json : null;
}

/**
 * 剥掉阅读器的 Markdown 前言，取出其中的 JSON 原文。
 */
export function extractRelayJson(text) {
  if (typeof text !== "string") return null;
  const marker = text.indexOf("Markdown Content:");
  const body = marker >= 0 ? text.slice(marker + "Markdown Content:".length) : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const json = JSON.parse(body.slice(start, end + 1));
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}

/**
 * fxTwitter 适配器：构造与官方路径同结构的数据对象。
 * 兼容新旧结构：v2 用 reposts 字段（即 retweets）。结构缺失返回 null。
 * 与上游唯一的差别：duration 保留秒（上游是毫秒），由 RuleResult 契约决定。
 */
export function buildFxResult(t) {
  if (!t || typeof t !== "object") return null;
  if (t.type === "tombstone") return null;
  const author = t.author || {};
  const authorName = author.name || author.screen_name || "";
  const authorScreenName = author.screen_name || "";
  const authorAvatar = author.avatar_url || "";
  const authorId = String(author.id || "");
  const authorUrl = authorScreenName
    ? `https://x.com/${authorScreenName}`
    : authorId
    ? `https://x.com/${authorId}`
    : "";
  const authorHandle = authorScreenName ? `@${authorScreenName}` : authorId;

  const media = t.media || {};
  const videos = [];
  const images = [];
  const seenVideoUrls = new Set();
  const pushVideo = (u, thumb, dur, formats) => {
    if (!u || seenVideoUrls.has(u)) return;
    seenVideoUrls.add(u);
    const durationSec = Number(dur) > 0 ? Math.round(Number(dur)) : undefined;
    const qualities = pickMp4Qualities(formats);
    videos.push({
      title: "",
      url: qualities?.[0]?.url || u,
      ...(qualities ? { qualities } : {}),
      duration: durationSec,
      durationFormat: formatSeconds(durationSec),
      cover: thumb || "",
    });
  };
  for (const v of Array.isArray(media.videos) ? media.videos : []) {
    if (v?.url) pushVideo(v.url, v.thumbnail_url, v.duration, v.formats);
  }
  for (const p of Array.isArray(media.photos) ? media.photos : []) {
    if (p?.url) images.push(p.url);
  }
  if (Array.isArray(media.all)) {
    const imageUrls = new Set(images);
    for (const m of media.all) {
      if (!m?.url) continue;
      if (m.type === "video") {
        pushVideo(m.url, m.thumbnail_url, m.duration, m.formats);
      } else if (m.type === "photo" && !imageUrls.has(m.url)) {
        images.push(m.url);
        imageUrls.add(m.url);
      }
    }
  }

  const primary = videos[0];
  const cover = primary?.cover || images[0] || "";
  const type = videos.length > 0 ? "video" : images.length > 0 ? "image" : "text";
  const followers = Number(author.followers);
  const following = Number(author.following);
  const created = t.created_at ? Date.parse(t.created_at) : NaN;

  return {
    title: t.text || "",
    author: authorName || authorScreenName,
    avatar: authorAvatar,
    uid: authorHandle,
    authorUrl,
    sign: typeof author.description === "string" ? author.description : undefined,
    followerCount:
      Number.isFinite(followers) && followers > 0 ? followers : undefined,
    followingCount:
      Number.isFinite(following) && following > 0 ? following : undefined,
    like: num(t.likes),
    retweets: num(t.reposts ?? t.retweets),
    replies: num(t.replies),
    views: num(t.views),
    cover,
    url: primary?.url || images[0] || "",
    duration: primary?.duration,
    durationFormat: primary?.durationFormat,
    qualities: videos.length === 1 ? primary?.qualities : undefined,
    videos: videos.length > 1 ? videos : undefined,
    images: images.length > 0 ? images : undefined,
    type,
    time: Number.isFinite(created) ? created : undefined,
  };
}

/**
 * vxtwitter 适配器：不返回作者简介/粉丝数/查看量，仅互动统计 + 媒体直链。
 * duration 同样保留秒。
 */
export function buildVxtwitterResult(t) {
  if (!t || typeof t !== "object") return null;
  const authorName = t.user_name || "";
  const authorScreenName = t.user_screen_name || "";
  const authorAvatar = t.user_profile_image_url || "";
  const authorUrl = authorScreenName
    ? `https://x.com/${authorScreenName}`
    : `https://x.com/${t.tweetID || ""}`;
  const authorHandle = authorScreenName ? `@${authorScreenName}` : "";

  const videos = [];
  const images = [];
  for (const m of Array.isArray(t.media_extended) ? t.media_extended : []) {
    if (!m?.url) continue;
    if (m.type === "video") {
      const durationMs = Number(m.duration_millis);
      const durationSec = durationMs > 0 ? Math.round(durationMs / 1000) : undefined;
      videos.push({
        title: "",
        url: m.url,
        duration: durationSec,
        durationFormat: formatSeconds(durationSec),
        cover: m.thumbnail_url || "",
      });
    } else if (m.type === "image") {
      images.push(m.url);
    }
  }
  if (videos.length === 0 && images.length === 0 && Array.isArray(t.mediaURLs)) {
    for (const u of t.mediaURLs) {
      if (/\.(mp4|m4v|mov|webm)(\?|$)/i.test(u)) {
        videos.push({ title: "", url: u, cover: "" });
      } else {
        images.push(u);
      }
    }
  }

  const primary = videos[0];
  const cover = primary?.cover || images[0] || "";
  const type = videos.length > 0 ? "video" : images.length > 0 ? "image" : "text";
  const epoch = Number(t.date_epoch);
  const created = epoch > 0 ? epoch * 1000 : NaN;

  return {
    title: t.text || "",
    author: authorName || authorScreenName,
    avatar: authorAvatar,
    uid: authorHandle,
    authorUrl,
    like: num(t.likes),
    retweets: num(t.retweets),
    replies: num(t.replies),
    cover,
    url: primary?.url || images[0] || "",
    duration: primary?.duration,
    durationFormat: primary?.durationFormat,
    videos: videos.length > 1 ? videos : undefined,
    images: images.length > 0 ? images : undefined,
    type,
    time: Number.isFinite(created) ? created : undefined,
  };
}

/**
 * 内部数据对象 → RuleResult。
 * data.videos 只在多视频时存在；单视频走 data.url/duration/qualities（上游口径）。
 * 正文（data.content）与媒体至少有一个；纯文字推文/长文走 richtext +
 * content_format。
 */
export function toRuleResult(data) {
  const media = [];
  const videos =
    Array.isArray(data.videos) && data.videos.length > 0
      ? data.videos
      : data.type === "video" && data.url
      ? [{ url: data.url, duration: data.duration, cover: data.cover, title: "" }]
      : [];
  for (const v of videos) {
    if (!v || !v.url) continue;
    media.push({
      kind: "video",
      url: v.url,
      cover: v.cover || "",
      duration: Number(v.duration) > 0 ? Math.round(Number(v.duration)) : 0,
      title: v.title || "",
    });
  }
  for (const u of Array.isArray(data.images) ? data.images : []) {
    if (!u) continue;
    media.push({ kind: "image", url: u, cover: u, title: "" });
  }
  const content =
    typeof data.content === "string" ? data.content.trim() : "";
  if (media.length === 0 && !content) {
    // 没有媒体也没有正文：调用方应先降级；这里留作规则自检。
    const error = new Error("规则未生成任何媒体或正文");
    error.code = "UPSTREAM_CHANGED";
    throw error;
  }

  let type;
  if (data.type === "richtext") type = "richtext";
  else if (data.type === "image") type = "image";
  else if (data.type === "video") type = "video";
  else type = content ? "richtext" : "video";

  return {
    type,
    title: data.title || "",
    // desc 只由规则显式提供的摘要填充；没有摘要就留空，不能复制 title。
    desc: data.desc || "",
    ...(content
      ? { content, content_format: data.contentFormat || "plain" }
      : {}),
    author: {
      nickname: data.author || "",
      id: data.uid || "",
      avatar: data.avatar || "",
    },
    cover: data.cover || "",
    media,
    raw: {
      author_url: data.authorUrl || "",
      sign: data.sign || "",
      follower_count: data.followerCount || 0,
      following_count: data.followingCount || 0,
      like: data.like || 0,
      retweets: data.retweets || 0,
      replies: data.replies || 0,
      views: data.views || 0,
      duration_format: data.durationFormat || "",
      qualities:
        data.qualities ||
        (videos.length > 0 && Array.isArray(videos[0].qualities)
          ? videos[0].qualities
          : []),
      create_time: data.time || 0,
      media_type: data.type || "",
    },
  };
}
