import { useState } from "react";
import type { UserInfo } from "@shared/protocol";

/** Profile picture with an initial-letter fallback (also used if the image fails to load). */
export function Avatar({
  user,
  speaking = false,
  size = 44,
}: {
  user: UserInfo;
  speaking?: boolean;
  size?: number;
}): JSX.Element {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  const cls = `avatar ${speaking ? "speaking" : ""}`;
  if (user.picture && !broken) {
    return (
      <img
        className={cls}
        style={style}
        src={user.picture}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    );
  }
  const initial = user.name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div className={`${cls} fallback`} style={style} aria-hidden>
      {initial}
    </div>
  );
}
