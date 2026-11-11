import { useEffect, useRef, useState } from "react";
import type { ScreenSource } from "@shared/ipc";
import type { ScreenQuality } from "../lib/RoomClient";
import { QualityControls } from "./QualityControls";

/**
 * Modal that lists shareable screens/windows (Electron has no native picker on
 * Windows, so we render our own), plus resolution/fps controls. Calls onPick with
 * the chosen source id, or onCancel if dismissed.
 */
export function ScreenPicker({
  quality,
  onQualityChange,
  shareAudio,
  onShareAudioChange,
  onPick,
  onCancel,
}: {
  quality: ScreenQuality;
  onQualityChange: (q: ScreenQuality) => void;
  shareAudio: boolean;
  onShareAudioChange: (on: boolean) => void;
  onPick: (sourceId: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.kootani
      .getScreenSources()
      .then((s) => {
        if (!cancelled) setSources(s);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't list your screens. Try again.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Esc closes. Read the latest onCancel via a ref so the room's frequent
  // re-renders don't re-subscribe (or worse, re-fetch the sources above).
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") cancelRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Screens first, then windows — screens are the common pick for game nights.
  const screens = sources?.filter((s) => s.id.startsWith("screen:")) ?? [];
  const windows = sources?.filter((s) => !s.id.startsWith("screen:")) ?? [];

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <h2>Share your screen</h2>
          <button className="link picker-close" onClick={onCancel}>
            ✕
          </button>
        </div>

        <div className="picker-quality">
          <QualityControls quality={quality} onChange={onQualityChange} />
          <label className="toggle-row picker-audio" title="Windows captures everything your PC plays. Friends will hear their own voices echoed if you play the call through speakers.">
            <input type="checkbox" checked={shareAudio} onChange={(e) => onShareAudioChange(e.target.checked)} />
            <span>Share system audio (game sound)</span>
          </label>
        </div>

        {error && <p className="error">{error}</p>}
        {!sources && !error && (
          <p className="host-status">
            <span className="spinner" /> Finding your screens…
          </p>
        )}

        {sources && sources.length === 0 && <p className="hint">Nothing to share was found.</p>}
        {sources && (
          <div className="picker-scroll">
            {screens.length > 0 && <div className="picker-group-label">Screens</div>}
            <div className="picker-grid">
              {screens.map((s) => (
                <SourceTile key={s.id} source={s} onPick={onPick} />
              ))}
            </div>
            {windows.length > 0 && <div className="picker-group-label">Windows</div>}
            <div className="picker-grid">
              {windows.map((s) => (
                <SourceTile key={s.id} source={s} onPick={onPick} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SourceTile({
  source,
  onPick,
}: {
  source: ScreenSource;
  onPick: (id: string) => void;
}): JSX.Element {
  return (
    <button className="source-tile" onClick={() => onPick(source.id)} title={source.name}>
      <img className="source-thumb" src={source.thumbnail} alt="" />
      <span className="source-name">
        {source.appIcon && <img className="source-icon" src={source.appIcon} alt="" />}
        {source.name}
      </span>
    </button>
  );
}
