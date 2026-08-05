// SIGNAL Party — create/join a room, configure a session (which games, how many
// rounds), run rounds, and show podium standings in between. The room is a
// Supabase realtime channel; scores live in localStorage and ride presence.
import QRCode from "qrcode";
import { joinRoom, myId, myName, setName, getScore, resetScore, type PlayerMeta } from "../shared/room";
import type { RealtimeChannel } from "@supabase/supabase-js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function genCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

const GAME_LABEL: Record<string, string> = { sentence: "Phrase", fragments: "Reveal", draw: "Draw" };
const AVATARS_FALLBACK = "🙂";

let code = "";
let isHost = false;
let name = myName();
let channel: RealtimeChannel | null = null;
let roster: PlayerMeta[] = [];

// ---- session state (persisted so it survives the trip through a game page) ----
interface Session { games: string[]; total: number; round: number; }
const sessKey = () => `signal_sess_${code}`;
function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(sessKey());
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}
function saveSession(s: Session | null): void {
  if (s) localStorage.setItem(sessKey(), JSON.stringify(s));
  else localStorage.removeItem(sessKey());
}

const params = new URLSearchParams(location.search);
const roomParam = params.get("room");
if (roomParam) {
  code = roomParam.toUpperCase();
  if (params.get("host") === "1") localStorage.setItem(`signal_host_${code}`, "1");
  isHost = localStorage.getItem(`signal_host_${code}`) === "1";
  // Anyone who already has a name goes straight to the lobby (which shows
  // standings if a session is running). Only a fresh scanner needs the gate.
  if (myName()) {
    name = myName();
    enterLobby();
  } else {
    showNameGate();
  }
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
  localStorage.setItem(`signal_host_${code}`, "1");
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

$<HTMLButtonElement>("joinBtn").onclick = () => {
  const n = $<HTMLInputElement>("nameInput").value.trim();
  if (!n) {
    $("gateStatus").textContent = "Enter a name to continue.";
    return;
  }
  name = n;
  setName(name);
  enterLobby();
};
$<HTMLInputElement>("nameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $<HTMLButtonElement>("joinBtn").click();
});

// ---- setup controls ----
const enabledGames = new Set(["sentence", "fragments", "draw"]);
let chosenRounds = 5;
for (const el of document.querySelectorAll<HTMLElement>(".gtoggle")) {
  const game = el.dataset.game!;
  el.querySelector(".sw")!.addEventListener("click", () => {
    const sw = $(`sw-${game}`);
    if (enabledGames.has(game)) {
      if (enabledGames.size === 1) return; // keep at least one on
      enabledGames.delete(game);
      sw.classList.remove("on");
    } else {
      enabledGames.add(game);
      sw.classList.add("on");
    }
  });
}
for (const b of document.querySelectorAll<HTMLButtonElement>("#rounds button")) {
  b.onclick = () => {
    chosenRounds = Number(b.dataset.r);
    document.querySelectorAll("#rounds button").forEach((x) => x.classList.toggle("on", x === b));
  };
}

function enterLobby(): void {
  $("landing").classList.add("hide");
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

  // Host tells a fresh joiner what the session settings are (so late arrivals
  // fall into the next round correctly).
  channel.on("broadcast", { event: "session" }, ({ payload }) => {
    const s = payload as Session;
    if (!isHost) saveSession(s);
  });

  channel.on("broadcast", { event: "round" }, ({ payload }) => {
    const p = payload as { game: string; beaconIds: string[]; seed: number; round: number; total: number };
    saveSession({ games: loadSession()?.games ?? enabledArray(), total: p.total, round: p.round });
    const role = p.beaconIds.includes(myId()) ? "beacon" : "player";
    location.href = `../${p.game}/?room=${code}&role=${role}&seed=${p.seed}&round=${p.round}&of=${p.total}`;
  });

  // Host started a fresh game — everyone clears their score and returns to the
  // lobby (each device resets its own local score).
  channel.on("broadcast", { event: "newgame" }, () => {
    resetScore(code);
    saveSession(null);
    location.href = isHost ? `?room=${code}&host=1` : `?room=${code}`;
  });

  const sess = loadSession();
  if (sess && sess.round >= 1) {
    showStandings(sess);
  } else {
    showLobbyControls();
  }
}

function enabledArray(): string[] {
  return ["sentence", "fragments", "draw"].filter((g) => enabledGames.has(g));
}

function showLobbyControls(): void {
  $("standings").classList.add("hide");
  $("lobby").classList.remove("hide");
  if (isHost) {
    $("setup").classList.remove("hide");
    const btn = $<HTMLButtonElement>("readyBtn");
    btn.textContent = "▶ Start party";
    btn.classList.remove("hide");
    $("lobbyStatus").textContent = "Pick games and rounds, then start.";
  } else {
    $("lobbyStatus").textContent = "You're in! Waiting for the host to start.";
  }
}

function renderRoster(players: PlayerMeta[]): void {
  roster = players;
  const sorted = [...players].sort((a, b) => b.score - a.score || (b.host ? 1 : 0) - (a.host ? 1 : 0));
  $("plab").textContent = `Players (${players.length})`;
  const rosterEl = $("roster");
  rosterEl.innerHTML = "";
  for (const p of sorted) {
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
    rosterEl.appendChild(row);
  }
  // keep the podium fresh if we're on the standings screen
  if (!$("standings").classList.contains("hide")) paintStandings(sorted);
}

// ---- start / advance the session ----
$<HTMLButtonElement>("readyBtn").onclick = () => {
  const games = enabledArray();
  const sess: Session = { games, total: chosenRounds, round: 0 };
  saveSession(sess);
  channel?.send({ type: "broadcast", event: "session", payload: sess });
  launchRound(sess, 1);
};

function launchRound(sess: Session, roundNum: number): void {
  const game = sess.games[(roundNum - 1) % sess.games.length]!;
  // Rotate the beacon/drawer through the players by round so it isn't always
  // the same person. 2–5 players + Phrase can use two beacons.
  const ordered = [...roster].sort((a, b) => (a.id < b.id ? -1 : 1));
  const n = ordered.length || 1;
  const beaconCount = game === "sentence" && n >= 6 ? 2 : 1;
  const beaconIds: string[] = [];
  for (let i = 0; i < beaconCount; i++) beaconIds.push(ordered[(roundNum - 1 + i) % n]?.id ?? myId());
  const seed = Math.floor(Math.random() * 1_000_000);
  saveSession({ ...sess, round: roundNum });
  channel?.send({
    type: "broadcast",
    event: "round",
    payload: { game, beaconIds, seed, round: roundNum, total: sess.total },
  });
  $("lobbyStatus").textContent = `🎮 Launching ${GAME_LABEL[game]}…`;
  $("standStatus").textContent = `Launching ${GAME_LABEL[game]}…`;
};

$<HTMLButtonElement>("nextBtn").onclick = () => {
  const sess = loadSession();
  if (!sess) return;
  launchRound(sess, sess.round + 1);
};

// ---- standings ----
function showStandings(sess: Session): void {
  $("lobby").classList.add("hide");
  $("standings").classList.remove("hide");
  const done = sess.round >= sess.total;
  $("standHead").textContent = done ? "Final results" : "Standings";
  $("standTitle").textContent = done ? "🏁 Game over" : `Round ${sess.round} of ${sess.total} · done`;
  paintStandings([...roster].sort((a, b) => b.score - a.score));
  const next = $<HTMLButtonElement>("nextBtn");
  if (isHost) {
    next.classList.remove("hide");
    if (done) {
      next.textContent = "↻ New game";
      next.onclick = () => {
        channel?.send({ type: "broadcast", event: "newgame", payload: {} });
      };
      $("standStatus").textContent = "";
    } else {
      next.textContent = "▶ Next round";
      next.onclick = () => launchRound(sess, sess.round + 1);
      $("standStatus").textContent = "";
    }
  } else {
    next.classList.add("hide");
    $("standStatus").textContent = done ? "Thanks for playing!" : "Waiting for the host to start the next round…";
  }
}

function paintStandings(sorted: PlayerMeta[]): void {
  const podium = $("podium");
  podium.innerHTML = "";
  const medals = ["🥇", "🥈", "🥉"];
  const order = [1, 0, 2]; // visual: 2nd, 1st, 3rd
  for (const idx of order) {
    const p = sorted[idx];
    const cell = document.createElement("div");
    cell.className = "pod" + (idx === 0 ? " p1" : "");
    if (!p) {
      cell.style.visibility = "hidden";
      podium.appendChild(cell);
      continue;
    }
    cell.innerHTML =
      `<div class="medal">${medals[idx]}</div>` +
      `<div class="pav">${(p.name || "?").slice(0, 2).toUpperCase()}</div>` +
      `<div class="pn">${escapeHtml(p.name)}${p.id === myId() ? " (you)" : ""}</div>` +
      `<div class="ps">${p.score || 0}</div>`;
    podium.appendChild(cell);
  }
  const list = $("standList");
  list.innerHTML = "";
  sorted.slice(3).forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "standrow" + (p.id === myId() ? " me" : "");
    row.innerHTML =
      `<div class="rk">${i + 4}</div>` +
      `<div class="nm">${escapeHtml(p.name)}${p.id === myId() ? " (you)" : ""}</div>` +
      `<div class="sc">${p.score || 0}</div>`;
    list.appendChild(row);
  });
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s || AVATARS_FALLBACK;
  return d.innerHTML;
}

window.addEventListener("beforeunload", () => {
  void channel?.unsubscribe();
});
