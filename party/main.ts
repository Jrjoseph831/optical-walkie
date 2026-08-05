// SIGNAL Party lobby — create/join a room, live roster + scoreboard, launch games.
import QRCode from "qrcode";
import { joinRoom, myId, myName, setName, getScore, type PlayerMeta } from "../shared/room";
import type { RealtimeChannel } from "@supabase/supabase-js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function genCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

let code = "";
let isHost = false;
let name = myName();
let channel: RealtimeChannel | null = null;
let roster: PlayerMeta[] = [];

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

$<HTMLButtonElement>("joinBtn").onclick = () => enterLobby();
$<HTMLInputElement>("nameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") enterLobby();
});

function enterLobby(): void {
  const n = $<HTMLInputElement>("nameInput").value.trim();
  if (!n) {
    $("gateStatus").textContent = "Enter a name to continue.";
    return;
  }
  name = n;
  setName(name);
  $("nameGate").classList.add("hide");
  $("lobby").classList.remove("hide");
  $("codeText").textContent = code;
  connect();
}

function connect(): void {
  const joinUrl = `${location.origin}${location.pathname}?room=${code}`;
  QRCode.toCanvas($("qr"), joinUrl, { width: 220, margin: 1, color: { dark: "#0f1118", light: "#ffffff" } }, () => {});

  const meta: Omit<PlayerMeta, "id"> = { name, host: isHost, score: getScore(code), ready: false, beacon: false };
  const r = joinRoom(code, meta, renderRoster);
  channel = r.channel;

  channel.on("broadcast", { event: "launch" }, ({ payload }) => {
    const p = payload as { game: string; beaconIds: string[]; seed: number };
    const role = p.beaconIds.includes(myId()) ? "beacon" : "player";
    location.href = `../${p.game}/?room=${code}&role=${role}&seed=${p.seed}`;
  });

  if (isHost) {
    const btn = $<HTMLButtonElement>("readyBtn");
    btn.textContent = "▶  Start · Phrase";
    btn.classList.remove("hide");
  }
  $("lobbyStatus").textContent = isHost
    ? "When everyone's in, hit Start."
    : "You're in! Waiting for the host to start.";
}

function renderRoster(players: PlayerMeta[]): void {
  roster = players;
  players.sort((a, b) => b.score - a.score || (b.host ? 1 : 0) - (a.host ? 1 : 0));
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
    nm.textContent = p.name + (p.id === myId() ? " (you)" : "");
    const tag = document.createElement("div");
    tag.className = "tag";
    tag.textContent = p.host ? "host" : "";
    const sc = document.createElement("div");
    sc.className = "sc";
    sc.textContent = String(p.score || 0);
    row.append(av, nm, tag, sc);
    roster.appendChild(row);
  }
}

$<HTMLButtonElement>("readyBtn").onclick = () => {
  // Any phone can be the beacon — pick at random each round so it rotates.
  // 2–5 players share one beacon; 6+ get two beaming the same phrase (the
  // shared seed keeps them identical) so a big group can crowd two screens.
  const players = roster.length ? roster : [{ id: myId() } as PlayerMeta];
  const beaconCount = players.length >= 6 ? 2 : 1;
  const shuffled = [...players];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const beaconIds = shuffled.slice(0, beaconCount).map((p) => p.id);
  const seed = Math.floor(Math.random() * 1_000_000);
  channel?.send({
    type: "broadcast",
    event: "launch",
    payload: { game: "sentence", beaconIds, seed },
  });
  $("lobbyStatus").textContent = "🎮 Launching Phrase…";
};

window.addEventListener("beforeunload", () => {
  void channel?.unsubscribe();
});
