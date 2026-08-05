// Device-bound player profile — no passwords, no sign-up. Identity is a
// generated id kept in localStorage; the name + avatar are chosen once and
// reused everywhere (solo runs, leaderboard, party name pre-fill). Party rooms
// never require any of this — a typed name is enough there.

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
  localStorage.setItem("signal_name", n.slice(0, 16));
}

export const AVATARS = ["🦊", "🐸", "🐙", "🦁", "🐼", "🦄", "👻", "🤖", "🛸", "🌵", "🎧", "🕹️", "⚡", "🎲", "🍕", "🐵"] as const;

export function myAvatar(): string {
  return localStorage.getItem("signal_avatar") ?? "🦊";
}
export function setAvatar(a: string): void {
  localStorage.setItem("signal_avatar", a);
}

// Local personal bests, one per game.
const bestKey = (game: string) => `signal_best_${game}`;
export function bestRun(game: string): number {
  return Number(localStorage.getItem(bestKey(game)) || 0);
}
/** Record a run locally; returns true when it's a new personal best. */
export function recordRun(game: string, score: number): boolean {
  if (score > bestRun(game)) {
    localStorage.setItem(bestKey(game), String(score));
    return true;
  }
  return false;
}
