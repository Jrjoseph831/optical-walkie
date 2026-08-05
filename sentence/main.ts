// Guess the Phrase — word-picture reveal mode.
//
// BEACON: renders each word as a black-on-white image, tiles it, and reveals the
// phrase ONE WORD-PICTURE AT A TIME — broadcasting the current word's tiles for a
// window, then moving to the next word; after the last word it loops and repeats
// until stopped. (Plus a meta fragment with word count, tile grid, answer hash.)
//
// PLAYER: hidden camera; caught tiles fill in each word-picture (unrevealed tiles
// stay gray). You grab as much of each word as you can before the beacon moves on,
// read the half-formed pixels, and guess the phrase (verified on-device). Fewer
// pixels needed + more time left = more points.
import QRCode from "qrcode";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { LTEncoder, LTDecoder } from "../shared/fountain";
import { packFrame, parseFrame, streamIdentity, fnv1a, type FrameHeader } from "../shared/protocol";
import { rasterizeQr } from "../shared/qr-raster";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path),
  },
});

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const MARGIN = 4;
const TX_FPS = 16;
const SCAN_MS = 70;
const META_EVERY = 12;
const ROW_REPEAT = 7; // frames each row lingers so a camera can catch it (no loop)
const GW = 30; // tiles wide per word
const GH = 9; // tiles tall per word (one full row is sent per frame)

const enc = new TextEncoder();
const dec = new TextDecoder();

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

// Render a word as black-on-white and downsample to a GW×GH bit grid (1 = ink).
function wordToTiles(word: string): Uint8Array {
  const scale = 10;
  const c = document.createElement("canvas");
  c.width = GW * scale;
  c.height = GH * scale;
  const cx = c.getContext("2d")!;
  cx.fillStyle = "#ffffff";
  cx.fillRect(0, 0, c.width, c.height);
  cx.fillStyle = "#000000";
  cx.textAlign = "center";
  cx.textBaseline = "middle";
  let fs = GH * scale * 0.95;
  cx.font = `bold ${fs}px Arial, sans-serif`;
  while (cx.measureText(word).width > c.width * 0.94 && fs > 6) {
    fs -= 2;
    cx.font = `bold ${fs}px Arial, sans-serif`;
  }
  cx.fillText(word, c.width / 2, c.height / 2 + scale * 0.5);
  const small = document.createElement("canvas");
  small.width = GW;
  small.height = GH;
  const sx = small.getContext("2d")!;
  sx.imageSmoothingEnabled = true;
  sx.drawImage(c, 0, 0, GW, GH);
  const d = sx.getImageData(0, 0, GW, GH).data;
  const bits = new Uint8Array(GW * GH);
  for (let i = 0; i < GW * GH; i++) bits[i] = d[i * 4]! < 128 ? 1 : 0;
  return bits;
}

// ---------- roles ----------
function setRole(r: "beacon" | "player"): void {
  $("beaconCard").classList.toggle("hide", r !== "beacon");
  $("playerCard").classList.toggle("hide", r !== "player");
  $<HTMLButtonElement>("roleBeacon").classList.toggle("active", r === "beacon");
  $<HTMLButtonElement>("rolePlayer").classList.toggle("active", r === "player");
  if (r !== "beacon") stopBeacon();
  if (r !== "player") stopCam();
}
$("roleBeacon").onclick = () => setRole("beacon");
$("rolePlayer").onclick = () => setRole("player");

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
let windowTimer: number | null = null;

function renderFrame(frame: Uint8Array): void {
  const qr = QRCode.create([{ data: frame, mode: "byte" } as unknown as QRCode.QRCodeSegment], { errorCorrectionLevel: "L" });
  const raster = rasterizeQr(qr.modules.size, qr.modules.data, MARGIN);
  const img = new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size);
  modC.width = raster.size;
  modC.height = raster.size;
  modCtx.putImageData(img, 0, 0);
  bbCtx.imageSmoothingEnabled = false;
  bbCtx.clearRect(0, 0, bb.width, bb.height);
  bbCtx.drawImage(modC, 0, 0, bb.width, bb.height);
}

async function startBeacon(): Promise<void> {
  const idx = puzzleSel.value === "random" ? Math.floor(Math.random() * PHRASES.length) : Number(puzzleSel.value);
  const phrase = PHRASES[idx]!;
  const words = phrase.split(/\s+/);
  const hash = await sha256hex(phrase);
  const metaFrame = frameForPayload(`M|${words.length}|${GW}|${GH}|${hash}`);
  const endFrame = frameForPayload(`E|done`);
  const rowFrames: Uint8Array[] = [];
  words.forEach((w, wi) => {
    const bits = wordToTiles(w);
    for (let r = 0; r < GH; r++) {
      let s = "";
      for (let x = 0; x < GW; x++) s += bits[r * GW + x] ? "1" : "0";
      rowFrames.push(frameForPayload(`R|${wi}|${r}|${s}`));
    }
  });
  // Shuffle so the whole sentence fills in scattered — a little here, a little
  // there — instead of word by word.
  for (let i = rowFrames.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rowFrames[i], rowFrames[j]] = [rowFrames[j]!, rowFrames[i]!];
  }
  // One long, non-looping playlist. Each row lingers a few frames so a camera
  // can catch it; when the playlist is exhausted the broadcast stops.
  const playlist: Uint8Array[] = [];
  for (const rf of rowFrames) for (let k = 0; k < ROW_REPEAT; k++) playlist.push(rf);

  if (txTimer !== null) clearInterval(txTimer);
  let idx = 0;
  let tick = 0;
  txTimer = window.setInterval(() => {
    if (tick % META_EVERY === 0) {
      renderFrame(metaFrame); // keep grid + hash available throughout
      tick++;
      return;
    }
    if (idx >= playlist.length) {
      renderFrame(endFrame);
      $("bcnStat").textContent = "Broadcast complete.";
      if (txTimer !== null) clearInterval(txTimer);
      txTimer = null;
      return;
    }
    renderFrame(playlist[idx]!);
    idx++;
    tick++;
    $("bcnStat").textContent = `Broadcasting… ${Math.round((idx / playlist.length) * 100)}%`;
  }, 1000 / TX_FPS);

  const b = $<HTMLButtonElement>("bcnBtn");
  b.textContent = "Stop";
  b.classList.add("stop");
  b.dataset.on = "1";
  void keepAwake();
}
function stopBeacon(): void {
  if (txTimer !== null) clearInterval(txTimer);
  if (windowTimer !== null) clearInterval(windowTimer);
  txTimer = windowTimer = null;
  const b = $<HTMLButtonElement>("bcnBtn");
  b.textContent = "Start broadcasting";
  b.classList.remove("stop");
  b.dataset.on = "";
}
$<HTMLButtonElement>("bcnBtn").onclick = () => ($<HTMLButtonElement>("bcnBtn").dataset.on ? stopBeacon() : void startBeacon());

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
let answerHash: string | null = null;
let known: Uint8Array[] = []; // per word: 0=white,1=black,2=unknown
let knownCount = 0;
const wordCanvas: HTMLCanvasElement[] = [];
const doneStreams = new Set<string>();
const decoders = new Map<string, LTDecoder>();
const pending: [number, number, string][] = []; // rows seen before meta
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
    c.width = GW;
    c.height = GH;
    c.className = "wc";
    c.style.height = "44px";
    c.style.width = 44 * (GW / GH) + "px";
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
  for (let i = 0; i < GW * GH; i++) {
    const v = arr[i]!;
    ctx.fillStyle = v === 2 ? "#2a2a2d" : v === 1 ? "#000000" : "#ffffff";
    ctx.fillRect(i % GW, Math.floor(i / GW), 1, 1);
  }
}
function setRow(w: number, r: number, bitsStr: string): void {
  if (w < 0 || w >= wordCount || r < 0 || r >= GH) return;
  const arr = known[w]!;
  let added = 0;
  for (let x = 0; x < GW && x < bitsStr.length; x++) {
    const i = r * GW + x;
    if (arr[i] === 2) {
      arr[i] = bitsStr.charCodeAt(x) === 49 ? 1 : 0; // '1'
      added++;
    }
  }
  if (added === 0) return;
  knownCount += added;
  drawWord(w);
  for (const [wi, el] of wordCanvas.entries()) el.classList.toggle("now", wi === w);
  const total = wordCount * GW * GH;
  $("count").textContent = `${Math.round((knownCount / total) * 100)}% revealed`;
  tickFx();
}

function fmtTime(s: number): string {
  return `0:${String(Math.max(0, s)).padStart(2, "0")}`;
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
    $<HTMLButtonElement>("camBtn").textContent = "Stop scanning";
    $<HTMLButtonElement>("camBtn").classList.add("stop");
    $<HTMLButtonElement>("camBtn").dataset.on = "1";
    $("answerWrap").classList.remove("hide");
    $("plStat").textContent = "Aim at the beacon — grab each word before it moves on!";
    if (wordCount === 0) $("words").textContent = "Locking onto the beacon…";
    startTimer();
    requestAnimationFrame(scan);
  } catch (e) {
    $("plStat").textContent = "Camera error: " + (e as Error).message;
  }
}
function stopCam(): void {
  scanning = false;
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
    if (!solved) $("plStat").textContent = "Broadcast complete — lock in your guess.";
    return;
  }
  if (p[0] === "M") {
    const wc = Number(p[1]);
    if (!answerHash && !Number.isNaN(wc)) {
      wordCount = wc;
      answerHash = p[4]!;
      known = Array.from({ length: wordCount }, () => new Uint8Array(GW * GH).fill(2));
      knownCount = 0;
      buildWordCanvases();
      for (const [w, r, s] of pending) setRow(w, r, s);
      pending.length = 0;
    }
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

$<HTMLButtonElement>("guessBtn").onclick = async () => {
  if (solved) return;
  if (!answerHash) {
    $("plStat").textContent = "Keep aiming — still locking onto the beacon…";
    return;
  }
  const guess = $<HTMLInputElement>("guess").value;
  if (!guess.trim()) return;
  const h = await sha256hex(guess);
  if (h === answerHash) {
    solved = true;
    const total = wordCount * GW * GH;
    const frac = total ? knownCount / total : 1;
    const score = Math.max(50, Math.round((1 - frac) * 1000));
    $("result").innerHTML = `<span class="win">🎉 Correct! Guessed at ${Math.round(frac * 100)}% revealed → ${score} pts</span>`;
    $("answerWrap").classList.add("hide");
    endRound();
  } else {
    $("result").innerHTML = `<span class="lose">❌ Not quite — try again</span>`;
  }
};

function resetGame(): void {
  doneStreams.clear();
  decoders.clear();
  pending.length = 0;
  solved = false;
  answerHash = null;
  wordCount = 0;
  known = [];
  knownCount = 0;
  wordCanvas.length = 0;
  if (countdown !== null) clearInterval(countdown);
  countdown = null;
  elapsed = 0;
  $("timer").textContent = fmtTime(elapsed);
  $("timer").classList.remove("low");
  $("count").textContent = "0% revealed";
  $("result").innerHTML = "";
  $<HTMLInputElement>("guess").value = "";
  $("words").textContent = scanning ? "Locking onto the beacon…" : "Start scanning and aim at the beacon.";
  $("answerWrap").classList.toggle("hide", !scanning);
  $("plStat").textContent = "";
  if (scanning) startTimer();
}
$<HTMLButtonElement>("newBtn").onclick = resetGame;

async function keepAwake(): Promise<void> {
  try {
    await (navigator as unknown as { wakeLock?: { request(t: string): Promise<unknown> } }).wakeLock?.request("screen");
  } catch { /* ignore */ }
}
