/**
 * UI sound cues (join, leave, mute…) synthesized with Web Audio — no asset files
 * to bundle. Short, quiet, and played on the user's chosen output device.
 */
export type SoundCue = "join" | "leave" | "mute" | "unmute" | "deafen" | "undeafen" | "disconnect" | "reconnect";

// [frequency Hz, start s, duration s] — rising = good, falling = bye.
const CUES: Record<SoundCue, [number, number, number][]> = {
  join: [
    [660, 0, 0.09],
    [880, 0.08, 0.12],
  ],
  leave: [
    [700, 0, 0.09],
    [470, 0.08, 0.14],
  ],
  mute: [[420, 0, 0.08]],
  unmute: [[640, 0, 0.08]],
  deafen: [
    [520, 0, 0.07],
    [360, 0.07, 0.1],
  ],
  undeafen: [
    [360, 0, 0.07],
    [560, 0.07, 0.1],
  ],
  disconnect: [
    [480, 0, 0.12],
    [380, 0.12, 0.12],
    [300, 0.24, 0.18],
  ],
  reconnect: [
    [520, 0, 0.08],
    [700, 0.08, 0.08],
    [880, 0.16, 0.12],
  ],
};

let ctx: AudioContext | null = null;
let currentSink = "";

export function playCue(cue: SoundCue, sinkId = ""): void {
  try {
    ctx ??= new AudioContext();
    void ctx.resume();
    const withSink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (sinkId !== currentSink && withSink.setSinkId) {
      currentSink = sinkId;
      void withSink.setSinkId(sinkId).catch(() => {});
    }
    const t0 = ctx.currentTime + 0.01;
    for (const [freq, start, dur] of CUES[cue]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + start);
      gain.gain.linearRampToValueAtTime(0.08, t0 + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.02);
    }
  } catch {
    /* sounds are decoration; never fail because of them */
  }
}
