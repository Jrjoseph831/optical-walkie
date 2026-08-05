// Shared party-room helpers used by both the lobby and the games.
// Identity + cumulative score persist in localStorage so a device keeps the same
// presence across page navigations (lobby -> game -> lobby). A room is a Supabase
// realtime channel; presence carries each player's live score (no database).
import { supabase, type PlayerMeta } from "./supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { myId } from "./profile";

export { myId, myName, setName } from "./profile";

const scoreKey = (room: string) => `signal_score_${room}`;
export function getScore(room: string): number {
  return Number(localStorage.getItem(scoreKey(room)) || 0);
}
export function addScore(room: string, pts: number): number {
  const s = getScore(room) + pts;
  localStorage.setItem(scoreKey(room), String(s));
  return s;
}
export function resetScore(room: string): void {
  localStorage.removeItem(scoreKey(room));
}

export type { PlayerMeta };

// Join a room channel; keeps our presence tracked with the given meta.
export function joinRoom(
  room: string,
  meta: Omit<PlayerMeta, "id">,
  onRoster: (players: PlayerMeta[]) => void,
): { channel: RealtimeChannel; update: (patch: Partial<PlayerMeta>) => void; id: string } {
  const id = myId();
  let current: PlayerMeta = { id, ...meta };
  // self: true — the sender must receive its own broadcasts (the host fires
  // `launch` and has to navigate into the game like everyone else).
  const channel = supabase.channel(`room:${room}`, {
    config: { presence: { key: id }, broadcast: { self: true } },
  });

  channel.on("presence", { event: "sync" }, () => {
    const state = channel.presenceState() as unknown as Record<string, PlayerMeta[]>;
    onRoster(Object.values(state).flat());
  });
  channel.subscribe(async (status) => {
    if (status === "SUBSCRIBED") await channel.track(current);
  });

  const update = (patch: Partial<PlayerMeta>) => {
    current = { ...current, ...patch };
    void channel.track(current);
  };
  return { channel, update, id };
}
