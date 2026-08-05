// Global solo leaderboard over Supabase's REST endpoint with plain fetch —
// deliberately no @supabase/supabase-js import so game bundles stay tiny.
// Party rooms never touch this; it's solo runs only.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";
import { myId, myName, myAvatar } from "./profile";

const RUNS = `${SUPABASE_URL}/rest/v1/runs`;
const HEADERS: Record<string, string> = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
};

export interface RunRow {
  player_id: string;
  name: string;
  avatar: string;
  score: number;
  created_at: string;
}

/**
 * Post a solo run to the board and return its worldwide rank (1 = best run
 * ever recorded for that game). Returns ok:false when the board is
 * unreachable — the caller should degrade gracefully, never block the win.
 */
export async function submitRun(
  game: string,
  score: number,
): Promise<{ ok: boolean; rank: number | null }> {
  try {
    const res = await fetch(RUNS, {
      method: "POST",
      headers: { ...HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify({
        player_id: myId(),
        name: myName() || "Player",
        avatar: myAvatar(),
        game,
        score,
      }),
    });
    if (!res.ok) return { ok: false, rank: null };
    const cnt = await fetch(`${RUNS}?game=eq.${game}&score=gt.${score}&select=id`, {
      headers: { ...HEADERS, Prefer: "count=exact", Range: "0-0" },
    });
    const range = cnt.headers.get("content-range") ?? "";
    const total = Number(range.split("/")[1]);
    return { ok: true, rank: Number.isFinite(total) ? total + 1 : null };
  } catch {
    return { ok: false, rank: null };
  }
}

/**
 * Best run per player, highest first. Fetches the top raw runs and de-dupes
 * client-side so one hot streak doesn't fill the board with a single name.
 */
export async function fetchTop(game: string, limit = 25): Promise<RunRow[]> {
  const res = await fetch(
    `${RUNS}?game=eq.${game}&select=player_id,name,avatar,score,created_at&order=score.desc&limit=200`,
    { headers: HEADERS },
  );
  if (!res.ok) throw new Error(`board fetch failed: ${res.status}`);
  const rows = (await res.json()) as RunRow[];
  const seen = new Set<string>();
  const best: RunRow[] = [];
  for (const r of rows) {
    if (seen.has(r.player_id)) continue;
    seen.add(r.player_id);
    best.push(r);
    if (best.length >= limit) break;
  }
  return best;
}
