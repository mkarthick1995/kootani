import { useEffect, useRef } from "react";

type SinkableAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

/**
 * Plays a peer's remote voice at a per-peer volume, on the chosen output device.
 * The MediaStream goes in via srcObject (it can't be an attribute); the element
 * stays hidden — it's audio only.
 */
export function RemoteAudio({
  stream,
  volume,
  muted,
  sinkId,
}: {
  stream: MediaStream | null;
  volume: number;
  muted: boolean;
  sinkId: string;
}): JSX.Element {
  const ref = useRef<SinkableAudio>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) {
      el.srcObject = stream;
      if (stream) void el.play().catch(() => {});
    }
  }, [stream]);

  useEffect(() => {
    if (ref.current) ref.current.volume = Math.max(0, Math.min(1, volume));
  }, [volume]);

  useEffect(() => {
    if (ref.current) ref.current.muted = muted;
  }, [muted]);

  useEffect(() => {
    // "" = system default. A vanished device just leaves audio on the default.
    void ref.current?.setSinkId?.(sinkId).catch(() => ref.current?.setSinkId?.("").catch(() => {}));
  }, [sinkId]);

  return <audio ref={ref} autoPlay playsInline hidden />;
}
