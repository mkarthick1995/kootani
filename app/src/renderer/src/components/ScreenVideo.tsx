import { useEffect, useRef } from "react";

type SinkableVideo = HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> };

/**
 * Renders a shared-screen MediaStream into a <video>. A MediaStream must be set
 * via srcObject (not an attribute), so we attach it in an effect.
 *
 * The sharer's own preview is muted (no looping their system audio back at
 * them); remote shares play with sound at `volume`, so game audio comes through.
 */
export function ScreenVideo({
  stream,
  muted,
  volume = 1,
  sinkId = "",
}: {
  stream: MediaStream;
  muted: boolean;
  volume?: number;
  sinkId?: string;
}): JSX.Element {
  const ref = useRef<SinkableVideo>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) {
      el.srcObject = stream;
      void el.play().catch(() => {});
    }
  }, [stream]);

  useEffect(() => {
    if (ref.current) ref.current.volume = Math.max(0, Math.min(1, volume));
  }, [volume]);

  useEffect(() => {
    if (!muted) void ref.current?.setSinkId?.(sinkId).catch(() => {});
  }, [sinkId, muted]);

  return <video ref={ref} className="screen-video" autoPlay playsInline muted={muted} />;
}
