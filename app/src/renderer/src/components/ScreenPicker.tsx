import { useEffect, useState } from "react";
import type { ScreenSource } from "@shared/ipc";

/**
 * Modal that lists shareable screens/windows (Electron has no native picker on
 * Windows, so we render our own). Calls onPick with the chosen source id, or
 * onCancel if dismissed.
 */
export function ScreenPicker({
  onPick,
  onCancel,
}: {
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

        {error && <p className="error">{error}</p>}
        {!sources && !error && (
          <p className="host-status">
            <span className="spinner" /> Finding your screens…
          </p>
        )}

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
