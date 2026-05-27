import { useEffect, useRef } from "react";

/**
 * Renders a shared-screen MediaStream into a <video>. A MediaStream must be set
 * via srcObject (not an attribute), so we attach it in an effect.
 *
 * `muted` is set for the sharer's own preview to avoid looping their system
 * audio back at them; remote shares play with sound so game audio comes through.
 */
export function ScreenVideo({
  stream,
  muted,
}: {
  stream: MediaStream;
  muted: boolean;
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);

  return <video ref={ref} className="screen-video" autoPlay playsInline muted={muted} />;
}
