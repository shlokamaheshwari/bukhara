// Tiny synthesized audio cues. No audio files — everything is generated
// via the Web Audio API on demand, so nothing ships in the bundle.
//
// User preference is persisted in localStorage under `bhukara-sound-enabled`.
// Default is on. The AudioContext is created lazily on first play so we
// don't burn CPU before we need it, and it's resumed if the browser
// suspended it under the autoplay policy.

const STORAGE_KEY = 'bhukara-sound-enabled';

let audioCtx: AudioContext | null = null;

function isEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const saved = window.localStorage.getItem(STORAGE_KEY);
  return saved === null ? true : saved === '1';
}

export function setSoundEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
}

export function isSoundEnabled(): boolean {
  return isEnabled();
}

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    } catch {
      return null;
    }
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => { /* ignore */ });
  }
  return audioCtx;
}

// Two-note chime — C6 → G6, ~450ms total. Warm, unobtrusive.
export function playTurnChime(): void {
  if (!isEnabled()) return;
  const ctx = ensureCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  const notes: { freq: number; start: number; dur: number; peak: number }[] = [
    { freq: 1046.5,  start: 0.00, dur: 0.32, peak: 0.14 },
    { freq: 1567.98, start: 0.11, dur: 0.36, peak: 0.11 },
  ];
  for (const n of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = n.freq;
    const t = now + n.start;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(n.peak, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + n.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + n.dur);
  }
}
