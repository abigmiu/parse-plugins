// @source https://github.com/hotier/MediaGet
// @file packages/parse-core/src/lib/bilibili-opus.js
// @license MIT
// @commit 17603b8a5404b4dc7408b5c44dae441ea9d2996f
// @adapted 纯函数原样复制，无 Node/运行时依赖；供 rule.mjs 的 opus/动态分支调用。
// @omitted 无。extractOpusFavorite 保留但当前未被 rule.mjs 使用（RuleResult 没有收藏数字段）。

/** http → https：hdslb 图床图片 http 直链在 https 页面会被混合内容拦截破图 */
function toHttps(url) {
  if (typeof url !== "string") return "";
  return url.replace(/^http:\/\//i, "https://");
}

/** 空串 / "-" / 纯空白视为无文案（与视频 desc 归一行为一致） */
function cleanText(text) {
  if (typeof text !== "string") return "";
  const t = text.trim();
  if (!t || t === "-") return "";
  return text;
}

/** 统计计数：仅保留正数，缺失/异常返回 undefined（调用方据此保持字段缺失） */
function positiveCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 从 opus/detail 响应提取收藏数。该接口的 modules 是数组（每项带 module_type），
 * 收藏数位于 MODULE_TYPE_STAT 项的 module_stat.favorite.count。
 * 缺失 / 结构不符 / 非正数时返回 undefined，由调用方保持字段缺失。
 */
export function extractOpusFavorite(payload) {
  const modules = payload?.data?.item?.modules;
  if (!Array.isArray(modules)) return undefined;
  const statModule = modules.find((m) => m?.module_stat);
  const favorite = statModule?.module_stat?.favorite;
  const count =
    favorite && typeof favorite === "object" ? favorite.count : favorite;
  return positiveCount(count);
}

export function classifyOpusDetail(detail) {
  const item = detail?.data?.item;
  if (!item) return { ok: false, msg: "解析失败！" };

  const type = item.type || "";
  const modules = item.modules || {};
  const dynamic = modules.module_dynamic || {};
  const opus = dynamic.major?.opus || {};
  const pics = (Array.isArray(opus.pics) ? opus.pics : [])
    .map((pic) => toHttps(pic?.url))
    .filter(Boolean);

  // 专栏文章封面图只是入口图，正文需另走已风控接口，保持拒绝
  if (type === "DYNAMIC_TYPE_ARTICLE") {
    return {
      ok: false,
      msg: "该动态是B站专栏文章，非图文动态，暂不支持解析正文图片",
    };
  }
  // 白名单之外的类型一律拒绝（视频/转发/直播/音乐等）
  if (!/^(DYNAMIC_TYPE_DRAW|DYNAMIC_TYPE_OPUS|DYNAMIC_TYPE_WORD)$/.test(type)) {
    return { ok: false, msg: "该动态不是图文或文字内容，暂不支持解析" };
  }

  const author = modules.module_author || {};
  const stat = modules.module_stat || {};
  const mid = author.mid;
  const pubTs = Number(author.pub_ts);
  const time = Number.isFinite(pubTs) && pubTs > 0 ? pubTs : undefined;
  const base = {
    title: opus.title || undefined,
    author: author.name || undefined,
    authorId: mid != null ? String(mid) : undefined,
    authorUrl: mid != null ? `https://space.bilibili.com/${mid}` : undefined,
    avatar: toHttps(author.face),
    time,
    stat: {
      like: positiveCount(stat.like?.count),
      reply: positiveCount(stat.comment?.count),
      favorite: positiveCount(stat.favorite?.count),
      share: positiveCount(stat.forward?.count),
    },
  };

  if (pics.length > 0) {
    return {
      ok: true,
      data: {
        type: "image",
        ...base,
        desc: cleanText(opus.summary?.text) || undefined,
        cover: pics[0],
        images: pics,
      },
    };
  }

  // 无图：纯文字动态（WORD，或 DRAW/OPUS 发成纯文字）。正文优先取
  // itemOpusStyle 的 opus.summary.text，旧/无 features 形态回退 desc.text。
  const text = cleanText(opus.summary?.text) || cleanText(dynamic.desc?.text);
  if (!text) {
    return { ok: false, msg: "该动态不包含可解析的文字或图片内容" };
  }
  return {
    ok: true,
    data: {
      type: "text",
      ...base,
      desc: text,
    },
  };
}
