/*
 * The real brand marks from assets/logos (agents and remote hosts; plain ssh
 * gets a generic terminal glyph, it is not a company), turned into Path2D so they draw
 * synchronously and never taint the canvas (no <img>, nothing external).
 * pixelLogo() rasterizes a mark at a tiny size and thresholds the alpha so it
 * sits on the pixel grid next to hand-placed pixels, except for the marks
 * that don't survive that at 5-9 px (Claude's spark, the command key, Codex's
 * prompt badge, Cursor's cube, Railway's striped disc, boat's pinwheel),
 * which are drawn by hand at those sizes; smoothLogo() keeps the
 * antialiasing for the screen-resolution label pass.
 */
import claudeSvg from "../../assets/logos/claude.svg";
import commandcodeSvg from "../../assets/logos/commandcode.svg";
import codexSvg from "../../assets/logos/codex.svg";
import opencodeSvg from "../../assets/logos/opencode.svg";
import droidSvg from "../../assets/logos/droid.svg";
import geminiSvg from "../../assets/logos/gemini.svg";
import qwenSvg from "../../assets/logos/qwen.svg";
import cursorSvg from "../../assets/logos/cursor.svg";
import hermesSvg from "../../assets/logos/hermes.svg";
import daytonaSvg from "../../assets/logos/daytona.svg";
import boatSvg from "../../assets/logos/boat.svg";
import railwaySvg from "../../assets/logos/railway.svg";
import vercelSvg from "../../assets/logos/vercel.svg";
import type { AgentKind, HostKind } from "../../src/shared/events.ts";
import { bitmap, type Bitmap } from "./util.ts";

interface Mark {
  vb: [number, number, number, number];
  /** Extra transform from a wrapping <g>, as a DOMMatrix. */
  m: DOMMatrix;
  paths: Path2D[];
  stroke: number; // 0 = fill
  evenodd: boolean;
}

function parseTransform(t: string | null): DOMMatrix {
  const m = new DOMMatrix();
  if (!t) return m;
  const re = /(translate|scale|matrix)\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  let out = m;
  while ((r = re.exec(t))) {
    const n = r[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (r[1] === "translate") out = out.translate(n[0] ?? 0, n[1] ?? 0);
    else if (r[1] === "scale") out = out.scale(n[0] ?? 1, n[1] ?? n[0] ?? 1);
    else if (n.length === 6) out = out.multiply(new DOMMatrix(n));
  }
  return out;
}

function parse(svg: string): Mark {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  const vb = (root.getAttribute("viewBox") ?? "0 0 24 24").split(/[\s,]+/).map(Number) as Mark["vb"];
  const g = root.querySelector("g");
  const m = parseTransform(g?.getAttribute("transform") ?? null);
  const paths = [...root.querySelectorAll("path")].map((p) => new Path2D(p.getAttribute("d") ?? ""));
  const strokeAttr = root.getAttribute("stroke");
  const stroke = strokeAttr && strokeAttr !== "none" ? Number(root.getAttribute("stroke-width") ?? 2) : 0;
  return { vb, m, paths, stroke, evenodd: root.getAttribute("fill-rule") === "evenodd" };
}

/** Anything with a mark: an agent or a remote host kind. */
export type LogoKind = AgentKind | Exclude<HostKind, "local">;

const SSH_GLYPH = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill-rule="evenodd"><path d="M3 3h18a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm1 4v12h16V7zm2 2.5 1.4-1.4 4.4 4.4-4.4 4.4L6 15.5l3-3zM12 15h6v2h-6z"/></svg>`;

const SVGS: Record<LogoKind, string> = {
  claude: claudeSvg, commandcode: commandcodeSvg, codex: codexSvg, opencode: opencodeSvg, droid: droidSvg,
  gemini: geminiSvg, qwen: qwenSvg, cursor: cursorSvg, hermes: hermesSvg,
  ssh: SSH_GLYPH, daytona: daytonaSvg, boat: boatSvg, railway: railwaySvg, vercel: vercelSvg,
};
const marks = new Map<LogoKind, Mark>();
function mark(kind: LogoKind): Mark {
  let mk = marks.get(kind);
  if (!mk) marks.set(kind, (mk = parse(SVGS[kind] ?? SVGS.claude)));
  return mk;
}

/** Draw a mark into a size x size box at (x, y). */
export function drawMark(g: CanvasRenderingContext2D, kind: LogoKind, x: number, y: number, size: number, color: string, strokeBoost = 1) {
  const mk = mark(kind);
  const [vx, vy, vw, vh] = mk.vb;
  const s = size / Math.max(vw, vh);
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.translate(-vx, -vy);
  const t = mk.m;
  g.transform(t.a, t.b, t.c, t.d, t.e, t.f);
  if (mk.stroke) {
    g.strokeStyle = color;
    g.lineWidth = mk.stroke * strokeBoost;
    g.lineCap = "round";
    g.lineJoin = "round";
    for (const p of mk.paths) g.stroke(p);
  } else {
    g.fillStyle = color;
    for (const p of mk.paths) g.fill(p, mk.evenodd ? "evenodd" : "nonzero");
  }
  g.restore();
}

/** Hand-pixelled marks for the sizes the room uses (pod signs 9, TV and tags 7, counts 5). */
const HAND: Partial<Record<LogoKind, Record<number, string[]>>> = {
  claude: {
    9: ["....#....", ".#..#..#.", "..#.#.#..", "...###...", "####.####", "...###...", "..#.#.#..", ".#..#..#.", "....#...."],
    7: ["...#...", ".#.#.#.", "..###..", "###.###", "..###..", ".#.#.#.", "...#..."],
    5: ["..#..", "#.#.#", ".###.", "#.#.#", "..#.."],
  },
  commandcode: {
    9: ["###...###", "#.#...#.#", "#########", "..#...#..", "..#...#..", "..#...#..", "#########", "#.#...#.#", "###...###"],
    7: ["##...##", "#######", ".#...#.", ".#...#.", ".#...#.", "#######", "##...##"],
    5: ["##.##", "#####", ".#.#.", "#####", "##.##"],
  },
  codex: {
    9: ["..#####..", ".#######.", "##.######", "###.#####", "####.####", "###.#####", "##.##..##", ".#######.", "..#####.."],
    7: [".#####.", "#######", "#.#####", "##.####", "#.##..#", "#######", ".#####."],
    5: [".###.", "#.###", "##.##", "#.#.#", ".###."],
  },
  cursor: {
    9: ["....#....", "..#####..", "#########", "#.#####.#", "#...#...#", "#...#...#", "#...#...#", ".##.#.##.", "....#...."],
    7: ["...#...", ".#####.", "#######", "#..#..#", "#..#..#", ".#.#.#.", "...#..."],
    5: ["..#..", "#####", "#.#.#", ".#.#.", "..#.."],
  },
  railway: {
    9: ["..#####..", ".#######.", "....#####", "#########", ".....####", "#########", "....#####", ".#######.", "..#####.."],
    7: [".#####.", "...####", "#######", "....###", "#######", "...####", ".#####."],
    5: [".###.", "..###", "#####", "..###", ".###."],
  },
  boat: {
    9: ["......#..", ".....##..", ".....#...", "#...###..", ".#######.", "..###...#", "...#.##..", "..##.##..", "..#......"],
    7: [".....#.", "....##.", "#..###.", ".#####.", "..##..#", ".##.#..", ".#....."],
    5: ["....#", "#.##.", ".###.", ".##.#", "#...."],
  },
  droid: {
    5: ["#.#.#", ".###.", "##.##", ".###.", "#.#.#"],
  },
};

/** The hand-drawn mark for `size`, or for a size up to 3 px bigger (centred), if there is one. */
function handRows(kind: LogoKind, size: number): { rows: string[]; off: number } | undefined {
  const h = HAND[kind];
  if (!h) return undefined;
  if (h[size]) return { rows: h[size]!, off: 0 };
  for (const s of [9, 7, 5]) if (h[s] && size > s && size - s <= 3) return { rows: h[s]!, off: Math.floor((size - s) / 2) };
  return undefined;
}

const pixCache = new Map<string, Bitmap>();
/**
 * The mark snapped to the pixel grid: rendered at 4x, box-filtered down and
 * alpha-thresholded, so thin rays survive and edges stay hard.
 */
export function pixelLogo(kind: LogoKind, size: number, color: string, threshold = 0.42): Bitmap {
  const key = `${kind}|${size}|${color}|${threshold}`;
  let b = pixCache.get(key);
  if (b) return b;
  const hand = handRows(kind, size);
  if (hand) {
    b = bitmap(size, size);
    b.g.fillStyle = color;
    hand.rows.forEach((row, y) => [...row].forEach((ch, x) => ch === "#" && b!.g.fillRect(x + hand.off, y + hand.off, 1, 1)));
    pixCache.set(key, b);
    return b;
  }
  const k = 4;
  const big = bitmap(size * k, size * k);
  big.g.imageSmoothingEnabled = true;
  drawMark(big.g, kind, 0, 0, size * k, "#fff", size <= 9 ? 1.35 : 1);
  const src = big.g.getImageData(0, 0, size * k, size * k).data;
  b = bitmap(size, size);
  const out = b.g.createImageData(size, size);
  const hex = parseInt(color.slice(1), 16);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0;
      for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) a += src[((y * k + dy) * size * k + x * k + dx) * 4 + 3];
      a /= k * k * 255;
      if (a >= threshold) {
        const i = (y * size + x) * 4;
        out.data[i] = (hex >> 16) & 255;
        out.data[i + 1] = (hex >> 8) & 255;
        out.data[i + 2] = hex & 255;
        out.data[i + 3] = 255;
      }
    }
  }
  b.g.putImageData(out, 0, 0);
  pixCache.set(key, b);
  return b;
}

const smoothCache = new Map<string, Bitmap>();
/** Antialiased mark at device-pixel size, for screen-space labels. */
export function smoothLogo(kind: LogoKind, size: number, color: string): Bitmap {
  const key = `${kind}|${size}|${color}`;
  let b = smoothCache.get(key);
  if (!b) {
    b = bitmap(size, size);
    b.g.imageSmoothingEnabled = true;
    drawMark(b.g, kind, 0, 0, size, color);
    smoothCache.set(key, b);
  }
  return b;
}
