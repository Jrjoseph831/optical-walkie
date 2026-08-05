// Curated draw-word bank. Words are grouped by category; a round's three decoys
// are drawn from the SAME category as the answer, so the wrong choices are
// always plausible (car -> bus / train / boat, never car -> house / tie). Each
// category is deep enough that the decoys vary round to round.
export const WORD_BANK: Record<string, string[]> = {
  animals: [
    "cat", "dog", "elephant", "giraffe", "penguin", "octopus", "rabbit",
    "horse", "snake", "owl", "shark", "frog", "bear", "fox", "monkey",
    "lion", "turtle", "whale", "spider", "butterfly",
  ],
  food: [
    "pizza", "burger", "banana", "apple", "donut", "ice cream", "hot dog",
    "taco", "cake", "egg", "carrot", "cherry", "pretzel", "cookie",
    "sandwich", "grapes", "cupcake", "pineapple", "popcorn", "lollipop",
  ],
  vehicles: [
    "car", "bus", "train", "airplane", "boat", "rocket", "bicycle", "truck",
    "helicopter", "scooter", "tractor", "submarine", "sailboat", "canoe",
    "ambulance", "motorcycle",
  ],
  household: [
    "chair", "lamp", "clock", "umbrella", "key", "scissors", "spoon", "cup",
    "ladder", "broom", "candle", "mirror", "toothbrush", "hammer", "bucket",
    "teapot", "fork", "pillow",
  ],
  nature: [
    "tree", "flower", "mountain", "sun", "cloud", "star", "rainbow", "cactus",
    "mushroom", "snowflake", "leaf", "volcano", "island", "waterfall", "moon",
    "tornado", "river",
  ],
  objects: [
    "guitar", "drum", "kite", "balloon", "crown", "glasses", "hat", "anchor",
    "magnet", "camera", "umbrella", "trophy", "compass", "lantern", "telescope",
    "envelope", "backpack", "clock",
  ],
  characters: [
    "robot", "ghost", "snowman", "alien", "skeleton", "wizard", "pirate",
    "mermaid", "dragon", "clown", "vampire", "superhero",
  ],
  buildings: [
    "house", "castle", "lighthouse", "tent", "bridge", "windmill", "barn",
    "skyscraper", "igloo", "pyramid", "church", "treehouse",
  ],
};

export interface Deal {
  word: string;
  category: string;
  choices: string[]; // the answer + 3 decoys, shuffled
  answerIndex: number; // position of the answer within choices
}

function shuffle<T>(a: T[], rnd: () => number = Math.random): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const CATEGORIES = Object.keys(WORD_BANK);

/**
 * Deal a word to draw plus three same-category decoys. Pass a seeded RNG so
 * that in a party round every device produces the identical deck; omit it for
 * solo/local dealing.
 */
export function dealWord(rnd: () => number = Math.random): Deal {
  const category = CATEGORIES[Math.floor(rnd() * CATEGORIES.length)]!;
  const pool = [...WORD_BANK[category]!];
  shuffle(pool, rnd);
  const word = pool[0]!;
  const decoys = pool.slice(1, 4);
  const choices = shuffle([word, ...decoys], rnd);
  return { word, category, choices, answerIndex: choices.indexOf(word) };
}

/**
 * Rebuild the exact same deal a drawer dealt, from a seed. Used so a party
 * beacon and its players agree on the answer + decoys without transmitting the
 * whole list.
 */
export function dealFromSeed(seed: number): Deal {
  return dealWord(mulberry32(seed));
}

// Small deterministic RNG (same one the games use) so a seed reproduces a deal.
export function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const titleCase = (s: string): string => s.replace(/\b\w/g, (c) => c.toUpperCase());
