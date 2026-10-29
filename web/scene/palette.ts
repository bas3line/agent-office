/*
 * The office palette. Every pixel the scene draws comes from here (skin and
 * hair ramps included) so the room reads as one hand-painted piece. Brand
 * colours match BRAND in src/shared/events.ts; each agent gets a BrandArt
 * (outfit, rug weave, desk, chair, keyboard), and each remote host kind a
 * server-room variant lit in its HOST_BRAND colour.
 */
import type { AgentKind, HostKind } from "../../src/shared/events.ts";
import { HOST_BRAND } from "../../src/shared/events.ts";

export const C = {
  // inks
  ink: "#0e0d16",
  ink2: "#1a1926",
  ink3: "#272536",
  // slate: metal, furniture, cool shadows
  slate1: "#38364d",
  slate2: "#4f4d68",
  slate3: "#706e8a",
  slate4: "#9b99b2",
  slate5: "#c9c7d8",
  white: "#f5f1e8",
  // wood
  wood1: "#3a241e",
  wood2: "#5a3829",
  wood3: "#7b5036",
  wood4: "#9d6c46",
  wood5: "#c08f5d",
  wood6: "#dcb67f",
  // plaster walls
  wall1: "#4c3f4a",
  wall2: "#6f5d63",
  wall3: "#97817b",
  wall4: "#bfa792",
  wall5: "#dcc8ae",
  // terracotta, Claude #D97757
  terra1: "#5a281f",
  terra2: "#963f2c",
  terra3: "#d97757",
  terra4: "#eba283",
  terra5: "#f7d3bf",
  // green, Codex #10A37F, and plants
  green1: "#0b3127",
  green2: "#125c45",
  green3: "#10a37f",
  green4: "#52d6a0",
  green5: "#b6f2d0",
  leaf1: "#1f3b2a",
  leaf2: "#356338",
  leaf3: "#5e9443",
  leaf4: "#9cc95a",
  // blues: sky, screens, glass
  blue1: "#0f1734",
  blue2: "#1b2c5a",
  blue3: "#2b4f8e",
  blue4: "#4888cf",
  blue5: "#93ccf2",
  // warm light
  gold1: "#9c5f27",
  gold2: "#e39f3c",
  gold3: "#ffd36c",
  gold4: "#fff2c4",
  // alarm
  red1: "#68192a",
  red2: "#c22d3c",
  red3: "#f2625a",
  // accents
  plum1: "#33213f",
  plum2: "#653c80",
  plum3: "#a56cc6",
  pink: "#f293b5",
  // Command Code monochrome
  cc0: "#0a0a0a",
  cc1: "#1c1c1f",
  cc2: "#2e2e33",
  cc6: "#a9a9b0",
  cc8: "#dedee2",
  cc9: "#f2f2f2",
  // honey oak parquet: cleaner and more saturated than the furniture wood
  oak1: "#43281a",
  oak2: "#6b3f24",
  oak3: "#94592f",
  oak4: "#b8763d",
  oak5: "#d4975a",
  oak6: "#ecc188",
  // opencode #FAB283 on warm charcoal
  op0: "#15110f",
  op1: "#241d1a",
  op2: "#3a2f2a",
  op3: "#fab283",
  op4: "#ffd5b3",
  // Factory droid #EE6018, hi-vis orange on steel
  dr1: "#4a1a06",
  dr2: "#a63f0c",
  dr3: "#ee6018",
  dr4: "#ff9a5c",
  dr5: "#ffd2b0",
  steel1: "#23262d",
  steel2: "#363a44",
  steel3: "#555b68",
  steel4: "#8790a0",
  // Gemini #8E75FF with its blue / pink sparkle
  gm1: "#141a36",
  gm2: "#3a2f8c",
  gm3: "#8e75ff",
  gm4: "#bcadff",
  gm5: "#e8e1ff",
  gmBlue: "#4796e3",
  gmPink: "#d96570",
  // Qwen #615CED
  qw1: "#1a1860",
  qw2: "#2f2aa8",
  qw3: "#615ced",
  qw4: "#a09dfa",
  qw5: "#dedcff",
  // Cursor graphite
  cu0: "#09090b",
  cu1: "#17171b",
  cu2: "#26262c",
  cu3: "#45454e",
  cu6: "#a3a3ad",
  cu9: "#edecec",
  // cloud wing: raised server-room floor and cool light
  sv0: "#070b16",
  sv1: "#0d1424",
  sv2: "#152036",
  sv3: "#20304e",
  sv4: "#35507a",
  cyan3: "#3fd9ff",
  cyan4: "#9cefff",
} as const;

export type ColorName = keyof typeof C;

/** Skin ramps: base, shadow, blush. */
export const SKINS: readonly [string, string, string][] = [
  ["#fde1cd", "#eab79c", "#f4a99a"],
  ["#f0c29f", "#d29470", "#e99a86"],
  ["#d49b6c", "#ad7249", "#c97a5e"],
  ["#a8704a", "#7f4f33", "#a85c48"],
  ["#704630", "#4f2f20", "#7d4535"],
];

/** Hair ramps: base, highlight, shadow. */
export const HAIRS: readonly [string, string, string][] = [
  ["#2a2232", "#4a405a", "#16121c"], // black
  ["#4a2f25", "#6e4836", "#2e1c17"], // dark brown
  ["#7a4a2c", "#a26a42", "#52301d"], // brown
  ["#a8502c", "#d07446", "#6e321c"], // auburn
  ["#dfb05a", "#f5d68c", "#a87b34"], // blonde
  ["#e6dccb", "#fbf6ec", "#b5a994"], // platinum
  ["#8f8da3", "#b9b7cb", "#64627a"], // grey
  ["#ee8fb4", "#f9bcd3", "#b8628a"], // pink
  ["#4a86cc", "#7fb2ea", "#2c5592"], // blue
  ["#8a5cc6", "#b289e4", "#5e3a90"], // violet
  ["#3fc796", "#86e8c0", "#1f8a64"], // mint
];

const rgbCache = new Map<string, [number, number, number]>();
export function rgb(hex: string): [number, number, number] {
  let v = rgbCache.get(hex);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    rgbCache.set(hex, v);
  }
  return v;
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const h = (x: number) => Math.round(x).toString(16).padStart(2, "0");
  return "#" + h(r1 + (r2 - r1) * t) + h(g1 + (g2 - g1) * t) + h(b1 + (b2 - b1) * t);
}


/** Rug weaves, one per brand so pods read apart at a glance. */
export type RugPattern = "diamond" | "checker" | "hex" | "blocks" | "chevron" | "sparkle" | "tri" | "cube" | "grid";

/** Per-brand colour sets used by rugs, outfits, desks, signs and labels. */
export interface BrandArt {
  main: string;
  dark: string;
  deep: string;
  light: string;
  pale: string;
  /** Pixel colour of the logo on outfits and signs. */
  mark: string;
  /** Readable brand colour on near-black: labels, glows, the selection ring. */
  ink: string;
  /** Rug fill / border / pattern. */
  rug: [string, string, string];
  pattern: RugPattern;
  /** Desk top / edge / front, legs, and an optional accent line on the front. */
  desk: [string, string, string];
  leg: string;
  trim: string | null;
  /** Chair shell / accent stripe, intern stool seat. */
  chair: [string, string];
  stool: string;
  /** Keyboard base / keys / the key lit while typing. */
  kbd: [string, string, string];
  /** Monitor power LED and bezel. */
  led: string;
  bezel: string;
  /** Laptop lid / deck / deck shadow. */
  laptop: [string, string, string];
  /** Sign plate behind the pod's name. */
  plate: string;
}

const slateDesk = {
  desk: [C.slate5, C.slate4, C.slate3] as [string, string, string], leg: C.slate2,
  kbd: [C.slate3, C.slate4, C.white] as [string, string, string],
  laptop: [C.slate2, C.slate4, C.slate3] as [string, string, string],
  bezel: C.ink2, plate: C.ink2,
};

export const BRAND_ART: Record<AgentKind, BrandArt> = {
  claude: {
    main: C.terra3, dark: C.terra2, deep: C.terra1, light: C.terra4, pale: C.terra5, mark: C.terra5, ink: C.terra3,
    rug: [C.terra2, C.terra4, C.terra1], pattern: "diamond",
    desk: [C.wood6, C.wood5, C.wood4], leg: C.wood2, trim: null,
    chair: [C.ink3, C.terra3], stool: C.terra2,
    kbd: [C.slate3, C.slate4, C.terra4], led: C.terra3, bezel: C.ink2,
    laptop: [C.slate2, C.slate4, C.slate3], plate: C.ink2,
  },
  commandcode: {
    main: C.cc1, dark: C.cc0, deep: C.cc0, light: C.cc2, pale: C.cc9, mark: C.cc9, ink: C.cc9,
    // a soft grey, not paper white: the brightest thing on screen shouldn't be a rug
    rug: ["#d0d0d4", C.cc0, "#9a9aa2"], pattern: "checker",
    desk: [C.cc2, C.cc1, C.cc0], leg: C.cc1, trim: C.cc9,
    chair: [C.cc9, C.cc0], stool: C.cc0,
    kbd: [C.cc9, C.cc6, C.cc0], led: C.cc9, bezel: C.cc0,
    laptop: [C.cc0, C.cc9, C.cc6], plate: C.cc0,
  },
  codex: {
    main: C.green3, dark: C.green2, deep: C.green1, light: C.green4, pale: C.green5, mark: C.green5, ink: C.green3,
    rug: [C.green2, C.green4, C.green1], pattern: "hex",
    ...slateDesk, trim: C.green3,
    chair: [C.slate1, C.green3], stool: C.green2,
    kbd: [C.slate3, C.slate4, C.green4], led: C.green4,
  },
  opencode: {
    // charcoal hoodie, peach drawstrings and mark
    main: C.op2, dark: C.op1, deep: C.op0, light: mix(C.op2, C.op3, 0.25), pale: C.op4, mark: C.op3, ink: C.op3,
    rug: [mix(C.op1, C.op3, 0.14), C.op3, mix(C.op1, C.op3, 0.45)], pattern: "blocks",
    desk: [C.cu2, C.cu1, C.cu0], leg: C.cu1, trim: C.op3,
    chair: [C.op1, C.op3], stool: C.op2,
    kbd: [C.cu2, C.cu3, C.op3], led: C.op3, bezel: C.cu0,
    laptop: [C.cu1, C.cu3, C.cu2], plate: C.op0,
  },
  droid: {
    // a hi-vis vest on the factory floor
    main: C.dr3, dark: C.dr2, deep: C.dr1, light: C.dr4, pale: C.dr5, mark: C.white, ink: C.dr3,
    rug: [C.steel2, C.dr3, C.steel3], pattern: "chevron",
    desk: [C.steel4, C.steel3, C.steel2], leg: C.steel1, trim: C.dr3,
    chair: [C.steel1, C.dr3], stool: C.dr2,
    kbd: [C.steel3, C.steel4, C.dr4], led: C.dr3, bezel: C.steel1,
    laptop: [C.steel2, C.steel4, C.steel3], plate: C.steel1,
  },
  gemini: {
    main: C.gm3, dark: C.gm2, deep: C.gm1, light: C.gm4, pale: C.gm5, mark: C.white, ink: C.gm4,
    rug: [C.gm1, C.gm3, C.gm4], pattern: "sparkle",
    ...slateDesk, trim: C.gmBlue,
    chair: [C.gm1, C.gm3], stool: C.gm2,
    kbd: [C.slate3, C.slate4, C.gm4], led: C.gm4,
  },
  qwen: {
    main: C.qw3, dark: C.qw2, deep: C.qw1, light: C.qw4, pale: C.qw5, mark: C.white, ink: C.qw4,
    rug: [C.qw2, C.qw4, mix(C.qw2, C.qw4, 0.45)], pattern: "tri",
    desk: [C.white, C.slate5, C.slate4], leg: C.slate3, trim: C.qw3,
    chair: [C.qw1, C.qw4], stool: C.qw2,
    kbd: [C.slate4, C.slate5, C.qw4], led: C.qw4, bezel: C.ink2,
    laptop: [C.slate2, C.slate4, C.slate3], plate: C.qw1,
  },
  cursor: {
    // black turtleneck, graphite everything
    main: C.cu1, dark: C.cu0, deep: C.cu0, light: C.cu2, pale: C.cu9, mark: C.cu9, ink: C.cu9,
    rug: [mix(C.cu2, C.cu6, 0.16), C.cu6, mix(C.cu3, C.cu6, 0.2)], pattern: "cube",
    desk: [C.cu2, C.cu1, C.cu0], leg: C.cu0, trim: C.cu6,
    chair: [C.cu0, C.cu6], stool: C.cu1,
    kbd: [C.cu3, C.cu6, C.cu9], led: C.cu9, bezel: C.cu0,
    laptop: [C.cu0, C.cu6, C.cu3], plate: C.cu0,
  },
  hermes: {
    // gold on deep plum, a caduceus mark
    main: C.gold3, dark: C.gold2, deep: C.gold1, light: C.gold4, pale: C.gold4, mark: C.ink, ink: C.gold3,
    rug: [C.plum1, C.gold3, mix(C.plum1, C.gold2, 0.5)], pattern: "sparkle",
    ...slateDesk, trim: C.gold3,
    chair: [C.ink3, C.gold3], stool: C.gold2,
    kbd: [C.slate3, C.slate4, C.gold3], led: C.gold3,
  },
};

/** Remote hosts: server-room desks in the cloud wing, lit in the host colour. */
export type RemoteKind = Exclude<HostKind, "local">;

export function hostArt(kind: RemoteKind): BrandArt {
  const col = HOST_BRAND[kind].color;
  return {
    main: col, dark: mix(col, C.ink, 0.45), deep: mix(col, C.ink, 0.75), light: mix(col, C.white, 0.35), pale: mix(col, C.white, 0.7),
    mark: col, ink: mix(col, C.white, 0.15),
    rug: [C.sv2, col, C.sv3], pattern: "grid",
    desk: [C.sv3, C.sv2, C.sv1], leg: C.sv0, trim: col,
    chair: [C.sv1, col], stool: C.sv2,
    kbd: [C.sv3, C.sv4, col], led: col, bezel: C.sv0,
    laptop: [C.sv1, C.sv4, C.sv3], plate: C.sv0,
  };
}

/** A desk / rug style: an agent's, or a remote host's server pod. */
export type ArtKey = AgentKind | `host-${RemoteKind}`;

const hostCache = new Map<string, BrandArt>();
export function art(key: ArtKey): BrandArt {
  if (!key.startsWith("host-")) return BRAND_ART[key as AgentKind] ?? BRAND_ART.claude;
  let a = hostCache.get(key);
  if (!a) hostCache.set(key, (a = hostArt(key.slice(5) as RemoteKind)));
  return a;
}
