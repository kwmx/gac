import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import {
  parseJwtClaims,
  extractAccountId,
  buildAuthorizeUrl,
  createPkcePair,
  shouldRefreshAccessToken,
  readAuthFile,
  loadCodexAuth,
  logoutCodex,
  codexAuthStatus,
  CODEX_CLIENT_ID,
  CODEX_REDIRECT_URI,
} from "../src/codexauth.js";

function makeJwt(claims) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.sig`;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gac-codexauth-"));
}

test("parseJwtClaims decodes a payload and rejects garbage", () => {
  const token = makeJwt({ email: "user@example.com", exp: 123 });
  assert.deepEqual(parseJwtClaims(token), { email: "user@example.com", exp: 123 });
  assert.equal(parseJwtClaims("not-a-jwt"), null);
  assert.equal(parseJwtClaims(null), null);
  assert.equal(parseJwtClaims("a.!!!.c"), null);
});

test("extractAccountId prefers the stored id, then token claims", () => {
  const idToken = makeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acc-from-id" },
  });
  assert.equal(extractAccountId({ account_id: "stored" }), "stored");
  assert.equal(extractAccountId({ id_token: idToken }), "acc-from-id");
  assert.equal(
    extractAccountId({ access_token: idToken, id_token: "junk" }),
    "acc-from-id"
  );
  assert.equal(extractAccountId({}), null);
  assert.equal(extractAccountId(null), null);
});

test("buildAuthorizeUrl carries the PKCE challenge, state, and client id", () => {
  const { challenge } = createPkcePair();
  const url = new URL(buildAuthorizeUrl({ challenge, state: "st4te" }));
  assert.equal(url.origin, "https://auth.openai.com");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), CODEX_CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), CODEX_REDIRECT_URI);
  assert.equal(url.searchParams.get("code_challenge"), challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "st4te");
  assert.equal(url.searchParams.get("response_type"), "code");
});

test("createPkcePair produces url-safe verifier and challenge", () => {
  const { verifier, challenge } = createPkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(verifier, challenge);
});

test("shouldRefreshAccessToken uses the exp claim when present", () => {
  const now = Date.now();
  const fresh = {
    tokens: { access_token: makeJwt({ exp: Math.floor(now / 1000) + 3600 }) },
  };
  const expiring = {
    tokens: { access_token: makeJwt({ exp: Math.floor(now / 1000) + 60 }) },
  };
  assert.equal(shouldRefreshAccessToken(fresh, now), false);
  assert.equal(shouldRefreshAccessToken(expiring, now), true);
});

test("shouldRefreshAccessToken falls back to last_refresh age", () => {
  const now = Date.now();
  const opaque = (lastRefresh) => ({
    tokens: { access_token: "opaque-token" },
    last_refresh: lastRefresh,
  });
  assert.equal(
    shouldRefreshAccessToken(opaque(new Date(now - 60_000).toISOString()), now),
    false
  );
  assert.equal(
    shouldRefreshAccessToken(opaque(new Date(now - 30 * 24 * 3600_000).toISOString()), now),
    true
  );
  assert.equal(shouldRefreshAccessToken(opaque(undefined), now), true);
  assert.equal(shouldRefreshAccessToken({ tokens: {} }, now), true);
  assert.equal(shouldRefreshAccessToken(null, now), true);
});

test("readAuthFile accepts only files with an access token", () => {
  const dir = tmpDir();
  const good = path.join(dir, "good.json");
  const noTokens = path.join(dir, "apikey-only.json");
  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(good, JSON.stringify({ tokens: { access_token: "at" } }));
  fs.writeFileSync(noTokens, JSON.stringify({ OPENAI_API_KEY: "sk-..." }));
  fs.writeFileSync(broken, "{nope");

  assert.deepEqual(readAuthFile(good), { tokens: { access_token: "at" } });
  assert.equal(readAuthFile(noTokens), null);
  assert.equal(readAuthFile(broken), null);
  assert.equal(readAuthFile(path.join(dir, "missing.json")), null);
});

test("loadCodexAuth prefers gac's own file over the Codex CLI file", () => {
  const dir = tmpDir();
  const gacAuthPath = path.join(dir, "codex-auth.json");
  const codexCliAuthPath = path.join(dir, "codex-cli-auth.json");
  const paths = { gacAuthPath, codexCliAuthPath };

  assert.equal(loadCodexAuth(paths), null);

  fs.writeFileSync(
    codexCliAuthPath,
    JSON.stringify({ tokens: { access_token: "cli" } })
  );
  assert.equal(loadCodexAuth(paths).auth.tokens.access_token, "cli");
  assert.equal(loadCodexAuth(paths).source, codexCliAuthPath);

  fs.writeFileSync(gacAuthPath, JSON.stringify({ tokens: { access_token: "own" } }));
  assert.equal(loadCodexAuth(paths).auth.tokens.access_token, "own");
  assert.equal(loadCodexAuth(paths).source, gacAuthPath);
});

test("logoutCodex removes gac credentials and reports a lingering Codex CLI login", () => {
  const dir = tmpDir();
  const gacAuthPath = path.join(dir, "codex-auth.json");
  const codexCliAuthPath = path.join(dir, "codex-cli-auth.json");
  fs.writeFileSync(gacAuthPath, JSON.stringify({ tokens: { access_token: "own" } }));
  fs.writeFileSync(
    codexCliAuthPath,
    JSON.stringify({ tokens: { access_token: "cli" } })
  );

  const first = logoutCodex({ gacAuthPath, codexCliAuthPath });
  assert.deepEqual(first, { removed: true, codexCliAuthPresent: true });
  assert.ok(!fs.existsSync(gacAuthPath));

  const second = logoutCodex({ gacAuthPath, codexCliAuthPath });
  assert.deepEqual(second, { removed: false, codexCliAuthPresent: true });
});

test("codexAuthStatus surfaces email, plan, and account id from the id token", () => {
  const dir = tmpDir();
  const gacAuthPath = path.join(dir, "codex-auth.json");
  const codexCliAuthPath = path.join(dir, "missing.json");
  const idToken = makeJwt({
    email: "user@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acc-1",
      chatgpt_plan_type: "plus",
    },
  });
  fs.writeFileSync(
    gacAuthPath,
    JSON.stringify({
      tokens: {
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        id_token: idToken,
      },
      last_refresh: "2026-01-01T00:00:00.000Z",
    })
  );

  const status = codexAuthStatus({ gacAuthPath, codexCliAuthPath });
  assert.equal(status.signedIn, true);
  assert.equal(status.email, "user@example.com");
  assert.equal(status.planType, "plus");
  assert.equal(status.accountId, "acc-1");
  assert.equal(status.needsRefresh, false);

  assert.deepEqual(
    codexAuthStatus({ gacAuthPath: path.join(dir, "none.json"), codexCliAuthPath }),
    { signedIn: false }
  );
});
