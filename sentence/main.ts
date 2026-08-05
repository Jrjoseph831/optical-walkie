// Guess the Phrase — word-picture reveal with a crisp 5x7 pixel font.
//
// BEACON: renders each word with an embedded dot-matrix font (consistent letter
// size, no downsample blur), tiles it, shuffles all rows across all words, and
// plays each row once — the whole phrase fills in scattered bursts, then stops.
// PLAYER: hidden camera; caught rows fill each word-picture in; read the pixels
// and guess (verified on-device). Guess earlier = more points.
import QRCode from "qrcode";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { LTEncoder, LTDecoder } from "../shared/fountain";
import { packFrame, parseFrame, streamIdentity, fnv1a, type FrameHeader } from "../shared/protocol";
import { rasterizeQr } from "../shared/qr-raster";
import { submitRun } from "../shared/leaderboard";
import { recordRun, myName, setName } from "../shared/profile";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path),
  },
});

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const TX_FPS = 16;
const SCAN_MS = 70;
const META_EVERY = 12;
const ROW_REPEAT = 7; // frames each row lingers so a camera can catch it
const TX_PASSES = 3; // full passes of the phrase, so a late camera still completes the board

// 5x7 dot-matrix font. Each glyph is 7 rows of 5 columns ("1" = ink).
const GLYPH_W = 5;
const GLYPH_H = 7;
const CHAR_W = 6; // 5 glyph columns + 1 gap
const GH = 9; // tile rows per word (7 glyph + 1 top/bottom pad)
const VOFF = 1;
const FONT: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "'": ["00100", "00100", "00100", "00000", "00000", "00000", "00000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

const enc = new TextEncoder();
const dec = new TextDecoder();

// Party mode: launched from the lobby with ?room=CODE&role=beacon|player.
// Party rooms keep their own score; solo runs post to the global board.
const partyParams = new URLSearchParams(location.search);
const partyRoom = partyParams.get("room");
const partyRole = partyParams.get("role");
function addScore(room: string, pts: number): number {
  const k = `signal_score_${room}`;
  const total = Number(localStorage.getItem(k) || 0) + pts;
  localStorage.setItem(k, String(total));
  return total;
}

const PHRASES: string[] = [
  "may the force be with you",
  "to be or not to be",
  "practice makes perfect",
  "the early bird gets the worm",
  "actions speak louder than words",
  "houston we have a problem",
  "a picture is worth a thousand words",
  "when in rome do as the romans",
];

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}
async function sha256hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", enc.encode(normalize(s)));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Render a word with the pixel font → bit grid (1 = ink) and its pixel width.
function renderWord(word: string): { bits: Uint8Array; width: number } {
  const chars = word.toUpperCase().split("");
  const width = Math.max(1, chars.length * CHAR_W - 1);
  const bits = new Uint8Array(width * GH);
  chars.forEach((ch, ci) => {
    const g = FONT[ch] ?? FONT[" "]!;
    for (let gy = 0; gy < GLYPH_H; gy++) {
      const rowStr = g[gy] ?? "00000";
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (rowStr[gx] === "1") {
          const px = ci * CHAR_W + gx;
          const py = gy + VOFF;
          if (px < width && py < GH) bits[py * width + px] = 1;
        }
      }
    }
  });
  return { bits, width };
}

// ---------- roles ----------
function setRole(r: "beacon" | "player"): void {
  $("beaconCard").classList.toggle("hide", r !== "beacon");
  $("playerCard").classList.toggle("hide", r !== "player");
  $<HTMLButtonElement>("roleBeacon").classList.toggle("active", r === "beacon");
  $<HTMLButtonElement>("rolePlayer").classList.toggle("active", r === "player");
  if (r !== "beacon") stopBeacon();
  if (r !== "player") stopCam();
  document.body.classList.remove("playing", "casting", "result", "prescan");
}
$("roleBeacon").onclick = () => setRole("beacon");
$("rolePlayer").onclick = () => enterPlayerMode();

const puzzleSel = $<HTMLSelectElement>("puzzle");
const randOpt = document.createElement("option");
randOpt.value = "random";
randOpt.textContent = "🎲 Random (surprise me)";
puzzleSel.appendChild(randOpt);
PHRASES.forEach((_, i) => {
  const o = document.createElement("option");
  o.value = String(i);
  o.textContent = `Phrase ${i + 1}`;
  puzzleSel.appendChild(o);
});
puzzleSel.value = "random";

// Tiny deterministic RNG — twin beacons seeded alike must agree on decoys.
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function frameForPayload(s: string): Uint8Array {
  const payload = enc.encode(s);
  const sessionId = (Math.random() * 0x10000) | 0;
  const blockLen = Math.max(1, payload.length);
  const e = new LTEncoder(payload, blockLen, sessionId);
  const base: FrameHeader = { sessionId, seq: 0, k: e.k, blockLen, totalLen: payload.length, payloadFnv: fnv1a(payload) };
  return packFrame({ ...base, seq: 0 }, e.encode(0));
}

// ---------- BEACON ----------
const bb = $<HTMLCanvasElement>("bb");
const bbCtx = bb.getContext("2d")!;
const modC = document.createElement("canvas");
const modCtx = modC.getContext("2d")!;
let txTimer: number | null = null;

function renderFrame(frame: Uint8Array): void {
  const qr = QRCode.create([{ data: frame, mode: "byte" } as unknown as QRCode.QRCodeSegment], { errorCorrectionLevel: "L" });
  const raster = rasterizeQr(qr.modules.size, qr.modules.data, MARGIN_QR);
  const img = new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size);
  modC.width = raster.size;
  modC.height = raster.size;
  modCtx.putImageData(img, 0, 0);
  bbCtx.imageSmoothingEnabled = false;
  bbCtx.clearRect(0, 0, bb.width, bb.height);
  bbCtx.drawImage(modC, 0, 0, bb.width, bb.height);
}
const MARGIN_QR = 4;

async function startBeacon(forceIdx?: number): Promise<void> {
  bcnGen++;
  const idx =
    forceIdx !== undefined
      ? forceIdx % PHRASES.length
      : puzzleSel.value === "random"
        ? Math.floor(Math.random() * PHRASES.length)
        : Number(puzzleSel.value);
  const phrase = PHRASES[idx]!;
  const words = phrase.split(/\s+/);
  const hash = await sha256hex(phrase);
  const rendered = words.map((w) => renderWord(w));
  const widths = rendered.map((r) => r.width);
  // Round nonce: players compare it to their current round and hard-reset when
  // it changes, so "Beam another phrase" doesn't pile onto a stale board. It
  // must differ even when the random pick lands on the same phrase twice — but
  // in a seeded (party) round it must be the seed itself, so twin beacons
  // beaming the same phrase agree and don't reset each other's players.
  const round = forceIdx !== undefined ? forceIdx : Math.floor(Math.random() * 1e9);
  // Answer choices: the phrase + 3 decoys as indices into PHRASES, drawn from
  // an RNG seeded with the nonce so twin beacons offer the identical set in
  // the identical order.
  const rng = mulberry32(round);
  const choiceSet = new Set<number>([idx]);
  while (choiceSet.size < Math.min(4, PHRASES.length)) choiceSet.add(Math.floor(rng() * PHRASES.length));
  const choices = [...choiceSet];
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [choices[i], choices[j]] = [choices[j]!, choices[i]!];
  }
  const metaFrame = frameForPayload(`M|${words.length}|${GH}|${hash}|${widths.join(",")}|${round}|${choices.join(",")}`);
  const endFrame = frameForPayload(`E|done`);
  endFrameCache = endFrame;

  const rowFrames: Uint8Array[] = [];
  rendered.forEach(({ bits, width }, wi) => {
    for (let r = 0; r < GH; r++) {
      let s = "";
      for (let x = 0; x < width; x++) s += bits[r * width + x] ? "1" : "0";
      rowFrames.push(frameForPayload(`R|${wi}|${r}|${s}`));
    }
  });
  // Several passes, reshuffled each time. A player whose camera comes up a beat
  // after the broadcast starts still catches every row on a later pass, so the
  // board always completes — that's what makes the first round reliable.
  const playlist: Uint8Array[] = [];
  for (let pass = 0; pass < TX_PASSES; pass++) {
    for (let i = rowFrames.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rowFrames[i], rowFrames[j]] = [rowFrames[j]!, rowFrames[i]!];
    }
    for (const rf of rowFrames) for (let k = 0; k < ROW_REPEAT; k++) playlist.push(rf);
  }

  if (txTimer !== null) clearInterval(txTimer);
  let playIdx = 0;
  let tick = 0;
  txTimer = window.setInterval(() => {
    if (tick % META_EVERY === 0) {
      renderFrame(metaFrame);
      tick++;
      return;
    }
    if (playIdx >= playlist.length) {
      $("bcnStat").textContent = "Broadcast complete.";
      finishBroadcast();
      return;
    }
    renderFrame(playlist[playIdx]!);
    playIdx++;
    tick++;
    $("bcnStat").textContent = `Broadcasting… ${Math.round((playIdx / playlist.length) * 100)}%`;
  }, 1000 / TX_FPS);

  const b = $<HTMLButtonElement>("bcnBtn");
  b.textContent = "Stop";
  b.classList.add("stop");
  b.dataset.on = "1";
  document.body.classList.add("casting");
  void keepAwake();
}
function stopBeacon(): void {
  bcnGen++;
  if (txTimer !== null) clearInterval(txTimer);
  txTimer = null;
  document.body.classList.remove("casting");
  const b = $<HTMLButtonElement>("bcnBtn");
  b.textContent = "Start";
  b.classList.remove("stop");
  b.dataset.on = "";
}
const defaultBcnClick = () =>
  $<HTMLButtonElement>("bcnBtn").dataset.on ? stopBeacon() : void startBeacon();
$<HTMLButtonElement>("bcnBtn").onclick = defaultBcnClick;

// The broadcast finished — either all passes played, or (in a party) every
// player already locked in an answer so we cut it short. Offer the next round.
let endFrameCache: Uint8Array | null = null;
function finishBroadcast(): void {
  if (txTimer !== null) clearInterval(txTimer);
  txTimer = null;
  if (endFrameCache) renderFrame(endFrameCache);
  const b = $<HTMLButtonElement>("bcnBtn");
  b.classList.remove("stop");
  b.dataset.on = "";
  if (partyRoom) {
    b.textContent = "▶  Next round";
    b.onclick = () => {
      b.onclick = defaultBcnClick;
      startNextRound();
    };
  } else {
    b.textContent = "▶  Beam another phrase";
    b.onclick = () => {
      b.onclick = defaultBcnClick;
      void autoBeacon(); // countdown again so players can re-aim
    };
  }
}

// Big 3·2·1 on the beacon canvas so freshly-arrived players have time to aim.
function drawCountdown(n: number): void {
  bbCtx.fillStyle = "#ffffff";
  bbCtx.fillRect(0, 0, bb.width, bb.height);
  bbCtx.fillStyle = "#0b0d13";
  bbCtx.font = `900 ${Math.round(bb.height * 0.5)}px -apple-system, system-ui, sans-serif`;
  bbCtx.textAlign = "center";
  bbCtx.textBaseline = "middle";
  bbCtx.fillText(String(n), bb.width / 2, bb.height / 2 + bb.height * 0.03);
}

let bcnGen = 0; // bumped by any manual start/stop to cancel a pending countdown

// ---------- party coordination (realtime, party mode only) ----------
// The room channel is loaded lazily so solo players never download the
// realtime client. Beacons count how many players have answered (presence
// tells us how many players there are); when all are in, the broadcast ends
// early and the host is offered the next round.
let partyCh: { send: (a: unknown) => unknown } | null = null;
let partyReportAnswer: () => void = () => {};

function startNextRound(): void {
  const seed = Math.floor(Math.random() * 1e9);
  // Broadcast so every beacon (twins included) beams the same fresh phrase and
  // players reset in lockstep; with broadcast self:true we react to it too.
  if (partyCh) void partyCh.send({ type: "broadcast", event: "next", payload: { seed } });
  else void autoBeacon();
}

async function setupParty(): Promise<void> {
  if (!partyRoom) return;
  try {
    const [{ supabase }, { myId }] = await Promise.all([
      import("../shared/supabase"),
      import("../shared/profile"),
    ]);
    const id = myId();
    const isBeacon = partyRole === "beacon";
    const ch = supabase.channel(`room:${partyRoom}`, {
      config: { presence: { key: id }, broadcast: { self: true } },
    });
    partyCh = ch;
    const answeredIds = new Set<string>();
    let playerCount = 0;
    const check = (): void => {
      if (isBeacon && playerCount > 0 && answeredIds.size >= playerCount && txTimer !== null) {
        $("bcnStat").textContent = "Everyone answered 🎉";
        finishBroadcast();
      }
    };
    ch.on("presence", { event: "sync" }, () => {
      const st = ch.presenceState() as unknown as Record<string, { role?: string }[]>;
      playerCount = Object.values(st).flat().filter((m) => m.role === "player").length;
      check();
    });
    ch.on("broadcast", { event: "answered" }, ({ payload }) => {
      answeredIds.add((payload as { id: string }).id);
      check();
    });
    ch.on("broadcast", { event: "next" }, ({ payload }) => {
      answeredIds.clear();
      const seed = (payload as { seed: number }).seed;
      if (isBeacon) {
        void autoBeacon(seed);
      } else {
        $("stage").classList.add("hide");
        $("plStat").textContent = "✨ Next round starting…";
      }
    });
    ch.subscribe((s) => {
      if (s === "SUBSCRIBED") void ch.track({ role: partyRole });
    });
    partyReportAnswer = () => void ch.send({ type: "broadcast", event: "answered", payload: { id } });
  } catch {
    /* realtime unavailable — the round still plays, just no auto-advance */
  }
}

async function autoBeacon(seed?: number): Promise<void> {
  const gen = ++bcnGen;
  setRole("beacon");
  document.body.classList.add("casting");
  for (let n = 3; n > 0; n--) {
    drawCountdown(n);
    await new Promise((r) => setTimeout(r, 1000));
    if (gen !== bcnGen) return;
  }
  bcnGen++;
  void startBeacon(seed);
}

// ---------- PLAYER ----------
const video = $<HTMLVideoElement>("video");
const work = $<HTMLCanvasElement>("work");
const workCtx = work.getContext("2d", { willReadFrequently: true })!;
let stream: MediaStream | null = null;
let scanning = false;
let inFlight = false;
let lastScan = 0;
let solved = false;
let audio: AudioContext | null = null;

let wordCount = 0;
let widths: number[] = [];
let totalTiles = 0;
let answerHash: string | null = null;
let roundId: string | null = null;
let answered = false;
let answerIdx = -1; // index into PHRASES of the correct choice, once known
let known: Uint8Array[] = [];
let knownCount = 0;
const wordCanvas: HTMLCanvasElement[] = [];
const doneStreams = new Set<string>();
const decoders = new Map<string, LTDecoder>();
const pending: [number, number, string][] = [];
let elapsed = 0;
let countdown: number | null = null;

function tickFx(): void {
  if (audio && audio.state === "running") {
    const t = audio.currentTime;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g);
    g.connect(audio.destination);
    o.start(t);
    o.stop(t + 0.06);
  }
  navigator.vibrate?.(8);
  const d = $("dot");
  d.classList.add("hit");
  setTimeout(() => d.classList.remove("hit"), 80);
}

function buildWordCanvases(): void {
  const wrap = $("words");
  wrap.innerHTML = "";
  wordCanvas.length = 0;
  for (let w = 0; w < wordCount; w++) {
    const c = document.createElement("canvas");
    c.width = widths[w]!;
    c.height = GH;
    c.className = "wc";
    c.style.height = "40px";
    c.style.width = 40 * (widths[w]! / GH) + "px";
    wrap.appendChild(c);
    wordCanvas.push(c);
    drawWord(w);
  }
}
function drawWord(w: number): void {
  const c = wordCanvas[w];
  if (!c) return;
  const ctx = c.getContext("2d")!;
  const arr = known[w]!;
  const width = widths[w]!;
  // Pixel-fill look: the canvas keeps its dark background and only inked
  // pixels light up as they arrive, so the phrase glows into existence pixel
  // by pixel instead of gray row-blocks snapping in. Unknown and blank pixels
  // both stay dark (transparent → shows the .wc background).
  ctx.clearRect(0, 0, width, GH);
  ctx.fillStyle = "#eaf6f0";
  for (let i = 0; i < width * GH; i++) {
    if (arr[i] === 1) ctx.fillRect(i % width, Math.floor(i / width), 1, 1);
  }
}
function setRow(w: number, r: number, bitsStr: string): void {
  if (w < 0 || w >= wordCount || r < 0 || r >= GH) return;
  const arr = known[w]!;
  const width = widths[w]!;
  let added = 0;
  for (let x = 0; x < width && x < bitsStr.length; x++) {
    const i = r * width + x;
    if (arr[i] === 2) {
      arr[i] = bitsStr.charCodeAt(x) === 49 ? 1 : 0;
      added++;
    }
  }
  if (added === 0) return;
  knownCount += added;
  drawWord(w);
  $("count").textContent = `${totalTiles ? Math.round((knownCount / totalTiles) * 100) : 0}% revealed`;
  tickFx();
}

function fmtTime(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function startTimer(): void {
  elapsed = 0;
  $("timer").textContent = fmtTime(elapsed);
  if (countdown !== null) clearInterval(countdown);
  countdown = window.setInterval(() => {
    elapsed++;
    $("timer").textContent = fmtTime(elapsed);
  }, 1000);
}
function endRound(): void {
  if (countdown !== null) clearInterval(countdown);
  countdown = null;
  scanning = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  const b = $<HTMLButtonElement>("camBtn");
  b.textContent = "Start scanning";
  b.classList.remove("stop");
  b.dataset.on = "";
}

// Drop the player straight onto a single-tap "aim at the beacon" screen —
// no role card, no second button. The one remaining tap is unavoidable: a
// browser will not open the camera without a user gesture.
function enterPlayerMode(): void {
  setRole("player");
  document.body.classList.add("prescan");
  const b = $<HTMLButtonElement>("camBtn");
  b.textContent = "▶  Aim at the beacon";
  b.classList.remove("hide");
}

async function startCam(): Promise<void> {
  try {
    if (!audio) audio = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    void audio.resume();
  } catch { /* ignore */ }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
    await video.play();
    scanning = true;
    document.body.classList.remove("prescan");
    document.body.classList.add("playing");
    document.body.classList.remove("result");
    $<HTMLButtonElement>("camBtn").textContent = "Stop scanning";
    $<HTMLButtonElement>("camBtn").classList.add("stop");
    $<HTMLButtonElement>("camBtn").dataset.on = "1";
    $("answerWrap").classList.remove("hide");
    $("plStat").textContent = "Aim at the beacon — read the phrase as it fills in!";
    if (wordCount === 0) $("words").textContent = "Locking onto the beacon…";
    startTimer();
    requestAnimationFrame(scan);
  } catch (e) {
    $("plStat").textContent = "Camera error: " + (e as Error).message;
  }
}
function stopCam(): void {
  scanning = false;
  document.body.classList.remove("playing");
  if (countdown !== null) clearInterval(countdown);
  countdown = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  const b = $<HTMLButtonElement>("camBtn");
  b.textContent = "Start scanning";
  b.classList.remove("stop");
  b.dataset.on = "";
}
$<HTMLButtonElement>("camBtn").onclick = () => ($<HTMLButtonElement>("camBtn").dataset.on ? stopCam() : void startCam());

function scan(ts: number): void {
  if (!scanning) return;
  if (video.videoWidth > 0 && !inFlight && ts - lastScan > SCAN_MS) {
    lastScan = ts;
    inFlight = true;
    work.width = video.videoWidth;
    work.height = video.videoHeight;
    workCtx.drawImage(video, 0, 0, work.width, work.height);
    const img = workCtx.getImageData(0, 0, work.width, work.height);
    readBarcodes(img, { formats: ["QRCode"], maxNumberOfSymbols: 1 })
      .then((res) => {
        const r = res.find((x) => x.isValid && x.bytes.length > 0);
        if (r) onFrame(new Uint8Array(r.bytes));
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  }
  requestAnimationFrame(scan);
}

function onFrame(bytes: Uint8Array): void {
  const parsed = parseFrame(bytes);
  if (!parsed) return;
  const { header, block } = parsed;
  const id = streamIdentity(header);
  if (doneStreams.has(id)) return;
  let d = decoders.get(id);
  if (!d) {
    d = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    decoders.set(id, d);
  }
  d.addFrame(header.seq, block);
  if (!d.isComplete) return;
  doneStreams.add(id);
  decoders.delete(id);
  const payload = d.assemble();
  if (!payload || fnv1a(payload) !== header.payloadFnv) return;
  handleFragment(dec.decode(payload));
}

function handleFragment(str: string): void {
  const p = str.split("|");
  if (p[0] === "E") {
    if (!solved && !answered) $("plStat").textContent = "Broadcast complete — lock in your answer!";
    return;
  }
  if (p[0] === "M") {
    const wc = Number(p[1]);
    if (Number.isNaN(wc)) return;
    const rid = p[5] ?? "";
    if (answerHash) {
      // Same round's meta repeating — nothing to do. A different nonce means
      // the beacon moved on to a fresh phrase: wipe the stale board mid-scan
      // and adopt the new round without making the player touch anything.
      if (rid === roundId) return;
      resetGame();
      $("plStat").textContent = "✨ New phrase incoming…";
    }
    roundId = rid;
    wordCount = wc;
    answerHash = p[3]!;
    widths = (p[4] ?? "").split(",").map(Number);
    totalTiles = widths.reduce((a, b) => a + b * GH, 0);
    known = widths.map((wd) => new Uint8Array(wd * GH).fill(2));
    knownCount = 0;
    buildWordCanvases();
    void renderOptions((p[6] ?? "").split(",").map(Number).filter((n) => !Number.isNaN(n)));
    for (const [w, r, s] of pending) setRow(w, r, s);
    pending.length = 0;
    return;
  }
  if (p[0] === "R") {
    const w = Number(p[1]);
    const r = Number(p[2]);
    const s = p[3] ?? "";
    if (Number.isNaN(w) || Number.isNaN(r)) return;
    if (!answerHash) {
      pending.push([w, r, s]);
      return;
    }
    setRow(w, r, s);
  }
}

// Jackbox-style answers: four choices, one lock-in. Guess earlier = more
// points; a wrong lock ends your round and glows the real answer.
async function renderOptions(idxs: number[]): Promise<void> {
  const wrap = $("opts");
  wrap.innerHTML = "";
  answered = false;
  answerIdx = -1;
  for (const ci of idxs) {
    if ((await sha256hex(PHRASES[ci] ?? "")) === answerHash) answerIdx = ci;
  }
  for (const ci of idxs) {
    const b = document.createElement("button");
    b.className = "opt";
    b.textContent = PHRASES[ci] ?? "?";
    b.onclick = () => lockIn(ci, b);
    wrap.appendChild(b);
  }
}

function lockIn(ci: number, btn: HTMLButtonElement): void {
  if (answered || solved || !answerHash) return;
  answered = true;
  const buttons = [...$("opts").querySelectorAll("button")];
  for (const b of buttons) b.disabled = true;
  if (partyRoom) partyReportAnswer();
  if (ci === answerIdx) {
    btn.classList.add("correct");
    solved = true;
    const frac = totalTiles ? knownCount / totalTiles : 1;
    const score = Math.max(50, Math.round((1 - frac) * 1000));
    // Party: keep the camera running so the next round's broadcast flows in and
    // auto-resets this player. Solo: stop the camera as before.
    if (partyRoom) {
      if (countdown !== null) clearInterval(countdown);
      countdown = null;
    } else {
      endRound();
    }
    showWinStage(score, frac);
  } else {
    btn.classList.add("wrong");
    for (const b of buttons) {
      if (b.textContent === (PHRASES[answerIdx] ?? "")) b.classList.add("correct");
    }
    $("result").innerHTML = `<span class="lose">Locked in — not it 😬</span>`;
    if (partyRoom) $("plStat").textContent = "Locked in — waiting for the next round…";
  }
}

// ---------- win stage: the loud moment ----------
let stageScoreValue = 0;

function countUp(el: HTMLElement, to: number, ms = 1100): void {
  const t0 = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / ms);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(to * eased).toLocaleString();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function launchConfetti(): void {
  const cv = $<HTMLCanvasElement>("confetti");
  const dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = cv.clientWidth * dpr;
  cv.height = cv.clientHeight * dpr;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const colors = ["#37e0b0", "#ffb84d", "#ff5c8a", "#4f8cff", "#9b7bff", "#ffffff"];
  const parts = Array.from({ length: 130 }, () => ({
    x: cv.width * (0.5 + (Math.random() - 0.5) * 0.35),
    y: cv.height * 0.38,
    vx: (Math.random() - 0.5) * 16 * dpr,
    vy: (-10 - Math.random() * 14) * dpr,
    w: (4 + Math.random() * 5) * dpr,
    h: (7 + Math.random() * 7) * dpr,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    c: colors[(Math.random() * colors.length) | 0]!,
  }));
  const g = 0.55 * dpr;
  let frames = 0;
  const tick = () => {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of parts) {
      p.vy += g;
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.985;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.globalAlpha = Math.max(0, 1 - frames / 170);
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    frames++;
    if (frames < 175) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, cv.width, cv.height);
  };
  requestAnimationFrame(tick);
}

async function postRun(score: number): Promise<void> {
  $("stageBoard").textContent = "Posting to the board…";
  const { ok, rank } = await submitRun("sentence", score);
  $("stageBoard").textContent = ok
    ? rank
      ? `🏆 On the board — #${rank} run worldwide`
      : "🏆 On the board"
    : "Saved on this device — the board is offline right now.";
}

function showWinStage(score: number, frac: number): void {
  stageScoreValue = score;
  $("stage").classList.remove("hide");
  $("stageSub").textContent = `guessed at just ${Math.round(frac * 100)}% revealed`;
  $("stageBoard").textContent = "";
  countUp($("stageScore"), score);
  requestAnimationFrame(launchConfetti);
  const best = recordRun("sentence", score);
  $("stageBest").classList.toggle("hide", !best);
  if (partyRoom) {
    const total = addScore(partyRoom, score);
    $("stageBoard").textContent = `+${score} pts → room total ${total.toLocaleString()}`;
    $("stageNew").textContent = "‹ Back to lobby";
  } else if (myName()) {
    void postRun(score);
  } else {
    $("claimWrap").classList.remove("hide");
  }
}

$<HTMLButtonElement>("claimBtn").onclick = () => {
  const n = $<HTMLInputElement>("claimName").value.trim();
  if (!n) return;
  setName(n);
  $("claimWrap").classList.add("hide");
  void postRun(stageScoreValue);
};
$<HTMLInputElement>("claimName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $<HTMLButtonElement>("claimBtn").click();
});

$<HTMLButtonElement>("stageNew").onclick = () => {
  if (partyRoom) {
    location.href = `../party/?room=${partyRoom}`;
  } else {
    $("stage").classList.add("hide");
    resetGame();
  }
};

function resetGame(): void {
  doneStreams.clear();
  decoders.clear();
  pending.length = 0;
  solved = false;
  answerHash = null;
  wordCount = 0;
  widths = [];
  totalTiles = 0;
  known = [];
  knownCount = 0;
  wordCanvas.length = 0;
  if (countdown !== null) clearInterval(countdown);
  countdown = null;
  elapsed = 0;
  $("timer").textContent = fmtTime(elapsed);
  $("count").textContent = "0% revealed";
  $("result").innerHTML = "";
  $("stage").classList.add("hide");
  answered = false;
  answerIdx = -1;
  $("opts").innerHTML = `<div class="optsHint">Answers appear once you lock onto the beacon…</div>`;
  $("words").textContent = scanning ? "Locking onto the beacon…" : "Start scanning and aim at the beacon.";
  $("answerWrap").classList.toggle("hide", !scanning);
  $("plStat").textContent = "";
  document.body.classList.remove("result");
  if (!scanning) document.body.classList.remove("playing");
  if (scanning) startTimer();
}
$<HTMLButtonElement>("newBtn").onclick = resetGame;

async function keepAwake(): Promise<void> {
  try {
    await (navigator as unknown as { wakeLock?: { request(t: string): Promise<unknown> } }).wakeLock?.request("screen");
  } catch { /* ignore */ }
}

// ---- party mode: launched from the lobby ----
if (partyRoom) {
  const backToLobby = () => {
    location.href = `../party/?room=${partyRoom}`;
  };
  const brand = document.querySelector(".brand") as HTMLAnchorElement | null;
  if (brand) {
    brand.href = `../party/?room=${partyRoom}`;
    const back = brand.querySelector(".back");
    if (back) back.textContent = "‹ lobby";
  }
  const nb = $<HTMLButtonElement>("newBtn");
  nb.textContent = "‹ Back to lobby";
  nb.onclick = backToLobby;
  void setupParty();
  if (partyRole === "beacon") {
    // Seed comes from the lobby so multiple beacons beam the SAME phrase.
    const seed = Number(partyParams.get("seed"));
    void autoBeacon(Number.isFinite(seed) ? seed : undefined);
  } else if (partyRole === "player") {
    enterPlayerMode();
  }
} else {
  // Walk-up solo: a big hover/fine-pointer screen is the stage, a phone is the
  // player. Auto-pick so the site "just starts" — Stop backs out of the
  // auto-beacon to the role picker for the odd desktop-with-a-camera setup.
  const desktopish = matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (desktopish) {
    void autoBeacon();
  } else {
    enterPlayerMode();
  }
}
