// @source https://github.com/frostming/fxzhihu
// @file src/lib.ts（fixImagesAndLinks / stripHtmlTags）
// @file src/answer.ts、src/article.ts、src/question.ts、src/status.ts（字段映射）
// @license MIT
// @commit 24403bfe80a07f6299ea6fba5374b2f2dcec2ff1
// @adapted 上游用 Cloudflare HTMLRewriter 改 <img data-actualsrc> / 去 <u>；
//   规则运行时没有 HTMLRewriter，这里用等价的正则实现，并兼容懒加载 data-original。
//   上游输出 HTML 模板；这里直接映射成 RuleResult（content/content_format=html）。
// @extended 过滤 data:image/svg 与 /equation 公式图；content 超过 1 MiB 时按 UTF-8 截断。
// @omitted 参考文献列表、origin_pin 转发内容、专栏信息卡片（RuleResult 无对应字段）。

const MAX_CONTENT_BYTES = 1 << 20; // 与宿主的 content 上限一致

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text) {
  return String(text == null ? "" : text).replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (match, body) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        if (Number.isFinite(code) && code > 0) {
          try {
            return String.fromCodePoint(code);
          } catch {
            return match;
          }
        }
        return match;
      }
      const key = body.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : match;
    }
  );
}

function parseAttrs(tag) {
  const attrs = [];
  ATTR_RE.lastIndex = 0;
  let match;
  while ((match = ATTR_RE.exec(tag))) {
    const quoted = match[3] !== undefined ? match[3] : match[4];
    const value = quoted !== undefined ? quoted : match[5];
    attrs.push([match[1], value]);
  }
  return attrs;
}

function attrValue(attrs, name) {
  const lower = String(name).toLowerCase();
  for (const [key, value] of attrs) {
    if (String(key).toLowerCase() === lower) return value;
  }
  return "";
}

function escapeAttr(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
}

function isDroppedImage(src) {
  const value = String(src == null ? "" : src).trim();
  if (!value) return false;
  if (/^data:image\/svg/i.test(value)) return true;
  return value.includes("/equation");
}

/** 上游 fixImagesAndLinks 的等价物：data-actualsrc/data-original 提升为 src，去掉 <u> 包裹。 */
export function fixImagesAndLinks(html) {
  if (!html) return "";
  let out = String(html).replace(IMG_TAG_RE, (tag) => {
    const attrs = parseAttrs(tag);
    const actual = attrValue(attrs, "data-actualsrc") || attrValue(attrs, "data-original");
    const src = actual || attrValue(attrs, "src");
    if (isDroppedImage(src)) return "";
    if (!src) return "<img>";

    const kept = [];
    let wroteSrc = false;
    for (const [name, value] of attrs) {
      const lower = String(name).toLowerCase();
      if (lower === "data-actualsrc" || lower === "data-original") continue;
      if (lower === "src") {
        if (!wroteSrc) {
          kept.push(`src="${escapeAttr(decodeEntities(actual || value))}"`);
          wroteSrc = true;
        }
        continue;
      }
      kept.push(`${name}="${escapeAttr(decodeEntities(value))}"`);
    }
    if (!wroteSrc) {
      kept.unshift(`src="${escapeAttr(decodeEntities(src))}"`);
    }
    return kept.length > 0 ? `<img ${kept.join(" ")}>` : "<img>";
  });
  // 上游移除 <u> 标签、保留文字。
  out = out.replace(/<\/?u\b[^>]*>/gi, "");
  return out;
}

/** 把 HTML 里的图片地址绝对化；非 http(s)（含 data:）返回空串。 */
export function absolutizeImageURL(src) {
  let value = decodeEntities(String(src == null ? "" : src)).trim();
  if (!value) return "";
  if (value.startsWith("//")) value = "https:" + value;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return "";
  try {
    return new URL(value, "https://www.zhihu.com/").href;
  } catch {
    return "";
  }
}

/** 从（已清洗的）正文 HTML 中提取图片，去重并绝对化。 */
export function extractImages(html) {
  const urls = [];
  const seen = new Set();
  IMG_TAG_RE.lastIndex = 0;
  let match;
  while ((match = IMG_TAG_RE.exec(String(html || "")))) {
    const src = attrValue(parseAttrs(match[0]), "src");
    if (isDroppedImage(src)) continue;
    const url = absolutizeImageURL(src);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

export function stripHtmlTags(html) {
  return String(html == null ? "" : html).replace(/<[^>]*>/g, "");
}

/** 去掉标签并把 <br> 变成换行，用于 desc 这类纯文本字段。 */
export function htmlToText(html) {
  const withBreaks = String(html == null ? "" : html).replace(/<br\s*\/?>/gi, "\n");
  return decodeEntities(stripHtmlTags(withBreaks)).trim();
}

/** 按 UTF-8 字节数截断，保证不超过宿主 1 MiB 上限；不打断可见文本。 */
export function clampContent(text) {
  const value = String(text == null ? "" : text);
  if (!value) return "";
  if (typeof TextEncoder === "undefined") {
    return value.length > 262144 ? value.slice(0, 262144) : value;
  }
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= MAX_CONTENT_BYTES) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, mid)).length <= MAX_CONTENT_BYTES) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return value.slice(0, low);
}

export function mapAuthor(author) {
  const a = author || {};
  let id = a.id != null && String(a.id) !== "" ? String(a.id) : "";
  if (!id && a.url_token) id = String(a.url_token);
  if (!id && typeof a.url === "string") {
    const match = a.url.match(/\/(?:people|org)\/([^/?#]+)/);
    if (match) id = match[1];
  }
  return {
    nickname: a.name || "",
    id,
    avatar: a.avatar_url || "",
  };
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** 正文/媒体决定 type：有视频 → video，有可见文字 → richtext，只有图 → image。 */
function pickType(content, videos, images) {
  if (videos.length > 0) return "video";
  if (htmlToText(content) !== "") return "richtext";
  if (images.length > 0) return "image";
  return "";
}

function imageMedia(urls, extra) {
  const media = [];
  const seen = new Set();
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    media.push({ kind: "image", url });
  }
  for (const item of extra || []) {
    if (!item || !item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    const mediaItem = { kind: "image", url: item.url };
    if (item.width) mediaItem.width = item.width;
    if (item.height) mediaItem.height = item.height;
    media.push(mediaItem);
  }
  return media;
}

function finishResult(kind, id, fields, content, videos, images, cover) {
  const type = pickType(content, videos, images);
  if (!type) return null;
  return {
    type,
    title: fields.title || "",
    desc: fields.desc || "",
    content,
    content_format: "html",
    author: fields.author,
    cover: cover || "",
    media: videos.concat(images),
    raw: { source: "zhihu", id, kind },
  };
}

/** /answer/<id>、/question/<qid>/answer/<aid> */
export function buildAnswerResult(data, id) {
  const contentHtml = fixImagesAndLinks(data.content || "");
  const content = clampContent(contentHtml);
  const images = imageMedia(extractImages(contentHtml));
  const question = data.question || {};
  let cover = images.length > 0 ? images[0].url : "";
  if (!cover) {
    const questionImages = extractImages(fixImagesAndLinks(question.detail || ""));
    cover = questionImages[0] || "";
  }
  return finishResult(
    "answer",
    id,
    {
      title: question.title || "",
      desc: data.excerpt || "",
      author: mapAuthor(data.author),
    },
    content,
    [],
    images,
    cover
  );
}

/** zhuanlan.zhihu.com/p/<id>、www.zhihu.com/p/<id> */
export function buildArticleResult(data, id) {
  const contentHtml = fixImagesAndLinks(data.content || "");
  const content = clampContent(contentHtml);
  const images = imageMedia(extractImages(contentHtml));
  const cover = data.image_url || (images.length > 0 ? images[0].url : "");
  return finishResult(
    "article",
    id,
    {
      title: data.title || "",
      desc: htmlToText(data.excerpt || ""),
      author: mapAuthor(data.author),
    },
    content,
    [],
    images,
    cover
  );
}

/** /question/<id> */
export function buildQuestionResult(data, id) {
  const contentHtml = fixImagesAndLinks(data.detail || "");
  const content = clampContent(contentHtml);
  const images = imageMedia(extractImages(contentHtml));
  return finishResult(
    "question",
    id,
    {
      title: data.title || "",
      desc: data.excerpt || "",
      author: mapAuthor(data.author),
    },
    content,
    [],
    images,
    images.length > 0 ? images[0].url : ""
  );
}

function pickVideo(item) {
  const playlist = Array.isArray(item.playlist) ? item.playlist : [];
  // 与上游 findVideoUrl 一致：只认 quality === "hd"。
  const hd = playlist.find((entry) => entry && entry.quality === "hd");
  if (!hd || !hd.url) return null;
  const url = absolutizeImageURL(hd.url);
  if (!url) return null;
  return {
    kind: "video",
    url,
    duration: toInt(item.duration) || toInt(hd.duration),
    cover: absolutizeImageURL(item.thumbnail || ""),
    width: toInt(item.width) || toInt(hd.width),
    height: toInt(item.height) || toInt(hd.height),
  };
}

/** /pin/<id> */
export function buildPinResult(data, id) {
  const author = mapAuthor(data.author);
  const items = Array.isArray(data.content) ? data.content : [];

  let contentHtml = data.content_html || "";
  if (!contentHtml) {
    // 部分纯文字想法没有 content_html；回落到 content[] 的 text 项。
    const textItem = items.find((item) => item && item.type === "text");
    if (textItem) contentHtml = textItem.content || textItem.own_text || "";
  }
  const fixed = fixImagesAndLinks(contentHtml);
  const content = clampContent(fixed);

  const itemImages = [];
  const videos = [];
  for (const item of items) {
    if (!item) continue;
    if (item.type === "image") {
      itemImages.push({
        url: absolutizeImageURL(item.original_url || item.url || ""),
        width: toInt(item.width),
        height: toInt(item.height),
      });
    } else if (item.type === "video" && videos.length === 0) {
      const video = pickVideo(item);
      if (video) videos.push(video);
    }
  }

  const images = imageMedia(extractImages(fixed), itemImages);
  const cover =
    (videos.length > 0 && videos[0].cover) ||
    (images.length > 0 ? images[0].url : "");

  return finishResult(
    "pin",
    id,
    {
      title: author.nickname ? `${author.nickname}的想法` : "知乎想法",
      desc: htmlToText(data.excerpt_title || ""),
      author,
    },
    content,
    videos,
    images,
    cover
  );
}
