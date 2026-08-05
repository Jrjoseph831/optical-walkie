// Global leaderboard — best solo run per player.
import { fetchTop, type RunRow } from "../shared/leaderboard";
import { myId } from "../shared/profile";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const MEDALS = ["🥇", "🥈", "🥉"];

function when(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  const days = Math.floor(d / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function render(rows: RunRow[]): void {
  const board = $("board");
  board.innerHTML = "";
  if (rows.length === 0) {
    board.innerHTML = `<div class="state"><span class="big">🌒</span>No runs on the board yet.<br />Be the first name up here.</div>`;
    return;
  }
  const me = myId();
  rows.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "row" + (i < 3 ? ` p${i + 1}` : "") + (r.player_id === me ? " me" : "");
    const rk = document.createElement("div");
    rk.className = "rk";
    rk.textContent = MEDALS[i] ?? String(i + 1);
    const av = document.createElement("div");
    av.className = "av";
    av.textContent = r.avatar || "🙂";
    const nm = document.createElement("div");
    nm.className = "nm";
    nm.textContent = r.name;
    const sm = document.createElement("small");
    sm.textContent = when(r.created_at);
    nm.appendChild(sm);
    const sc = document.createElement("div");
    sc.className = "sc";
    sc.textContent = r.score.toLocaleString();
    row.append(rk, av, nm, sc);
    board.appendChild(row);
  });
}

async function load(): Promise<void> {
  try {
    render(await fetchTop("sentence"));
  } catch {
    $("board").innerHTML =
      `<div class="state"><span class="big">🛰️</span>The board is warming up.<br />Your runs still count — check back soon.</div>`;
  }
}

void load();
