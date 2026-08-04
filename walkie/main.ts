// Optical Walkie-Talkie — a two-way messaging lab built on DECIMEN's codec.
//
// Reuses the proven fountain-LT codec + frame format + QR raster from ../shared,
// and zxing-wasm for decode. Adds two things DECIMEN doesn't have:
//   1) AES-GCM encryption of the message before it enters the fountain, so a
//      bystander camera / Google Lens sees only ciphertext frames.
//   2) A continuous two-way "billboard" model: your screen always loops your
//      current committed message as animated QR; your camera continuously reads
//      the other phone's billboard. Hitting TRANSMIT swaps which message your
//      billboard broadcasts. Nothing is ever sent to a server — the message
//      exists only as light between two screens.
import QRCode from "qrcode";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { LTEncoder, LTDecoder } from "../shared/fountain";
import { packFrame, parseFrame, streamIdentity, fnv1a, type FrameHeader } from "../shared/protocol";
import { rasterizeQr } from "../shared/qr-raster";

// Serve the decoder wasm locally (Vite ?url) so phones need only the LAN.
prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path),
  },
});

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const keyIn = $<HTMLInputElement>("key");
const msgIn = $<HTMLInputElement>("msg");
const txBtn = $<HTMLButtonElement>("txBtn");
const camBtn = $<HTMLButtonElement>("camBtn");
const statusEl = $<HTMLDivElement>("status");
const logEl = $<HTMLDivElement>("log");
const video = $<HTMLVideoElement>("video");
const work = $<HTMLCanvasElement>("work");
const bb = $<HTMLCanvasElement>("bb");
const idle = $<HTMLDivElement>("idle");
const caption = $<HTMLDivElement>("caption");

const BLOCK_LEN = 512; // bytes per fountain block → frame ≈ 532 B (moderate QR)
const MARGIN = 4; // QR quiet-zone modules
const TX_FPS = 12; // billboard frame rate
const SCAN_MS = 80; // ~12 decode attempts/sec (shares CPU with the billboard)

// ---------- crypto (AES-GCM, key = SHA-256(shared key)) ----------
const keyCache: Record<string, Promise<CryptoKey>> = {};
function keyFrom(pass: string): Promise<CryptoKey> {
  return (keyCache[pass] ??= (async () => {
    const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pass));
    return crypto.subtle.importKey("raw", h, "AES-GCM", false, ["encrypt", "decrypt"]);
  })());
}
async function aesEnc(bytes: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}
async function aesDec(bytes: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return new Uint8Array(pt);
}

// ---------- log ----------
function addLog(who: "peer" | "me", text: string): void {
  const div = document.createElement("div");
  div.className = who;
  div.innerHTML = `<div class="who">${who === "peer" ? "Received" : "You broadcast"}</div>`;
  const body = document.createElement("div");
  body.textContent = text;
  div.appendChild(body);
  logEl.prepend(div);
}

// ---------- transmit (billboard) ----------
let txTimer: number | null = null;
const bbCtx = bb.getContext("2d")!;
const mod = document.createElement("canvas"); // module-resolution scratch
const modCtx = mod.getContext("2d")!;

function renderFrame(frame: Uint8Array): void {
  const qr = QRCode.create([{ data: frame, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
    errorCorrectionLevel: "L",
  });
  const size = qr.modules.size;
  const raster = rasterizeQr(size, qr.modules.data, MARGIN);
  const img = new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size);
  mod.width = raster.size;
  mod.height = raster.size;
  modCtx.putImageData(img, 0, 0);
  bbCtx.imageSmoothingEnabled = false;
  bbCtx.clearRect(0, 0, bb.width, bb.height);
  bbCtx.drawImage(mod, 0, 0, bb.width, bb.height);
}

async function transmit(): Promise<void> {
  const text = msgIn.value.trim();
  if (!text) return;
  const key = await keyFrom(keyIn.value);
  const payload = await aesEnc(new TextEncoder().encode(text), key);
  const sessionId = (Math.random() * 0x10000) | 0;
  const enc = new LTEncoder(payload, BLOCK_LEN, sessionId);
  const base: FrameHeader = {
    sessionId,
    seq: 0,
    k: enc.k,
    blockLen: BLOCK_LEN,
    totalLen: payload.length,
    payloadFnv: fnv1a(payload),
  };
  if (txTimer !== null) clearInterval(txTimer);
  idle.style.display = "none";
  bb.classList.remove("idle");
  const preview = text.length > 40 ? text.slice(0, 40) + "…" : text;
  caption.innerHTML = `Broadcasting: <b>${preview.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!))}</b> · ${enc.k} block${enc.k === 1 ? "" : "s"} · looping`;
  addLog("me", text);
  msgIn.value = "";
  let seq = 0;
  txTimer = window.setInterval(() => {
    renderFrame(packFrame({ ...base, seq }, enc.encode(seq)));
    seq++;
  }, 1000 / TX_FPS);
}
txBtn.onclick = () => void transmit();
msgIn.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void transmit();
});

// ---------- receive (camera → decode → fountain → decrypt) ----------
let stream: MediaStream | null = null;
let scanning = false;
let inFlight = false;
let lastScan = 0;
let activeId: string | null = null;
let decoder: LTDecoder | null = null;
const loggedStreams = new Set<string>();
const workCtx = work.getContext("2d", { willReadFrequently: true })!;

async function startCam(): Promise<void> {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
    await video.play();
    scanning = true;
    camBtn.textContent = "Stop";
    statusEl.textContent = "Listening… point the camera at the other phone's code.";
    requestAnimationFrame(scan);
  } catch (e) {
    statusEl.textContent = "Camera error: " + (e as Error).message;
  }
}
function stopCam(): void {
  scanning = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  camBtn.textContent = "Camera";
}
camBtn.onclick = () => (scanning ? stopCam() : void startCam());

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
        if (r) void onFrame(new Uint8Array(r.bytes));
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  }
  requestAnimationFrame(scan);
}

async function onFrame(bytes: Uint8Array): Promise<void> {
  const parsed = parseFrame(bytes);
  if (!parsed) return;
  const { header, block } = parsed;
  const id = streamIdentity(header);
  if (loggedStreams.has(id)) return; // already received this message (sender loops it)
  if (id !== activeId) {
    activeId = id;
    decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    statusEl.textContent = `Receiving a message… (${header.k} block${header.k === 1 ? "" : "s"})`;
  }
  if (!decoder) return;
  decoder.addFrame(header.seq, block);
  statusEl.textContent = `Receiving… ${decoder.solvedCount}/${decoder.k} blocks`;
  if (!decoder.isComplete) return;

  const payload = decoder.assemble();
  loggedStreams.add(id);
  decoder = null;
  activeId = null;
  if (!payload || fnv1a(payload) !== header.payloadFnv) {
    statusEl.textContent = "A message arrived but failed its integrity check.";
    return;
  }
  try {
    const key = await keyFrom(keyIn.value);
    const text = new TextDecoder().decode(await aesDec(payload, key));
    addLog("peer", text);
    statusEl.textContent = "✅ Message received. Listening…";
  } catch {
    statusEl.textContent = "A message arrived but the shared key doesn't match (can't decrypt).";
  }
}

// Keep the screen awake while broadcasting (best-effort).
async function keepAwake(): Promise<void> {
  try {
    await (navigator as unknown as { wakeLock?: { request(t: string): Promise<unknown> } }).wakeLock?.request("screen");
  } catch {
    /* ignore */
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void keepAwake();
});
void keepAwake();
