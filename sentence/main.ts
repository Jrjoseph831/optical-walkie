// Guess the Phrase — single-beacon "sentence" mode.
//
// BEACON: scatters a phrase word by word — each word is a tiny fountain-QR
// fragment, cycling (plus a meta fragment with word count + answer hash).
// PLAYER: hidden camera; caught words drop into their positions, the rest stay
// blank. A countdown enforces incompleteness — catch what you can, then guess
// the whole phrase (verified on-device). Fewer words needed = more points.
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
const TX_FPS = 12;
const SCAN_MS = 70;
const META_EVERY = 12;
const ROUND_SECONDS = 20;

const enc = new TextEncoder();
const dec = new TextDecoder();

const PHRASES: string[] = [
  "the quick brown fox jumps over the lazy dog",
  "may the force be with you",
  "to be or not to be that is the question",
  "a picture is worth a thousand words",
  "the early bird catches the worm",
  "actions speak louder than words",
  "when in rome do as the romans do",
  "houston we have a problem",
  "with great power comes great responsibility",
  "an apple a day keeps the doctor away",
];

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}
async function sha256hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", enc.encode(normalize(s)));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
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

// ---------- shared QR frame builder ----------
function frameForPayload(s: string): Uint8Array {
  const payload = enc.encode(s);
  const sessionId = (Math.random() * 0x10000) | 0;
  const blockLen = Math.max(1, payload.length); // one block → always k=1
  const e = new LTEncoder(payload, blockLen, sessionId);
  const base: FrameHeader = {
    sessionId,
    seq: 0,
    k: e.k,
    blockLen,
    totalLen: payload.length,
    payloadFnv: fnv1a(payload),
  };
  return packFrame({ ...base, seq: 0 }, e.encode(0));
}

// ---------- BEACON ----------
const bb = $<HTMLCanvasElement>("bb");
const bbCtx = bb.getContext("2d")!;
const modC = document.createElement("canvas");
const modCtx = modC.getContext("2d")!;
let txTimer: number | null = null;

function renderFrame(frame: Uint8Array): void {
  const qr = QRCode.create([{ data: frame, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
    errorCorrectionLevel: "L",
  });
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
  const metaFrame = frameForPayload(`M|${words.length}|${hash}`);
  const wordFrames = words.map((w, i) => frameForPayload(`W|${i}|${w}`));

  if (txTimer !== null) clearInterval(txTimer);
  let wi = 0;
  let tick = 0;
  txTimer = window.setInterval(() => {
    if (tick % META_EVERY === 0) {
      renderFrame(metaFrame);
    } else {
      renderFrame(wordFrames[wi]!);
      wi = (wi + 1) % wordFrames.length;
    }
    tick++;
  }, 1000 / TX_FPS);

  $("bcnStat").textContent = `Broadcasting a ${words.length}-word phrase — looping`;
  const b = $<HTMLButtonElement>("bcnBtn");
  b.textContent = "Stop";
  b.classList.add("stop");
  b.dataset.on = "1";
  void keepAwake();
}
function stopBeacon(): void {
  if (txTimer !== null) clearInterval(txTimer);
  txTimer = null;
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
let ended = false;
let audio: AudioContext | null = null;

let wordCount = 0;
let answerHash: string | null = null;
const caught = new Map<number, string>();
const doneStreams = new Set<string>();
const decoders = new Map<string, LTDecoder>();
let timeLeft = ROUND_SECONDS;
let countdown: number | null = null;

function tickFx(): void {
  if (audio && audio.state === "running") {
    const t = audio.currentTime;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g);
    g.connect(audio.destination);
    o.start(t);
    o.stop(t + 0.06);
  }
  navigator.vibrate?.(12);
  const d = $("dot");
  d.classList.add("hit");
  setTimeout(() => d.classList.remove("hit"), 90);
}

function renderWords(): void {
  const wrap = $("words");
  if (wordCount === 0) {
    wrap.textContent = "Locking onto the beacon…";
    return;
  }
  wrap.innerHTML = "";
  for (let i = 0; i < wordCount; i++) {
    const span = document.createElement("span");
    if (caught.has(i)) {
      span.className = "w";
      span.textContent = caught.get(i)! + " ";
    } else {
      span.className = "blank";
      span.textContent = "____ ";
    }
    wrap.appendChild(span);
  }
  $("count").textContent = `${caught.size} / ${wordCount} words`;
}

function fmtTime(s: number): string {
  return `0:${String(Math.max(0, s)).padStart(2, "0")}`;
}
function startTimer(): void {
  timeLeft = ROUND_SECONDS;
  $("timer").textContent = fmtTime(timeLeft);
  if (countdown !== null) clearInterval(countdown);
  countdown = window.setInterval(() => {
    timeLeft--;
    $("timer").textContent = fmtTime(timeLeft);
    $("timer").classList.toggle("low", timeLeft <= 5);
    if (timeLeft <= 0) endRound();
  }, 1000);
}
function endRound(): void {
  ended = true;
  if (countdown !== null) clearInterval(countdown);
  countdown = null;
  scanning = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  const b = $<HTMLButtonElement>("camBtn");
  b.textContent = "Start scanning";
  b.classList.remove("stop");
  b.dataset.on = "";
  if (!solved) $("plStat").textContent = "Time! Lock in your best guess.";
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
    ended = false;
    $<HTMLButtonElement>("camBtn").textContent = "Stop scanning";
    $<HTMLButtonElement>("camBtn").classList.add("stop");
    $<HTMLButtonElement>("camBtn").dataset.on = "1";
    $("answerWrap").classList.remove("hide");
    $("plStat").textContent = "Aim at the beacon — catch words fast!";
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
  if (p[0] === "M") {
    const wc = Number(p[1]);
    if (!answerHash && !Number.isNaN(wc)) {
      wordCount = wc;
      answerHash = p[2]!;
      renderWords();
    }
    return;
  }
  if (p[0] === "W") {
    const idx = Number(p[1]);
    if (Number.isNaN(idx) || caught.has(idx)) return;
    caught.set(idx, p.slice(2).join("|"));
    renderWords();
    tickFx();
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
    const frac = wordCount ? caught.size / wordCount : 1;
    const score = Math.max(50, Math.round((1 - frac) * 800 + timeLeft * 10));
    $("result").innerHTML = `<span class="win">🎉 Correct! Guessed with ${caught.size}/${wordCount} words, ${timeLeft}s left → ${score} pts</span>`;
    $("answerWrap").classList.add("hide");
    endRound();
  } else {
    $("result").innerHTML = `<span class="lose">❌ Not quite — try again</span>`;
  }
};

function resetGame(): void {
  caught.clear();
  doneStreams.clear();
  decoders.clear();
  solved = false;
  ended = false;
  answerHash = null;
  wordCount = 0;
  if (countdown !== null) clearInterval(countdown);
  countdown = null;
  timeLeft = ROUND_SECONDS;
  $("timer").textContent = fmtTime(timeLeft);
  $("timer").classList.remove("low");
  $("count").textContent = "0 / ? words";
  $("result").innerHTML = "";
  $<HTMLInputElement>("guess").value = "";
  $("words").textContent = "Start scanning and aim at the beacon.";
  $("answerWrap").classList.toggle("hide", !scanning);
  $("plStat").textContent = "";
}
$<HTMLButtonElement>("newBtn").onclick = resetGame;

async function keepAwake(): Promise<void> {
  try {
    await (navigator as unknown as { wakeLock?: { request(t: string): Promise<unknown> } }).wakeLock?.request("screen");
  } catch { /* ignore */ }
}
