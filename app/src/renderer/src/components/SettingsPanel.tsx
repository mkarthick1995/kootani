import type { ShortcutAction } from "@shared/ipc";
import type { RoomClient, RoomSnapshot } from "../lib/RoomClient";

/** Devices, mic processing and preferences. Everything here only affects you. */
export function SettingsPanel({
  snapshot,
  client,
  shortcuts,
  version,
  onClose,
}: {
  snapshot: RoomSnapshot;
  client: RoomClient;
  shortcuts: ShortcutAction[];
  version: string;
  onClose: () => void;
}): JSX.Element {
  const { settings, inputs, outputs } = snapshot;
  const inputMissing = settings.inputDeviceId && !inputs.some((d) => d.id === settings.inputDeviceId);
  const outputMissing = settings.outputDeviceId && !outputs.some((d) => d.id === settings.outputDeviceId);

  return (
    <aside className="settings-panel">
      <div className="settings-head">
        <div className="settings-title">
          Settings <span className="hint-inline">— these only affect you</span>
        </div>
        <button className="link picker-close" onClick={onClose} aria-label="Close settings">
          ✕
        </button>
      </div>

      <div className="settings-columns">
        <section>
          <h3>Devices</h3>
          <label className="setting-field">
            <span>Microphone</span>
            <select
              className="select"
              value={inputMissing ? "" : settings.inputDeviceId}
              onChange={(e) => void client.setInputDevice(e.target.value)}
            >
              <option value="">System default</option>
              {inputs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label className="setting-field">
            <span>Speakers / headphones</span>
            <select
              className="select"
              value={outputMissing ? "" : settings.outputDeviceId}
              onChange={(e) => client.setOutputDevice(e.target.value)}
            >
              <option value="">System default</option>
              {outputs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <div className="slider-row">
            <span className="slider-label">Input volume</span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={settings.inputVolume}
              onChange={(e) => client.setInputVolume(Number(e.target.value))}
            />
            <span className="slider-val">{Math.round(settings.inputVolume * 100)}%</span>
          </div>
          <div className={`mic-test ${snapshot.selfSpeaking ? "live" : ""}`}>
            <span className="mic-test-dot" />
            {snapshot.micError
              ? "No microphone"
              : snapshot.selfSpeaking
                ? "We can hear you"
                : "Say something to test your mic"}
            {snapshot.micError && (
              <button className="link inline" onClick={() => void client.retryMic()}>
                Try again
              </button>
            )}
          </div>
        </section>

        <section>
          <h3>Voice processing</h3>
          <Toggle
            label="Echo cancellation"
            hint="Stops your speakers leaking back into your mic."
            checked={settings.echoCancellation}
            onChange={(v) => client.setEchoCancellation(v)}
          />
          <Toggle
            label="Noise suppression"
            hint="Filters fans, keyboards and background hum."
            checked={settings.noiseSuppression}
            onChange={(v) => client.setNoiseSuppression(v)}
          />
          <Toggle
            label="Auto gain"
            hint="Evens out your volume. Turn off to control it manually."
            checked={settings.autoGainControl}
            onChange={(v) => client.setAutoGainControl(v)}
          />
        </section>

        <section>
          <h3>App</h3>
          <Toggle
            label="Sound effects"
            hint="Join, leave and mute sounds."
            checked={settings.sounds}
            onChange={(v) => client.setSounds(v)}
          />
          <div className="shortcut-list">
            <div>
              <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> mute
              {!shortcuts.includes("toggle-mute") && <em> (unavailable — used by another app)</em>}
            </div>
            <div>
              <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> deafen
              {!shortcuts.includes("toggle-deafen") && <em> (unavailable — used by another app)</em>}
            </div>
            <div className="hint">Hotkeys work even while a game has focus.</div>
          </div>
          <p className="version-line left">
            Kootani v{version} ·{" "}
            <button className="link inline" onClick={() => void window.kootani.openLogs()}>
              Open logs
            </button>
          </p>
        </section>
      </div>
    </aside>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className="toggle-row" title={hint}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}
