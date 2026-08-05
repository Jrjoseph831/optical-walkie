// Fragments — reveal-the-mystery, single-beacon optical game.
//
// BEACON: takes an image, downsamples it to a GRID×GRID mosaic, and rapidly
// broadcasts each tile (plus a meta fragment carrying grid size + answer hash)
// as tiny fountain-QR streams (DECIMEN codec), cycling forever.
//
// PLAYER: camera is HIDDEN — the app grabs frames only to decode. Each decoded
// tile fills in the mystery image, with a haptic tick. The picture sharpens as
// you keep the beacon in frame; guess anytime (verified on-device via the hash).
// Fewer tiles revealed at the moment you solve = more points.
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
const BLOCK_LEN = 64;
const MARGIN = 4;
const TX_FPS = 12;
const SCAN_MS = 70;
const GRID = 16; // 256 tiles
const META_EVERY = 14; // inject the meta fragment roughly every N frames

const enc = new TextEncoder();
const dec = new TextDecoder();

const IMAGES: { emoji: string; answer: string; label: string }[] = [
  { emoji: "🐘", answer: "elephant", label: "Mystery A" },
  { emoji: "🍕", answer: "pizza", label: "Mystery B" },
  { emoji: "🐧", answer: "penguin", label: "Mystery C" },
  { emoji: "🚀", answer: "rocket", label: "Mystery D" },
  { emoji: "🦈", answer: "shark", label: "Mystery E" },
  { emoji: "🍔", answer: "burger", label: "Mystery F" },
];

async function sha256hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", enc.encode(s.trim().toLowerCase()));
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
IMAGES.forEach((p, i) => {
  const o = document.createElement("option");
  o.value = String(i);
  o.textContent = `${p.label} ${p.emoji}`;
  puzzleSel.appendChild(o);
});
puzzleSel.value = "random";

// ---------- BEACON ----------
const bb = $<HTMLCanvasElement>("bb");
const bbCtx = bb.getContext("2d")!;
const modC = document.createElement("canvas");
const modCtx = modC.getContext("2d")!;
let txTimer: number | null = null;

// Render an emoji big, then downsample to GRID×GRID → array of [r,g,b].
function imageToTiles(emoji: string): number[][] {
  const c = document.createElement("canvas");
  c.width = c.height = 220;
  const cx = c.getContext("2d")!;
  cx.fillStyle = "#ffffff";
  cx.fillRect(0, 0, 220, 220);
  cx.font = "170px serif";
  cx.textAlign = "center";
  cx.textBaseline = "middle";
  cx.fillText(emoji, 110, 120);
  const small = document.createElement("canvas");
  small.width = small.height = GRID;
  const sx = small.getContext("2d")!;
  sx.imageSmoothingEnabled = true;
  sx.drawImage(c, 0, 0, GRID, GRID);
  const data = sx.getImageData(0, 0, GRID, GRID).data;
  const tiles: number[][] = [];
  for (let i = 0; i < GRID * GRID; i++) {
    tiles.push([data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!]);
  }
  return tiles;
}

function frameForPayload(s: string): Uint8Array {
  const payload = enc.encode(s);
  const sessionId = (Math.random() * 0x10000) | 0;
  // One block per fragment → always k=1 → decodes from a single frame. (Meta
  // used to exceed BLOCK_LEN and need 2 frames, which the beacon never sent.)
  const blockLen = Math.max(1, payload.length);
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
  const idx = puzzleSel.value === "random" ? Math.floor(Math.random() * IMAGES.length) : Number(puzzleSel.value);
  const pick = IMAGES[idx]!;
  const hash = await sha256hex(pick.answer);
  const tiles = imageToTiles(pick.emoji);
  const metaFrame = frameForPayload(`M|${GRID}|${GRID}|${hash}`);
  const tileFrames = tiles.map((t, i) => frameForPayload(`T|${i}|${t[0]}|${t[1]}|${t[2]}`));

  if (txTimer !== null) clearInterval(txTimer);
  let ti = 0;
  let tick = 0;
  txTimer = window.setInterval(() => {
    if (tick % META_EVERY === 0) {
      renderFrame(metaFrame);
    } else {
      renderFrame(tileFrames[ti]!);
      ti = (ti + 1) % tileFrames.length;
    }
    tick++;
  }, 1000 / TX_FPS);

  $("bcnStat").textContent = `Broadcasting ${pick.label} — ${tiles.length} tiles looping`;
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
const reveal = $<HTMLCanvasElement>("reveal");
const rCtx = reveal.getContext("2d")!;
let stream: MediaStream | null = null;
let scanning = false;
let inFlight = false;
let lastScan = 0;
let solved = false;
let startTime = 0;
let audio: AudioContext | null = null;

let gridW = GRID;
let gridH = GRID;
let answerHash: string | null = null;
const tilePix = new Map<number, number[]>();
const doneStreams = new Set<string>();
const decoders = new Map<string, LTDecoder>();

function initReveal(): void {
  reveal.width = gridW;
  reveal.height = gridH;
  rCtx.imageSmoothingEnabled = false;
  rCtx.fillStyle = "#111114";
  rCtx.fillRect(0, 0, gridW, gridH);
}
function drawTile(idx: number, rgb: number[]): void {
  const x = idx % gridW;
  const y = Math.floor(idx / gridW);
  rCtx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  rCtx.fillRect(x, y, 1, 1);
}
function tick(): void {
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
  navigator.vibrate?.(12); // no-op on iOS (Apple exposes no web Vibration API)
  const d = $("dot");
  d.classList.add("hit");
  setTimeout(() => d.classList.remove("hit"), 90);
}

async function startCam(): Promise<void> {
  // Unlock audio inside the user gesture (tap) — otherwise it stays suspended
  // on mobile and no ticks play.
  try {
    if (!audio) audio = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    void audio.resume();
  } catch { /* ignore */ }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
    await video.play();
    scanning = true;
    initReveal();
    $<HTMLButtonElement>("camBtn").textContent = "Stop scanning";
    $<HTMLButtonElement>("camBtn").classList.add("stop");
    $<HTMLButtonElement>("camBtn").dataset.on = "1";
    $("answerWrap").classList.remove("hide");
    $("plStat").textContent = "Aim at the beacon — hold steady to fill it in.";
    requestAnimationFrame(scan);
  } catch (e) {
    $("plStat").textContent = "Camera error: " + (e as Error).message;
  }
}
function stopCam(): void {
  scanning = false;
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
    if (!answerHash) {
      const w = Number(p[1]);
      const h = Number(p[2]);
      if (!Number.isNaN(w) && !Number.isNaN(h)) {
        answerHash = p[3]!;
        // Only re-init if the grid actually differs (tiles are already drawing).
        if (w !== gridW || h !== gridH) {
          gridW = w;
          gridH = h;
          initReveal();
          for (const [idx, rgb] of tilePix) drawTile(idx, rgb);
        }
        $("plStat").textContent = "Locked on — keep filling, guess when ready.";
      }
    }
    return;
  }
  if (p[0] === "T") {
    const idx = Number(p[1]);
    if (Number.isNaN(idx) || tilePix.has(idx)) return;
    const rgb = [Number(p[2]), Number(p[3]), Number(p[4])];
    if (tilePix.size === 0) startTime = performance.now();
    tilePix.set(idx, rgb);
    drawTile(idx, rgb); // draw immediately — never gate rendering on the meta
    tick();
    updateProgress();
  }
}

function updateProgress(): void {
  const total = gridW * gridH;
  const pct = Math.round((tilePix.size / total) * 100);
  $("pct").textContent = pct + "%";
  $("tiles").textContent = `${tilePix.size} pieces`;
}

$<HTMLButtonElement>("guessBtn").onclick = async () => {
  if (solved || !answerHash) {
    if (!answerHash) $("plStat").textContent = "Keep aiming — waiting to lock onto the beacon…";
    return;
  }
  const guess = $<HTMLInputElement>("guess").value;
  if (!guess.trim()) return;
  const h = await sha256hex(guess);
  if (h === answerHash) {
    solved = true;
    const total = gridW * gridH;
    const revealed = tilePix.size / total;
    const secs = (performance.now() - startTime) / 1000;
    const score = Math.max(50, Math.round((1 - revealed) * 1000));
    $("result").innerHTML = `<span class="win">🎉 Correct! Solved at ${Math.round(revealed * 100)}% revealed in ${secs.toFixed(1)}s → ${score} pts</span>`;
    $("answerWrap").classList.add("hide");
    stopCam();
  } else {
    $("result").innerHTML = `<span class="lose">❌ Not it — keep going (or guess again)</span>`;
  }
};

function resetGame(): void {
  tilePix.clear();
  doneStreams.clear();
  decoders.clear();
  solved = false;
  startTime = 0;
  answerHash = null;
  gridW = GRID;
  gridH = GRID;
  initReveal();
  updateProgress();
  $("result").innerHTML = "";
  $<HTMLInputElement>("guess").value = "";
  $("answerWrap").classList.toggle("hide", !scanning);
  $("plStat").textContent = scanning ? "New game — aim at the beacon." : "Start scanning and aim at the beacon.";
}
$<HTMLButtonElement>("newBtn").onclick = resetGame;

async function keepAwake(): Promise<void> {
  try {
    await (navigator as unknown as { wakeLock?: { request(t: string): Promise<unknown> } }).wakeLock?.request("screen");
  } catch { /* ignore */ }
}
