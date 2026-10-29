/*
 * Workers, drawn from code. A sprite is composed from hand-placed part grids
 * (legs, torso, arms, head, hair, accessories) written as 16-wide strings of
 * colour symbols, then auto-outlined with a darkened copy of the neighbouring
 * colour. A worker's look (skin, hair, outfit, accessory) comes from a hash of
 * its workerId, so the same session looks the same on every reload. Every
 * (look, pose, frame) is composed once and cached as a canvas.
 */
import type { AgentKind } from "../../src/shared/events.ts";
import { BRAND_ART, C, HAIRS, SKINS, mix } from "./palette.ts";
import { bitmap, hash, pick, rng, type Bitmap } from "./util.ts";

export type Dir = "down" | "up" | "left" | "right";
export type Pose =
  | "stand" | "walk" | "sit" | "type" | "lean" | "sleep" | "think"
  | "raise" | "cheer" | "grab" | "flip" | "point" | "carry";

export interface Look {
  agent: AgentKind;
  intern: boolean;
  skin: number;
  hair: number;
  style: HairStyle;
  acc: Accessory;
  pants: string;
  shoes: string;
  key: string;
}

type HairStyle = "short" | "bob" | "long" | "spiky" | "bun" | "buzz" | "curly" | "pony" | "mohawk";
type Accessory = "none" | "glasses" | "headphones" | "cap" | "beanie" | "shades";

const STYLES: HairStyle[] = ["short", "bob", "long", "spiky", "bun", "buzz", "curly", "pony", "short", "bob", "mohawk"];
const ACCS: Accessory[] = ["none", "none", "glasses", "headphones", "cap", "none", "glasses", "headphones", "beanie", "shades"];
const PANTS = [C.blue2, C.slate1, C.wood2, C.ink3, C.blue3, C.slate2];
const SHOES = [C.white, C.ink2, C.wood3, C.slate4, C.white, C.red2];

export function lookFor(workerId: string, agent: AgentKind, intern: boolean): Look {
  const r = rng(hash(workerId));
  const skin = Math.floor(r() * SKINS.length);
  const hair = Math.floor(r() * HAIRS.length);
  const style = pick(STYLES, Math.floor(r() * 1000));
  const acc = pick(ACCS, Math.floor(r() * 1000));
  const pants = pick(PANTS, Math.floor(r() * 1000));
  const shoes = pick(SHOES, Math.floor(r() * 1000));
  const key = `${agent}${intern ? "i" : ""}-${skin}-${hair}-${style}-${acc}-${pants}-${shoes}`;
  return { agent, intern, skin, hair, style, acc, pants, shoes, key };
}

/* ------------------------------------------------------------------ parts */
// Symbols: s skin, S skin shadow, c blush, e eye, m mouth, h/H/j hair base,
// highlight, shadow, o/O/p outfit base/shadow/highlight, l logo, w white,
// n/N pants, b shoes, a/A accessory, g glasses, y lanyard, k ink,
// u/v outfit accents (Gemini's blue-to-pink sweater).

const HEAD: Record<"down" | "up" | "side", string[]> = {
  down: [
    "....ssssssss....",
    "...ssssssssss...",
    "...ssssssssss...",
    "...ssssssssss...",
    "...ssessssess...",
    "...ssessssess...",
    "...scsssssscs...",
    "...SsssmmsssS...",
    "....SSssssSS....",
  ],
  up: [
    "....ssssssss....",
    "...ssssssssss...",
    "...ssssssssss...",
    "...ssssssssss...",
    "...ssssssssss...",
    "...ssssssssss...",
    "...ssssssssss...",
    "...SssssssssS...",
    "....SSSSSSSS....",
  ],
  side: [
    "....ssssssss....",
    "...ssssssssss...",
    "...ssssssssss...",
    "...ssssssssss...",
    "...sssssssess...",
    "...ssssSssesss..",
    "...ssssSssscs...",
    "...Ssssssssms...",
    "....SSsssssS....",
  ],
};
const HEAD_Y = 2;

// Hair grids start at y=0 so volume can rise above the scalp.
const HAIR: Record<HairStyle, Record<"down" | "up" | "side", string[]>> = {
  short: {
    down: [
      "................",
      ".....hhhhhh.....",
      "....hHHhhhhh....",
      "...hHhhhhhhhh...",
      "...hhhhhhhhhh...",
      "...hhjhhhjhhh...",
      "...hh......hh...",
      "...h........h...",
    ],
    up: [
      "................",
      ".....hhhhhh.....",
      "....hhHHhhhh....",
      "...hhHhhhhhhh...",
      "...hhhhhhhhhh...",
      "...hhhhhhhhhh...",
      "...hhhhhhhhhh...",
      "...hhhhhhhhhh...",
      "...jhhhhhhhhj...",
      "....jjjjjjjj....",
    ],
    side: [
      "................",
      ".....hhhhhh.....",
      "....hHHhhhhhh...",
      "...hHhhhhhhhhh..",
      "...hhhhhhhhhhh..",
      "...hhhhhhhjh....",
      "...hhhhh........",
      "...hhhh.........",
      "....jj..........",
    ],
  },
  buzz: {
    down: [
      "................",
      "................",
      "....jjjjjjjj....",
      "...jhhhhhhhhj...",
      "...hhhhhhhhhh...",
      "...j........j...",
    ],
    up: [
      "................",
      "................",
      "....jjjjjjjj....",
      "...jhhhhhhhhj...",
      "...hhhhhhhhhh...",
      "...hhhhhhhhhh...",
      "...hhhhhhhhhh...",
      "...jhhhhhhhhj...",
    ],
    side: [
      "................",
      "................",
      "....jjjjjjjj....",
      "...jhhhhhhhhj...",
      "...hhhhhhhhh....",
      "...hhhhh........",
      "...jhh..........",
    ],
  },
  bob: {
    down: [
      "................",
      ".....hhhhhh.....",
      "...hhHHhhhhhh...",
      "..hhHhhhhhhhhh..",
      "..hhhhhhhhhhhh..",
      "..hhhjjhhjjhhh..",
      "..hhh......hhh..",
      "..hhh......hhh..",
      "..hhh......hhh..",
      "..jhh......hhj..",
      "...j........j...",
    ],
    up: [
      "................",
      ".....hhhhhh.....",
      "...hhhHHhhhhh...",
      "..hhhHhhhhhhhh..",
      "..hhhhhhhhhhhh..",
      "..hhhhhhhhhhhh..",
      "..hhhhhhhhhhhh..",
      "..hhhhhhhhhhhh..",
      "..hhhhhhhhhhhh..",
      "..jhhhhhhhhhhj..",
      "...jjjjjjjjjj...",
    ],
    side: [
      "................",
      ".....hhhhhh.....",
      "...hhHHhhhhhh...",
      "..hhHhhhhhhhhh..",
      "..hhhhhhhhhhhh..",
      "..hhhhhhhhjh....",
      "..hhhhhh........",
      "..hhhhhh........",
      "..hhhhhh........",
      "..jhhhhj........",
      "...jjjj.........",
    ],
  },
  long: {
    down: [
      "................",
      ".....hhhhhh.....",
      "...hhHHhhhhhh...",
      "..hhHhhhhhhhhh..",
      "..hhhhhhhhhhhh..",
      "..hhhhjhhjhhhh..",
      "..hhh......hhh..",
      "..hh........hh..",
      "..hh........hh..",
      "..hh........hh..",
      "..hh........hh..",
      "..hj........jh..",
      "..j..........j..",
    ],
    up: [
      "................",
      ".....hhhhhh.....",
      "...hhhHHhhhhh...",
      "..hhhHhhhhhhhh..",
      "..hhhhhhhhhhhh..",
      "..hhhhhhhhhhhh..",
      "..hhhhhhhhhhhh..",
      "..hhhhhhhhhhhh..",
      "..hhhhhhhhhhhh..",
      "...hhhhhhhhhh...",
      "...hhhhhhhhhh...",
      "...jhhhhhhhhj...",
      "....jjjjjjjj....",
      "................",
    ],
    side: [
      "................",
      ".....hhhhhh.....",
      "...hhHHhhhhhh...",
      "..hhHhhhhhhhhh..",
      "..hhhhhhhhhhhh..",
      "..hhhhhhhhjh....",
      "..hhhhhh........",
      "..hhhhh.........",
      "..hhhhh.........",
      "..hhhhh.........",
      "..hhhhh.........",
      "..jhhhj.........",
      "...jjj..........",
    ],
  },
  spiky: {
    down: [
      "....h..h..h.....",
      "....hh.hh.hh.h..",
      "...hhHhHhhhhh...",
      "..hhHhhhhhhhhh..",
      "...hhhhhhhhhh...",
      "...hjhhjhhjhh...",
      "...hh......hh...",
      "...h........h...",
    ],
    up: [
      "....h..h..h.....",
      "...hhh.hh.hh.h..",
      "...hhHhHhhhhh...",
      "..hhHhhhhhhhhh..",
      "...hhhhhhhhhh...",
      "...hhhhhhhhhh...",
      "...hhhhhhhhhh...",
      "...hhhhhhhhhh...",
      "...jhhhhhhhhj...",
      "....jjjjjjjj....",
    ],
    side: [
      "...h...h..h.....",
      "...hh..hh.hh....",
      "..hhhHhHhhhhh...",
      "..hhHhhhhhhhhh..",
      "...hhhhhhhhhhh..",
      "...hhhhhhhjh....",
      "...hhhhh........",
      "...hhhh.........",
      "....jj..........",
    ],
  },
  bun: {
    down: [
      "......hhhh......",
      ".....hHhhhh.....",
      "....hhjjjjhh....",
      "...hHhhhhhhhh...",
      "...hhhhhhhhhh...",
      "...hhjhhhhjhh...",
      "...hh......hh...",
      "...h........h...",
    ],
    up: [
      "......hhhh......",
      ".....hHhhhh.....",
      "....hhjjjjhh....",
      "...hhHhhhhhhh...",
      "...hhhhhhhhhh...",
      "...hhhhhhhhhh...",
      "...hhhhhhhhhh...",
      "...hhhhhhhhhh...",
      "...jhhhhhhhhj...",
      "....jjjjjjjj....",
    ],
    side: [
      "...hhhh.........",
      "..hHhhhh........",
      "..hhjhhhhhh.....",
      "...hHhhhhhhhhh..",
      "...hhhhhhhhhhh..",
      "...hhhhhhhjh....",
      "...hhhhh........",
      "...hhhh.........",
      "....jj..........",
    ],
  },
  curly: {
    down: [
      "....hh.hh.hh....",
      "...hhHhhHhhhh...",
      "..hhHhhhhhhhhh..",
      ".hhhhhhhhhhhhhh.",
      ".hhhhhhhhhhhhhh.",
      ".hhhjhhjjhhjhhh.",
      ".hhh........hhh.",
      ".hhh........hhh.",
      "..hj........jh..",
      "..j..........j..",
    ],
    up: [
      "....hh.hh.hh....",
      "...hhHhhHhhhh...",
      "..hhHhhhhhhhhh..",
      ".hhhhhhhhhhhhhh.",
      ".hhhhhhhhhhhhhh.",
      ".hhhhhhhhhhhhhh.",
      ".hhhhhhhhhhhhhh.",
      ".hhhhhhhhhhhhhh.",
      "..hhhhhhhhhhhh..",
      "..jhhhhhhhhhhj..",
      "...jj.jj.jj.j...",
    ],
    side: [
      "....hh.hh.hh....",
      "...hhHhhHhhhh...",
      "..hhHhhhhhhhhh..",
      ".hhhhhhhhhhhhhh.",
      ".hhhhhhhhhhhhh..",
      ".hhhhhhhhhjh....",
      ".hhhhhhh........",
      ".hhhhhhh........",
      "..hhhhj.........",
      "..j.jj..........",
    ],
  },
  pony: {
    down: [
      "................",
      ".....hhhhhh.....",
      "....hHHhhhhh....",
      "...hHhhhhhhhh...",
      "...hhhhhhhhhh...",
      "...hhjhhhhjhh...",
      "...hh......hh...",
      "...h........h...",
    ],
    up: [
      "................",
      ".....hhhhhh.....",
      "....hhHHhhhh....",
      "...hhHhhhhhhh...",
      "...hhhhhhhhhh...",
      "...hhhhjjhhhh...",
      "...hhhhhhhhhh...",
      "...hhhhhhhhhh...",
      "...jhhhhhhhhj...",
      "....jjjhhjjj....",
      ".......hh.......",
      ".......hh.......",
      ".......jj.......",
    ],
    side: [
      "................",
      ".....hhhhhh.....",
      "....hHHhhhhhh...",
      "..hhHhhhhhhhhh..",
      ".hhhhhhhhhhhhh..",
      ".hh.hhhhhhjh....",
      ".hh.hhhh........",
      "..h.hhh.........",
      "..j.............",
    ],
  },
  mohawk: {
    down: [
      "......hh........",
      "......hHh.......",
      ".....hhHh.......",
      "....jhhhhj......",
      "...jjhhhhjj.....",
      "...j..jj...j....",
    ],
    up: [
      "......hh........",
      "......hHh.......",
      ".....hhHh.......",
      "....jhhhhj......",
      "...jjhhhhjj.....",
      "...jjhhhhjjj....",
      "....jhhhhj......",
      ".....hhhh.......",
      "......jj........",
    ],
    side: [
      ".....hhh........",
      "....hhHhh.......",
      "...hhhHhhh......",
      "...jhhhhhhj.....",
      "...jjjjjjj......",
      "...jj...........",
    ],
  },
};

const ACC: Record<Exclude<Accessory, "none">, Record<"down" | "up" | "side", string[]>> = {
  glasses: {
    down: ["", "", "", "", "", "....ggg..ggg....", "....geggggeg....", "....ggg..ggg...."],
    up: [],
    side: ["", "", "", "", "", ".........ggg....", "......ggggeg....", ".........ggg...."],
  },
  shades: {
    down: ["", "", "", "", "", "", "...kkkkkkkkkk...", "....kk....kk...."],
    up: [],
    side: ["", "", "", "", "", "", "........kkkkk...", ".........kk....."],
  },
  headphones: {
    down: ["", "....aaaaaaaa....", "...a........a...", "..a..........a..", "..a..........a..", "", ".aA..........Aa.", ".aA..........Aa.", ".aa..........aa."],
    up: ["", "....aaaaaaaa....", "...a........a...", "..a..........a..", "..a..........a..", "", ".aA..........Aa.", ".aA..........Aa.", ".aa..........aa."],
    side: ["", "....aaaaaaaa....", "...a....a.......", "..a.....a.......", "........a.......", "......aaa.......", "......aAAa......", "......aAAa......", ".......aa......."],
  },
  cap: {
    down: ["", ".....aaaaaa.....", "....aAaaaaaa....", "...aaaaaaaaaa...", "...aaaaaaaaaa...", "..AAAAAAAAAAAA.."],
    up: ["", ".....aaaaaa.....", "....aaaaaaaa....", "...aaaaaaaaaa...", "...aaaaaaaaaa...", "...aaaAAAAaaa..."],
    side: ["", ".....aaaaaa.....", "....aAaaaaaa....", "...aaaaaaaaaa...", "...aaaaaaaaaaaaa", "...AAAAAAAAAAAA."],
  },
  beanie: {
    down: [".......a........", "......aaa.......", "....aaaaaaaa....", "...aAaaaaaaaa...", "...aaaaaaaaaa...", "...AAAAAAAAAA..."],
    up: [".......a........", "......aaa.......", "....aaaaaaaa....", "...aAaaaaaaaa...", "...aaaaaaaaaa...", "...AAAAAAAAAA..."],
    side: [".......a........", "......aaa.......", "....aaaaaaaa....", "...aAaaaaaaaa...", "...aaaaaaaaaaa..", "...AAAAAAAAAAA.."],
  },
};

// Torso rows y=11..17. Brand outfits are recoloured, logos placed by symbol.
const TORSO: Record<AgentKind, Record<"down" | "up" | "side", string[]>> = {
  claude: {
    down: [
      "....oppSSppo....",
      "....oopppooo....",
      "....ooooolol....",
      "....oooooolo....",
      "....ooooolol....",
      "....oOOOOOOo....",
      "....OOOOOOOO....",
    ],
    up: [
      "....oppppppo....",
      "....oppppppo....",
      "....oOppppOo....",
      "....ooOOOOoo....",
      "....oooooooo....",
      "....oooooooo....",
      "....OOOOOOOO....",
    ],
    side: [
      ".....pppSoo.....",
      ".....ppooooo....",
      ".....oooooool...",
      ".....oooooooo...",
      ".....oooooooo...",
      ".....oOOOOOoo...",
      ".....OOOOOOOO...",
    ],
  },
  commandcode: {
    down: [
      "....ppppppoo....",
      "....pooooooo....",
      "....oooolllo....",
      "....oooolold....",
      "....oooolllo....",
      "....oooooooo....",
      "....OOOOOOOO....",
    ],
    up: [
      "....ppppppoo....",
      "....oooooooo....",
      "....oooooooo....",
      "....oooooooo....",
      "....oooooooo....",
      "....oooooooo....",
      "....OOOOOOOO....",
    ],
    side: [
      ".....pppppo.....",
      ".....oooooooo...",
      ".....oooooool...",
      ".....oooooooo...",
      ".....oooooooo...",
      ".....oooooooo...",
      ".....OOOOOOOO...",
    ],
  },
  codex: {
    down: [
      "....opwSSwpo....",
      "....oopwwzoo....",
      "....ooowwzlo....",
      "....ooowwzoo....",
      "....ooowwzoo....",
      "....oOOwwzOo....",
      "....OOOOOOOO....",
    ],
    up: [
      "....oopppooo....",
      "....oooooooo....",
      "....oooooooo....",
      "....oooooooo....",
      "....oooooooo....",
      "....oooooooo....",
      "....OOOOOOOO....",
    ],
    side: [
      ".....oopSwo.....",
      ".....oooooww....",
      ".....oooooozl...",
      ".....oooooooo...",
      ".....oooooooo...",
      ".....oOOOOOoo...",
      ".....OOOOOOOO...",
    ],
  },
  opencode: {
    down: [
      "....OpSSSSpO....",
      "....oolOOloo....",
      "....oolooloo....",
      "....oooooooo....",
      "....oppppppo....",
      "....opOOOOpo....",
      "....OOOOOOOO....",
    ],
    up: [
      "....oppppppo....",
      "....opOOOOpo....",
      "....oopOOpoo....",
      "....oooppooo....",
      "....oooooooo....",
      "....oooooooo....",
      "....OOOOOOOO....",
    ],
    side: [
      ".....pppSoo.....",
      ".....ppoloooo...",
      ".....oooloooo...",
      ".....oooooooo...",
      ".....oopppppo...",
      ".....oOOOOOoo...",
      ".....OOOOOOOO...",
    ],
  },
  droid: {
    down: [
      "....oozSSzoo....",
      "....oozzzzoo....",
      "....llllllll....",
      "....oooooooo....",
      "....llllllll....",
      "....oOOOOOOo....",
      "....OOOOOOOO....",
    ],
    up: [
      "....oooooooo....",
      "....oooooooo....",
      "....llllllll....",
      "....oooooooo....",
      "....llllllll....",
      "....oooooooo....",
      "....OOOOOOOO....",
    ],
    side: [
      ".....oozSoo.....",
      ".....oooooooo...",
      ".....llllllll...",
      ".....oooooooo...",
      ".....llllllll...",
      ".....oOOOOOoo...",
      ".....OOOOOOOO...",
    ],
  },
  gemini: {
    down: [
      "....upSSSSpu....",
      "....uuuuuuuu....",
      "....oooooolo....",
      "....ooooolll....",
      "....oooooolo....",
      "....vvvvvvvv....",
      "....OOOOOOOO....",
    ],
    up: [
      "....uuuuuuuu....",
      "....uuuuuuuu....",
      "....oooooooo....",
      "....oooooooo....",
      "....oooooooo....",
      "....vvvvvvvv....",
      "....OOOOOOOO....",
    ],
    side: [
      ".....uupSuu.....",
      ".....uuuuuuuu...",
      ".....oooooool...",
      ".....oooooooo...",
      ".....oooooooo...",
      ".....vvvvvvvv...",
      ".....OOOOOOOO...",
    ],
  },
  qwen: {
    down: [
      "....wpSSSSpw....",
      "....woozzoow....",
      "....woozolow....",
      "....woozooow....",
      "....woozolow....",
      "....wOOzOOOw....",
      "....OOOOOOOO....",
    ],
    up: [
      "....wppppppw....",
      "....woooooow....",
      "....woooooow....",
      "....woooooow....",
      "....woooooow....",
      "....wOOOOOOw....",
      "....OOOOOOOO....",
    ],
    side: [
      ".....wppSoo.....",
      ".....woooooow...",
      ".....wooooool...",
      ".....woooooow...",
      ".....woooooow...",
      ".....wOOOOOow...",
      ".....OOOOOOOO...",
    ],
  },
  cursor: {
    down: [
      "....OppppppO....",
      "....oOOOOOOo....",
      "....oooooolo....",
      "....ooooolll....",
      "....oooooooo....",
      "....oooooooo....",
      "....OOOOOOOO....",
    ],
    up: [
      "....OppppppO....",
      "....oooooooo....",
      "....oooooooo....",
      "....oooooooo....",
      "....oooooooo....",
      "....oooooooo....",
      "....OOOOOOOO....",
    ],
    side: [
      ".....ppppoo.....",
      ".....oOOooooo...",
      ".....oooooool...",
      ".....oooooooo...",
      ".....oooooooo...",
      ".....oOOOOOoo...",
      ".....OOOOOOOO...",
    ],
  },
  hermes: {
    down: [
      "....opwSSwpo....",
      "....oopwwzoo....",
      "....ooowwzlo....",
      "....ooowwzoo....",
      "....ooowwzoo....",
      "....oOOwwzOo....",
      "....OOOOOOOO....",
    ],
    up: [
      "....oopppooo....",
      "....oooooooo....",
      "....oooooooo....",
      "....oooooooo....",
      "....oooooooo....",
      "....oooooooo....",
      "....OOOOOOOO....",
    ],
    side: [
      ".....oopSwo.....",
      ".....oooooww....",
      ".....oooooozl...",
      ".....oooooooo...",
      ".....oooooooo...",
      ".....oOOOOOoo...",
      ".....OOOOOOOO...",
    ],
  },
};
const TORSO_Y = 11;

// Arms, rows y=11..20 (overlay on the torso).
type ArmSet = Record<string, string[]>;
const ARMS_DOWN: ArmSet = {
  stand: [
    "...o........o...",
    "..oo........oo..",
    "..oO........Oo..",
    "..oO........Oo..",
    "..oO........Oo..",
    "..ss........ss..",
  ],
  swingA: [
    "...o........o...",
    "..oo........oo..",
    "..oO........Oo..",
    "..oO........ss..",
    "..oO............",
    "..ss............",
  ],
  swingB: [
    "...o........o...",
    "..oo........oo..",
    "..oO........Oo..",
    "..ss........Oo..",
    "............Oo..",
    "............ss..",
  ],
  carry: [
    "...o........o...",
    "..oo........oo..",
    "..oO........Oo..",
    "...ss......ss...",
  ],
};
// Arms raised above the head start at y=1 and are drawn under the head.
const TALL_Y = 1;
const ONE_DOWN = ["...o........o...", "............oo..", "............Oo..", "............Oo..", "............Oo..", "............ss.."];
const TALL: ArmSet = {
  raise0: [
    ".ss.............",
    ".ss.............",
    ".oo.............",
    ".oO.............",
    ".oO.............",
    "..oO............",
    "..oO............",
    "..oO............",
    "..oO............",
    "..oo............",
    ...ONE_DOWN,
  ],
  raise1: [
    "ss..............",
    "ss..............",
    ".oo.............",
    ".oO.............",
    ".oO.............",
    "..oO............",
    "..oO............",
    "..oO............",
    "..oO............",
    "..oo............",
    ...ONE_DOWN,
  ],
  cheer0: [
    "ss............ss",
    ".ss..........ss.",
    ".oo..........oo.",
    ".oO..........Oo.",
    "..oO........Oo..",
    "..oO........Oo..",
    "..oO........Oo..",
    "..oO........Oo..",
    "..oO........Oo..",
    "..oo........oo..",
    "...o........o...",
  ],
  cheer1: [
    "", "", "", "", "",
    ".ss..........ss.",
    ".ss..........ss.",
    ".oO..........Oo.",
    ".oO..........Oo.",
    "..oO........Oo..",
    "...o........o...",
  ],
};
const ARMS_UP: ArmSet = {
  stand: ARMS_DOWN.stand,
  swingA: ARMS_DOWN.swingA,
  swingB: ARMS_DOWN.swingB,
  // seated, reaching for the keyboard: elbows out, hands hidden in front
  sit: [
    "...o........o...",
    "..oo........oo..",
    "..oO........Oo..",
    "...O........O...",
  ],
  typeA: [
    "...o........o...",
    "..oo........oo..",
    "..oO........Oo..",
    "...ss.......O...",
  ],
  typeB: [
    "...o........o...",
    "..oo........oo..",
    "..oO........Oo..",
    "...O.......ss...",
  ],
  // hands behind the head, elbows out
  lean: [
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ],
  grab: [
    "...o........o...",
    "..oo........oo..",
    ".oO..........Oo.",
    ".ss..........ss.",
  ],
};
const LEAN_HEAD_ARMS = [
  ".oo..........oo.",
  ".oO..........Oo.",
  "..oO........Oo..",
];

const ARMS_SIDE: ArmSet = {
  stand: [
    "................",
    ".......oo.......",
    ".......oO.......",
    ".......oO.......",
    ".......oO.......",
    ".......ss.......",
  ],
  swingA: [
    "................",
    ".......oo.......",
    "........oO......",
    ".........oO.....",
    "..........ss....",
    "................",
  ],
  swingB: [
    "................",
    ".......oo.......",
    "......oO........",
    ".....oO.........",
    ".....ss.........",
    "................",
  ],
  point: [
    "................",
    ".......ooooooss.",
    ".......oOOOO....",
    "................",
  ],
  carry: [
    "................",
    ".......oo.......",
    "........oooss...",
    "................",
  ],
};

// Legs, rows y=18..23.
const LEGS: Record<"front" | "side", Record<string, string[]>> = {
  front: {
    stand: [
      ".....nnnnnn.....",
      ".....nnNNnn.....",
      ".....nn..nn.....",
      ".....nn..nn.....",
      ".....bb..bb.....",
      "....bbb..bbb....",
    ],
    stepL: [
      ".....nnnnnn.....",
      ".....nnNNnn.....",
      ".....nn..nn.....",
      ".....bb..nn.....",
      "....bbb..bb.....",
      ".........bbb....",
    ],
    stepR: [
      ".....nnnnnn.....",
      ".....nnNNnn.....",
      ".....nn..nn.....",
      ".....nn..bb.....",
      ".....bb..bbb....",
      "....bbb.........",
    ],
  },
  side: {
    stand: [
      "......nnnnn.....",
      "......nnnnn.....",
      ".......nnn......",
      ".......nnn......",
      ".......bbb......",
      ".......bbbb.....",
    ],
    strideA: [
      "......nnnnn.....",
      ".....nnnNnnn....",
      ".....nn...nn....",
      "....nn.....nn...",
      "....bb.....bbb..",
      "...bb......bbbb.",
    ],
    pass: [
      "......nnnnn.....",
      "......nnnnn.....",
      "......nnNnn.....",
      ".......nnbb.....",
      ".......bbbb.....",
      ".......bbbb.....",
    ],
    strideB: [
      "......nnnnn.....",
      ".....nnnNnnn....",
      ".....nn...nn....",
      "....nn.....nn...",
      "...bbb.....bb...",
      "...bbbb.....bb..",
    ],
  },
};
const LEG_Y = 18;

/* -------------------------------------------------------------- composing */

const W = 16, H = 24, PAD = 1;
export const SPRITE_W = W + PAD * 2;
export const SPRITE_H = H + PAD * 2;
/** Feet sit on this row of the sprite canvas. */
export const SPRITE_FOOT = PAD + 23;

type Grid = (string | null)[];

function colours(look: Look): Record<string, string> {
  const [skin, skinS, blush] = SKINS[look.skin];
  const [hair, hairH, hairJ] = HAIRS[look.hair];
  const ba = BRAND_ART[look.agent] ?? BRAND_ART.claude;
  const accC = look.agent === "claude" ? C.ink3 : look.agent === "codex" ? C.slate1 : C.terra3;
  const accMain = look.acc === "cap" || look.acc === "beanie" ? pick([C.blue3, C.red2, C.gold2, C.plum2, C.ink3, C.green2], look.hair + look.skin) : accC;
  const out: Record<string, string> = {
    s: skin, S: skinS, c: blush, e: C.ink, m: mix(skinS, C.red1, 0.35),
    h: hair, H: hairH, j: hairJ,
    o: ba.main, O: ba.dark, p: ba.light, l: ba.mark,
    w: C.white, z: ba.deep,
    n: look.pants, N: mix(look.pants, C.ink, 0.4),
    b: look.shoes,
    a: accMain, A: mix(accMain, C.ink, 0.35),
    g: C.ink2, k: C.ink,
    y: C.gold2, d: ba.main,
    u: ba.light, v: ba.dark,
  };
  if (look.agent === "gemini") { out.u = C.gmBlue; out.v = mix(C.gmPink, C.gm3, 0.35); }
  if (look.agent === "commandcode") {
    out.o = C.cc1; out.O = C.cc0; out.p = C.cc2; out.l = C.cc9; out.d = C.cc1;
  }
  return out;
}

function stamp(grid: Grid, rows: string[], y0: number, map: Record<string, string>, dx = 0, flip = false) {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const y = y0 + r;
    if (y < 0 || y >= H) continue;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === ".") continue;
      const col = map[ch];
      if (!col) continue;
      let x = i + dx;
      if (flip) x = W - 1 - x;
      if (x < 0 || x >= W) continue;
      grid[y * W + x] = col;
    }
  }
}

/** Remove a row from a part (interns are a little shorter). */
function dropRow(rows: string[], idx: number): string[] {
  return rows.filter((_, i) => i !== idx);
}

interface Spec {
  dir: Dir;
  legs: string | null; // leg key or null for seated
  arms: string;
  bob: number;
  headDx?: number;
  headDy?: number;
  sit?: boolean;
}

function specFor(pose: Pose, dir: Dir, frame: number): Spec {
  const side = dir === "left" || dir === "right";
  switch (pose) {
    case "walk":
    case "carry": {
      const f = frame & 3;
      const carry = pose === "carry";
      if (side) {
        const legs = ["strideA", "pass", "strideB", "pass"][f];
        const arms = carry ? "carry" : ["swingA", "stand", "swingB", "stand"][f];
        return { dir, legs, arms, bob: f === 1 || f === 3 ? -1 : 0 };
      }
      const legs = ["stepL", "stand", "stepR", "stand"][f];
      const arms = carry ? "carry" : ["swingA", "stand", "swingB", "stand"][f];
      return { dir, legs, arms, bob: f === 1 || f === 3 ? -1 : 0 };
    }
    case "sit": return { dir: "up", legs: null, arms: "sit", bob: 0, sit: true };
    case "type": return { dir: "up", legs: null, arms: frame % 3 === 0 ? "typeA" : frame % 3 === 1 ? "sit" : "typeB", bob: 0, headDy: frame % 3 === 1 ? 1 : 0, sit: true };
    case "think": return { dir: "up", legs: null, arms: "sit", bob: 0, headDx: frame & 1 ? 1 : 0, sit: true };
    case "lean": return { dir: "up", legs: null, arms: "lean", bob: 1, sit: true };
    case "sleep": return { dir: "up", legs: null, arms: "sit", bob: 1, headDx: 1, headDy: 2, sit: true };
    case "raise": return { dir: "down", legs: "stand", arms: frame & 1 ? "raise1" : "raise0", bob: 0 };
    case "cheer": return { dir: "down", legs: "stand", arms: frame & 1 ? "cheer1" : "cheer0", bob: frame & 1 ? 0 : -1 };
    case "grab": return { dir: "up", legs: "stand", arms: "grab", bob: 1 };
    case "flip": return { dir: "up", legs: "stand", arms: "cheer0", bob: -1 };
    case "point": return { dir: dir === "left" ? "left" : "right", legs: "stand", arms: "point", bob: 0 };
    default: return { dir, legs: "stand", arms: "stand", bob: 0 };
  }
}

const SIT_DROP = 3;

function compose(look: Look, pose: Pose, dir: Dir, frame: number): Bitmap {
  const sp = specFor(pose, dir, frame);
  const map = colours(look);
  const grid: Grid = new Array(W * H).fill(null);
  const d = sp.dir;
  const side = d === "left" || d === "right";
  const flip = d === "left";
  const hv: "down" | "up" | "side" = side ? "side" : d === "up" ? "up" : "down";
  const intern = look.intern;
  // Interns: one torso row and one leg row shorter, everything else shifts.
  const torso = (TORSO[look.agent] ?? TORSO.claude)[hv];
  const torsoRows = intern ? dropRow(torso, 3) : torso;
  const shrink = intern ? 2 : 0;
  const drop = (sp.sit ? SIT_DROP : 0) + shrink;
  const up = sp.bob + drop;

  if (sp.legs) {
    const set = side ? LEGS.side : LEGS.front;
    let legs = set[sp.legs] ?? set.stand;
    if (intern) legs = dropRow(legs, 2);
    stamp(grid, legs, LEG_Y + (intern ? 1 : 0), map, 0, flip);
  }
  const tall = TALL[sp.arms];
  if (tall) stamp(grid, tall, TALL_Y + up, map, 0, flip);
  const armSet = side ? ARMS_SIDE : d === "up" ? ARMS_UP : ARMS_DOWN;
  let arms = tall ? [] : armSet[sp.arms] ?? armSet.stand ?? ARMS_DOWN.stand;
  if (intern && arms.length > 4) arms = dropRow(arms, 3);
  const armsBehind = d === "up" && (sp.arms === "sit" || sp.arms.startsWith("type"));
  if (armsBehind) stamp(grid, arms, TORSO_Y + up, map, 0, flip);
  stamp(grid, torsoRows, TORSO_Y + up, map, 0, flip);
  if (!armsBehind) stamp(grid, arms, TORSO_Y + up, map, 0, flip);
  if (intern && hv !== "up") {
    // lanyard and visitor badge
    const lm = { ...map, w: C.white, y: C.gold2 };
    const rows = hv === "down"
      ? ["......y..y......", ".......yy.......", ".......ww.......", ".......ww......."]
      : ["", "..........y.....", "..........w.....", "..........w....."];
    stamp(grid, rows, TORSO_Y + up, lm, 0, flip);
  }
  // Head + hair + accessory.
  const hdx = sp.headDx ?? 0;
  const hdy = (sp.headDy ?? 0) + up;
  stamp(grid, HEAD[hv], HEAD_Y + hdy, map, hdx, flip);
  const hair = HAIR[look.style][hv];
  stamp(grid, hair, 0 + hdy, map, hdx, flip);
  if (look.acc !== "none") {
    const a = ACC[look.acc][hv];
    if (a.length) stamp(grid, a, 0 + hdy, map, hdx, flip);
  }
  if (sp.arms === "lean") stamp(grid, LEAN_HEAD_ARMS, HEAD_Y + 4 + hdy, map, 0, flip);
  return rasterize(grid);
}

function rasterize(grid: Grid): Bitmap {
  const b = bitmap(SPRITE_W, SPRITE_H);
  const img = b.g.createImageData(SPRITE_W, SPRITE_H);
  const px = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? null : grid[y * W + x]);
  const put = (x: number, y: number, hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const i = ((y + PAD) * SPRITE_W + x + PAD) * 4;
    img.data[i] = (n >> 16) & 255;
    img.data[i + 1] = (n >> 8) & 255;
    img.data[i + 2] = n & 255;
    img.data[i + 3] = 255;
  };
  for (let y = -PAD; y < H + PAD; y++) {
    for (let x = -PAD; x < W + PAD; x++) {
      const c = px(x, y);
      if (c) { put(x, y, c); continue; }
      // selective outline: darkened copy of the neighbour it borders
      const n = px(x, y - 1) ?? px(x, y + 1) ?? px(x - 1, y) ?? px(x + 1, y);
      if (n) put(x, y, mix(n, C.ink, 0.82));
    }
  }
  b.g.putImageData(img, 0, 0);
  return b;
}

const cache = new Map<string, Bitmap>();
export function sprite(look: Look, pose: Pose, dir: Dir, frame: number): Bitmap {
  const key = `${look.key}|${pose}|${dir}|${frame}`;
  let b = cache.get(key);
  if (!b) {
    // composing is cheap; keep memory flat over a long day of subagents
    if (cache.size > 4000) cache.clear();
    b = compose(look, pose, dir, frame);
    cache.set(key, b);
  }
  return b;
}

/** Solid silhouette of a sprite, for selection glows. */
const silCache = new WeakMap<HTMLCanvasElement, Map<string, Bitmap>>();
export function silhouette(src: Bitmap, color: string): Bitmap {
  let m = silCache.get(src.c);
  if (!m) silCache.set(src.c, (m = new Map()));
  let b = m.get(color);
  if (!b) {
    b = bitmap(src.w, src.h);
    b.g.drawImage(src.c, 0, 0);
    b.g.globalCompositeOperation = "source-in";
    b.g.fillStyle = color;
    b.g.fillRect(0, 0, b.w, b.h);
    m.set(color, b);
  }
  return b;
}

/* ------------------------------------------------------------- the cat */

const CAT: Record<string, string[]> = {
  walk0: [
    "..........o.o.",
    "o.........oooo",
    ".o........ooeo",
    "..oooooooooooo",
    "..ooooooooooO.",
    "..wOOOOOOOOw..",
    "..o.o....o.o..",
    "..w.w....w.w..",
  ],
  walk1: [
    "..........o.o.",
    ".o........oooo",
    ".o........ooeo",
    "..oooooooooooo",
    "..ooooooooooO.",
    "..wOOOOOOOOw..",
    "...o.o..o.o...",
    "...w.w..w.w...",
  ],
  sit: [
    "......o.o.....",
    "......ooo.....",
    "......eoe.....",
    "......owo.....",
    ".....ooooo....",
    ".....owwwo....",
    "o....oowoo....",
    ".oooooOwOO....",
  ],
  loaf: [
    "..............",
    "..............",
    "..........o.o.",
    "...oooooooooo.",
    "..ooooooooookk",
    ".oooooooooooo.",
    "oooOOOOOOOOO..",
    ".OO...........",
  ],
};
const CAT_COATS: Record<string, string>[] = [
  { o: C.gold2, O: C.gold1, w: C.white, e: C.green4, k: C.ink },
  { o: C.ink3, O: C.ink2, w: C.slate4, e: C.gold3, k: C.ink },
  { o: C.slate4, O: C.slate3, w: C.white, e: C.gold3, k: C.ink },
];
const catCache = new Map<string, Bitmap>();
export function catSprite(pose: "walk0" | "walk1" | "sit" | "loaf", left: boolean, coat: number): Bitmap {
  const key = `${pose}|${left}|${coat}`;
  let b = catCache.get(key);
  if (!b) {
    const grid: Grid = new Array(W * H).fill(null);
    const rows = CAT[pose];
    // bottom-align the 8 rows on the sprite's foot row, centred
    stamp(grid, rows, H - rows.length, CAT_COATS[coat % CAT_COATS.length], 1, left);
    b = rasterize(grid);
    catCache.set(key, b);
  }
  return b;
}
