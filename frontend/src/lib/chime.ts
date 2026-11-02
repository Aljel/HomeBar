/** A soft two-note bell generated with WebAudio — no audio files. */

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

/** Call from a user gesture (click) so browsers allow sound later. */
export async function unlockAudio(): Promise<boolean> {
  const c = context();
  if (!c) return false;
  if (c.state === "suspended") {
    try {
      await c.resume();
    } catch {
      return false;
    }
  }
  return c.state === "running";
}

function bell(c: AudioContext, freq: number, start: number, gain: number) {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + 1.6);
  g.connect(c.destination);
  // fundamental + a quiet inharmonic partial gives a glassy "ting"
  for (const [mult, level] of [
    [1, 1],
    [2.76, 0.18],
    [5.4, 0.05],
  ] as const) {
    const o = c.createOscillator();
    const og = c.createGain();
    o.type = "sine";
    o.frequency.value = freq * mult;
    og.gain.value = level;
    o.connect(og).connect(g);
    o.start(start);
    o.stop(start + 1.7);
  }
}

export function chime(): void {
  const c = context();
  if (!c || c.state !== "running") return;
  const t = c.currentTime + 0.02;
  bell(c, 1046.5, t, 0.22); // C6
  bell(c, 1568, t + 0.16, 0.16); // G6
}
