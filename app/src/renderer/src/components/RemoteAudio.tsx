import { useEffect, useRef } from "react";

/**
 * Plays a peer's remote stream. We attach the MediaStream via srcObject (which
 * can't be expressed as an attribute) and keep the element hidden — it's audio.
 */
export function RemoteAudio({ stream }: { stream: MediaStream | null }): JSX.Element {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) {
      el.srcObject = stream;
    }
  }, [stream]);

  return <audio ref={ref} autoPlay playsInline hidden />;
}
