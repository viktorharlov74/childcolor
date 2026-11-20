"use strict";

const DrawingTools = (() => {
  const checkInterval = 8000;
  const completionPercent = 98;
  const solidAlpha = 128;
  const svgNamespace = "http://www.w3.org/2000/svg";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let localLineworkRequest = null;

  class DrawingResults {
    constructor() {
      this.cache = new Map();
    }

    key(id) {
      return `childcolor.completed-${id}.v1`;
    }

    get(id) {
      if (!this.cache.has(id)) {
        let paint = null;
        try {
          const stored = localStorage.getItem(this.key(id));
          if (stored?.startsWith("data:image/png;base64,")) paint = stored;
        } catch {}
        this.cache.set(id, paint);
      }
      return this.cache.get(id);
    }

    set(id, paint) {
      this.cache.set(id, paint);
      try {
        if (paint) localStorage.setItem(this.key(id), paint);
        else localStorage.removeItem(this.key(id));
      } catch {}
    }
  }

  class DrawingSession {
    constructor(canvas, context, results, onComplete) {
      this.canvas = canvas;
      this.context = context;
      this.results = results;
      this.onComplete = onComplete;
      this.current = null;
      this.timer = null;
    }

    get drawing() {
      return this.current?.drawing;
    }

    get isPainting() {
      return Boolean(this.current && !this.current.complete);
    }

    open(drawing) {
      this.close();
      const paint = this.results.get(drawing.id);
      this.current = { drawing, complete: Boolean(paint), dirty: false, mask: null, area: 0 };
      return paint;
    }

    start() {
      if (this.isPainting && this.timer === null) {
        this.timer = setInterval(() => this.checkCoverage(), checkInterval);
      }
    }

    stopChecking() {
      clearInterval(this.timer);
      this.timer = null;
    }

    close() {
      this.stopChecking();
      this.current = null;
      this.clearPaint();
    }

    clearPaint() {
      if (this.current) this.current.dirty = false;
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    markPainted() {
      if (this.isPainting) this.current.dirty = true;
    }

    async restore(paint) {
      const current = this.current;
      const image = new Image();
      image.src = paint;
      try {
        await image.decode();
        if (this.current !== current) return "stale";
        this.context.save();
        this.context.clip(current.drawing.silhouette);
        this.context.drawImage(image, 0, 0);
        this.context.restore();
        return "restored";
      } catch {
        return this.current === current ? "invalid" : "stale";
      }
    }

    checkCoverage() {
      const current = this.current;
      if (!current || current.complete || !current.dirty) return;
      current.dirty = false;

      const { width, height } = this.canvas;
      if (!current.mask) {
        const mask = document.createElement("canvas");
        mask.width = width;
        mask.height = height;
        const maskContext = mask.getContext("2d");
        maskContext.fill(current.drawing.silhouette);
        current.mask = maskContext.getImageData(0, 0, width, height).data;
        for (let index = 3; index < current.mask.length; index += 4) {
          if (current.mask[index] >= solidAlpha) current.area++;
        }
      }

      const paint = this.context.getImageData(0, 0, width, height).data;
      let colored = 0;
      for (let index = 3; index < current.mask.length; index += 4) {
        if (current.mask[index] >= solidAlpha && paint[index] >= solidAlpha) colored++;
      }
      if (!current.area || colored * 100 < current.area * completionPercent) return;

      this.stopChecking();
      current.complete = true;
      current.mask = null;
      this.results.set(current.drawing.id, this.canvas.toDataURL("image/png"));
      this.onComplete(current.drawing);
    }
  }

  class DrawingSound {
    constructor(musicUrl) {
      this.music = new Audio();
      this.music.preload = "none";
      this.music.loop = true;
      this.music.src = musicUrl;
      this.effect = new Audio();
      this.effect.preload = "none";
      this.enabled = true;
      this.context = null;
      this.chime = null;
      this.completionBuffers = new Map();
      this.soundGeneration = 0;
    }

    startMusic(completionSound) {
      if (!this.enabled) return;
      const AudioEngine = window.AudioContext || window.webkitAudioContext;
      if (AudioEngine) {
        this.context ??= new AudioEngine();
        this.context.resume().catch(() => {});
        if (completionSound) this.loadCompletion(completionSound).catch(() => {});
      }
      this.resumeMusic();
    }

    resumeMusic() {
      if (this.enabled) this.music.play().catch(() => {});
    }

    pause() {
      this.soundGeneration++;
      this.music.pause();
      this.effect.pause();
    }

    stop() {
      this.pause();
      this.music.currentTime = 0;
      this.effect.currentTime = 0;
      this.chime?.disconnect();
      this.chime = null;
    }

    loadCompletion(name) {
      if (!this.completionBuffers.has(name)) {
        const source = window.childcolorSounds?.[name];
        const request = fetch(source)
          .then(response => {
            if (!response.ok) throw new Error("Completion sound could not be loaded");
            return response.arrayBuffer();
          })
          .then(bytes => this.context.decodeAudioData(bytes));
        this.completionBuffers.set(name, request);
        request.catch(() => this.completionBuffers.delete(name));
      }
      return this.completionBuffers.get(name);
    }

    playCompletion(name) {
      this.music.pause();
      const audio = this.context;
      if (!this.enabled || audio?.state !== "running") return;

      if (name) {
        const generation = ++this.soundGeneration;
        this.loadCompletion(name).then(buffer => {
          if (!this.enabled || this.soundGeneration !== generation || audio.state !== "running") return;
          const bark = audio.createBufferSource();
          bark.buffer = buffer;
          this.chime?.disconnect();
          this.chime = audio.createGain();
          bark.connect(this.chime).connect(audio.destination);
          bark.start();
        }).catch(() => {});
        return;
      }

      this.chime = audio.createGain();
      this.chime.connect(audio.destination);
      const start = audio.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.5];
      for (const [index, frequency] of notes.entries()) {
        const note = audio.createOscillator();
        const envelope = audio.createGain();
        const onset = start + index * 0.1;
        note.frequency.value = frequency;
        envelope.gain.setValueAtTime(0, onset);
        envelope.gain.linearRampToValueAtTime(0.084, onset + 0.025);
        envelope.gain.exponentialRampToValueAtTime(0.0007, onset + 0.55);
        note.connect(envelope).connect(this.chime);
        note.start(onset);
        note.stop(onset + 0.56);
      }
    }

    playTap(source) {
      if (!this.enabled || !source) return;
      if (this.effect.getAttribute("src") !== source) this.effect.src = source;
      this.effect.currentTime = 0;
      this.effect.play().catch(() => {});
    }
  }

  function releaseStars(layer) {
    if (reducedMotion.matches || document.hidden) return;

    const colors = ["#edac24", "#ec6b9a", "#649eef", "#9e78e4", "#4bb890"];
    const stars = document.createDocumentFragment();
    layer.style.setProperty("--star-fall", `${layer.clientHeight + 16}px`);

    for (let index = 0; index < 18; index++) {
      const star = document.createElement("span");
      star.className = "celebration-star";
      star.style.setProperty("--star-x", `${5 + index * 17 % 88}%`);
      star.style.setProperty("--star-size", `${7 + index * 5 % 7}px`);
      star.style.setProperty("--star-color", colors[index % colors.length]);
      star.style.setProperty("--star-delay", `${index * 26}ms`);
      star.style.setProperty("--star-time", `${1080 + index % 5 * 110}ms`);
      star.style.setProperty("--star-drift", `${(index % 5 - 2) * 9}px`);
      star.style.setProperty("--star-turn", `${index % 2 ? -125 : 145}deg`);
      star.addEventListener("animationend", () => star.remove(), { once: true });
      stars.append(star);
    }
    layer.replaceChildren(stars);
  }

  const drawingAnimations = {
    "three-cats": {
      duration: 1020,
      poses: [
        [0.22, "translateY(-5%) rotate(-3deg) scale(0.97)"],
        [0.43, "translateY(1%) rotate(2deg) scale(0.99)"],
        [0.68, "translateY(-3%) rotate(3deg) scale(0.98)"],
        [0.84, "translateY(0.6%) rotate(-1deg)"],
      ],
    },
    korzhik: {
      duration: 780,
      poses: [
        [0.14, "translateY(1%) scaleY(0.96)"],
        [0.34, "translateY(-7%) rotate(-5deg)"],
        [0.55, "translateY(1%) scaleY(0.97)"],
        [0.76, "translateY(-4%) rotate(5deg)"],
      ],
    },
    kompot: {
      duration: 1080,
      poses: [
        [0.2, "translateX(-4%) rotate(3deg) scale(0.97)"],
        [0.62, "translateX(8%) rotate(-5deg) scale(0.94)"],
        [0.83, "translateX(3%) rotate(-2deg) scale(0.97)"],
      ],
    },
    karamelka: {
      duration: 970,
      poses: [
        [0.24, "translate(-2%, -2%) rotate(-10deg) scale(0.98)"],
        [0.51, "translate(2%, -4%) rotate(11deg) scale(0.98)"],
        [0.76, "translate(-1%, -1%) rotate(-5deg)"],
      ],
    },
    "karamelka-heart": {
      duration: 820,
      poses: [
        [0.21, "scale(1.05)"],
        [0.41, "scale(0.99)"],
        [0.64, "scale(1.035)"],
        [0.83, "scale(0.997)"],
      ],
    },
    lapochka: {
      duration: 940,
      poses: [
        [0.26, "translateY(2%) rotateX(16deg) scale(0.96)"],
        [0.48, "translateY(4%) rotateX(28deg) scale(0.92)"],
        [0.74, "translateY(-2%) rotateX(-6deg) scale(0.98)"],
      ],
    },
    "dad-cat": {
      duration: 920,
      poses: [
        [0.2, "translateX(-2%) rotate(-3deg) scale(0.97)"],
        [0.52, "translateX(4%) rotate(7deg) scale(0.94)"],
        [0.78, "translateX(1%) rotate(-2deg) scale(0.98)"],
      ],
    },
    mom: {
      duration: 1000,
      poses: [
        [0.27, "rotateY(-28deg) rotate(-4deg)"],
        [0.56, "rotateY(20deg) rotate(4deg)"],
        [0.79, "rotateY(-9deg) rotate(-2deg)"],
      ],
    },
    masha: {
      duration: 1160,
      poses: [
        [0.3, "translateX(-3%) rotate(-6deg) scale(0.98)"],
        [0.65, "translateX(3%) rotate(6deg) scale(0.98)"],
        [0.88, "translateX(-1%) rotate(-2deg)"],
      ],
    },
    "masha-bike": {
      duration: 1080,
      poses: [
        [0.2, "translate(3%, -2%) rotate(-4deg)"],
        [0.41, "translate(5%, 0) rotate(2deg) scale(0.98)"],
        [0.66, "translate(7%, -3%) rotate(-4deg) scale(0.98)"],
        [0.86, "translate(3%, -1%) rotate(1deg)"],
      ],
    },
    cat: {
      duration: 870,
      poses: [
        [0.23, "translateY(-5%) rotateY(55deg) rotateZ(-8deg)"],
        [0.5, "translateY(-8%) rotateY(180deg) rotateZ(0deg)"],
        [0.82, "translateY(-2%) rotateY(315deg) rotateZ(7deg)"],
      ],
      finish: "translateY(0) rotateY(360deg) rotateZ(0deg)",
    },
    dolphin: {
      duration: 1120,
      poses: [
        [0.24, "translate(4%, -7%) rotate(11deg) scale(0.98)"],
        [0.53, "translate(0, -5%) rotate(-3deg)"],
        [0.76, "translate(-5%, 5%) rotate(-15deg) scale(0.98)"],
        [0.9, "translate(-2%, 2%) rotate(-5deg)"],
      ],
    },
    corgi: {
      duration: 1250,
      poses: [
        [0.12, "translateY(2%) scale(1.04, 0.94)"],
        [0.3, "translateY(-7%) rotate(-7deg) scale(0.98, 1.03)"],
        [0.44, "translateY(1%) rotate(2deg) scale(1.04, 0.96)"],
        [0.63, "translateY(-5%) rotate(8deg) scale(0.99, 1.02)"],
        [0.78, "translateY(1%) rotate(-3deg) scale(1.02, 0.97)"],
        [0.9, "translateY(-2%) rotate(2deg)"],
      ],
    },
    dachshund: {
      duration: 1300,
      poses: [
        [0.14, "translateX(-4%) rotate(-4deg) scale(0.98, 1.02)"],
        [0.3, "translate(3%, -3%) rotate(4deg) scale(1.04, 0.97)"],
        [0.45, "translateX(-3%) rotate(-5deg) scale(0.98, 1.03)"],
        [0.62, "translate(4%, -5%) rotate(6deg) scale(1.03, 0.98)"],
        [0.78, "translateX(-2%) rotate(-3deg) scale(0.99, 1.01)"],
        [0.91, "translate(1%, -1%) rotate(2deg)"],
      ],
    },
    car: {
      duration: 990,
      poses: [
        [0.18, "translateX(-5%) rotate(-1deg) scale(0.98)"],
        [0.55, "translateX(6%) rotate(1deg) scale(0.98)"],
        [0.78, "translateX(-3%) rotate(-1deg)"],
      ],
    },
  };

  function animateDrawing(artwork, id) {
    if (reducedMotion.matches) {
      artwork.animate([{ opacity: 1 }, { opacity: 0.72 }, { opacity: 1 }], { duration: 250 });
      return;
    }

    const { duration, poses, finish = "none" } = drawingAnimations[id] ?? drawingAnimations.cat;
    artwork.animate([
      { transform: "none" },
      ...poses.map(([offset, transform]) => ({ offset, transform })),
      { transform: finish },
    ], { duration, easing: "ease-in-out" });
  }

  function loadLocalLinework() {
    if (!localLineworkRequest) {
      localLineworkRequest = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "./drawings/local-linework.js";
        script.onload = () => resolve(window.childcolorLocalLinework);
        script.onerror = () => {
          localLineworkRequest = null;
          script.remove();
          reject(new Error("Local outlines could not be loaded"));
        };
        document.head.append(script);
      });
    }
    return localLineworkRequest;
  }

  async function inlineImage(image) {
    const source = new URL(image.getAttribute("href"), document.baseURI);
    if (source.protocol === "data:") return;

    let dataUrl;
    if (source.protocol === "file:") {
      const local = await loadLocalLinework();
      dataUrl = local?.[source.pathname.split("/").pop()];
      if (!dataUrl) throw new Error("Missing local outline");
    } else {
      const response = await fetch(source);
      if (!response.ok) throw new Error("Outline could not be downloaded");
      const blob = await response.blob();
      dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }
    image.setAttribute("href", dataUrl);
  }

  async function renderPng(canvas, drawing) {
    const exported = document.createElement("canvas");
    exported.width = canvas.width;
    exported.height = canvas.height;
    const context = exported.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, exported.width, exported.height);
    context.drawImage(canvas, 0, 0);

    const svg = document.createElementNS(svgNamespace, "svg");
    svg.setAttribute("viewBox", drawing.symbol.getAttribute("viewBox"));
    svg.setAttribute("width", String(canvas.width));
    svg.setAttribute("height", String(canvas.height));
    for (const part of drawing.symbol.children) svg.append(part.cloneNode(true));
    await Promise.all(Array.from(svg.querySelectorAll("image"), inlineImage));

    const source = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml" }));
    try {
      const lines = new Image();
      lines.src = url;
      await lines.decode();
      context.drawImage(lines, 0, 0);
    } finally {
      URL.revokeObjectURL(url);
    }

    const png = await new Promise(resolve => exported.toBlob(resolve, "image/png"));
    if (!png) throw new Error("PNG export failed");
    return new File([png], `${drawing.name} — Раскраски для маленькой девочки.png`, { type: "image/png" });
  }

  async function saveFile(file) {
    const share = { files: [file] };
    if (navigator.canShare?.(share)) {
      try {
        await navigator.share(share);
        return;
      } catch (error) {
        if (error.name === "AbortError") return;
      }
    }

    const link = document.createElement("a");
    const url = URL.createObjectURL(file);
    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  return { DrawingResults, DrawingSession, DrawingSound, releaseStars, animateDrawing, renderPng, saveFile };
})();
