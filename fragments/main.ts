// Fragments — single-beacon optical clue hunt.
//
// One device is the BEACON: it cycles through a puzzle's clues, broadcasting
// each as an animated fountain-QR (reusing DECIMEN's codec). Other devices are
// PLAYERS: their camera decodes each clue as it comes around, collects the full
// set, and lets them guess the answer — verified ON-DEVICE against a hash baked
// into the broadcast, so there is no server and no back-channel.
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
const BLOCK_LEN = 400;
const MARGIN = 4;
const TX_FPS = 10;
const FRAG_MS = 2000; // how long each clue is broadcast before the beacon moves on
const SCAN_MS = 80;

interface Puzzle {
  id: string;
  theme: string;
  clues: string[];
  answer: string;
}
const PUZZLES: Puzzle[] = [
  { id: "p1", theme: "Animal", clues: ["I have a long trunk", "The largest land animal", "Famous for my memory", "Big flapping ears"], answer: "elephant" },
  { id: "p2", theme: "Place", clues: ["City of light", "Home to a famous iron tower", "Croissants and cafés", "Capital of France"], answer: "paris" },
  { id: "p3", theme: "Movie", clues: ["A great white shark", "Spielberg, 1975", "You're gonna need a bigger boat", "A New England beach town"], answer: "jaws" },
];

const enc = new TextEncoder();
const dec = new TextDecoder();

async function sha256hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", enc.encode(s.trim().toLowerCase()));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------- role switching ----------
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

// populate puzzle picker
const puzzleSel = $<HTMLSelectElement>("puzzle");
PUZZLES.forEach((p, i) => {
  const o = document.createElement("option");
  o.value = String(i);
  o.textContent = `${p.theme} (${p.clues.length} clues)`;
  puzzleSel.appendChild(o);
});

// ---------- BEACON ----------
const bb = $<HTMLCanvasElement>("bb");
const bbCtx = bb.getContext("2d")!;
const mod = document.createElement("canvas");
const modCtx = mod.getContext("2d")!;
let txTimer: number | null = null;
let fragTimer: number | null = null;

function renderFrame(frame: Uint8Array): void {
  const qr = QRCode.create([{ data: frame, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
    errorCorrectionLevel: "L",
  });
  const raster = rasterizeQr(qr.modules.size, qr.modules.data, MARGIN);
  const img = new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size);
  mod.width = raster.size;
  mod.height = raster.size;
  modCtx.putImageData(img, 0, 0);
  bbCtx.imageSmoothingEnabled = false;
  bbCtx.clearRect(0, 0, bb.width, bb.height);
  bbCtx.drawImage(mod, 0, 0, bb.width, bb.height);
}

async function startBeacon(): Promise<void> {
  const puzzle = PUZZLES[Number(puzzleSel.value)]!;
  const hash = await sha256hex(puzzle.answer);
  const total = puzzle.clues.length;
  // Build one fountain encoder per clue fragment.
  const encoders = puzzle.clues.map((clue, i) => {
    const payload = enc.encode(`${puzzle.id}|${i}|${total}|${hash}|${clue}`);
    const sessionId = ((Math.random() * 0x10000) | 0) ^ (i << 3);
    const e = new LTEncoder(payload, BLOCK_LEN, sessionId);
    const base: FrameHeader = {
      sessionId,
      seq: 0,
      k: e.k,
      blockLen: BLOCK_LEN,
      totalLen: payload.length,
      payloadFnv: fnv1a(payload),
    };
    return { e, base };
  });

  if (txTimer !== null) clearInterval(txTimer);
  if (fragTimer !== null) clearInterval(fragTimer);
  let frag = 0;
  let seq = 0;
  const draw = () => {
    const { e, base } = encoders[frag]!;
    renderFrame(packFrame({ ...base, seq }, e.encode(seq)));
    seq++;
  };
  txTimer = window.setInterval(draw, 1000 / TX_FPS);
  $("bcnStat").textContent = `Broadcasting “${puzzle.theme}” — clue 1 / ${total}`;
  fragTimer = window.setInterval(() => {
    frag = (frag + 1) % total;
    seq = 0;
    $("bcnStat").textContent = `Broadcasting “${puzzle.theme}” — clue ${frag + 1} / ${total}`;
  }, FRAG_MS);

  $<HTMLButtonElement>("bcnBtn").textContent = "Stop";
  $<HTMLButtonElement>("bcnBtn").classList.add("stop");
  $<HTMLButtonElement>("bcnBtn").dataset.on = "1";
  void keepAwake();
}
function stopBeacon(): void {
  if (txTimer !== null) clearInterval(txTimer);
  if (fragTimer !== null) clearInterval(fragTimer);
  txTimer = fragTimer = null;
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
let startTime = 0;
let answerHash: string | null = null;
let expectedTotal = 0;
const collected = new Map<number, string>();
const decoders = new Map<string, LTDecoder>();
const doneStreams = new Set<string>();

async function startCam(): Promise<void> {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
    await video.play();
    scanning = true;
    $<HTMLButtonElement>("camBtn").textContent = "Stop camera";
    $<HTMLButtonElement>("camBtn").classList.add("stop");
    $<HTMLButtonElement>("camBtn").dataset.on = "1";
    $("plStat").textContent = "Scanning… collect every clue.";
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
  b.textContent = "Start camera";
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
  if (p.length < 5) return;
  const idx = Number(p[1]);
  const total = Number(p[2]);
  const hash = p[3]!;
  const clue = p.slice(4).join("|");
  if (Number.isNaN(idx) || Number.isNaN(total)) return;
  if (collected.size === 0) startTime = performance.now();
  answerHash = hash;
  expectedTotal = total;
  if (!collected.has(idx)) collected.set(idx, clue);
  renderClues();
}

function renderClues(): void {
  $("prog").textContent = `${collected.size} / ${expectedTotal || "?"} clues`;
  const wrap = $("clues");
  wrap.innerHTML = "";
  for (let i = 0; i < expectedTotal; i++) {
    const div = document.createElement("div");
    if (collected.has(i)) {
      div.className = "clue";
      div.innerHTML = `<span class="n">${i + 1}</span>`;
      const t = document.createElement("span");
      t.textContent = collected.get(i)!;
      div.appendChild(t);
    } else {
      div.className = "slot";
      div.textContent = `Clue ${i + 1} — not collected yet`;
    }
    wrap.appendChild(div);
  }
  if (expectedTotal > 0 && collected.size >= expectedTotal && !solved) {
    $("answerWrap").classList.remove("hide");
    $("plStat").textContent = "All clues collected! Take your guess.";
  }
}

$<HTMLButtonElement>("guessBtn").onclick = async () => {
  if (solved || !answerHash) return;
  const guess = $<HTMLInputElement>("guess").value;
  if (!guess.trim()) return;
  const h = await sha256hex(guess);
  if (h === answerHash) {
    solved = true;
    const secs = ((performance.now() - startTime) / 1000).toFixed(1);
    $("result").innerHTML = `<span class="win">🎉 Correct! Solved in ${secs}s</span>`;
    $("answerWrap").classList.add("hide");
    stopCam();
  } else {
    $("result").innerHTML = `<span class="lose">❌ Not it — try again</span>`;
  }
};

async function keepAwake(): Promise<void> {
  try {
    await (navigator as unknown as { wakeLock?: { request(t: string): Promise<unknown> } }).wakeLock?.request("screen");
  } catch {
    /* ignore */
  }
}
