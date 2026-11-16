// @source https://github.com/ZiLing/ParseHub (reference/ParseHub)
// @file src/parsehub/provider_api/twitter.py (ArticleRenderer)
// @license MIT
//
// X Article 的 Draft.js content_state → Markdown 渲染。
//
// 这里的输入是 GraphQL TweetResultByRestId（fieldToggles
// withArticleRichContentState=true）返回的 article_results.result。
// 结构移植自旧的 Python 实现，仅把 dict/循环换成 JS，块级/行内标记与
// 媒体实体替换顺序保持原样。X 的 Article JSON 不是公开稳定接口，字段
// 缺失时按空内容处理，由调用方决定是否降级。

const INLINE_STYLES = {
  Bold: "**",
  Italic: "*",
  Strikethrough: "~~",
};

const BLOCK_FORMATTERS = {
  "header-one": (t) => `# ${t}`,
  "header-two": (t) => `## ${t}`,
  "header-three": (t) => `### ${t}`,
  blockquote: (t) =>
    t
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
  "ordered-list-item": (t) => `1. ${t}`,
  "unordered-list-item": (t) => `- ${t}`,
};

function insertionWeight(kind) {
  if (kind === "end") return 1;
  if (kind === "start") return -1;
  return 0;
}

/**
 * 与 Python 版一致的插入顺序：先处理靠后的位置；同一位置 start → atomic →
 * end。text.split("") 以 UTF-16 code unit 为单位，和 Draft.js 的 offset 对齐。
 */
function applyInsertions(text, insertions) {
  const chars = String(text).split("");
  insertions.sort(
    (a, b) =>
      b.idx - a.idx ||
      insertionWeight(a.kind) - insertionWeight(b.kind) ||
      a.length - b.length
  );
  for (const ins of insertions) {
    if (ins.kind === "atomic" && ins.idx < chars.length) {
      chars[ins.idx] = ins.text;
    } else {
      chars.splice(ins.idx, 0, ins.text);
    }
  }
  return chars.join("");
}

function buildMediaIndex(mediaEntities) {
  const byId = new Map();
  const items = [];
  for (const entity of Array.isArray(mediaEntities) ? mediaEntities : []) {
    const mediaId = entity?.media_id;
    const info = entity?.media_info || {};
    const typename = info.__typename;

    if (typename === "ApiImage") {
      const url = info.original_img_url || "";
      if (mediaId && url) byId.set(String(mediaId), { type: "image", url });
      if (url) {
        items.push({
          kind: "image",
          url,
          width: Number(info.original_img_width) || 0,
          height: Number(info.original_img_height) || 0,
        });
      }
    } else if (typename === "ApiVideo") {
      const preview = info.preview_image || {};
      const previewUrl = preview.original_img_url || "";
      const videoUrl = bestMp4Url(info.variants);
      if (mediaId && previewUrl) {
        byId.set(String(mediaId), {
          type: "video",
          previewUrl,
          videoUrl,
        });
      }
      if (videoUrl) {
        items.push({
          kind: "video",
          url: videoUrl,
          cover: previewUrl,
          duration: Math.round(Number(info.duration_millis) / 1000) || 0,
          width: Number(preview.original_img_width) || 0,
          height: Number(preview.original_img_height) || 0,
        });
      }
    }
  }
  return { byId, items };
}

function bestMp4Url(variants) {
  let best = "";
  let bestBitrate = -1;
  for (const v of Array.isArray(variants) ? variants : []) {
    const ct = v?.content_type || v?.type || "";
    if (!String(ct).includes("mp4")) continue;
    const br = Number(v.bitrate ?? v.bit_rate) || 0;
    const url = v?.url || v?.src || "";
    if (url && br > bestBitrate) {
      bestBitrate = br;
      best = url;
    }
  }
  return best;
}

function mediaEntityToMarkdown(entityData, mediaById) {
  const mediaItems = entityData?.data?.mediaItems;
  if (!Array.isArray(mediaItems) || mediaItems.length === 0) return "";
  const obj = mediaById.get(String(mediaItems[0]?.mediaId));
  if (!obj) return "";
  if (obj.type === "image") return `![Image](${obj.url})`;
  if (obj.type === "video") {
    return obj.videoUrl
      ? `[![Video](${obj.previewUrl})](${obj.videoUrl})`
      : `![Video Preview](${obj.previewUrl})`;
  }
  return "";
}

function collectInlineStyles(block) {
  const out = [];
  for (const style of Array.isArray(block?.inlineStyleRanges)
    ? block.inlineStyleRanges
    : []) {
    const marker = INLINE_STYLES[style?.style];
    if (!marker) continue;
    const offset = Number(style.offset) || 0;
    const length = Number(style.length) || 0;
    out.push({ idx: offset, text: marker, kind: "start", length });
    out.push({ idx: offset + length, text: marker, kind: "end", length });
  }
  return out;
}

function collectEntities(block, entityMap, mediaById) {
  const out = [];
  for (const ent of Array.isArray(block?.entityRanges) ? block.entityRanges : []) {
    const offset = Number(ent.offset) || 0;
    const length = Number(ent.length) || 0;
    const entityData = entityMap.get(String(ent.key)) || {};
    const type = entityData.type;

    if (type === "LINK") {
      const url = entityData?.data?.url || "";
      out.push({ idx: offset, text: "[", kind: "start", length });
      out.push({ idx: offset + length, text: `](${url})`, kind: "end", length });
    } else if (type === "MEDIA") {
      const md = mediaEntityToMarkdown(entityData, mediaById);
      if (md) out.push({ idx: offset, text: md, kind: "atomic", length });
    } else if (type === "DIVIDER") {
      out.push({ idx: offset, text: "\n---\n", kind: "atomic", length });
    }
  }
  return out;
}

function renderBlock(block, entityMap, mediaById) {
  const blockType = block?.type || "unstyled";
  const text = String(block?.text ?? "");
  const insertions = [
    ...collectInlineStyles(block),
    ...collectEntities(block, entityMap, mediaById),
  ];
  const rendered = applyInsertions(text, insertions);
  const formatter = BLOCK_FORMATTERS[blockType];
  return formatter ? formatter(rendered) : rendered;
}

/**
 * article_results.result → { title, markdown, media[], cover }。
 * media[] 是文章内联媒体（图片/视频），cover 只作为封面，不重复放进 media。
 */
export function renderArticle(articleData) {
  const data = articleData && typeof articleData === "object" ? articleData : {};
  const contentState = data.content_state || {};
  const blocks = Array.isArray(contentState.blocks) ? contentState.blocks : [];

  const entityMap = new Map();
  const rawEntityMap = contentState.entityMap;
  if (Array.isArray(rawEntityMap)) {
    for (const item of rawEntityMap) {
      if (item && item.key != null) entityMap.set(String(item.key), item.value || {});
    }
  } else if (rawEntityMap && typeof rawEntityMap === "object") {
    // 部分 Article 响应把 entityMap 序列化成 { "0": {...} }。
    for (const key of Object.keys(rawEntityMap)) {
      entityMap.set(String(key), rawEntityMap[key] || {});
    }
  }

  const { byId, items } = buildMediaIndex(data.media_entities);
  const cover =
    data?.cover_media?.media_info?.original_img_url ||
    data?.cover_media?.media_info?.preview_image?.original_img_url ||
    "";

  const lines = [];
  if (cover) lines.push(`![Cover Image](${cover})\n`);
  for (const block of blocks) lines.push(renderBlock(block, entityMap, byId));

  return {
    title: typeof data.title === "string" ? data.title : "",
    markdown: lines.join("\n\n"),
    media: items,
    cover,
  };
}
