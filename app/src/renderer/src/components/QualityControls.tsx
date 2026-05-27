import { SCREEN_FRAME_RATES, SCREEN_RESOLUTIONS, type ScreenQuality } from "../lib/RoomClient";

/**
 * Two dropdowns for screen-share resolution and frame rate. Used both in the
 * picker (to set the quality of the share you're about to start) and live on the
 * self-preview tile while sharing (changes apply immediately, no reconnection).
 */
export function QualityControls({
  quality,
  onChange,
  compact = false,
}: {
  quality: ScreenQuality;
  onChange: (q: ScreenQuality) => void;
  compact?: boolean;
}): JSX.Element {
  return (
    <div className={`quality-controls ${compact ? "compact" : ""}`}>
      <label className="quality-field">
        <span>Resolution</span>
        <select
          className="select"
          value={quality.maxHeight}
          onChange={(e) => onChange({ ...quality, maxHeight: Number(e.target.value) })}
        >
          {SCREEN_RESOLUTIONS.map((r) => (
            <option key={r.height} value={r.height}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <label className="quality-field">
        <span>Frame rate</span>
        <select
          className="select"
          value={quality.frameRate}
          onChange={(e) => onChange({ ...quality, frameRate: Number(e.target.value) })}
        >
          {SCREEN_FRAME_RATES.map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
