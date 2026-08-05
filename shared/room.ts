// Shared party-room helpers used by both the lobby and the games.
// Identity + cumulative score persist in localStorage so a device keeps the same
// presence across page navigations (lobby -> game -> lobby). A room is a Supabase
// realtime channel; presence carries each player's live score (no database).
import { supabase, type PlayerMeta } from "./supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

function uuid(): string {
  const c = crypto as unknown as { randomUUID?: () => string };
  if (typeof c.randomUUID === "function") return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function myId(): string {
  let id = localStorage.getItem("signal_pid");
  if (!id) {
    id = uuid();
    localStorage.setItem("signal_pid", id);
  }
  return id;
}
export function myName(): string {
  return localStorage.getItem("signal_name") ?? "";
}
export function setName(n: string): void {
  localStorage.setItem("signal_name", n);
}

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
  const channel = supabase.channel(`room:${room}`, { config: { presence: { key: id } } });

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
