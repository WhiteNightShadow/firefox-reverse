/* ChatImages.sys.mjs — 用户在输入框粘贴/拖入的图片：上限、图片引用的校验、发给模型时的图片预算。
 *
 * 纯函数，不碰文件和 DOM（存取在 ConversationStore，粘贴和压缩在侧栏面板），Node 自测可以直接 import。
 *
 * 发给模型的图片统一用 OpenAI Chat 的形态：{ type: "image_url", image_url: { url: "data:<mime>;base64,..." } }，
 * LlmClient 再按协议翻成 Anthropic 的 image 块、Responses 的 input_image、Gemini 的 inlineData。
 * 内容块里不能加自定义字段：OpenAI 形态的消息原样发出去，校验严格的网关会拒收不认识的字段。
 */

/** 存下来的图片只有这几种：各家 API 都收（GIF 只收静态的，粘贴时会转成 PNG）。 */
export const IMAGE_MIME_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const IMAGE_EXT = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" });

/** 一条消息最多带几张图。 */
export const MAX_IMAGES_PER_MESSAGE = 8;
/** 单张图压缩后的上限：3.5MB，base64 后约 4.7MB——低于 Anthropic 网关常见的单图 5MB（base64）和 Bedrock 的 3.75MB。 */
export const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
/** 一条消息里图片合计的上限，保证最新一条消息的图片一定放得进一次请求的图片预算。 */
export const MAX_MESSAGE_IMAGE_BYTES = 8 * 1024 * 1024;
/** 长边上限。Anthropic 一次请求超过 20 张图时每张不能超过 2000px，超了整个会话以后每次请求都会被拒；
 *  各家实际也会缩到 2000px 左右（OpenAI 高清档 2048、Claude 1568/2576）。粘贴时就缩好。 */
export const MAX_IMAGE_EDGE = 2000;
/** 一次请求最多带几张图（含工具截图），超过的从最早的开始换成文字说明。 */
export const MAX_REQUEST_IMAGES = 20;
/** 一次请求里图片 data URL 合计的字符数上限：Gemini 内联数据整个请求 20MB，留出文字的余量。 */
export const MAX_REQUEST_IMAGE_CHARS = 12 * 1024 * 1024;
/** 估算上下文时一张图按多少字符算。按 base64 长度算会把一张 1MB 的截图当成上百万字，立刻触发压缩。
 *  各家一张图实际约 1.5k–4.8k token。 */
export const IMAGE_CONTEXT_CHARS = 3000;

const DATA_URL = /^data:([^;,]+);base64,/;

/** 内容块是不是一张图。 */
export function isImagePart(part) {
  return !!part && typeof part === "object" && (part.type === "image_url" || part.type === "input_image");
}

/** 一段消息内容折算成多少字符（估上下文用）：文字按长度，图片按 IMAGE_CONTEXT_CHARS。 */
export function contentChars(content) {
  if (content == null) return 0;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return String(content).length;
  let n = 0;
  for (const part of content) {
    if (typeof part === "string") n += part.length;
    else if (isImagePart(part)) n += IMAGE_CONTEXT_CHARS;
    else if (part && typeof part.text === "string") n += part.text.length;
    else if (part != null) n += JSON.stringify(part).length;
  }
  return n;
}

/** 一段内容里有几张图。 */
export function countImageParts(content) {
  return Array.isArray(content) ? content.filter(isImagePart).length : 0;
}

/** 给摘要、日志用的说明：「（附图 2 张）」；没有图返回 ""。 */
export function imagesNote(n) {
  return n > 0 ? `（附图 ${n} 张）` : "";
}

export const IMAGE_NOTE_OLD = n => `［这里原本附有 ${n} 张图片，时间较早，这次没有发给模型］`;
export const IMAGE_NOTE_UNSUPPORTED = n => `［这里附有 ${n} 张图片，当前模型不支持看图，没有发给模型］`;
export const IMAGE_NOTE_MISSING = n => `［这里附有 ${n} 张图片，图片文件已经不在了］`;

function partChars(part) {
  const image = part.image_url;
  const url = typeof image === "string" ? image : image && image.url;
  return typeof url === "string" ? url.length : 0;
}

/**
 * 一次请求里的图片不超过张数和字符数预算：从最新的往前留，放不下的（更早的）换成一句文字说明。
 * 没有超的时候原样返回同一个数组（不复制，服务端的前缀缓存不受影响）；超了只复制改到的消息。
 * 只动 user 消息里的图片块；工具结果、system、assistant 不动。
 */
export function limitImageParts(messages, { maxImages = MAX_REQUEST_IMAGES, maxChars = MAX_REQUEST_IMAGE_CHARS } = {}) {
  if (!Array.isArray(messages)) return messages;
  let total = 0;
  let images = 0;
  for (const m of messages) {
    if (m && m.role === "user" && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (isImagePart(part)) {
          images++;
          total += partChars(part);
        }
      }
    }
  }
  if (images <= maxImages && total <= maxChars) return messages;
  let keptImages = 0;
  let keptChars = 0;
  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (!m || m.role !== "user" || !Array.isArray(m.content) || !m.content.some(isImagePart)) continue;
    // 同一条消息里的图从后往前算：一条消息放不下全部时，留下靠后的几张。
    const keep = new Set();
    for (let j = m.content.length - 1; j >= 0; j--) {
      const part = m.content[j];
      if (!isImagePart(part)) continue;
      const size = partChars(part);
      if (keptImages < maxImages && keptChars + size <= maxChars) {
        keep.add(j);
        keptImages++;
        keptChars += size;
      }
    }
    const dropped = m.content.filter((part, j) => isImagePart(part) && !keep.has(j)).length;
    if (!dropped) continue;
    const content = [];
    let noted = false;
    m.content.forEach((part, j) => {
      if (!isImagePart(part) || keep.has(j)) {
        content.push(part);
      } else if (!noted) {
        noted = true;
        content.push({ type: "text", text: IMAGE_NOTE_OLD(dropped) });
      }
    });
    out[i] = { ...m, content };
  }
  return out;
}

/** 看文件头认图片格式（不信扩展名和声明的类型）；认不出返回 ""。 */
export function sniffImageMime(bytes) {
  const b = bytes;
  if (!b || b.length < 12) return "";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return "image/png";
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return "image/webp";
  }
  return "";
}

/** Uint8Array → 标准 base64（不是 base64url）。 */
export function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

/** 标准 base64 → Uint8Array；不是合法 base64 抛错。 */
export function base64ToBytes(text) {
  const s = String(text || "");
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64 后的字符数。 */
export function base64Length(size) {
  return Math.ceil(size / 3) * 4;
}

/** data URL 的 MIME；不是 base64 data URL 返回 ""。 */
export function dataUrlMime(url) {
  const m = typeof url === "string" ? DATA_URL.exec(url) : null;
  return m ? m[1].toLowerCase() : "";
}

function positiveInt(value, max) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= max ? n : 0;
}

/** 校验并规整一条消息上的图片引用 { id, mime, width, height, size }；不合格的丢掉。 */
export function cleanImageRefs(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const ref of list) {
    if (!ref || typeof ref !== "object") continue;
    const id = String(ref.id || "");
    const mime = String(ref.mime || "");
    if (!/^[0-9a-f]{64}$/.test(id) || !IMAGE_MIME_TYPES.includes(mime)) continue;
    out.push({
      id,
      mime,
      width: positiveInt(ref.width, 100000),
      height: positiveInt(ref.height, 100000),
      size: positiveInt(ref.size, MAX_IMAGE_BYTES),
    });
    if (out.length >= MAX_IMAGES_PER_MESSAGE) break;
  }
  return out;
}

/** 一张图片引用的简短描述：「1600×900 PNG 312KB」。 */
export function describeImage(ref) {
  const kind = String(ref && ref.mime || "").replace("image/", "").toUpperCase() || "图片";
  const dims = ref && ref.width && ref.height ? `${ref.width}×${ref.height} ` : "";
  const size = ref && ref.size ? ` ${ref.size < 1024 * 1024 ? Math.max(1, Math.round(ref.size / 1024)) + "KB" : (ref.size / 1024 / 1024).toFixed(1) + "MB"}` : "";
  return dims + kind + size;
}
