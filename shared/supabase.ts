// Realtime client — used by the party lobby only (presence + broadcast, no
// auth, no tables). Games and the leaderboard talk to Supabase over plain
// fetch (see shared/leaderboard.ts) to keep their bundles small.
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";

export { SUPABASE_URL, SUPABASE_ANON_KEY };

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: { params: { eventsPerSecond: 10 } },
});

export interface PlayerMeta {
  id: string;
  name: string;
  host: boolean;
  score: number;
  ready: boolean;
  beacon: boolean;
}
