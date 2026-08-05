// Draw & Guess — the drawer is dealt a word, sketches it on a pad, and beams
// the bitmap in light (row by row, like Phrase). Guessers watch it glow in and
// pick from four category-matched choices. Answer + decoys are reproduced on
// every device from the round seed via the shared word bank, so nothing but the
// seed has to travel.
import QRCode from "qrcode";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { LTEncoder, LTDecoder } from "../shared/fountain";
import { packFrame, parseFrame, streamIdentity, fnv1a, type FrameHeader } from "../shared/protocol";
import { rasterizeQr } from "../shared/qr-raster";
import { dealFromSeed, titleCase, type Deal } from "../shared/wordbank";
import { recordRun, bestRun } from "../shared/profile";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path),
  },
});

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const enc = new TextEncoder();
const dec = new TextDecoder();
const TX_FPS = 16;
const SCAN_MS = 70;
const META_EVERY = 10;
const GRID = 44; // drawing rasterised to GRID x GRID monochrome
const ROW_REPEAT = 5;
const TX_PASSES = 2;
const MARGIN_QR = 4;

const partyParams = new URLSearchParams(location.search);
const partyRoom = partyParams.get("room");
const partyRole = partyParams.get("role");
const partySession = partyParams.get("of");
function addScore(room: string, pts: number): number {
  const k = `signal_score_${room}`;
  const total = Number(localStorage.getItem(k) || 0) + pts;
  localStorage.setItem(k, String(total));
  return total;
}

// ---------- roles ----------
function setRole(r: "beacon" | "player"): void {
  $("beaconCard").classList.toggle("hide", r !== "beacon");
  $("playerCard").classList.toggle("hide", r !== "player");
  $<HTMLButtonElement>("roleBeacon").classList.toggle("active", r === "beacon");
  $<HTMLButtonElement>("rolePlayer").classList.toggle("active", r === "player");
  if (r !== "player") stopCam();
  document.body.classList.remove("playing", "casting", "drawing", "prescan");
}
$("roleBeacon").onclick = () => enterDrawer();
$("rolePlayer").onclick = () => enterPlayerMode();

// ---------- shared frame helper ----------
function frameForPayload(s: string): Uint8Array {
  const payload = enc.encode(s);
  const sessionId = (Math.random() * 0x10000) | 0;
  const blockLen = Math.max(1, payload.length);
  const e = new LTEncoder(payload, blockLen, sessionId);
  const base: FrameHeader = { sessionId, seq: 0, k: e.k, blockLen, totalLen: payload.length, payloadFnv: fnv1a(payload) };
  return packFrame({ ...base, seq: 0 }, e.encode(0));
}

// ---------- DRAWER: word + pad ----------
let drawSeed = 0;
let deal: Deal = dealFromSeed(0);

function newDeal(seed?: number): void {
  drawSeed = seed ?? Math.floor(Math.random() * 1e9);
  deal = dealFromSeed(drawSeed);
  $("drawWord").textContent = titleCase(deal.word);
  $("drawCat").textContent = `category · ${deal.category}`;
}

const pad = $<HTMLCanvasElement>("pad");
const pctx = pad.getContext("2d")!;
let brush = 12;
function clearPad(): void {
  pctx.fillStyle = "#f6f4ee";
  pctx.fillRect(0, 0, pad.width, pad.height);
}
clearPad();
$<HTMLButtonElement>("clearPad").onclick = clearPad;
$<HTMLButtonElement>("thin").onclick = () => {
  brush = 8;
  $("thin").classList.add("on");
  $("thick").classList.remove("on");
};
$<HTMLButtonElement>("thick").onclick = () => {
  brush = 22;
  $("thick").classList.add("on");
  $("thin").classList.remove("on");
};

let drawingStroke = false;
let lastX = 0;
let lastY = 0;
function padXY(e: PointerEvent): [number, number] {
  const r = pad.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * pad.width, ((e.clientY - r.top) / r.height) * pad.height];
}
pad.addEventListener("pointerdown", (e) => {
  drawingStroke = true;
  [lastX, lastY] = padXY(e);
  pctx.fillStyle = "#141210";
  pctx.beginPath();
  pctx.arc(lastX, lastY, brush / 2, 0, Math.PI * 2);
  pctx.fill();
  pad.setPointerCapture(e.pointerId);
});
pad.addEventListener("pointermove", (e) => {
  if (!drawingStroke) return;
  const [x, y] = padXY(e);
  pctx.strokeStyle = "#141210";
  pctx.lineWidth = brush;
  pctx.lineCap = "round";
  pctx.lineJoin = "round";
  pctx.beginPath();
  pctx.moveTo(lastX, lastY);
  pctx.lineTo(x, y);
  pctx.stroke();
  [lastX, lastY] = [x, y];
});
const endStroke = () => (drawingStroke = false);
pad.addEventListener("pointerup", endStroke);
pad.addEventListener("pointercancel", endStroke);

function rasterize(): Uint8Array {
  const off = document.createElement("canvas");
  off.width = off.height = GRID;
  const octx = off.getContext("2d", { willReadFrequently: true })!;
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, GRID, GRID);
  octx.drawImage(pad, 0, 0, GRID, GRID);
  const d = octx.getImageData(0, 0, GRID, GRID).data;
  const bits = new Uint8Array(GRID * GRID);
  for (let i = 0; i < GRID * GRID; i++) {
    const lum = (d[i * 4]! + d[i * 4 + 1]! + d[i * 4 + 2]!) / 3;
    bits[i] = lum < 128 ? 1 : 0;
  }
  return bits;
}

function enterDrawer(): void {
  setRole("beacon");
  if (drawSeed === 0) newDeal(partyRoom ? Number(partyParams.get("seed")) || undefined : undefined);
  document.body.classList.add("drawing");
}
$<HTMLButtonElement>("reshuffle").onclick = () => {
  newDeal();
  clearPad();
};

// ---------- beaming ----------
const bb = $<HTMLCanvasElement>("bb");
const bbCtx = bb.getContext("2d")!;
const modC = document.createElement("canvas");
const modCtx = modC.getContext("2d")!;
let txTimer: number | null = null;
let endFrameCache: Uint8Array | null = null;

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

function beam(): void {
  const bits = rasterize();
  const metaFrame = frameForPayload(`M|${GRID}|${GRID}|${drawSeed}`);
  endFrameCache = frameForPayload(`E|done`);

  // Only inked rows travel — a drawing is mostly whitespace, so this keeps the
  // broadcast short. A blank row simply stays dark on the guesser's screen.
  const rowFrames: Uint8Array[] = [];
  const inkedRows: number[] = [];
  for (let r = 0; r < GRID; r++) {
    let s = "";
    let any = false;
    for (let x = 0; x < GRID; x++) {
      const on = bits[r * GRID + x] === 1;
      if (on) any = true;
      s += on ? "1" : "0";
    }
    if (any) inkedRows.push(r);
  }
  if (inkedRows.length === 0) {
    $("bcnStat").removeAttribute("hidden");
    $("bcnStat").textContent = "Draw something first!";
    return;
  }
  for (const r of inkedRows) {
    let s = "";
    for (let x = 0; x < GRID; x++) s += bits[r * GRID + x] === 1 ? "1" : "0";
    rowFrames.push(frameForPayload(`R|${r}|${s}`));
  }
  const playlist: Uint8Array[] = [];
  for (let pass = 0; pass < TX_PASSES; pass++) {
    for (let i = rowFrames.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rowFrames[i], rowFrames[j]] = [rowFrames[j]!, rowFrames[i]!];
    }
    for (const rf of rowFrames) for (let k = 0; k < ROW_REPEAT; k++) playlist.push(rf);
  }

  document.body.classList.remove("drawing");
  document.body.classList.add("casting");
  pendingBeam = { playlist, metaFrame };
  beaconBegun = false;
  // Party: hold on the ready screen until every guesser has armed their camera
  // (or the drawer taps Beam now), then count down and beam. Solo: beam now.
  if (partyRoom) {
    drawBeaconWait(readyCount, playerCount);
    showBeamNow();
    maybeBeginBeam();
  } else {
    void beginBeam();
  }
}
$<HTMLButtonElement>("beamBtn").onclick = beam;

function finishBroadcast(): void {
  if (txTimer !== null) clearInterval(txTimer);
  txTimer = null;
  if (endFrameCache) renderFrame(endFrameCache);
  $("bcnStat").removeAttribute("hidden");
  $("bcnStat").textContent = "Beamed! ✏️";
  // Party session: hand control back to the standings hub.
  if (partySession) {
    void partyCh?.send({ type: "broadcast", event: "roundend", payload: {} });
    return;
  }
  showDrawerNext();
}

function showDrawerNext(): void {
  // Repurpose the beam button as a "next drawing" control on the casting screen.
  const homeBtn = document.createElement("button");
  homeBtn.className = "btn primary";
  homeBtn.textContent = "✏️  Draw another";
  homeBtn.style.position = "fixed";
  homeBtn.style.left = "22px";
  homeBtn.style.right = "22px";
  homeBtn.style.bottom = "22px";
  homeBtn.style.width = "auto";
  homeBtn.id = "nextDrawBtn";
  document.getElementById("nextDrawBtn")?.remove();
  homeBtn.onclick = () => startNextRound();
  $("beaconCard").appendChild(homeBtn);
}

function startNextRound(): void {
  document.getElementById("nextDrawBtn")?.remove();
  const seed = Math.floor(Math.random() * 1e9);
  if (partyCh) void partyCh.send({ type: "broadcast", event: "next", payload: { seed } });
  else {
    newDeal(seed);
    clearPad();
    document.body.classList.remove("casting");
    document.body.classList.add("drawing");
  }
}

// ---------- GUESSER: camera + reveal ----------
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
let answered = false;
let audio: AudioContext | null = null;

let gridW = GRID;
let gridH = GRID;
let roundSeed = -1;
let answerIndex = -1;
const rowsSeen = new Set<number>();
const doneStreams = new Set<string>();
const decoders = new Map<string, LTDecoder>();

function initReveal(): void {
  reveal.width = gridW;
  reveal.height = gridH;
  rCtx.imageSmoothingEnabled = false;
  rCtx.fillStyle = "#0a0b10";
  rCtx.fillRect(0, 0, gridW, gridH);
}
function setRevealRow(r: number, bits: string): void {
  for (let x = 0; x < gridW && x < bits.length; x++) {
    if (bits.charCodeAt(x) === 49) {
      rCtx.fillStyle = "#ffe6b0";
      rCtx.fillRect(x, r, 1, 1);
    }
  }
}

function tickFx(): void {
  if (audio && audio.state === "running") {
    const t = audio.currentTime;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 760;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g);
    g.connect(audio.destination);
    o.start(t);
    o.stop(t + 0.06);
  }
  navigator.vibrate?.(6);
  const d = $("dot");
  d.classList.add("hit");
  setTimeout(() => d.classList.remove("hit"), 80);
}

function enterPlayerMode(): void {
  setRole("player");
  document.body.classList.add("prescan");
  const b = $<HTMLButtonElement>("camBtn");
  b.textContent = partyRoom ? "✓  I'm ready" : "▶  Aim at the drawer";
  b.classList.remove("hide");
  if (partyRoom) {
    const t = document.querySelector(".th-title");
    if (t) t.textContent = "Ready up";
    const s = document.querySelector(".th-sub");
    if (s) s.textContent = "Tap ready and aim at the drawer. The round starts once everyone's in.";
  }
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
    initReveal();
    $<HTMLButtonElement>("camBtn").textContent = "Stop";
    $<HTMLButtonElement>("camBtn").classList.add("stop");
    $<HTMLButtonElement>("camBtn").dataset.on = "1";
    $("answerWrap").classList.remove("hide");
    if (partyRoom) {
      partyReportReady();
      $("plStat").textContent = "✓ Ready — waiting for the drawing…";
    } else {
      $("plStat").textContent = "Aim at the drawer — the sketch fills in as you watch.";
    }
    requestAnimationFrame(scan);
  } catch (e) {
    $("plStat").textContent = "Camera error: " + (e as Error).message;
  }
}
function stopCam(): void {
  scanning = false;
  document.body.classList.remove("playing");
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  const b = $<HTMLButtonElement>("camBtn");
  b.textContent = "Start";
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
      .finally(() => (inFlight = false));
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
    if (!solved && !answered) $("plStat").textContent = "That's the whole drawing — lock in your answer!";
    return;
  }
  if (p[0] === "M") {
    const w = Number(p[1]);
    const h = Number(p[2]);
    const seed = Number(p[3]);
    if (Number.isNaN(w) || Number.isNaN(h) || Number.isNaN(seed)) return;
    if (seed === roundSeed) return;
    if (roundSeed !== -1) resetGuess(); // new drawing — wipe and adopt
    roundSeed = seed;
    gridW = w;
    gridH = h;
    initReveal();
    const d = dealFromSeed(seed);
    answerIndex = d.answerIndex;
    renderOptions(d);
    $("plStat").textContent = "Locked on — guess when you think you've got it.";
    return;
  }
  if (p[0] === "R") {
    const r = Number(p[1]);
    const bits = p[2] ?? "";
    if (Number.isNaN(r) || roundSeed === -1) return;
    setRevealRow(r, bits);
    if (!rowsSeen.has(r)) {
      rowsSeen.add(r);
      $("pct").textContent = `${Math.round((rowsSeen.size / gridH) * 100)}%`;
      tickFx();
    }
  }
}

// ---------- multiple-choice ----------
function renderOptions(d: Deal): void {
  const wrap = $("opts");
  wrap.innerHTML = "";
  answered = false;
  d.choices.forEach((word, i) => {
    const b = document.createElement("button");
    b.className = "opt";
    b.textContent = titleCase(word);
    b.onclick = () => lockIn(i, b);
    wrap.appendChild(b);
  });
}

function lockIn(i: number, btn: HTMLButtonElement): void {
  if (answered || solved || roundSeed === -1) return;
  answered = true;
  const buttons = [...$("opts").querySelectorAll("button")] as HTMLButtonElement[];
  for (const b of buttons) b.disabled = true;
  if (partyRoom) partyReportAnswer();
  if (i === answerIndex) {
    btn.classList.add("correct");
    solved = true;
    const frac = Math.min(1, rowsSeen.size / gridH);
    const score = Math.max(50, Math.round((1 - frac) * 1000));
    showWinStage(score, frac);
  } else {
    btn.classList.add("wrong");
    buttons[answerIndex]?.classList.add("correct");
    $("result").innerHTML = `<span class="lose">Locked in — not it 😬</span>`;
    if (partyRoom) $("plStat").textContent = "Locked in — waiting for the next round…";
  }
}

// ---------- win stage ----------
function countUp(el: HTMLElement, to: number, ms = 1000): void {
  const t0 = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / ms);
    el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))).toLocaleString();
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
  const colors = ["#ffb84d", "#37e0b0", "#ff5c8a", "#4f8cff", "#ffffff"];
  const parts = Array.from({ length: 120 }, () => ({
    x: cv.width * (0.5 + (Math.random() - 0.5) * 0.35), y: cv.height * 0.38,
    vx: (Math.random() - 0.5) * 16 * dpr, vy: (-10 - Math.random() * 14) * dpr,
    w: (4 + Math.random() * 5) * dpr, h: (7 + Math.random() * 7) * dpr,
    rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, c: colors[(Math.random() * colors.length) | 0]!,
  }));
  const g = 0.55 * dpr;
  let frames = 0;
  const t = () => {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of parts) {
      p.vy += g; p.x += p.vx; p.y += p.vy; p.vx *= 0.985; p.rot += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c;
      ctx.globalAlpha = Math.max(0, 1 - frames / 170); ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
    }
    frames++;
    if (frames < 175) requestAnimationFrame(t); else ctx.clearRect(0, 0, cv.width, cv.height);
  };
  requestAnimationFrame(t);
}
function showWinStage(score: number, frac: number): void {
  $("stage").classList.remove("hide");
  $("stageLabel").textContent = "Guessed it";
  $("stageSub").textContent = `at ${Math.round(frac * 100)}% drawn`;
  countUp($("stageScore"), score);
  requestAnimationFrame(launchConfetti);
  const best = recordRun("draw", score);
  if (partyRoom) {
    const total = addScore(partyRoom, score);
    $("stageSub").textContent = `+${score} → room total ${total.toLocaleString()}`;
    $("stageNew").textContent = "‹ Back to lobby";
  } else {
    $("stageSub").textContent = best
      ? `at ${Math.round(frac * 100)}% drawn · new best!`
      : `at ${Math.round(frac * 100)}% drawn · best ${bestRun("draw").toLocaleString()}`;
  }
}
$<HTMLButtonElement>("stageNew").onclick = () => {
  if (partyRoom) location.href = `../party/?room=${partyRoom}`;
  else { $("stage").classList.add("hide"); resetGuess(); }
};

function resetGuess(): void {
  doneStreams.clear();
  decoders.clear();
  rowsSeen.clear();
  solved = false;
  answered = false;
  roundSeed = -1;
  answerIndex = -1;
  gridW = gridH = GRID;
  initReveal();
  $("pct").textContent = "0%";
  $("result").innerHTML = "";
  $("stage").classList.add("hide");
  $("opts").innerHTML = `<div class="optsHint">Choices appear once you lock on…</div>`;
  $("answerWrap").classList.toggle("hide", !scanning);
  $("plStat").textContent = scanning ? "Waiting for the next drawing…" : "Tap Start, then aim at the drawer.";
  document.body.classList.remove("result");
  if (!scanning) document.body.classList.remove("playing");
}
$<HTMLButtonElement>("newBtn").onclick = resetGuess;

async function keepAwake(): Promise<void> {
  try {
    await (navigator as unknown as { wakeLock?: { request(t: string): Promise<unknown> } }).wakeLock?.request("screen");
  } catch { /* ignore */ }
}

// ---------- party coordination (lazy realtime) ----------
let partyCh: { send: (a: unknown) => unknown } | null = null;
let partyReportAnswer: () => void = () => {};
let partyReportReady: () => void = () => {};
let beaconBegun = false;
let pendingBeam: { playlist: Uint8Array[]; metaFrame: Uint8Array } | null = null;
let playerCount = 0;
let readyCount = 0;

function drawCountdown(n: number): void {
  bbCtx.fillStyle = "#ffffff";
  bbCtx.fillRect(0, 0, bb.width, bb.height);
  bbCtx.fillStyle = "#0b0d13";
  bbCtx.textAlign = "center";
  bbCtx.textBaseline = "middle";
  bbCtx.font = `900 ${Math.round(bb.height * 0.5)}px -apple-system, system-ui, sans-serif`;
  bbCtx.fillText(String(n), bb.width / 2, bb.height / 2 + bb.height * 0.03);
}
function drawBeaconWait(readyN: number, total: number): void {
  bbCtx.fillStyle = "#ffffff";
  bbCtx.fillRect(0, 0, bb.width, bb.height);
  bbCtx.fillStyle = "#0b0d13";
  bbCtx.textAlign = "center";
  bbCtx.textBaseline = "middle";
  bbCtx.font = `800 ${Math.round(bb.height * 0.11)}px -apple-system, system-ui, sans-serif`;
  bbCtx.fillText("READY UP", bb.width / 2, bb.height * 0.3);
  bbCtx.font = `900 ${Math.round(bb.height * 0.3)}px -apple-system, system-ui, sans-serif`;
  bbCtx.fillText(`${readyN}/${total || "·"}`, bb.width / 2, bb.height * 0.56);
  bbCtx.font = `700 ${Math.round(bb.height * 0.06)}px -apple-system, system-ui, sans-serif`;
  bbCtx.fillText("guessers ready", bb.width / 2, bb.height * 0.78);
}
function showBeamNow(): void {
  document.getElementById("beamNowBtn")?.remove();
  const b = document.createElement("button");
  b.className = "btn primary";
  b.textContent = "▶ Beam now";
  b.id = "beamNowBtn";
  b.style.cssText = "position:fixed;left:22px;right:22px;bottom:22px;width:auto;";
  b.onclick = () => void beginBeam();
  $("beaconCard").appendChild(b);
}
function maybeBeginBeam(): void {
  if (!pendingBeam || beaconBegun) return;
  drawBeaconWait(readyCount, playerCount);
  if (playerCount > 0 && readyCount >= playerCount) void beginBeam();
}
async function beginBeam(): Promise<void> {
  if (!pendingBeam || beaconBegun) return;
  beaconBegun = true;
  document.getElementById("beamNowBtn")?.remove();
  void partyCh?.send({ type: "broadcast", event: "go", payload: {} });
  for (let n = 3; n > 0; n--) {
    drawCountdown(n);
    await new Promise((r) => setTimeout(r, 700));
  }
  runBeam(pendingBeam.playlist, pendingBeam.metaFrame);
}
function runBeam(playlist: Uint8Array[], metaFrame: Uint8Array): void {
  if (txTimer !== null) clearInterval(txTimer);
  let idx = 0;
  let tick = 0;
  txTimer = window.setInterval(() => {
    if (tick % META_EVERY === 0) {
      renderFrame(metaFrame);
      tick++;
      return;
    }
    if (idx >= playlist.length) {
      finishBroadcast();
      return;
    }
    renderFrame(playlist[idx]!);
    idx++;
    tick++;
  }, 1000 / TX_FPS);
  void keepAwake();
}
function runPlayerCountdown(): void {
  let n = 3;
  $("plStat").textContent = `Starting in ${n}…`;
  const iv = window.setInterval(() => {
    n--;
    if (n > 0) $("plStat").textContent = `Starting in ${n}…`;
    else {
      $("plStat").textContent = "Go! 🟢 What is it?";
      clearInterval(iv);
    }
  }, 1000);
}

async function setupParty(): Promise<void> {
  if (!partyRoom) return;
  try {
    const [{ supabase }, { myId }] = await Promise.all([import("../shared/supabase"), import("../shared/profile")]);
    const id = myId();
    const isDrawer = partyRole === "beacon";
    const ch = supabase.channel(`room:${partyRoom}`, { config: { presence: { key: id }, broadcast: { self: true } } });
    partyCh = ch;
    const answeredIds = new Set<string>();
    let readyFlag = false;
    const trackMe = () => ch.track({ role: partyRole, ready: readyFlag });
    const check = (): void => {
      if (isDrawer && playerCount > 0 && answeredIds.size >= playerCount && txTimer !== null) {
        $("bcnStat").removeAttribute("hidden");
        $("bcnStat").textContent = "Everyone guessed 🎉";
        finishBroadcast();
      }
    };
    ch.on("presence", { event: "sync" }, () => {
      const members = Object.values(
        ch.presenceState() as unknown as Record<string, { role?: string; ready?: boolean }[]>,
      ).flat();
      playerCount = members.filter((m) => m.role === "player").length;
      readyCount = members.filter((m) => m.role === "player" && m.ready).length;
      check();
      if (isDrawer) maybeBeginBeam();
    });
    ch.on("broadcast", { event: "answered" }, ({ payload }) => {
      answeredIds.add((payload as { id: string }).id);
      check();
    });
    ch.on("broadcast", { event: "go" }, () => {
      if (!isDrawer) runPlayerCountdown();
    });
    ch.on("broadcast", { event: "next" }, ({ payload }) => {
      answeredIds.clear();
      const seed = (payload as { seed: number }).seed;
      if (isDrawer) {
        document.getElementById("nextDrawBtn")?.remove();
        newDeal(seed);
        clearPad();
        document.body.classList.remove("casting");
        document.body.classList.add("drawing");
      } else {
        $("stage").classList.add("hide");
        $("plStat").textContent = "✨ New drawing coming…";
      }
    });
    ch.on("broadcast", { event: "roundend" }, () => {
      location.href = `../party/?room=${partyRoom}&back=1`;
    });
    ch.subscribe((s) => {
      if (s === "SUBSCRIBED") void trackMe();
    });
    partyReportAnswer = () => void ch.send({ type: "broadcast", event: "answered", payload: { id } });
    partyReportReady = () => {
      readyFlag = true;
      void trackMe();
    };
  } catch { /* realtime unavailable — round still plays */ }
}

// ---------- init ----------
if (partyRoom) {
  const brand = document.querySelector(".brand") as HTMLAnchorElement | null;
  if (brand) {
    brand.href = `../party/?room=${partyRoom}`;
    const back = brand.querySelector(".back");
    if (back) back.textContent = "‹ lobby";
  }
  $<HTMLButtonElement>("newBtn").textContent = "‹ Back to lobby";
  $<HTMLButtonElement>("newBtn").onclick = () => (location.href = `../party/?room=${partyRoom}`);
  void setupParty();
  if (partyRole === "beacon") enterDrawer();
  else if (partyRole === "player") enterPlayerMode();
} else {
  // Walk-up solo: a big screen draws (mouse), a phone guesses.
  if (matchMedia("(hover: hover) and (pointer: fine)").matches) enterDrawer();
  else enterPlayerMode();
}
