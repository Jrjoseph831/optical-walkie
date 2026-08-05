// SIGNAL Party lobby — Supabase Realtime (presence + broadcast).
// No database: a room is just a realtime channel keyed by its code. Presence
// tracks who's in the room; broadcast carries ready/start (and later scores).
import QRCode from "qrcode";
import { supabase, type PlayerMeta } from "../shared/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- room + identity ----
const params = new URLSearchParams(location.search);
let code = params.get("room");
let isHost = false;
if (!code) {
  code = genCode();
  isHost = true;
  history.replaceState(null, "", `?room=${code}&host=1`);
} else {
  isHost = params.get("host") === "1";
}
const playerId = crypto.randomUUID();
let name = localStorage.getItem("signal_name") ?? "";
let channel: RealtimeChannel | null = null;

function genCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

// ---- name gate ----
$("codeText").textContent = code;
$("heroSub").textContent = isHost ? "Share the code — get everyone in." : `Joining room ${code}.`;
$("nameGate").classList.remove("hide");
$<HTMLInputElement>("nameInput").value = name;
if (isHost) $("nameLabel").textContent = "You're the host — what's your name?";

$<HTMLButtonElement>("joinBtn").onclick = () => void join();
$<HTMLInputElement>("nameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") void join();
});

async function join(): Promise<void> {
  const n = $<HTMLInputElement>("nameInput").value.trim();
  if (!n) {
    $("gateStatus").textContent = "Enter a name to join.";
    return;
  }
  name = n;
  localStorage.setItem("signal_name", name);
  $("nameGate").classList.add("hide");
  $("lobby").classList.remove("hide");
  await connect();
}

// ---- realtime ----
async function connect(): Promise<void> {
  // Join QR points at the plain room URL (no host flag → joiners are players).
  const joinUrl = `${location.origin}${location.pathname}?room=${code}`;
  QRCode.toCanvas($("qr"), joinUrl, { width: 220, margin: 1, color: { dark: "#0f1118", light: "#ffffff" } }, () => {});

  channel = supabase.channel(`room:${code}`, { config: { presence: { key: playerId } } });

  channel.on("presence", { event: "sync" }, renderRoster);
  channel.on("broadcast", { event: "start" }, () => {
    $("lobbyStatus").textContent = "🎮 Everyone's ready! (game launch wires in next.)";
  });

  channel.subscribe(async (status) => {
    if (status === "SUBSCRIBED") {
      const meta: PlayerMeta = { id: playerId, name, host: isHost, score: 0, ready: false, beacon: false };
      await channel!.track(meta);
      if (isHost) $("readyBtn").classList.remove("hide");
      $("lobbyStatus").textContent = isHost ? "Waiting for players…" : "You're in! Waiting for the host to start.";
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      $("lobbyStatus").textContent = "Connection problem — check the network and refresh.";
    }
  });
}

function renderRoster(): void {
  if (!channel) return;
  const state = channel.presenceState() as unknown as Record<string, PlayerMeta[]>;
  const players = Object.values(state).flat();
  players.sort((a, b) => (b.host ? 1 : 0) - (a.host ? 1 : 0));
  $("plab").textContent = `Players (${players.length})`;
  const roster = $("roster");
  roster.innerHTML = "";
  for (const p of players) {
    const row = document.createElement("div");
    row.className = "prow";
    const av = document.createElement("div");
    av.className = "av";
    av.textContent = (p.name || "?").slice(0, 2).toUpperCase();
    const nm = document.createElement("div");
    nm.className = "nm";
    nm.textContent = p.name + (p.id === playerId ? " (you)" : "");
    const tag = document.createElement("div");
    if (p.host) {
      tag.className = "tag";
      tag.textContent = "host";
    } else if (p.ready) {
      tag.className = "tag ready";
      tag.textContent = "ready";
    } else {
      tag.className = "tag";
      tag.textContent = "";
    }
    row.append(av, nm, tag);
    roster.appendChild(row);
  }
}

$<HTMLButtonElement>("readyBtn").onclick = () => {
  channel?.send({ type: "broadcast", event: "start", payload: { by: name } });
  $("lobbyStatus").textContent = "🎮 Starting…";
};

window.addEventListener("beforeunload", () => {
  void channel?.unsubscribe();
});
