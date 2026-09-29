import { FilesetResolver, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";

const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const PINCH_CLOSE = 0.27;
const PINCH_OPEN = 0.42;
const PINCH_FRAMES = 2;
const COOLDOWN_MS = 520;
const TRACK_INTERVAL_MS = 110;

const canvas = document.querySelector("#fireworks");
const stage = document.querySelector("#stage");
const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
const backgroundCanvas = document.querySelector("#backgroundMotion");
const backgroundCtx = backgroundCanvas.getContext("2d", { alpha: true, desynchronized: true });
const cityVideo = document.querySelector("#cityVideo");
const maskImage = new Image();
const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
const MASK_FEATHER_PX = 8;
const MASK_RISE_RATIO = 0.065;
let maskReady = false;
maskImage.src = "assets/skyline-mask.png";
const fx = document.createElement("canvas");
const fxCtx = fx.getContext("2d", { alpha: true, desynchronized: true });
const grainCanvas = document.querySelector("#grain");
const grainCtx = grainCanvas.getContext("2d", { alpha: true });
const dustSprite = document.createElement("canvas");
dustSprite.width = dustSprite.height = 18;
const dustSpriteCtx = dustSprite.getContext("2d");
const dustGlow = dustSpriteCtx.createRadialGradient(9, 9, 0, 9, 9, 9);
dustGlow.addColorStop(0, "rgba(255,255,255,.9)");
dustGlow.addColorStop(.25, "rgba(255,255,255,.5)");
dustGlow.addColorStop(1, "rgba(255,255,255,0)");
dustSpriteCtx.fillStyle = dustGlow;
dustSpriteCtx.fillRect(0, 0, 18, 18);
function makeLightSprite(center, edge) {
  const sprite = document.createElement("canvas");
  sprite.width = sprite.height = 16;
  const spriteCtx = sprite.getContext("2d");
  const glow = spriteCtx.createRadialGradient(8, 8, 0, 8, 8, 8);
  glow.addColorStop(0, center);
  glow.addColorStop(.22, center);
  glow.addColorStop(1, edge);
  spriteCtx.fillStyle = glow;
  spriteCtx.fillRect(0, 0, 16, 16);
  return sprite;
}
const warmLightSprite = makeLightSprite("rgba(255,230,175,.95)", "rgba(255,174,66,0)");
const coolLightSprite = makeLightSprite("rgba(220,245,255,.9)", "rgba(80,178,255,0)");
const smokeSprite = makeLightSprite("rgba(185,185,180,.38)", "rgba(115,120,125,0)");
const video = document.querySelector("#webcam");
const guide = document.querySelector("#handGuide");
const guideCtx = guide.getContext("2d");
const startButton = document.querySelector("#startButton");
const demoButton = document.querySelector("#demoButton");
const soundToggle = document.querySelector("#soundToggle");
const cameraCard = document.querySelector("#cameraCard");
const statusText = document.querySelector("#statusText");
const statusDot = document.querySelector("#statusDot");
const pinchMeter = document.querySelector("#pinchMeter");
const toast = document.querySelector("#toast");
const gestureHint = document.querySelector("#gestureHint");

let width = 0;
let height = 0;
let dpr = 1;
let particles = [];
let dust = [];
let flares = [];
let cityLights = [];
let headlights = [];
let hazePuffs = [];
let cloudWisps = [];
let sceneGlows = [];
let smoke = [];
let rockets = [];
let landmarker = null;
let lastVideoTime = -1;
let lastDetectAt = 0;
let pinched = false;
let closeFrames = 0;
let smoothedRatio = 1;
let pinchStartedAt = 0;
let chargedPoint = null;
let chargeLevel = 0;
let finalePose = false;
let finalePoseFrames = 0;
let finaleReleaseFrames = 0;
let lastFinaleAt = 0;
let lastBurstAt = 0;
let lastHandSeenAt = performance.now();
let lastBurstType = -1;
let lastPalette = -1;
let soundEnabled = true;
let audioContext = null;
const activeSounds = new Set();

const soundTemplates = {
  single: new Audio("assets/sounds/single-firework.mp3"),
  burst: new Audio("assets/sounds/burst-fireworks.mp3")
};
Object.values(soundTemplates).forEach((sound) => { sound.preload = "auto"; });

function ensureAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!audioContext) audioContext = new AudioContextClass();
  if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
  return audioContext;
}

function playSpatialSound(key, x, { volume, playbackRate, stopAfter } = {}) {
  if (!soundEnabled) return;
  const sound = soundTemplates[key].cloneNode();
  sound.playbackRate = playbackRate ?? 1;
  const context = ensureAudioContext();
  if (!context) {
    sound.volume = volume ?? .5;
    sound.play().catch(() => {});
    return;
  }
  sound.volume = 1;
  const source = context.createMediaElementSource(sound);
  const gain = context.createGain();
  const panner = context.createStereoPanner();
  gain.gain.value = volume ?? .5;
  panner.pan.value = Math.max(-.88, Math.min(.88, (x / width) * 1.76 - .88));
  source.connect(gain).connect(panner).connect(context.destination);
  activeSounds.add(sound);
  sound.addEventListener("ended", () => activeSounds.delete(sound), { once: true });
  canvas.dataset.sound = key;
  canvas.dataset.soundPan = panner.pan.value.toFixed(2);
  canvas.dataset.soundPitch = sound.playbackRate.toFixed(2);
  sound.play().catch(() => {});
  if (stopAfter) setTimeout(() => { sound.pause(); activeSounds.delete(sound); }, stopAfter);
}

function playLaunchWhistle(x) {
  playSpatialSound("single", x, { volume: .2, playbackRate: 1.3 + Math.random() * .32, stopAfter: 820 });
}

function scheduleDistantBoom(type, x) {
  const delay = 500 + Math.random() * 1000;
  canvas.dataset.boomDelay = String(Math.round(delay));
  setTimeout(() => playSpatialSound("burst", x, {
    volume: type === "Willow" ? .46 : .58,
    playbackRate: .78 + Math.random() * .28
  }), delay);
}

const palettes = [
  ["#fff6dc", "#ffc95f", "#e69235"],
  ["#fff1e6", "#ff8b67", "#b9423e"],
  ["#fff9e9", "#f7dfb0", "#d8a65d"],
  ["#f5ffe8", "#a9cf87", "#6f9567"],
  ["#fff3f6", "#d99abb", "#8e6b91"],
  ["#fff8e8", "#e8c795", "#bd7d63"],
  ["#fff2dc", "#f2a05b", "#c95a56"],
  ["#fff8e8", "#d46e62", "#e4b35f", "#92b47d", "#b48ba6"]
];
const paletteNames = ["Gold", "Ruby", "Champagne", "Sage", "Violet", "Copper", "Sunset", "Festival"];
const roadPaths = [
  [[.50,.98],[.53,.94],[.56,.89],[.59,.84]],
  [[.33,.97],[.40,.93],[.47,.89],[.54,.85]],
  [[.77,.97],[.70,.93],[.65,.88],[.60,.84]],
  [[.58,.98],[.61,.94],[.64,.91],[.69,.88]]
];

function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${value >> 16},${(value >> 8) & 255},${value & 255}`;
}

function updateMaskCache() {
  if (!width || !height || !maskImage.complete || !maskImage.naturalWidth) return;
  const sourceWidth = cityVideo.videoWidth || maskImage.naturalWidth;
  const sourceHeight = cityVideo.videoHeight || maskImage.naturalHeight;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = (width - drawWidth) / 2;
  const coverY = (height - drawHeight) / 2;
  // Raise the skyline matte slightly so rockets emerge from behind the distant
  // horizon, then feather its edge so the cutoff never reads as a hard line.
  const maskRise = Math.max(34, Math.min(80, height * MASK_RISE_RATIO));
  const drawY = coverY - maskRise;
  maskCanvas.width = width;
  maskCanvas.height = height;
  maskCtx.clearRect(0, 0, width, height);
  // The supplied mask represents the complete video frame; stretch it into the
  // video's intrinsic frame before applying the identical object-fit: cover transform.
  maskCtx.save();
  maskCtx.filter = `blur(${MASK_FEATHER_PX}px)`;
  maskCtx.drawImage(maskImage, drawX, drawY, drawWidth, drawHeight);
  maskCtx.restore();
  const pixels = maskCtx.getImageData(0, 0, width, height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const luminance = (pixels.data[i] + pixels.data[i + 1] + pixels.data[i + 2]) / 3;
    pixels.data[i] = 255;
    pixels.data[i + 1] = 255;
    pixels.data[i + 2] = 255;
    pixels.data[i + 3] = luminance;
  }
  maskCtx.putImageData(pixels, 0, 0);
  maskReady = true;
  canvas.dataset.mask = "ready";
  canvas.dataset.maskFit = `${Math.round(drawWidth)}x${Math.round(drawHeight)}@${Math.round(drawX)},${Math.round(drawY)}`;
  canvas.dataset.maskFeather = `${MASK_FEATHER_PX}px`;
  canvas.dataset.maskRise = `${Math.round(maskRise)}px`;
}

maskImage.addEventListener("load", updateMaskCache);
cityVideo.addEventListener("loadedmetadata", updateMaskCache);

function getSkylineY(x) {
  if (!maskReady || !height) return height * .86;
  const sampleX = Math.max(0, Math.min(width - 1, Math.round(x)));
  try {
    const column = maskCtx.getImageData(sampleX, 0, 1, height).data;
    for (let y = Math.round(height * .2); y < height; y++) {
      // The feathered matte changes from opaque sky to transparent skyline.
      if (column[y * 4 + 3] < 128) return y;
    }
  } catch (_) {}
  return height * .86;
}

function resize() {
  width = innerWidth;
  height = innerHeight;
  // Fireworks do not need retina resolution; one CSS pixel keeps large screens smooth.
  dpr = 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  backgroundCanvas.width = width;
  backgroundCanvas.height = height;
  updateMaskCache();
  fx.width = Math.max(1, Math.round(width * .5));
  fx.height = Math.max(1, Math.round(height * .5));
  fxCtx.setTransform(.5, 0, 0, .5, 0, 0);
  grainCanvas.width = 320;
  grainCanvas.height = 180;
  const grainImage = grainCtx.createImageData(grainCanvas.width, grainCanvas.height);
  for (let i = 0; i < grainImage.data.length; i += 4) {
    const shade = 120 + Math.floor(Math.random() * 110);
    grainImage.data[i] = shade;
    grainImage.data[i + 1] = shade * .86;
    grainImage.data[i + 2] = shade * .68;
    grainImage.data[i + 3] = 28 + Math.floor(Math.random() * 32);
  }
  grainCtx.putImageData(grainImage, 0, 0);
  cityLights = Array.from({ length: 150 }, () => ({
    x: Math.random() * width,
    y: height * (.795 + Math.random() * .18),
    size: .28 + Math.random() * .62,
    phase: Math.random() * Math.PI * 2,
    speed: .00035 + Math.random() * .0011,
    warmth: Math.random()
  }));
  headlights = Array.from({ length: 9 }, (_, index) => ({
    path: index % roadPaths.length,
    progress: Math.random(),
    speed: .009 + Math.random() * .012,
    color: index % 3 === 0 ? "#ff9d70" : "#fff4c9"
  }));
  hazePuffs = Array.from({ length: 7 }, () => ({
    x: Math.random() * width,
    y: height * (.70 + Math.random() * .095),
    width: width * (.16 + Math.random() * .18),
    speed: .25 + Math.random() * .35,
    phase: Math.random() * Math.PI * 2
  }));
  cloudWisps = Array.from({ length: 5 }, () => ({
    x: width * (.58 + Math.random() * .42),
    y: height * (.54 + Math.random() * .19),
    width: width * (.10 + Math.random() * .12),
    speed: -.45 - Math.random() * .55,
    alpha: .018 + Math.random() * .025
  }));
  resizeGuide();
}

function resizeGuide() {
  const rect = guide.getBoundingClientRect();
  guide.width = Math.max(1, Math.round(rect.width));
  guide.height = Math.max(1, Math.round(rect.height));
}

function launchBurst(x, y, explode = false, sizeBoost = 1, gesture = "pinch") {
  const now = performance.now();
  const skylineY = getSkylineY(x);
  const highestSafeBurst = Math.max(height * .18, skylineY - height * .08);
  const targetY = Math.max(height * .05, Math.min(height * .55, highestSafeBurst, y));
  if (!explode) {
    const launchDuration = 680;
    // Begin just behind the local skyline so every launch follows the actual mask.
    const startY = Math.min(height - 8, skylineY + Math.max(16, height * .025));
    rockets.push({ x, startY, targetY, born: now, duration: launchDuration, sizeBoost });
    canvas.dataset.launchY = (startY / height).toFixed(2);
    canvas.dataset.skylineY = (skylineY / height).toFixed(2);
    canvas.dataset.stage = "launch";
    canvas.dataset.gesture = gesture;
    playLaunchWhistle(x);
    lastBurstAt = now;
    setTimeout(() => launchBurst(x, targetY, true, sizeBoost, gesture), launchDuration - 15);
    return "Launching";
  }
  y = targetY;
  const lowPower = (navigator.hardwareConcurrency || 4) <= 4 || matchMedia("(max-width: 700px)").matches;
  let quality = lowPower ? .66 : .88;
  const baseRadiusRatio = Math.random() < .2 ? .27 + Math.random() * .055 : .15 + Math.random() * .085;
  const radiusRatio = Math.min(.46, baseRadiusRatio * sizeBoost * .72);
  if (radiusRatio > .36) quality *= .62;
  else if (radiusRatio > .27) quality *= .72;
  else if (radiusRatio > .2) quality *= .82;
  else if (radiusRatio > .15) quality *= .9;
  const radius = Math.min(width, height) * radiusRatio;
  const types = ["Chrysanthemum", "Willow", "Palm", "Peony", "Heart"];
  let typeIndex;
  do { typeIndex = Math.floor(Math.random() * types.length); } while (typeIndex === lastBurstType);
  lastBurstType = typeIndex;
  const type = types[typeIndex];
  let paletteIndex;
  do { paletteIndex = Math.floor(Math.random() * palettes.length); } while (paletteIndex === lastPalette);
  lastPalette = paletteIndex;
  const palette = palettes[paletteIndex];
  const gold = ["#fff7d1", "#ffd166", "#ff9f43"];

  canvas.dataset.bursts = String(Number(canvas.dataset.bursts || 0) + 1);
  canvas.dataset.type = type;
  canvas.dataset.palette = paletteNames[paletteIndex];
  canvas.dataset.size = radiusRatio.toFixed(2);
  canvas.dataset.burstY = (y / height).toFixed(2);
  canvas.dataset.stage = "burst";
  flares.push({ x, y, born: now, color: type === "Willow" || type === "Palm" ? gold[0] : palette[0] });
  sceneGlows.push({ x, y, born: now, duration: sizeBoost > 1 ? 1350 : 1050, rgb: hexToRgb(palette[Math.min(1, palette.length - 1)]) });
  for (let i = 0; i < (sizeBoost > 1 ? 7 : 4); i++) {
    smoke.push({
      x: x + (Math.random() - .5) * radius * .42,
      y: y + (Math.random() - .5) * radius * .24,
      vx: 3 + Math.random() * 7,
      vy: -2 - Math.random() * 5,
      size: radius * (.36 + Math.random() * .38),
      born: now,
      duration: 4200 + Math.random() * 2400,
      phase: Math.random() * Math.PI * 2
    });
  }
  scheduleDistantBoom(type, x);

  const addParticle = (vx, vy, options = {}) => {
    const headStart = options.headStart ?? (8 + Math.random() * 14);
    const magnitude = Math.hypot(vx, vy) || 1;
    particles.push({
      x: x + (vx / magnitude) * headStart,
      y: y + (vy / magnitude) * headStart,
      oldX: x,
      oldY: y,
      vx,
      vy,
      life: options.life ?? 1.12,
      decay: options.decay ?? (0.2 + Math.random() * 0.07),
      drag: options.drag ?? (0.94 + Math.random() * 0.025),
      gravity: options.gravity ?? (62 + Math.random() * 42),
      width: options.width ?? (1.2 + Math.random() * 1.8),
      color: options.color ?? palette[Math.floor(Math.random() * palette.length)],
      born: now,
      twinkle: Math.random() * Math.PI * 2,
      glitter: options.glitter ?? Math.random() > .45,
      trailMs: options.trailMs ?? 420,
      maxHistory: options.maxHistory ?? 28,
      history: [{ x, y, at: now }],
      lastTrailSample: now,
      diedAt: null,
      jitter: options.jitter ?? 0
    });
  };

  if (type === "Chrysanthemum") {
    const count = Math.round(132 * quality);
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - .5) * .055;
      const power = radius * (.38 + Math.pow(Math.random(), .68) * .82) * (i % 5 === 0 ? 1.08 : 1);
      addParticle(Math.cos(angle) * power, Math.sin(angle) * power, {
        color: Math.random() > .3 ? palette[Math.floor(Math.random() * palette.length)] : gold[Math.floor(Math.random() * gold.length)], trailMs: 650, drag: .965,
        decay: .15 + Math.random() * .05, gravity: 58 + Math.random() * 22, glitter: true
      });
    }
  } else if (type === "Willow") {
    const count = Math.round(100 * quality);
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - .5) * .08;
      const power = radius * (.38 + Math.pow(Math.random(), .7) * .7);
      addParticle(Math.cos(angle) * power, Math.sin(angle) * power, {
        color: Math.random() > .72 ? palette[1 + Math.floor(Math.random() * (palette.length - 1))] : gold[1 + Math.floor(Math.random() * 2)], trailMs: 900, width: 1.45 + Math.random() * 1.2,
        drag: .953, decay: .115 + Math.random() * .035, gravity: 92 + Math.random() * 28, glitter: Math.random() > .7
      });
    }
  } else if (type === "Palm") {
    const arms = lowPower ? 8 : 11;
    const perArm = lowPower ? 7 : 8;
    for (let arm = 0; arm < arms; arm++) {
      const baseAngle = (Math.PI * 2 * arm) / arms + Math.random() * .18;
      for (let j = 0; j < perArm; j++) {
        const angle = baseAngle + (Math.random() - .5) * .075;
        const power = radius * (.63 + (j / perArm) * .58 + Math.random() * .08);
        addParticle(Math.cos(angle) * power, Math.sin(angle) * power, {
          color: Math.random() > .48 ? palette[Math.floor(Math.random() * palette.length)] : gold[Math.floor(Math.random() * gold.length)], trailMs: 760, width: 1.55 + Math.random() * 1.45,
          drag: .96, decay: .14 + Math.random() * .045, gravity: 76 + Math.random() * 22, glitter: j > perArm * .55
        });
      }
    }
  } else if (type === "Heart") {
    const layers = [1, .76, .52, .3];
    for (const layer of layers) {
      const count = Math.round((29 + layer * 13) * quality);
      const offset = Math.random() * .12;
      for (let i = 0; i < count; i++) {
        const t = (Math.PI * 2 * i) / count + offset;
        const hx = 16 * Math.pow(Math.sin(t), 3);
        const hy = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
        const scale = (radius / 19) * layer;
        const jitter = .92 + Math.random() * .16;
        addParticle(hx * scale * jitter, hy * scale * jitter, {
          color: Math.random() > .2 ? palette[Math.floor(Math.random() * palette.length)] : "#fff6f1",
          trailMs: 500, drag: .972, width: 1.2 + layer * 1.2 + Math.random() * .7,
          decay: .18 + Math.random() * .045, gravity: 36 + Math.random() * 16, glitter: true, headStart: 3
        });
      }
    }
  } else {
    const count = Math.round(122 * quality);
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * .1;
      const power = radius * (.22 + Math.pow(Math.random(), .72) * .92);
      addParticle(Math.cos(angle) * power, Math.sin(angle) * power, {
        trailMs: 440, drag: .947, decay: .21 + Math.random() * .065,
        gravity: 52 + Math.random() * 28, glitter: Math.random() > .32, jitter: 5
      });
    }
  }

  if (type !== "Heart") {
    const pistilCount = Math.round(22 * quality);
    for (let i = 0; i < pistilCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const power = radius * (.16 + Math.random() * .3);
      addParticle(Math.cos(angle) * power, Math.sin(angle) * power, {
        color: Math.random() > .35 ? "#fffbe7" : gold[1], trailMs: 360,
        width: 1.4 + Math.random() * 1.2, drag: .95, decay: .24 + Math.random() * .06,
        gravity: 42 + Math.random() * 20, glitter: true, headStart: 3
      });
    }
  }

  const dustCount = Math.round(30 * quality);
  for (let i = 0; i < dustCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = radius * (.18 + Math.random() * .58);
    dust.push({
      x: x + (Math.random() - .5) * 12,
      y: y + (Math.random() - .5) * 12,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      decay: .28 + Math.random() * .24,
      drag: .94 + Math.random() * .035,
      gravity: 28 + Math.random() * 34,
      size: .8 + Math.random() * 2.2,
      color: Math.random() > .25 ? palette[Math.floor(Math.random() * palette.length)] : "#fff8e8",
      born: now,
      trailMs: 260,
      maxHistory: 14,
      history: [{ x, y, at: now }],
      lastTrailSample: now,
      diedAt: null
    });
  }

  // Keep rapid successive pinches smooth while preserving several layered bursts.
  if (particles.length > 680) particles.splice(0, particles.length - 680);
  if (dust.length > 180) dust.splice(0, dust.length - 180);

  lastBurstAt = now;
  return `${paletteNames[paletteIndex]} ${type}`;
}

function pointOnRoad(path, progress) {
  const scaled = Math.min(.9999, progress) * (path.length - 1);
  const index = Math.floor(scaled);
  const local = scaled - index;
  const start = path[index];
  const end = path[index + 1];
  return {
    x: (start[0] + (end[0] - start[0]) * local) * width,
    y: (start[1] + (end[1] - start[1]) * local) * height
  };
}

function animateBackground(now) {
  requestAnimationFrame(animateBackground);
  if (animateBackground.last && now - animateBackground.last < 100) return;
  const dt = Math.min((animateBackground.last ? now - animateBackground.last : 100) / 1000, .15);
  animateBackground.last = now;
  backgroundCtx.clearRect(0, 0, width, height);
  backgroundCtx.globalCompositeOperation = "screen";

  cityLights.forEach((light) => {
    const pulse = .055 + (Math.sin(now * light.speed + light.phase) + 1) * .055;
    backgroundCtx.globalAlpha = pulse;
    const size = 2.2 + light.size * 3.4;
    backgroundCtx.drawImage(light.warmth > .22 ? warmLightSprite : coolLightSprite, light.x - size / 2, light.y - size / 2, size, size);
  });

  headlights.forEach((headlight) => {
    headlight.progress = (headlight.progress + headlight.speed * dt) % 1;
    const point = pointOnRoad(roadPaths[headlight.path], headlight.progress);
    backgroundCtx.globalAlpha = .28;
    backgroundCtx.fillStyle = headlight.color;
    backgroundCtx.beginPath();
    backgroundCtx.arc(point.x, point.y, .75, 0, Math.PI * 2);
    backgroundCtx.fill();
    backgroundCtx.globalAlpha = .12;
    backgroundCtx.drawImage(warmLightSprite, point.x - 3, point.y - 3, 6, 6);
  });

  hazePuffs.forEach((puff) => {
    puff.x += puff.speed * dt;
    if (puff.x - puff.width / 2 > width) puff.x = -puff.width / 2;
    backgroundCtx.globalAlpha = .016 + (Math.sin(now * .00012 + puff.phase) + 1) * .006;
    backgroundCtx.drawImage(smokeSprite, puff.x - puff.width / 2, puff.y - height * .035, puff.width, height * .07);
  });

  cloudWisps.forEach((cloud) => {
    cloud.x += cloud.speed * dt;
    if (cloud.x + cloud.width < width * .55) cloud.x = width + cloud.width * .2;
    backgroundCtx.globalAlpha = cloud.alpha * (.8 + Math.sin(now * .00009 + cloud.y) * .2);
    backgroundCtx.drawImage(smokeSprite, cloud.x - cloud.width / 2, cloud.y - height * .035, cloud.width, height * .07);
  });

  backgroundCtx.globalAlpha = 1;
  backgroundCtx.globalCompositeOperation = "source-over";
  backgroundCanvas.dataset.frames = String(Number(backgroundCanvas.dataset.frames || 0) + 1);
  backgroundCanvas.dataset.twinkles = String(cityLights.length);
  backgroundCanvas.dataset.headlights = String(headlights.length);
  backgroundCanvas.dataset.clouds = String(cloudWisps.length);
}

function animateFireworks(now) {
  requestAnimationFrame(animateFireworks);
  if (animateFireworks.last && now - animateFireworks.last < 1000 / 45) return;
  try {
    const dt = Math.min((animateFireworks.last ? now - animateFireworks.last : 16) / 1000, 0.033);
    animateFireworks.last = now;
    canvas.dataset.frames = String(Number(canvas.dataset.frames || 0) + 1);
    ctx.clearRect(0, 0, width, height);
    fxCtx.save();
    fxCtx.setTransform(1, 0, 0, 1, 0, 0);
    fxCtx.clearRect(0, 0, fx.width, fx.height);
    fxCtx.restore();
    ctx.globalCompositeOperation = "screen";

    sceneGlows = sceneGlows.filter((glow) => {
      const life = 1 - (now - glow.born) / glow.duration;
      if (life <= 0) return false;
      const radius = Math.min(620, Math.max(width, height) * .42);
      const gradient = ctx.createRadialGradient(glow.x, glow.y, 0, glow.x, glow.y, radius);
      gradient.addColorStop(0, `rgba(${glow.rgb},${.19 * life})`);
      gradient.addColorStop(.34, `rgba(${glow.rgb},${.09 * life})`);
      gradient.addColorStop(1, `rgba(${glow.rgb},0)`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      const wash = ctx.createLinearGradient(0, height * .68, 0, height);
      wash.addColorStop(0, `rgba(${glow.rgb},0)`);
      wash.addColorStop(1, `rgba(${glow.rgb},${.065 * life})`);
      ctx.fillStyle = wash;
      ctx.fillRect(0, height * .68, width, height * .32);
      return true;
    });

    smoke = smoke.filter((puff) => {
      const age = (now - puff.born) / puff.duration;
      if (age >= 1) return false;
      puff.x += puff.vx * dt;
      puff.y += puff.vy * dt;
      const alpha = Math.sin(Math.min(1, age * 2.5) * Math.PI / 2) * (1 - age) * .13;
      const size = puff.size * (1 + age * .7);
      ctx.globalAlpha = alpha * (sceneGlows.length ? 1.35 : 1);
      ctx.drawImage(smokeSprite, puff.x - size / 2, puff.y - size / 2, size, size * .72);
      return true;
    });

    fxCtx.globalCompositeOperation = "lighter";
    rockets = rockets.filter((rocket) => {
      const age = (now - rocket.born) / rocket.duration;
      if (age >= 1) return false;
      const eased = 1 - Math.pow(1 - age, 2.2);
      const y = rocket.startY + (rocket.targetY - rocket.startY) * eased;
      const trail = 28 + age * 42;
      const grad = fxCtx.createLinearGradient(rocket.x, y, rocket.x, y + trail);
      grad.addColorStop(0, "rgba(255,252,224,.98)");
      grad.addColorStop(.25, "rgba(255,191,88,.78)");
      grad.addColorStop(1, "rgba(255,150,55,0)");
      fxCtx.strokeStyle = grad;
      fxCtx.lineWidth = 1.7 * Math.min(1.5, rocket.sizeBoost || 1);
      fxCtx.beginPath();
      fxCtx.moveTo(rocket.x, y);
      fxCtx.lineTo(rocket.x + Math.sin(age * 17) * 2, y + trail);
      fxCtx.stroke();
      return true;
    });

    flares = flares.filter((flare) => {
      const age = (now - flare.born) / 170;
      if (age >= 1) return false;
      const glow = 52 * (1 - age);
      const grad = fxCtx.createRadialGradient(flare.x, flare.y, 0, flare.x, flare.y, glow);
      grad.addColorStop(0, `rgba(255,255,245,${.88 * (1 - age)})`);
      grad.addColorStop(.18, `${flare.color}88`);
      grad.addColorStop(1, "transparent");
      fxCtx.fillStyle = grad;
      fxCtx.beginPath();
      fxCtx.arc(flare.x, flare.y, glow, 0, Math.PI * 2);
      fxCtx.fill();
      return true;
    });

    const updateTrail = (p, sampleInterval = 32) => {
      if (now - p.lastTrailSample >= sampleInterval) {
        p.history.push({ x: p.x, y: p.y, at: now });
        p.lastTrailSample = now;
      }
      const trailCutoff = now - p.trailMs;
      while (p.history.length > 2 && p.history[0].at < trailCutoff) p.history.shift();
      while (p.history.length > p.maxHistory) p.history.shift();
    };

    const drawTrail = (p, alpha, widthScale = 1) => {
      const points = [...p.history, { x: p.x, y: p.y, at: now }];
      fxCtx.strokeStyle = now - p.born < 115 ? "#fffdf2" : p.color;
      fxCtx.lineCap = "round";
      fxCtx.lineJoin = "round";
      for (let i = 1; i < points.length; i++) {
        const segmentAge = Math.max(0, now - points[i].at);
        const segmentFade = Math.max(0, 1 - segmentAge / p.trailMs);
        if (segmentFade <= 0) continue;
        fxCtx.globalAlpha = alpha * segmentFade * .62;
        fxCtx.lineWidth = p.width * widthScale * (.45 + segmentFade * .55);
        fxCtx.beginPath();
        fxCtx.moveTo(points[i - 1].x, points[i - 1].y);
        fxCtx.lineTo(points[i].x, points[i].y);
        fxCtx.stroke();
      }
    };

    particles = particles.filter((p) => {
      if (p.life > 0) {
        p.life = Math.max(0, p.life - p.decay * dt);
        if (p.jitter) {
          p.vx += (Math.random() - .5) * p.jitter;
          p.vy += (Math.random() - .5) * p.jitter;
        }
        p.vx *= Math.pow(p.drag, dt * 60);
        const dying = 1 - Math.min(1, p.life);
        p.vy = p.vy * Math.pow(p.drag, dt * 60) + p.gravity * dt * (1.05 + dying * 1.7);
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        updateTrail(p);
        if (p.life <= 0) p.diedAt = now;
      }
      const tailFade = p.diedAt === null ? 1 : Math.max(0, 1 - (now - p.diedAt) / p.trailMs);
      if (tailFade <= 0) return false;
      const flicker = .65 + Math.sin(now * .025 + p.twinkle) * .3;
      const alpha = (p.life > 0 ? Math.min(1, p.life) : tailFade) * flicker;
      drawTrail(p, alpha, Math.max(.4, p.life) * .76);
      const brightFrom = p.history[Math.max(0, p.history.length - 3)];
      if (p.life > 0) {
        fxCtx.globalAlpha = alpha;
        fxCtx.lineWidth = p.width * Math.max(.5, p.life);
        fxCtx.beginPath();
        fxCtx.moveTo(brightFrom.x, brightFrom.y);
        fxCtx.lineTo(p.x, p.y);
        fxCtx.stroke();
      }
      if (p.life > 0 && p.glitter && Math.sin(now * .045 + p.twinkle) > .48) {
        fxCtx.globalAlpha = Math.min(1, alpha + .25);
        fxCtx.fillStyle = "#fffbea";
        fxCtx.beginPath();
        fxCtx.arc(p.x, p.y, Math.max(.8, p.width * .65), 0, Math.PI * 2);
        fxCtx.fill();
      }
      return p.y < height + 30 || p.diedAt !== null;
    });

    dust = dust.filter((p) => {
      if (p.life > 0) {
        p.life = Math.max(0, p.life - p.decay * dt);
        p.vx *= Math.pow(p.drag, dt * 60);
        p.vy = p.vy * Math.pow(p.drag, dt * 60) + p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        updateTrail(p, 38);
        if (p.life <= 0) p.diedAt = now;
      }
      const tailFade = p.diedAt === null ? 1 : Math.max(0, 1 - (now - p.diedAt) / p.trailMs);
      if (tailFade <= 0) return false;
      const alpha = (p.life > 0 ? p.life : tailFade) * .5;
      p.width = Math.max(.65, p.size * .55);
      drawTrail(p, alpha, .7);
      if (p.life > 0) {
        fxCtx.globalAlpha = alpha;
        const spriteSize = p.size * (4 + p.life * 3);
        fxCtx.drawImage(dustSprite, p.x - spriteSize / 2, p.y - spriteSize / 2, spriteSize, spriteSize);
      }
      return p.y < height + 30 || p.diedAt !== null;
    });

    fxCtx.globalAlpha = 1;
    if (maskReady) {
      fxCtx.save();
      fxCtx.setTransform(1, 0, 0, 1, 0, 0);
      fxCtx.globalCompositeOperation = "destination-in";
      fxCtx.drawImage(maskCanvas, 0, 0, fx.width, fx.height);
      fxCtx.restore();
    }
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = .42;
    ctx.filter = "blur(3.5px)";
    ctx.drawImage(fx, 0, 0, width, height);
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.drawImage(fx, 0, 0, width, height);
    if (maskReady) {
      ctx.save();
      ctx.globalCompositeOperation = "destination-in";
      ctx.globalAlpha = 1;
      ctx.drawImage(maskCanvas, 0, 0, width, height);
      ctx.restore();
    }
    ctx.globalCompositeOperation = "source-over";
    canvas.dataset.particles = String(particles.length);
    canvas.dataset.dust = String(dust.length);
    canvas.dataset.smoke = String(smoke.length);
    canvas.dataset.glows = String(sceneGlows.length);
  } catch (error) {
    canvas.dataset.animationError = error?.message || String(error);
    console.error("Firework animation recovered from a bad frame", error);
  }
}

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function launchFinale(x, y) {
  const shots = 14;
  canvas.dataset.gesture = "finale";
  for (let i = 0; i < shots; i++) {
    setTimeout(() => {
      const lane = (i + .5) / shots;
      const targetX = Math.max(width * .04, Math.min(width * .96,
        lane * width + (Math.random() - .5) * width * .09));
      const targetY = height * (.08 + Math.random() * .44);
      const heroShell = i % 5 === 2;
      const sizeBoost = heroShell ? 1.65 + Math.random() * .55 : .68 + Math.random() * .82;
      launchBurst(targetX, targetY, false, sizeBoost, "finale");
    }, i * 165 + Math.random() * 85);
  }
}

function drawHand(points, isPinched, charge = 0) {
  const w = guide.width;
  const h = guide.height;
  guideCtx.clearRect(0, 0, w, h);
  const edges = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
  guideCtx.strokeStyle = isPinched ? "rgba(255,211,106,.98)" : "rgba(255,226,166,.78)";
  guideCtx.lineWidth = isPinched ? 2 : 1.35;
  guideCtx.lineCap = "round";
  edges.forEach(([a, b]) => {
    guideCtx.beginPath();
    guideCtx.moveTo(points[a].x * w, points[a].y * h);
    guideCtx.lineTo(points[b].x * w, points[b].y * h);
    guideCtx.stroke();
  });
  [4, 8].forEach((i) => {
    guideCtx.fillStyle = isPinched ? "#ffd36a" : "#ffe4ae";
    guideCtx.shadowColor = "#ffd36a";
    guideCtx.shadowBlur = isPinched ? 10 : 4;
    guideCtx.beginPath();
    guideCtx.arc(points[i].x * w, points[i].y * h, isPinched ? 4.5 : 3.2, 0, Math.PI * 2);
    guideCtx.fill();
  });
  const indexX = points[8].x * w;
  const indexY = points[8].y * h;
  guideCtx.fillStyle = "#fff4c9";
  guideCtx.shadowColor = "#ffd36a";
  guideCtx.shadowBlur = 14;
  guideCtx.beginPath();
  guideCtx.arc(indexX, indexY, 3.8, 0, Math.PI * 2);
  guideCtx.fill();
  if (isPinched) {
    guideCtx.shadowBlur = 8;
    guideCtx.strokeStyle = `rgba(255,211,106,${.5 + charge * .5})`;
    guideCtx.lineWidth = 2.4;
    guideCtx.beginPath();
    guideCtx.arc(indexX, indexY, 11 + charge * 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * charge);
    guideCtx.stroke();
  }
  guideCtx.shadowBlur = 0;
}

function processResult(result) {
  const hands = result.landmarks;
  if (!hands?.length) {
    closeFrames = 0;
    smoothedRatio = 1;
    if (performance.now() - lastHandSeenAt > 320) {
      pinched = false;
      chargeLevel = 0;
      chargedPoint = null;
    }
    pinchMeter.textContent = "Hand not found";
    guideCtx.clearRect(0, 0, guide.width, guide.height);
    return;
  }

  const points = hands[0];
  lastHandSeenAt = performance.now();
  gestureHint.classList.remove("visible");
  const pinchDistance = distance(points[4], points[8]);
  const palmScale = Math.max((distance(points[5], points[17]) + distance(points[0], points[9])) / 2, .04);
  const ratio = pinchDistance / palmScale;
  smoothedRatio = smoothedRatio * .55 + ratio * .45;
  const now = performance.now();
  const fingertipTouches = [8, 12, 16, 20].map((tip) => distance(points[4], points[tip]) / palmScale);
  const finaleCandidate = fingertipTouches.every((touchRatio) => touchRatio < .5);

  if (finaleCandidate) {
    finalePoseFrames += 1;
    finaleReleaseFrames = 0;
    if (!finalePose && finalePoseFrames >= 3 && now - lastFinaleAt > 3200) {
      finalePose = true;
      lastFinaleAt = now;
      pinched = false;
      closeFrames = 0;
      chargeLevel = 0;
      chargedPoint = null;
      launchFinale((1 - points[9].x) * width, points[9].y * height);
      pinchMeter.textContent = "Finale!";
    }
  } else {
    finalePoseFrames = 0;
    finaleReleaseFrames += 1;
    if (finaleReleaseFrames >= 3) finalePose = false;
  }

  if (!finalePose && !pinched && smoothedRatio < PINCH_CLOSE) {
    closeFrames += 1;
    if (closeFrames >= PINCH_FRAMES && now - lastBurstAt > COOLDOWN_MS) {
      pinched = true;
      pinchStartedAt = now;
      chargeLevel = 0;
    }
  } else if (pinched && smoothedRatio > PINCH_OPEN) {
    const point = chargedPoint;
    // A complete hold earns a deliberately oversized hero shell.
    const sizeBoost = .72 + chargeLevel * 1.18 + Math.pow(chargeLevel, 5) * 1.55;
    pinched = false;
    closeFrames = 0;
    chargeLevel = 0;
    chargedPoint = null;
    if (point) launchBurst(point.x, point.y, false, sizeBoost, "charged-pinch");
  } else if (smoothedRatio >= PINCH_CLOSE) {
    closeFrames = 0;
  }

  if (pinched) {
    const midX = (points[4].x + points[8].x) / 2;
    const midY = (points[4].y + points[8].y) / 2;
    chargedPoint = { x: (1 - midX) * width, y: midY * height };
    chargeLevel = Math.min(1, (now - pinchStartedAt) / 2200);
    canvas.dataset.charge = chargeLevel.toFixed(2);
    pinchMeter.textContent = `Charging ${Math.round(chargeLevel * 100)}%`;
  } else if (!finalePose) {
    pinchMeter.textContent = finaleCandidate ? "Touch all fingertips to thumb" : "Pinch and hold";
  }
  drawHand(points, pinched, chargeLevel);
}

function trackHands(now) {
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime && now - lastDetectAt > TRACK_INTERVAL_MS) {
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
  if (startCamera.pending || landmarker) return;
  startCamera.pending = true;
  startButton.hidden = true;
  startButton.disabled = true;
  startButton.querySelector("span").textContent = "Starting…";
  toast.hidden = true;
  cameraCard.hidden = false;

  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access requires localhost or HTTPS.");
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } }, audio: false });
    video.srcObject = stream;
    await video.play();
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
    requestAnimationFrame(trackHands);
  } catch (error) {
    console.error(error);
    showError(error.name === "NotAllowedError"
      ? "Camera access needs your permission. Select Try again when you’re ready."
      : `Couldn’t start hand tracking. ${error.message || "Check your connection and try again."}`);
    startButton.disabled = false;
    startButton.hidden = false;
    startButton.querySelector("span").textContent = "Try again";
  } finally {
    startCamera.pending = false;
  }
}

startButton.addEventListener("click", startCamera);
demoButton.addEventListener("click", () => launchBurst(width * (.35 + Math.random() * .3), height * (.24 + Math.random() * .3)));
soundToggle.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  if (!soundEnabled) {
    activeSounds.forEach((sound) => { sound.pause(); sound.currentTime = 0; });
    activeSounds.clear();
  }
  soundToggle.setAttribute("aria-pressed", String(soundEnabled));
  soundToggle.setAttribute("aria-label", soundEnabled ? "Turn firework sounds off" : "Turn firework sounds on");
  soundToggle.querySelector("span:first-child").textContent = soundEnabled ? "🔊" : "🔇";
  soundToggle.querySelector("span:last-child").textContent = soundEnabled ? "Sound on" : "Sound off";
});
addEventListener("pointerdown", ensureAudioContext, { passive: true });
stage.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button, .camera-card")) return;
  launchBurst(event.clientX, event.clientY, false, .9, "tap");
});
setInterval(() => {
  gestureHint.classList.toggle("visible", performance.now() - lastHandSeenAt >= 3000);
}, 250);
addEventListener("resize", resize);
resize();
requestAnimationFrame(animateBackground);
requestAnimationFrame(animateFireworks);
startCamera();
