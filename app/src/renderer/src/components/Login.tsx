import { useState } from "react";
import { LIMITS, type UserInfo } from "@shared/protocol";
import type { KootaniConfig } from "@shared/ipc";

export function Login({
  config,
  onLogin,
}: {
  config: KootaniConfig | null;
  onLogin: (u: UserInfo) => void;
}): JSX.Element {
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signInWithGoogle = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onLogin(await window.kootani.googleLogin());
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "";
      if (!/cancelled/i.test(msg)) setError(msg || "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="centered">
      <div className="card login">
        <h1 className="brand">Kootani</h1>
        <p className="tagline">கூட்டணி — your alliance, in voice.</p>

        {config?.googleConfigured !== false && (
          <>
            {busy ? (
              <div className="busy-row">
                <p className="host-status">
                  <span className="spinner" /> Finish signing in in your browser…
                </p>
                <button className="btn small" onClick={() => void window.kootani.cancelGoogleLogin()}>
                  Cancel
                </button>
              </div>
            ) : (
              <button className="btn primary" disabled={!config} onClick={signInWithGoogle}>
                Sign in with Google
              </button>
            )}
            <div className="divider">
              <span>or</span>
            </div>
          </>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (nickname.trim()) onLogin({ name: nickname.trim() });
          }}
        >
          <label className="field-label" htmlFor="nickname">
            Pick a display name
          </label>
          <input
            id="nickname"
            className="input"
            placeholder="What friends will see"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            maxLength={LIMITS.maxNameLength}
            disabled={busy}
            autoFocus={config?.googleConfigured === false}
          />
          <button className="btn" type="submit" disabled={!nickname.trim() || busy}>
            Continue
          </button>
        </form>

        {error && <p className="error">{error}</p>}
        {config && <p className="version-line">v{config.version}</p>}
      </div>
    </div>
  );
}
