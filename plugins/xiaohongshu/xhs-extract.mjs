// @source https://github.com/hotier/MediaGet
// @file packages/parse-core/src/lib/xhsCore.js
// @license MIT
// @commit 17603b8a5404b4dc7408b5c44dae441ea9d2996f
// @adapted 从上游 xhsCore.js 复制纯函数（safeGet / resolveNotePayload /
//   sanitizeInitialStateJson / extractInitialStateJson / collectVideoEntries /
//   pickStableVideoUrl / 图片 URL 提取），fetch -> 调用方传入的 ctx.http.request。
// @omitted 互动统计、博主主页统计/缓存/profile token（RuleResult 没有对应字段）；
//   Cookie 池（宿主每次解析使用独立 Cookie jar）。
//
// 扩展（相对上游）：实况图的 live_photo_url。上游只输出静态图 URL，这里从
// noteData.imageList[i] 在 livePhoto === true 时复用 video stream 选择逻辑
// （collectVideoEntries + pickStableVideoUrl）提取实况视频地址。

/** 小红书 H5 UA，与上游 lib/http.ts 的 UA_EDGE_WIN129 逐字符一致。 */
export const XHS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0";

/** 与上游 lib/http.ts 的 TIMEOUT 常量组保持一致。 */
export const TIMEOUT = {
  SHORT: 5000,
  PAGE: 20000,
};

/** 小红书短链统一走 https（上游 normalizeXhsUrl）。 */
export function normalizeXhsUrl(url) {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase();
    if (["xhslink.com", "xhslink.cn"].includes(host) && u.protocol === "http:") {
      u.protocol = "https:";
      return u.toString();
    }
  } catch {
    /* ignore */
  }
  return url.trim();
}

/** 安全地获取嵌套属性（上游 safeGet）。 */
export function safeGet(obj, path) {
  try {
    return path.split(".").reduce((current, key) => {
      if (current && typeof current === "object" && key in current) {
        return current[key];
      }
      return null;
    }, obj);
  } catch {
    return null;
  }
}

/**
 * 识别小红书的「拦截页」：链接失效/需要登录时，小红书会 302 到 /404 或 /login，
 * 这两类页面同样带 __INITIAL_STATE__（但 note 是空壳或不存在）。
 * 与上游 detectXhsBlockedPage 的判定一致，只把 output(code,msg) 换成错误码。
 */
export function detectXhsBlockedPage(finalUrl) {
  if (!finalUrl) return null;
  let path = "";
  try {
    path = new URL(finalUrl).pathname;
  } catch {
    return null;
  }
  if (/^\/login(\/|$)/.test(path)) {
    return {
      code: "COOKIE_REQUIRED",
      message: "该笔记需要登录才能浏览，请配置小红书 Cookie 后重试",
    };
  }
  if (/^\/website-login\/captcha/.test(path)) {
    return {
      code: "RISK_CONTROL",
      message: "小红书触发了安全验证，请稍后重试，或配置有效的 Cookie",
    };
  }
  if (/^\/website-login\/error(\/|$)/.test(path) || /error_code=300017/.test(finalUrl)) {
    return {
      code: "MEDIA_NOT_FOUND",
      message: "笔记暂时无法查看：可能已删除、设为私密或被限制访问",
    };
  }
  if (/^\/404(\/|$)/.test(path) || /error_code=300031/.test(finalUrl)) {
    return {
      code: "MEDIA_NOT_FOUND",
      message: "笔记暂时无法浏览：链接可能已失效或需要新的分享链接",
    };
  }
  return null;
}

/**
 * 新版笔记页：note.currentNoteId + note.noteDetailMap[id].note
 * 旧版：noteData.data.noteData 等（上游 resolveNotePayload）。
 */
export function resolveNotePayload(decoded) {
  const noteId = safeGet(decoded, "note.currentNoteId");
  const detailMap = safeGet(decoded, "note.noteDetailMap");
  if (noteId && detailMap && typeof detailMap === "object") {
    const entry = detailMap[noteId];
    if (entry && entry.note && typeof entry.note === "object") {
      return entry.note;
    }
    if (entry && typeof entry === "object" && entry.title) {
      return entry;
    }
  }

  const legacy =
    safeGet(decoded, "noteData.data.noteData") ||
    safeGet(decoded, "note.data") ||
    safeGet(decoded, "noteDetail.data") ||
    safeGet(decoded, "data.noteData") ||
    safeGet(decoded, "note.noteDetailMap")?.[noteId]?.note ||
    safeGet(decoded, "note.noteDetailMap")?.[noteId];
  if (legacy) return legacy;

  // 登录页/404 页也带 note 空壳（无任何笔记字段），按字段特征校验。
  const shell = safeGet(decoded, "note");
  if (
    shell &&
    typeof shell === "object" &&
    (shell.title || shell.desc || shell.noteId || shell.imageList || shell.video)
  ) {
    return shell;
  }
  return null;
}

/**
 * 小红书页面的 __INITIAL_STATE__ 不是严格 JSON：匿名页偶见 `undefined`，
 * 登录态页面还会带 `new Map([])` / `new Set([])` 这类 JS 字面量。
 * 这里按字符串边界安全改写为 JSON 等价形态（上游 sanitizeInitialStateJson）。
 */
export function sanitizeInitialStateJson(raw) {
  let out = "";
  let i = 0;
  const n = raw.length;
  let inString = false;

  while (i < n) {
    const ch = raw[i];

    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += raw[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    // new Map(...) / new Set(...) / new WeakMap(...) → {} / []
    const ctor = /^new (Map|Set|WeakMap|WeakSet)\s*\(/.exec(raw.slice(i, i + 24));
    if (ctor) {
      const isMap = ctor[1] === "Map" || ctor[1] === "WeakMap";
      i += ctor[0].length;
      let depth = 1;
      let str = false;
      while (i < n && depth > 0) {
        const c = raw[i];
        if (str) {
          if (c === "\\") {
            i += 2;
            continue;
          }
          if (c === '"') str = false;
        } else if (c === '"') {
          str = true;
        } else if (c === "(") {
          depth += 1;
        } else if (c === ")") {
          depth -= 1;
        }
        i += 1;
      }
      out += isMap ? "{}" : "[]";
      continue;
    }

    if (raw.startsWith("undefined", i)) {
      out += "null";
      i += "undefined".length;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/** 从页面 HTML 提取 __INITIAL_STATE__（上游 extractInitialStateJson 的三级兜底）。 */
export function extractInitialStateJson(html) {
  // 取到下一个 </script>，避免对大段 JSON 做错误的非贪婪 `}` 截断
  const re = /window\.__INITIAL_STATE__\s*=\s*(.*?)<\/script>/is;
  const m = html.match(re);
  if (m?.[1]) {
    return m[1].trim();
  }
  const legacy =
    /<script>\s*window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/i.exec(html);
  if (legacy?.[1]) {
    return legacy[1].trim();
  }
  const inline =
    /<script[^>]*>\s*window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/i.exec(html);
  return inline?.[1]?.trim() ?? null;
}

/**
 * 从 video.media.stream 取可用视频档位（上游 collectVideoEntries）。
 * 旧结构键为 h264/h265/av1，新结构为 EF4~EF7；旧键优先，全缺时遍历数组键兜底。
 * 实况图的 imageList[i].stream 也是同一结构，因此复用。
 */
export function collectVideoEntries(stream) {
  if (!stream || typeof stream !== "object") return [];

  const isEntry = (e) =>
    e &&
    typeof e === "object" &&
    (e.masterUrl || (Array.isArray(e.backupUrls) && e.backupUrls.length > 0));

  for (const key of ["h264", "h265", "av1", "h266"]) {
    const arr = stream[key];
    if (!Array.isArray(arr)) continue;
    const list = arr.filter(isEntry);
    if (list.length) return list;
  }

  const fallback = [];
  for (const value of Object.values(stream)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (isEntry(entry)) fallback.push(entry);
    }
  }
  return fallback;
}

/**
 * 选取稳定可用的视频直链（上游 pickStableVideoUrl）：
 * backupUrls 为裸直链（长期有效）优先，masterUrl 带约 30 分钟签名仅作兜底。
 * HEAD 验证可用性；HEAD 全部失败时仍返回第一候选，交给下游 GET 尝试。
 */
export async function pickStableVideoUrl(ctx, entry) {
  if (!entry || typeof entry !== "object") return null;

  const toHttps = (u) => (u ? u.replace(/^http:/i, "https:") : u);

  const candidates = [];
  if (Array.isArray(entry.backupUrls)) {
    for (const u of entry.backupUrls) {
      if (u) candidates.push(toHttps(u));
    }
  }
  if (entry.masterUrl) candidates.push(toHttps(entry.masterUrl));

  for (const u of candidates) {
    try {
      const head = await ctx.http.request({
        url: u,
        method: "HEAD",
        timeoutMs: TIMEOUT.SHORT,
      });
      if (head.status >= 200 && head.status < 400) return u;
    } catch {
      /* try next */
    }
  }
  return candidates[0] || null;
}

/** 图片 URL：urlDefault -> url -> infoList[0].url，统一转 https（上游字段顺序）。 */
export function pickImageUrl(img) {
  if (!img || typeof img !== "object") return "";
  const raw =
    img.urlDefault ||
    img.url ||
    safeGet(img, "infoList.0.url") ||
    "";
  return String(raw).replace(/^http:/i, "https:");
}

/**
 * 视频笔记 -> 单个 video media（上游取最高分辨率档位）。
 * 返回 null 表示不是视频笔记。
 */
export async function buildVideoMedia(ctx, noteData) {
  const videoStream = safeGet(noteData, "video.media.stream");
  if (!videoStream || typeof videoStream !== "object") return null;

  const list = collectVideoEntries(videoStream);
  if (!list.length) return null;

  const stableUrls = await Promise.all(list.map((entry) => pickStableVideoUrl(ctx, entry)));
  const resolved = list
    .map((entry, i) => ({ entry, url: stableUrls[i] }))
    .filter(({ url }) => url)
    .sort(
      (a, b) =>
        (Number(b.entry.height) || 0) - (Number(a.entry.height) || 0) ||
        (Number(b.entry.width) || 0) - (Number(a.entry.width) || 0)
    );

  const best = resolved[0];
  if (!best) return null;

  const imageList = noteData.imageList;
  let cover = "";
  if (Array.isArray(imageList) && imageList.length > 0) {
    cover = pickImageUrl(imageList[0]);
  }

  // 上游 stream[].duration 为毫秒，RuleResult.duration 为秒。
  const rawDuration =
    best.entry.duration ?? safeGet(noteData, "video.media.video.duration");
  const duration =
    typeof rawDuration === "number" && rawDuration > 0
      ? Math.round(rawDuration / 1000)
      : 0;

  return {
    kind: "video",
    url: best.url,
    live_photo_url: "",
    width: Number(best.entry.width) || 0,
    height: Number(best.entry.height) || 0,
    duration,
    cover,
    title: "",
  };
}

/**
 * 图文笔记 -> image media[]。
 *
 * 相对上游的扩展：imageList[i].livePhoto === true 时，用该图的 stream
 * （与 video.media.stream 同结构）选出实况视频地址，填入 live_photo_url。
 * 上游只返回图片 URL，会丢掉实况视频；这里保留。
 */
export async function buildImageMedia(ctx, noteData) {
  const imageList = noteData.imageList;
  if (!Array.isArray(imageList) || imageList.length === 0) return [];

  const media = [];
  for (const img of imageList) {
    if (!img || typeof img !== "object") continue;
    const imageUrl = pickImageUrl(img);
    if (!imageUrl) continue;

    let livePhotoUrl = "";
    if (img.livePhoto === true) {
      const entries = collectVideoEntries(img.stream);
      if (entries.length > 0) {
        livePhotoUrl = (await pickStableVideoUrl(ctx, entries[0])) || "";
      }
    }

    media.push({
      kind: "image",
      url: imageUrl,
      live_photo_url: livePhotoUrl,
      width: Number(img.width) || 0,
      height: Number(img.height) || 0,
      duration: 0,
      cover: "",
      title: "",
    });
  }
  return media;
}
