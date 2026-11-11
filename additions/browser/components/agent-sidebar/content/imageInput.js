/* imageInput.js — 输入框粘贴/拖入图片：从剪贴板和拖放数据里取图片文件，缩到长边 2000px、压到 3.5MB 以内。
 * 打进侧栏 bundle，在侧栏文档里跑（要用 createImageBitmap 和 canvas）。 */
import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, sniffImageMime } from "../modules/ChatImages.sys.mjs";

// 没超尺寸、没超大小时原样保留的格式（不重新编码，文字截图不会糊）。GIF 可能是动图，各家 API 不收动图，一律转成 PNG。
const KEEP_AS_IS = new Set(["image/png", "image/jpeg", "image/webp"]);
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif|tiff?)$/i;

function isImageFile(file, item) {
  return /^image\//i.test((file && file.type) || "") || /^image\//i.test((item && item.type) || "");
}

/** 剪贴板或拖放数据里的图片文件。firefox 粘贴截图时给的是一个 image/png 文件，复制的文件给的是文件本身。 */
export function imageFilesOf(dataTransfer) {
  if (!dataTransfer) {
    return [];
  }
  const files = [];
  for (const item of Array.from(dataTransfer.items || [])) {
    if (!item || item.kind !== "file") {
      continue;
    }
    const file = typeof item.getAsFile === "function" ? item.getAsFile() : null;
    if (file && isImageFile(file, item)) {
      files.push(file);
    }
  }
  if (!files.length) {
    for (const file of Array.from(dataTransfer.files || [])) {
      if (file && isImageFile(file)) {
        files.push(file);
      }
    }
  }
  return files;
}

/** 拖进来的东西里有没有文件（拖文字、拖链接不算）。 */
export function dragHasFiles(dataTransfer) {
  return !!dataTransfer && Array.from(dataTransfer.types || []).includes("Files");
}

/**
 * 剪贴板里图片和文字都有时，贴文字还是贴图：
 * - Excel、Word、WPS 复制的内容同时带一张渲染出来的图，这时贴文字（和以前一样）；
 * - 浏览器「复制图片」会把图片地址也当文字放进去，截图工具可能带上文件名：只有一个链接/文件名时贴图片。
 */
export function textWinsOverImage(text) {
  const s = String(text || "").trim();
  if (!s) {
    return false;
  }
  if (!/\s/.test(s) && /^[a-z][a-z0-9+.-]*:\S+$/i.test(s)) {
    return false; // 一个链接（http:、data:、file: 等）
  }
  if (!/[\r\n]/.test(s) && s.length < 260 && IMAGE_NAME.test(s)) {
    return false; // 一个图片文件名或路径
  }
  return true;
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("图片编码失败"))), type, quality);
  });
}

async function encode(doc, bitmap, width, height, type, quality) {
  const canvas = doc.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (type === "image/jpeg") {
    ctx.fillStyle = "#fff"; // JPEG 没有透明，透明处垫白，不然是黑的
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  return toBlob(canvas, type, quality);
}

/**
 * 把一张图片文件处理成可以存、可以发给模型的样子：{ bytes, mime, width, height, sourceWidth, sourceHeight, name }。
 * - 长边超过 2000px 的按比例缩小（Retina 屏的截图常有 3000px 宽）；
 * - PNG/JPEG/WebP 没超尺寸、没超 3.5MB 的原样保留；
 * - 其余（GIF、BMP、AVIF、太大的）重新编码：先 PNG，还超就 JPEG（透明处垫白），再不行继续缩小。
 */
export async function prepareImage(file, { doc = document, maxEdge = MAX_IMAGE_EDGE, maxBytes = MAX_IMAGE_BYTES } = {}) {
  const type = String((file && file.type) || "").toLowerCase();
  const name = String((file && file.name) || "");
  if (type === "image/svg+xml") {
    throw new Error("不支持 SVG 图片，截图后再贴");
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("读不出这张图片（格式不支持或文件损坏）");
  }
  try {
    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;
    if (!sourceWidth || !sourceHeight) {
      throw new Error("图片是空的");
    }
    const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
    let width = Math.max(1, Math.round(sourceWidth * scale));
    let height = Math.max(1, Math.round(sourceHeight * scale));
    const result = async (blob, mime) => ({
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mime,
      width,
      height,
      sourceWidth,
      sourceHeight,
      name,
    });
    if (scale === 1 && KEEP_AS_IS.has(type) && file.size <= maxBytes) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (sniffImageMime(bytes) === type) {
        return { bytes, mime: type, width, height, sourceWidth, sourceHeight, name };
      }
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const png = await encode(doc, bitmap, width, height, "image/png");
      if (png.size <= maxBytes) {
        return result(png, "image/png");
      }
      for (const quality of [0.92, 0.85, 0.75]) {
        const jpeg = await encode(doc, bitmap, width, height, "image/jpeg", quality);
        if (jpeg.size <= maxBytes) {
          return result(jpeg, "image/jpeg");
        }
      }
      width = Math.max(1, Math.round(width * 0.75));
      height = Math.max(1, Math.round(height * 0.75));
    }
    throw new Error(`图片太大，压缩后仍超过 ${maxBytes / 1024 / 1024}MB`);
  } finally {
    if (bitmap && typeof bitmap.close === "function") {
      bitmap.close();
    }
  }
}
