import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import crypto from "crypto";
import { spawn } from "child_process";
import { getConfigPath } from "./config.js";

// OAuth client used by OpenAI's own Codex CLI. Signing in with it bills usage
// to the user's ChatGPT plan instead of an API key, which OpenAI allows for
// plan subscribers.
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_REDIRECT_PORT = 1455;
export const CODEX_REDIRECT_URI = `http://localhost:${CODEX_REDIRECT_PORT}/auth/callback`;
const CODEX_SCOPE = "openid profile email offline_access";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
// Refresh slightly before the access token's exp claim; when the token has no
// exp claim, fall back to age since last_refresh (Codex CLI uses 28 days; we
// stay well under that).
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const REFRESH_FALLBACK_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function getGacAuthPath() {
  return path.join(path.dirname(getConfigPath()), "codex-auth.json");
}

export function getCodexCliAuthPath() {
  return path.join(os.homedir(), ".codex", "auth.json");
}

function base64UrlEncode(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function createPkcePair() {
  const verifier = base64UrlEncode(crypto.randomBytes(64));
  const challenge = base64UrlEncode(
    crypto.createHash("sha256").update(verifier).digest()
  );
  return { verifier, challenge };
}

// Decode a JWT payload without verifying the signature — we only read our own
// tokens for display metadata (email, plan) and refresh timing.
export function parseJwtClaims(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    const claims = JSON.parse(payload);
    return claims && typeof claims === "object" ? claims : null;
  } catch (err) {
    return null;
  }
}

// The ChatGPT account id lives in the `https://api.openai.com/auth` claim of
// the id/access token; the backend requires it as a request header.
export function extractAccountId(tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  if (tokens.account_id) return tokens.account_id;
  for (const token of [tokens.id_token, tokens.access_token]) {
    const auth = parseJwtClaims(token)?.["https://api.openai.com/auth"];
    if (auth && typeof auth === "object" && auth.chatgpt_account_id) {
      return auth.chatgpt_account_id;
    }
  }
  return null;
}

export function buildAuthorizeUrl({ challenge, state }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: CODEX_REDIRECT_URI,
    scope: CODEX_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  });
  return `${CODEX_ISSUER}/oauth/authorize?${params.toString()}`;
}

export function shouldRefreshAccessToken(auth, nowMs = Date.now()) {
  const tokens = auth?.tokens;
  if (!tokens || !tokens.access_token) return true;
  const exp = Number(parseJwtClaims(tokens.access_token)?.exp);
  if (Number.isFinite(exp) && exp > 0) {
    return nowMs >= exp * 1000 - REFRESH_SKEW_MS;
  }
  const lastRefresh = Date.parse(auth.last_refresh || "");
  if (!Number.isFinite(lastRefresh)) return true;
  return nowMs - lastRefresh > REFRESH_FALLBACK_AGE_MS;
}

export function readAuthFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.tokens &&
      typeof parsed.tokens === "object" &&
      parsed.tokens.access_token
    ) {
      return parsed;
    }
  } catch (err) {
    // Missing or malformed file — treated as "not signed in".
  }
  return null;
}

// gac's own login wins; otherwise reuse an existing Codex CLI login so users
// who already ran `codex login` are signed in with zero extra steps.
export function loadCodexAuth(paths = {}) {
  const gacPath = paths.gacAuthPath ?? getGacAuthPath();
  const cliPath = paths.codexCliAuthPath ?? getCodexCliAuthPath();
  const own = readAuthFile(gacPath);
  if (own) return { auth: own, source: gacPath };
  const cli = readAuthFile(cliPath);
  if (cli) return { auth: cli, source: cliPath };
  return null;
}

function saveAuthFile(filePath, auth) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

async function requestTokens(body) {
  let response;
  try {
    response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  } catch (err) {
    throw new Error(`Could not reach ${CODEX_ISSUER}. (${err.message})`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token request failed (${response.status}): ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error("Token endpoint returned a non-JSON response.");
  }
}

function tokensFromResponse(json, previous = {}) {
  const tokens = {
    id_token: json.id_token || previous.id_token || null,
    access_token: json.access_token || previous.access_token || null,
    refresh_token: json.refresh_token || previous.refresh_token || null,
  };
  tokens.account_id = extractAccountId(tokens) || previous.account_id || null;
  return tokens;
}

async function refreshCodexAuth(auth, source) {
  const refreshToken = auth?.tokens?.refresh_token;
  if (!refreshToken) {
    throw new Error(
      "ChatGPT session expired and no refresh token is stored. Run `gac auth login`."
    );
  }
  let json;
  try {
    json = await requestTokens({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
      scope: "openid profile email",
    });
  } catch (err) {
    throw new Error(
      `Could not refresh the ChatGPT session (${err.message}). Run \`gac auth login\`.`
    );
  }
  const updated = {
    ...auth,
    tokens: tokensFromResponse(json, auth.tokens),
    last_refresh: new Date().toISOString(),
  };
  try {
    // Write back to the file the tokens came from: OAuth refresh rotates the
    // refresh token, so an out-of-date ~/.codex/auth.json would strand the
    // Codex CLI (and vice versa).
    saveAuthFile(source, updated);
  } catch (err) {
    // Read-only auth file: keep going with the in-memory tokens.
  }
  return updated;
}

// Resolve a usable access token + account id, refreshing when needed.
export async function getCodexCredentials({ forceRefresh = false, paths } = {}) {
  const loaded = loadCodexAuth(paths);
  if (!loaded) {
    throw new Error(
      "Not signed in to ChatGPT. Run `gac auth login` to connect your plan."
    );
  }
  let { auth, source } = loaded;
  if (forceRefresh || shouldRefreshAccessToken(auth)) {
    auth = await refreshCodexAuth(auth, source);
  }
  const accountId = extractAccountId(auth.tokens);
  if (!auth.tokens.access_token || !accountId) {
    throw new Error(
      "Stored ChatGPT credentials are incomplete. Run `gac auth login`."
    );
  }
  return { accessToken: auth.tokens.access_token, accountId };
}

function openBrowser(url) {
  const platform = process.platform;
  let command;
  let args;
  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url.replace(/&/g, "^&")];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch (err) {
    // Best-effort: the URL is printed either way.
  }
}

const CALLBACK_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>gac</title></head>
<body style="font-family: system-ui, sans-serif; text-align: center; padding-top: 4rem;">
<h2>Signed in</h2><p>You can close this tab and return to the terminal.</p>
</body></html>`;

function waitForCallback(server, expectedState) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error("Login timed out waiting for the browser callback."));
    }, LOGIN_TIMEOUT_MS);
    timeoutId.unref?.();

    server.on("request", (req, res) => {
      const url = new URL(req.url, `http://localhost:${CODEX_REDIRECT_PORT}`);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      const fail = (message) => {
        res.writeHead(400, { "Content-Type": "text/plain" }).end(message);
        clearTimeout(timeoutId);
        reject(new Error(message));
      };
      const error = url.searchParams.get("error");
      if (error) {
        fail(`Login failed: ${url.searchParams.get("error_description") || error}`);
        return;
      }
      if (url.searchParams.get("state") !== expectedState) {
        fail("Login failed: state mismatch. Try again.");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        fail("Login failed: no authorization code in the callback.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }).end(CALLBACK_PAGE);
      clearTimeout(timeoutId);
      resolve(code);
    });
  });
}

// Interactive sign-in: opens the browser to auth.openai.com and completes the
// PKCE exchange via a temporary local callback server on port 1455 (the
// redirect URI registered for the Codex OAuth client, so it cannot vary).
export async function loginCodex({ notify = () => {}, browser = true } = {}) {
  const { verifier, challenge } = createPkcePair();
  const state = base64UrlEncode(crypto.randomBytes(24));
  const authUrl = buildAuthorizeUrl({ challenge, state });

  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${CODEX_REDIRECT_PORT} is already in use (another login in progress?). Close it and retry.`
          )
        );
      } else {
        reject(err);
      }
    });
    server.listen(CODEX_REDIRECT_PORT, "127.0.0.1", resolve);
  });

  try {
    notify(`Open this URL in your browser to sign in with your ChatGPT account:\n\n  ${authUrl}\n\n`);
    notify(
      "Waiting for the browser sign-in to finish... (on a remote machine, forward the port first: ssh -L 1455:localhost:1455 <host>)\n"
    );
    if (browser) openBrowser(authUrl);

    const code = await waitForCallback(server, state);
    const json = await requestTokens({
      grant_type: "authorization_code",
      code,
      redirect_uri: CODEX_REDIRECT_URI,
      client_id: CODEX_CLIENT_ID,
      code_verifier: verifier,
    });
    const auth = {
      OPENAI_API_KEY: null,
      tokens: tokensFromResponse(json),
      last_refresh: new Date().toISOString(),
    };
    if (!auth.tokens.access_token) {
      throw new Error("Login failed: token exchange returned no access token.");
    }
    saveAuthFile(getGacAuthPath(), auth);
    return codexAuthStatus();
  } finally {
    server.close();
  }
}

export function logoutCodex(paths = {}) {
  const gacPath = paths.gacAuthPath ?? getGacAuthPath();
  const cliPath = paths.codexCliAuthPath ?? getCodexCliAuthPath();
  let removed = false;
  try {
    fs.unlinkSync(gacPath);
    removed = true;
  } catch (err) {
    // Nothing stored — that's fine.
  }
  return { removed, codexCliAuthPresent: Boolean(readAuthFile(cliPath)) };
}

export function codexAuthStatus(paths = {}) {
  const loaded = loadCodexAuth(paths);
  if (!loaded) return { signedIn: false };
  const { auth, source } = loaded;
  const idClaims = parseJwtClaims(auth.tokens.id_token) || {};
  const authClaim = idClaims["https://api.openai.com/auth"] || {};
  return {
    signedIn: true,
    source,
    email: idClaims.email || null,
    planType: authClaim.chatgpt_plan_type || null,
    accountId: extractAccountId(auth.tokens),
    lastRefresh: auth.last_refresh || null,
    needsRefresh: shouldRefreshAccessToken(auth),
  };
}
