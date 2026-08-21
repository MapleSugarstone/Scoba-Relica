// Turning source art into a spritesheet at load time, so a tileset can be
// authored as "this tile, turned" instead of as more PNG files. One 64 px edge
// tile plus three rotations covers all four sides of an island, and editing the
// one source file updates every orientation on the next reload.

/** Clockwise rotation applied when a piece is packed. */
export type Turn = 0 | 90 | 180 | 270;

export interface Piece {
  key: string;
  img: CanvasImageSource;
  /** Source rect, defaulting to the whole image. Art drawn on a 65 px canvas
   * crops to 64 here rather than every caller remembering the odd row. */
  sx?: number;
  sy?: number;
  size?: number;
  /** The source is mirrored first, then turned. */
  flipX?: boolean;
  turn?: Turn;
}

export interface Sheet {
  canvas: HTMLCanvasElement;
  cell: number;
  /** Packed keys in pack order, so a palette can list what is in here. */
  keys: string[];
  /** Source rect of a packed piece, ready to hand to drawImage. */
  at(key: string): { x: number; y: number } | null;
}

export function packSheet(pieces: Piece[], cell: number): Sheet {
  const cols = Math.ceil(Math.sqrt(pieces.length));
  const rows = Math.ceil(pieces.length / cols);
  const canvas = document.createElement("canvas");
  canvas.width = cols * cell;
  canvas.height = rows * cell;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  const spots = new Map<string, { x: number; y: number }>();
  pieces.forEach((p, i) => {
    const x = (i % cols) * cell;
    const y = Math.floor(i / cols) * cell;
    const size = p.size ?? cell;
    ctx.save();
    ctx.translate(x + cell / 2, y + cell / 2);
    if (p.turn) ctx.rotate((p.turn * Math.PI) / 180);
    if (p.flipX) ctx.scale(-1, 1);
    ctx.drawImage(p.img, p.sx ?? 0, p.sy ?? 0, size, size, -cell / 2, -cell / 2, cell, cell);
    ctx.restore();
    spots.set(p.key, { x, y });
  });

  return {
    canvas,
    cell,
    keys: pieces.map((p) => p.key),
    at: (key) => spots.get(key) ?? null,
  };
}
