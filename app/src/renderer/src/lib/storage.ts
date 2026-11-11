/**
 * Tiny typed wrapper over localStorage. Every read tolerates missing/corrupt
 * data (falls back to defaults field by field) and every write tolerates storage
 * being unavailable — preferences are a convenience, never a failure mode.
 */
export function loadJson<T extends object>(key: string, defaults: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return { ...defaults };
    const out = { ...defaults } as Record<string, unknown>;
    for (const [k, def] of Object.entries(defaults)) {
      if (k in parsed && typeof parsed[k] === typeof def) out[k] = parsed[k];
    }
    return out as T;
  } catch {
    return { ...defaults };
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable; the setting just won't persist */
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
