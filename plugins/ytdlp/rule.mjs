// @source https://github.com/yt-dlp/yt-dlp
// @file 无（本规则是宿主能力适配层，不复制上游代码）
// @license Unlicense
// @commit 无（未绑定上游版本；能力由本机安装的 yt-dlp 提供）
// @adapted 直接调用 ctx.native.ytdlp.resolve，挑选 progressive 格式并映射为 RuleResult
//
// 通用 yt-dlp 规则：只调用宿主原生能力，自身不下载、不起进程。
// 这是兜底规则，排在所有平台规则之后；宿主在 yt-dlp 不可用时会跳过本包。
//
// 返回的媒体优先选择「音视频合一的 progressive 格式」，避免依赖 ffmpeg 合流。
// 需要合流的长尾站点暂时返回 MEDIA_NOT_FOUND，等宿主的 HLS/DASH + ffmpeg 能力落地。

export const meta = {
  id: "ytdlp",
  name: "yt-dlp（通用兜底）",
  types: ["video"],
  // 平台规则都没匹配时，任何 http(s) 链接都可以交给 yt-dlp 尝试。
  match: {
    hosts: [],
    patterns: ["^https?://"],
  },
  native: ["ytdlp"],
  // 兜底规则：仅当没有任何平台规则匹配时才运行。
  fallback: true,
  version: "0.1.0",
  source: "https://github.com/yt-dlp/yt-dlp",
  license: "Unlicense",
};

export async function parse(ctx) {
  const info = await ctx.native.ytdlp.resolve(ctx.request.url);
  if (!info) {
    return ctx.fail("NATIVE_FAILED", "yt-dlp 没有返回结果");
  }
  if (info.live_status === "is_live" || info.live_status === "is_upcoming" || info.live_status === "was_live") {
    return ctx.fail("MEDIA_NOT_FOUND", "不支持直播或直播回放");
  }

  const formats = Array.isArray(info.formats) ? info.formats : [];
  const progressive = formats
    .filter((f) => isHTTP(f.url) && hasVideo(f) && hasAudio(f))
    .sort((a, b) => score(b) - score(a));
  const picked = progressive[0];
  if (!picked) {
    return ctx.fail(
      "MEDIA_NOT_FOUND",
      "yt-dlp 只返回了分离的音视频流，需要 ffmpeg 合流；当前版本暂不支持"
    );
  }

  return {
    type: "video",
    title: info.title || "",
    desc: info.description || "",
    author: {
      nickname: info.uploader || "",
      id: info.uploader_id || "",
      avatar: "",
    },
    cover: info.thumbnail || "",
    media: [
      {
        kind: "video",
        url: picked.url,
        width: num(picked.width) || num(info.width),
        height: num(picked.height) || num(info.height),
        duration: num(info.duration),
        cover: info.thumbnail || "",
        title: info.title || "",
      },
    ],
    raw: {
      source: "ytdlp",
      id: info.id || "",
      extractor: info.extractor || "",
      format_id: picked.format_id || "",
      // 宿主下载时用这个页面地址交给 yt-dlp；CDN 直链往往需要 yt-dlp 自己的请求头。
      webpage_url: info.webpage_url || ctx.request.url,
    },
  };
}

function isHTTP(raw) {
  return typeof raw === "string" && (raw.startsWith("https://") || raw.startsWith("http://"));
}

function hasVideo(f) {
  return typeof f.vcodec === "string" && f.vcodec !== "" && f.vcodec !== "none";
}

function hasAudio(f) {
  return typeof f.acodec === "string" && f.acodec !== "" && f.acodec !== "none";
}

function score(f) {
  const height = num(f.height);
  const tbr = Number(f.tbr) || 0;
  return height * 1000 + tbr;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}
