// @source https://github.com/hotier/MediaGet
// @file packages/parse-core/src/lib/douyin-extract.js
// @file packages/parse-core/src/lib/quality.js
// @license MIT
// @commit 17603b8a5404b4dc7408b5c44dae441ea9d2996f
// @adapted logger -> removed; buildQualityList inlined from quality.js; network-free.
//
// 纯函数层：输入 HTML / _ROUTER_DATA，输出结构化数据。保持上游字段路径和正则原样。

export function headerValue(response, name) {
  const headers = (response && response.headers) || {};
  const key = String(name).toLowerCase();
  if (typeof headers[key] === "string") return headers[key];
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === key) return String(headers[k]);
  }
  return "";
}

/** 从 Set-Cookie 提取 ttwid；替代上游的 response.headers.getSetCookie()。 */
export function extractTtwid(response) {
  const cookies = headerValue(response, "set-cookie");
  const match = cookies.match(/ttwid=([^;,\s]+)/);
  return match ? "ttwid=" + match[1] : "";
}

const LOADER_KEYS = ["video_(id)/page", "note_(id)/page", "story_(id)/page"];

export function hasValidData(info) {
  if (!info || !info.loaderData) return false;
  return LOADER_KEYS.some(
    (k) => info.loaderData[k] && (info.loaderData[k].videoInfoRes.item_list || []).length > 0
  );
}

/**
 * 依次支持：_ROUTER_DATA（当前主格式）→ RENDER_DATA（URL 编码）→ _SSR_DATA。
 * 注意：即使页面带 argus 风控脚本，只要含有效数据块也会被解析出来（先数据后反爬）。
 */
export function tryParseEmbedded(html) {
  const router = html.match(/window\._ROUTER_DATA\s*=\s*([\s\S]*?)<\/script>/);
  if (router && router[1]) {
    try {
      return JSON.parse(router[1].trim());
    } catch {
      /* 尝试下一种格式 */
    }
  }
  const render = html.match(/<script[^>]+id=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/);
  if (render && render[1]) {
    try {
      return JSON.parse(decodeURIComponent(render[1].trim()));
    } catch {
      /* 尝试下一种格式 */
    }
  }
  const ssr = html.match(/window\._SSR_(?:HYDRATED_)?DATA\s*=\s*([\s\S]*?)<\/script>/);
  if (ssr && ssr[1]) {
    try {
      return JSON.parse(ssr[1].trim());
    } catch {
      /* 无可用数据 */
    }
  }
  return null;
}

export function parseVideoData(videoInfo) {
  try {
    let videoData = null;
    for (const key of LOADER_KEYS) {
      const page = videoInfo.loaderData[key];
      const list = page && page.videoInfoRes && page.videoInfoRes.item_list;
      if (Array.isArray(list) && list[0]) {
        videoData = list[0];
        break;
      }
    }
    if (!videoData) return { ok: false, reason: "empty" };
    if (!videoData.author) return { ok: false, reason: "author" };

    // aweme_type: 0=普通视频, 1=图文, 2=图文(实况图/动图), 4=故事。
    const playAddr = videoData.video && videoData.video.play_addr ? videoData.video.play_addr : {};
    const hasUri = !!playAddr.uri && !String(playAddr.uri).startsWith("http");
    const durationMs = videoData.video && videoData.video.duration ? videoData.video.duration : 0;
    const hasRealVideo = (!!(playAddr.url_list && playAddr.url_list[0]) || hasUri) && (durationMs > 0 || hasUri);
    const awemeType = videoData.aweme_type;
    const isImageType = awemeType === 1 || awemeType === 2;
    const isVideo = !isImageType && hasRealVideo;
    const images = Array.isArray(videoData.images)
      ? videoData.images.map((img) => img && img.url_list && img.url_list[0]).filter(Boolean)
      : [];

    if (!isVideo && images.length === 0) return { ok: false, reason: "media" };

    const play = (videoData.video && videoData.video.play_addr) || {};
    const urlList = Array.isArray(play.url_list) ? play.url_list : [];
    let videoResUrl = urlList[0] ? cleanDouyinPlayUrl(urlList[0]) : "";

    // uri 兜底直链：分享页未内嵌 url_list 但只要拿到 video_id（uri）即可构造官方播放接口。
    if (!videoResUrl && play.uri && !String(play.uri).startsWith("http")) {
      videoResUrl =
        "https://www.iesdouyin.com/aweme/v1/play/?video_id=" + play.uri + "&ratio=1080p&line=0";
    }

    // bit_rate 档位表存在时，主直链跟随最高档（play_addr 只是默认档）。
    const qualities = isVideo ? pickDouyinQualities(videoData.video) : null;
    if (qualities) videoResUrl = qualities[0].url;

    const audioUrl =
      videoData.music && videoData.music.play_url && videoData.music.play_url.url_list
        ? videoData.music.play_url.url_list[0] || ""
        : "";

    return {
      ok: true,
      data: {
        author: (videoData.author && videoData.author.nickname) || "未知作者",
        uid: (videoData.author && videoData.author.unique_id) || "",
        sign: (videoData.author && videoData.author.signature) || "",
        avatar:
          videoData.author && videoData.author.avatar_medium && videoData.author.avatar_medium.url_list
            ? videoData.author.avatar_medium.url_list[0] || ""
            : "",
        like: (videoData.statistics && videoData.statistics.digg_count) || 0,
        time: videoData.create_time || 0,
        title: videoData.desc || "无标题",
        desc: videoData.desc || "",
        cover: isVideo
          ? (videoData.video && videoData.video.cover && videoData.video.cover.url_list
              ? videoData.video.cover.url_list[0] || ""
              : "")
          : images[0] || "",
        type: isVideo ? "video" : "image",
        url: videoResUrl || "",
        qualities: qualities || undefined,
        images: images.length > 0 ? images : undefined,
        imageMeta: Array.isArray(videoData.images) ? videoData.images : [],
        // 上游是毫秒；规则契约统一成秒。
        duration: Math.round(durationMs / 1000),
        width: isVideo ? Number(play.width) || 0 : 0,
        height: isVideo ? Number(play.height) || 0 : 0,
        audioUrl: audioUrl || undefined,
        stat: {
          view: (videoData.statistics && videoData.statistics.play_count) || 0,
          like: (videoData.statistics && videoData.statistics.digg_count) || 0,
          reply: (videoData.statistics && videoData.statistics.comment_count) || 0,
          favorite: (videoData.statistics && videoData.statistics.collect_count) || 0,
          share: (videoData.statistics && videoData.statistics.share_count) || 0,
        },
        music: {
          author: (videoData.music && videoData.music.author) || "未知音乐作者",
          title: (videoData.music && videoData.music.title) || "",
          avatar:
            videoData.music && videoData.music.cover_large && videoData.music.cover_large.url_list
              ? videoData.music.cover_large.url_list[0] || ""
              : "",
        },
        awemeId: videoData.aweme_id || "",
        secUid: (videoData.author && (videoData.author.sec_uid || videoData.author.uid)) || "",
      },
    };
  } catch (error) {
    return { ok: false, reason: "error", error: error };
  }
}

export function extractFilterReason(videoInfo) {
  if (!videoInfo || typeof videoInfo !== "object") return null;
  const loaderData = videoInfo.loaderData || {};
  for (const key of Object.keys(loaderData)) {
    const val = loaderData[key];
    if (val && typeof val === "object") {
      const filterList = val.videoInfoRes && val.videoInfoRes.filter_list;
      if (Array.isArray(filterList) && filterList.length > 0) {
        return filterList.map((f) => f.filter_reason).join("; ");
      }
    }
  }
  return null;
}

/**
 * 页面是否命中反爬 JS challenge（无数据壳页面）：
 * _$jsvmprt（旧）与 argus 风控脚本（新）。只用于无数据时归类报错。
 */
export function isChallengeHtml(html) {
  return (
    html.includes("_$jsvmprt") || html.includes("argus-csp-token") || html.includes("precollect")
  );
}

export function isUserProfileUrl(urlStr) {
  return /\/share\/user\//.test(urlStr) || /[?&]sec_uid=/.test(urlStr);
}

/**
 * 支持 /video|note|story/ID、/share/(video|note)/ID、纯长数字，
 * 以及跳转域名的 target 参数（link.wtturl.cn 等）。
 */
export function extractIdFromUrl(urlStr) {
  try {
    const target = new URL(urlStr).searchParams.get("target");
    if (target) {
      const decoded = decodeURIComponent(target);
      const inner = extractIdFromUrl(decoded);
      if (inner) return inner;
    }
  } catch {
    /* URL 解析失败，继续走常规路径 */
  }

  let match = urlStr.match(/video\/(\d+)/);
  if (match) return { id: match[1], type: "video" };
  match = urlStr.match(/note\/(\d+)/);
  if (match) return { id: match[1], type: "note" };
  match = urlStr.match(/story\/(\d+)/);
  if (match) return { id: match[1], type: "story" };
  match = urlStr.match(/(\d{15,})/);
  if (match) return { id: match[1], type: "video" };
  match = urlStr.match(/share\/(video|note)\/(\d+)/);
  if (match) return { id: match[2], type: match[1] };
  return null;
}

function cleanDouyinPlayUrl(raw) {
  return String(raw || "").replace("playwm", "play").replace("play_wm", "play");
}

/** 上游 quality.js buildQualityList：去重，不足 2 档返回 undefined。 */
function buildQualityList(entries) {
  const list = [];
  const seen = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const url = entry && entry.url;
    if (!url || seen[url]) continue;
    seen[url] = true;
    const rawQuality = Number(entry.quality);
    const quality = Number.isFinite(rawQuality) ? rawQuality : 0;
    list.push({
      quality: quality,
      label: String(entry.label || (quality ? quality + "P" : "默认")),
      url: url,
    });
  }
  return list.length >= 2 ? list : undefined;
}

function pickDouyinQualities(video) {
  const list = Array.isArray(video && video.bit_rate)
    ? video.bit_rate
    : Array.isArray(video && video.bitRateList)
      ? video.bitRateList
      : [];
  const entries = list
    .map((item) => {
      const play = (item && (item.play_addr || item.playAddr)) || {};
      const raw = Array.isArray(play.url_list) ? play.url_list[0] : "";
      const height = Number(play.height || (item && item.height)) || 0;
      const bitrate = Number(item && (item.bit_rate || item.bitRate)) || 0;
      return {
        url: cleanDouyinPlayUrl(raw),
        quality: height || bitrate,
        label: (item && (item.gear_name || item.gearName)) || (height ? height + "p" : ""),
        sort: height || bitrate,
      };
    })
    .filter((entry) => entry.url)
    .sort((a, b) => b.sort - a.sort);
  return buildQualityList(entries);
}

/** 上游 { code, msg, data } → 规则契约 RuleResult。 */
export function toRuleResult(data) {
  const media = [];
  if (data.type === "video" && data.url) {
    media.push({
      kind: "video",
      url: data.url,
      cover: data.cover || "",
      width: data.width || 0,
      height: data.height || 0,
      duration: data.duration || 0,
      title: data.title || "",
    });
  }
  // 图文：每个 images[] 一项；实况图上游未给出 live_photo_url，先保持 undefined。
  if (media.length === 0 && Array.isArray(data.images)) {
    for (let i = 0; i < data.images.length; i++) {
      const meta = data.imageMeta && data.imageMeta[i] ? data.imageMeta[i] : {};
      media.push({
        kind: "image",
        url: data.images[i],
        cover: data.images[i],
        width: Number(meta.width) || 0,
        height: Number(meta.height) || 0,
        title: data.title || "",
      });
    }
  }
  if (media.length === 0) {
    // 理论上 parseVideoData 已经拦掉；留作规则自检。
    const error = new Error("规则未生成任何媒体");
    error.code = "UPSTREAM_CHANGED";
    throw error;
  }

  return {
    type: data.type === "video" ? "video" : "image",
    title: data.title || "",
    desc: data.desc || "",
    author: {
      nickname: data.author || "",
      id: data.uid || "",
      avatar: data.avatar || "",
    },
    cover: data.cover || "",
    media: media,
    raw: {
      aweme_id: data.awemeId || "",
      sec_uid: data.secUid || "",
      author_url: data.secUid ? "https://www.douyin.com/user/" + data.secUid : "",
      like: data.like || 0,
      create_time: data.time || 0,
      duration_ms: data.duration ? data.duration * 1000 : 0,
      stat: data.stat,
      music: data.music,
      qualities: data.qualities || [],
      audio_url: data.audioUrl || "",
      sign: data.sign || "",
    },
  };
}
