const cache = new Map<string, HTMLImageElement>();

export function loadImage(url: string): Promise<HTMLImageElement> {
  const hit = cache.get(url);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      cache.set(url, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

/**
 * The drawn pixels of an image, with the empty ground around them cut away.
 *
 * Move art and accessories are drawn on the same canvas a Scoba is, so where a
 * piece sits in its own file says nothing about how big it is or where it
 * goes. Cropping to what was actually drawn is what lets everything else treat
 * a piece as its own size.
 */
export function cropToContent(img: HTMLImageElement): HTMLCanvasElement | HTMLImageElement {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (w === 0 || h === 0) return img;
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  const sctx = src.getContext("2d")!;
  sctx.drawImage(img, 0, 0);
  const px = sctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3]! < 8) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return img;
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
