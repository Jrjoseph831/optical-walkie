// Supabase client for the party/lobby layer (realtime presence + broadcast).
// The anon key is public by design — it ships to every browser and is safe to
// commit; data access is governed by RLS (we use no tables yet, only realtime
// channels for ephemeral lobby state).
import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://ngvdkqhgwqdfeixxxnkx.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5ndmRrcWhnd3FkZmVpeHh4bmt4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5MzM2MzEsImV4cCI6MjEwMTUwOTYzMX0.N2Z0yfX6g3_McNoUyu5XCFBFja3_8ZXsRj5xdaijwP0";

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
