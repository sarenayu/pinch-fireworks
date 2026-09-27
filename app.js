import { FilesetResolver, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";

const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const PINCH_CLOSE = 0.38;
const PINCH_OPEN = 0.58;
const PINCH_FRAMES = 2;
const COOLDOWN_MS = 520;

const canvas = document.querySelector("#fireworks");
const ctx = canvas.getContext("2d");
const video = document.querySelector("#webcam");
const guide = document.querySelector("#handGuide");
const guideCtx = guide.getContext("2d");
const startButton = document.querySelector("#startButton");
const demoButton = document.querySelector("#demoButton");
const welcome = document.querySelector("#welcome");
const cameraCard = document.querySelector("#cameraCard");
const hint = document.querySelector("#hint");
const statusText = document.querySelector("#statusText");
const statusDot = document.querySelector("#statusDot");
const pinchMeter = document.querySelector("#pinchMeter");
const toast = document.querySelector("#toast");
const hintTitle = hint.querySelector("strong");
const hintDetail = hint.querySelector("small");

let width = 0;
let height = 0;
let dpr = 1;
let particles = [];
let rings = [];
let flares = [];
let landmarker = null;
let lastVideoTime = -1;
let lastDetectAt = 0;
let pinched = false;
let closeFrames = 0;
let smoothedRatio = 1;
let lastBurstAt = 0;
let lastHandSeenAt = 0;

const palettes = [
  ["#fff5c4", "#ffd166", "#ff7a5c"],
  ["#f4f0ff", "#c9a7ff", "#7bdff2"],
  ["#fff8f0", "#ff8fab", "#ff4d6d"],
  ["#edfff8", "#7df9c2", "#5ab9ea"]
];

function resize() {
  width = innerWidth;
  height = innerHeight;
  dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (video.videoWidth) resizeGuide();
}

function resizeGuide() {
  const rect = guide.getBoundingClientRect();
  guide.width = Math.round(rect.width * dpr);
  guide.height = Math.round(rect.height * dpr);
  guideCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function launchBurst(x, y) {
  const now = performance.now();
  const palette = palettes[Math.floor(Math.random() * palettes.length)];
  const count = matchMedia("(max-width: 700px)").matches ? 105 : 160;
  const radius = Math.min(width, height) * (0.22 + Math.random() * 0.08);

  flares.push({ x, y, born: now, color: palette[0] });
  rings.push({ x, y, born: now, color: palette[1], radius });

  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.12;
    const shell = i % 4 === 0 ? 1.15 : .78;
    const power = radius * shell * (0.72 + Math.random() * 0.5);
    const color = palette[Math.floor(Math.random() * palette.length)];
    particles.push({
      x, y, oldX: x, oldY: y,
      vx: Math.cos(angle) * power,
      vy: Math.sin(angle) * power,
      life: 1.15,
      decay: 0.38 + Math.random() * 0.24,
      drag: 0.93 + Math.random() * 0.035,
      gravity: 52 + Math.random() * 34,
      width: 1.4 + Math.random() * 2.3,
      color,
      twinkle: Math.random() * Math.PI * 2,
      glitter: Math.random() > .42
    });
  }
  lastBurstAt = now;
}

function animateFireworks(now) {
  const dt = Math.min((animateFireworks.last ? now - animateFireworks.last : 16) / 1000, 0.033);
  animateFireworks.last = now;
  ctx.clearRect(0, 0, width, height);
  ctx.globalCompositeOperation = "lighter";

  flares = flares.filter((flare) => {
    const age = (now - flare.born) / 360;
    if (age >= 1) return false;
    const glow = 125 * (1 - age);
    const grad = ctx.createRadialGradient(flare.x, flare.y, 0, flare.x, flare.y, glow);
    grad.addColorStop(0, `rgba(255,255,245,${0.9 * (1 - age)})`);
    grad.addColorStop(.15, `${flare.color}99`);
    grad.addColorStop(1, "transparent");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(flare.x, flare.y, glow, 0, Math.PI * 2);
    ctx.fill();
    return true;
  });

  rings = rings.filter((ring) => {
    const age = (now - ring.born) / 700;
    if (age >= 1) return false;
    ctx.globalAlpha = (1 - age) * .7;
    ctx.strokeStyle = ring.color;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, ring.radius * age, 0, Math.PI * 2);
    ctx.stroke();
    return true;
  });

  particles = particles.filter((p) => {
    p.life -= p.decay * dt;
    if (p.life <= 0) return false;
    p.oldX = p.x;
    p.oldY = p.y;
    p.vx *= Math.pow(p.drag, dt * 60);
    p.vy = p.vy * Math.pow(p.drag, dt * 60) + p.gravity * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const alpha = Math.min(1, Math.max(0, p.life)) * (.76 + Math.sin(now * .018 + p.twinkle) * .2);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 7;
    ctx.lineWidth = p.width * Math.max(.45, p.life);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(p.x - p.vx * dt * 3.2, p.y - p.vy * dt * 3.2);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.shadowBlur = 0;
    if (p.glitter && Math.sin(now * .035 + p.twinkle) > .55) {
      ctx.globalAlpha = Math.min(1, alpha + .2);
      ctx.fillStyle = "#fffbea";
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1, p.width * .72), 0, Math.PI * 2);
      ctx.fill();
    }
    return p.y < height + 40;
  });
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  requestAnimationFrame(animateFireworks);
}

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function drawHand(points, isPinched) {
  const w = guide.clientWidth;
  const h = guide.clientHeight;
  guideCtx.clearRect(0, 0, w, h);
  const edges = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
  guideCtx.strokeStyle = isPinched ? "rgba(255,211,106,.9)" : "rgba(112,230,187,.72)";
  guideCtx.lineWidth = 1.3;
  edges.forEach(([a, b]) => {
    guideCtx.beginPath();
    guideCtx.moveTo(points[a].x * w, points[a].y * h);
    guideCtx.lineTo(points[b].x * w, points[b].y * h);
    guideCtx.stroke();
  });
  [4, 8].forEach((i) => {
    guideCtx.fillStyle = isPinched ? "#ffd36a" : "#8df0c9";
    guideCtx.beginPath();
    guideCtx.arc(points[i].x * w, points[i].y * h, 4, 0, Math.PI * 2);
    guideCtx.fill();
  });
}

function processResult(result) {
  const hands = result.landmarks;
  if (!hands?.length) {
    closeFrames = 0;
    smoothedRatio = 1;
    if (performance.now() - lastHandSeenAt > 320) pinched = false;
    pinchMeter.textContent = "Hand not found";
    hintTitle.textContent = "Show your hand";
    hintDetail.textContent = "Keep it inside the camera frame";
    guideCtx.clearRect(0, 0, guide.clientWidth, guide.clientHeight);
    return;
  }

  const points = hands[0];
  lastHandSeenAt = performance.now();
  const pinchDistance = distance(points[4], points[8]);
  const palmWidth = Math.max(distance(points[5], points[17]), .04);
  const ratio = pinchDistance / palmWidth;
  smoothedRatio = smoothedRatio * .55 + ratio * .45;
  const now = performance.now();

  if (!pinched && smoothedRatio < PINCH_CLOSE) {
    closeFrames += 1;
    if (closeFrames >= PINCH_FRAMES && now - lastBurstAt > COOLDOWN_MS) {
      pinched = true;
      const midX = (points[4].x + points[8].x) / 2;
      const midY = (points[4].y + points[8].y) / 2;
      launchBurst((1 - midX) * width, Math.max(80, Math.min(height * .72, midY * height)));
      hintTitle.textContent = "Open your fingers";
      hintDetail.textContent = "Then pinch again for another burst";
    }
  } else if (pinched && smoothedRatio > PINCH_OPEN) {
    pinched = false;
    closeFrames = 0;
    hintTitle.textContent = "Ready — pinch to launch";
    hintDetail.textContent = "Touch thumb and index finger together";
  } else if (smoothedRatio >= PINCH_CLOSE) {
    closeFrames = 0;
  }

  pinchMeter.textContent = pinched ? "Open fingers to reset" : smoothedRatio < .7 ? "Almost there…" : "Ready to pinch";
  drawHand(points, pinched);
}

function trackHands(now) {
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime && now - lastDetectAt > 32) {
    lastVideoTime = video.currentTime;
    lastDetectAt = now;
    try { processResult(landmarker.detectForVideo(video, now)); }
    catch (error) { console.warn("Hand tracking frame skipped", error); }
  }
  requestAnimationFrame(trackHands);
}

function setStatus(message, state = "") {
  statusText.textContent = message;
  statusDot.className = `status-dot ${state}`;
}

function showError(message) {
  toast.textContent = message;
  toast.hidden = false;
  setStatus("Camera unavailable", "error");
}

async function startCamera() {
  startButton.disabled = true;
  startButton.querySelector("span").textContent = "Starting…";
  toast.hidden = true;
  cameraCard.hidden = false;

  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access requires localhost or HTTPS.");
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    video.srcObject = stream;
    await video.play();
    resizeGuide();
    setStatus("Loading hand tracking…");
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: .55,
      minHandPresenceConfidence: .55,
      minTrackingConfidence: .5
    });
    setStatus("Camera ready", "ready");
    welcome.classList.add("leaving");
    setTimeout(() => { welcome.hidden = true; }, 500);
    hint.hidden = false;
    requestAnimationFrame(trackHands);
  } catch (error) {
    console.error(error);
    showError(error.name === "NotAllowedError"
      ? "Camera permission was blocked. Allow camera access in your browser, then reload the page."
      : `Couldn’t start hand tracking. ${error.message || "Check your connection and try again."}`);
    startButton.disabled = false;
    startButton.querySelector("span").textContent = "Try again";
  }
}

startButton.addEventListener("click", startCamera);
demoButton.addEventListener("click", () => launchBurst(width * (.35 + Math.random() * .3), height * (.24 + Math.random() * .3)));
addEventListener("resize", resize);
resize();
requestAnimationFrame(animateFireworks);
