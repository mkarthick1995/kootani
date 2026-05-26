import { useEffect, useRef } from "react";

/**
 * Plays a peer's remote stream at a per-peer volume. We attach the MediaStream
 * via srcObject (which can't be an attribute) and set element.volume; the
 * element stays hidden — it's audio only.
 */
export function RemoteAudio({
  stream,
  volume,
}: {
  stream: MediaStream | null;
  volume: number;
}): JSX.Element {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) {
      el.srcObject = stream;
    }
  }, [stream]);

  useEffect(() => {
    if (ref.current) ref.current.volume = Math.max(0, Math.min(1, volume));
  }, [volume]);

  return <audio ref={ref} autoPlay playsInline hidden />;
}
