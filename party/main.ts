// SIGNAL Party lobby — Supabase Realtime (presence + broadcast).
// A room is just a realtime channel keyed by its code. No database.
import QRCode from "qrcode";
import { supabase, type PlayerMeta } from "../shared/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// UUID with a fallback — crypto.randomUUID throws on older mobile Safari, which
// would kill the whole script and leave an unstyled shell.
function uuid(): string {
  const c = crypto as unknown as { randomUUID?: () => string };
  if (typeof c.randomUUID === "function") return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
function genCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

const playerId = uuid();
let code = "";
let isHost = false;
let name = localStorage.getItem("signal_name") ?? "";
let channel: RealtimeChannel | null = null;

// ---- routing: ?room means we came from a QR/link → skip landing ----
const params = new URLSearchParams(location.search);
const roomParam = params.get("room");
if (roomParam) {
  code = roomParam.toUpperCase();
  isHost = params.get("host") === "1";
  showNameGate();
} else {
  showLanding();
}

function showLanding(): void {
  $("landing").classList.remove("hide");
  $("nameGate").classList.add("hide");
  $("lobby").classList.add("hide");
}
function showNameGate(): void {
  $("landing").classList.add("hide");
  $("nameGate").classList.remove("hide");
  $("lobby").classList.add("hide");
  $<HTMLInputElement>("nameInput").value = name;
  $("nameLabel").textContent = isHost ? "You're the host — what's your name?" : `Joining room ${code} — your name?`;
  $("heroSub").textContent = isHost ? "Share the code — get everyone in." : `Joining room ${code}.`;
}

// ---- landing actions ----
$<HTMLButtonElement>("createBtn").onclick = () => {
  code = genCode();
  isHost = true;
  history.replaceState(null, "", `?room=${code}&host=1`);
  showNameGate();
};
$<HTMLButtonElement>("codeJoinBtn").onclick = () => {
  const c = $<HTMLInputElement>("codeInput").value.trim().toUpperCase();
  if (c.length < 3) {
    $("landingStatus").textContent = "Enter the room code (e.g. PLUM).";
    return;
  }
  code = c;
  isHost = false;
  history.replaceState(null, "", `?room=${code}`);
  showNameGate();
};
$<HTMLInputElement>("codeInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $<HTMLButtonElement>("codeJoinBtn").click();
});

// ---- name gate ----
$<HTMLButtonElement>("joinBtn").onclick = () => void enterLobby();
$<HTMLInputElement>("nameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") void enterLobby();
});

async function enterLobby(): Promise<void> {
  const n = $<HTMLInputElement>("nameInput").value.trim();
  if (!n) {
    $("gateStatus").textContent = "Enter a name to continue.";
    return;
  }
  name = n;
  localStorage.setItem("signal_name", name);
  $("nameGate").classList.add("hide");
  $("lobby").classList.remove("hide");
  $("codeText").textContent = code;
  await connect();
}

// ---- realtime ----
async function connect(): Promise<void> {
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
      $("lobbyStatus").textContent = "Connection problem — check your network and refresh.";
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
    tag.className = p.ready && !p.host ? "tag ready" : "tag";
    tag.textContent = p.host ? "host" : p.ready ? "ready" : "";
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
