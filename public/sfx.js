// Tiny synthesized sound effects (Web Audio — no audio files). Off switch is persisted per browser.
(() => {
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null, master = null, on = true, lastHover = 0, lastTick = 0;
  try { on = localStorage.getItem("botany_sound") !== "off"; } catch {}

  function ensure() {
    if (!AC) return false;
    if (!ctx) { ctx = new AC(); master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination); }
    if (ctx.state === "suspended") ctx.resume();
    return true;
  }
  function tone(freq, at, dur, { type = "sine", gain = 0.18, to = null, attack = 0.006 } = {}) {
    const t = ctx.currentTime + at, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.02);
  }
  function rustle(at, dur, from, to, gain = 0.16) { // filtered-noise sweep, like a paper page
    const t = ctx.currentTime + at, n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = buf; f.type = "bandpass"; f.Q.value = 0.9;
    f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(master); src.start(t);
  }
  const chime = (f, at, gain = 0.16) => { tone(f, at, 1.1, { gain }); tone(f * 2, at, 0.5, { gain: gain * 0.25 }); };
  const C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5;

  const sounds = {
    open:    () => { rustle(0, 0.22, 1200, 3600, 0.15); tone(330, 0, 0.08, { type: "triangle", gain: 0.06 }); },
    back:    () => rustle(0, 0.15, 3200, 1000, 0.1),
    login:   () => { chime(C5, 0); chime(E5, 0.09); chime(G5, 0.18, 0.18); },
    logout:  () => { chime(G5, 0, 0.12); chime(E5, 0.1, 0.1); },
    error:   () => { tone(170, 0, 0.26, { type: "triangle", gain: 0.22, to: 105 }); },
    toast:   () => tone(1318.5, 0, 0.14, { gain: 0.08 }),
    tap:     () => tone(540, 0, 0.07, { type: "triangle", gain: 0.1, to: 380 }),
    results: () => tone(1500, 0, 0.03, { type: "triangle", gain: 0.035 }),
    hover:   () => tone(1900, 0, 0.025, { type: "sine", gain: 0.022 }),
    tick:    () => tone(1250, 0, 0.03, { gain: 0.045 }),
    done:    () => { [C5, E5, G5, C6].forEach((f, i) => chime(f, i * 0.1, 0.15)); }
  };

  function updateToggles() {
    document.querySelectorAll(".sound-toggle").forEach((b) => {
      b.setAttribute("aria-pressed", String(on));
      b.title = on ? "Sound on" : "Sound off";
    });
  }
  window.Sfx = {
    play(name) {
      if (!on || !sounds[name] || !ensure()) return;
      const t = performance.now();
      if (name === "hover") { if (t - lastHover < 140) return; lastHover = t; }
      if (name === "tick") { if (t - lastTick < 60) return; lastTick = t; }
      try { sounds[name](); } catch {}
    },
    toggle() {
      on = !on;
      try { localStorage.setItem("botany_sound", on ? "on" : "off"); } catch {}
      updateToggles(); if (on) this.play("tap");
    }
  };
  document.addEventListener("DOMContentLoaded", () => {
    updateToggles();
    document.querySelectorAll(".sound-toggle").forEach((b) => b.addEventListener("click", () => window.Sfx.toggle()));
  });
})();
