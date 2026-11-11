/**
 * Google sign-in for a desktop app, the way Google actually supports it:
 * the system browser (NOT an embedded webview — Google blocks those) plus a
 * loopback redirect and PKCE.
 *
 * We only want identity (name/email/avatar), so we read them from the returned
 * OpenID id_token. We trust the token because it arrives over TLS straight from
 * Google's token endpoint; we are not using it to authorize a backend.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { shell } from "electron";
import type { UserInfo } from "../shared/protocol.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode the payload of a JWT without verifying the signature (see note above). */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1];
  const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
  return JSON.parse(json);
}

/** Aborts the sign-in currently waiting on the browser, if any. */
let cancelPending: (() => void) | null = null;

export function cancelGoogleLogin(): void {
  cancelPending?.();
}

export async function googleLogin(clientId: string, clientSecret: string): Promise<UserInfo> {
  cancelPending?.(); // only one sign-in at a time
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  const state = base64url(randomBytes(16));

  // A short-lived loopback server catches Google's redirect.
  const { code, redirectUri, close } = await new Promise<{
    code: string;
    redirectUri: string;
    close: () => void;
  }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/") {
        res.writeHead(404);
        res.end();
        return;
      }
      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Kootani</title>` +
          `<body style="font-family:system-ui;background:#1b1d24;color:#e6e8ee;` +
          `display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
          `<div style="text-align:center"><h2>Kootani</h2>` +
          `<p>${error ? "Sign-in failed." : "Signed in — you can close this tab."}</p></div>`,
      );

      if (error) {
        abort(new Error(error === "access_denied" ? "Sign-in was cancelled in the browser." : `Google returned: ${error}`));
      } else if (returnedState !== state) {
        abort(new Error("State mismatch — possible CSRF, aborting."));
      } else if (returnedCode) {
        if (timeout) clearTimeout(timeout);
        cancelPending = null;
        const addr = server.address() as AddressInfo;
        resolve({
          code: returnedCode,
          redirectUri: `http://127.0.0.1:${addr.port}`,
          close: () => server.close(),
        });
      }
    });

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const abort = (err: Error): void => {
      if (timeout) clearTimeout(timeout);
      cancelPending = null;
      server.close();
      reject(err);
    };
    cancelPending = () => abort(new Error("Sign-in cancelled."));

    server.on("error", (err) => abort(err));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const redirectUri = `http://127.0.0.1:${addr.port}`;
      const authUrl = new URL(AUTH_ENDPOINT);
      authUrl.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        prompt: "select_account",
      }).toString();
      shell.openExternal(authUrl.toString()).catch(() =>
        abort(new Error("Couldn't open your web browser for sign-in.")),
      );
    });

    // Don't hang forever if the user abandons the browser.
    timeout = setTimeout(() => abort(new Error("Sign-in timed out.")), 300_000);
    timeout.unref();
  });

  try {
    const tokenRes = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed (${tokenRes.status}): ${await tokenRes.text()}`);
    }

    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokens.id_token) throw new Error("No id_token in Google's response.");

    const claims = decodeJwtPayload(tokens.id_token);
    return {
      name: String(claims.name ?? claims.email ?? "Player"),
      email: claims.email ? String(claims.email) : undefined,
      picture: claims.picture ? String(claims.picture) : undefined,
    };
  } finally {
    close();
  }
}
