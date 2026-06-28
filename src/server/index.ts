import express, { type Request, type Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ApiErrorResponse,
  AuthConfigResponse,
  AuthStartResponse,
  SessionResponse,
  SpotifyPaging,
  SpotifyProfile
} from "../shared/types.js";

const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_URL = "https://api.spotify.com/v1";
const SCOPES = ["user-top-read", "user-read-recently-played", "user-read-private", "user-read-email"];

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const CLIENT_URL = process.env.CLIENT_URL || "http://127.0.0.1:5173";
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || `http://${HOST}:${PORT}/api/auth/callback`;
const SESSION_COOKIE = "spotistats_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

interface SpotifyTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
  tokenType: string;
}

interface SessionData {
  id: string;
  clientId?: string;
  oauthState?: string;
  codeVerifier?: string;
  tokens?: SpotifyTokens;
}

interface SpotifyTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

class AuthExpiredError extends Error {
  code = "reauthorization_required";

  constructor(message = "Spotify session expired. Please sign in again.") {
    super(message);
  }
}

const sessions = new Map<string, SessionData>();
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/api/auth/config", (_request: Request, response: Response<AuthConfigResponse>) => {
  response.json({ redirectUri: REDIRECT_URI, scopes: SCOPES });
});

app.get("/api/session", (request: Request, response: Response<SessionResponse>) => {
  const session = getExistingSession(request);
  response.json({
    authenticated: Boolean(session?.tokens),
    clientId: session?.clientId ?? null
  });
});

app.post("/api/auth/start", (request: Request, response: Response<AuthStartResponse | ApiErrorResponse>) => {
  const clientId = String(request.body?.clientId || "").trim();

  if (clientId.length < 10) {
    response.status(400).json({ code: "invalid_client_id", message: "Paste a Spotify app Client ID first." });
    return;
  }

  const session = getOrCreateSession(request, response);
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = pkceChallenge(codeVerifier);
  const oauthState = randomToken(32);

  session.clientId = clientId;
  session.codeVerifier = codeVerifier;
  session.oauthState = oauthState;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SCOPES.join(" "),
    redirect_uri: REDIRECT_URI,
    state: oauthState,
    code_challenge_method: "S256",
    code_challenge: codeChallenge
  });

  response.json({ authorizeUrl: `${SPOTIFY_AUTHORIZE_URL}?${params.toString()}` });
});

app.get("/api/auth/callback", async (request: Request, response: Response) => {
  const session = getExistingSession(request);
  const error = stringQuery(request.query.error);
  const code = stringQuery(request.query.code);
  const returnedState = stringQuery(request.query.state);

  if (error) {
    redirectToClient(response, { authError: `Spotify login failed: ${error}` });
    return;
  }

  if (!session?.clientId || !session.codeVerifier || !session.oauthState || !code || returnedState !== session.oauthState) {
    redirectToClient(response, { authError: "Spotify login could not be verified. Please try again." });
    return;
  }

  try {
    const payload = await exchangeToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: session.clientId,
      code_verifier: session.codeVerifier
    });

    if (!payload.access_token || !payload.refresh_token) {
      throw new Error("Spotify did not return a complete token response.");
    }

    session.tokens = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
      scope: payload.scope,
      tokenType: payload.token_type || "Bearer"
    };
    session.codeVerifier = undefined;
    session.oauthState = undefined;

    redirectToClient(response, { connected: "1" });
  } catch (callbackError) {
    redirectToClient(response, { authError: errorMessage(callbackError) });
  }
});

app.post("/api/auth/logout", (request: Request, response: Response<SessionResponse>) => {
  const session = getExistingSession(request);

  if (session) {
    session.tokens = undefined;
    session.codeVerifier = undefined;
    session.oauthState = undefined;
  }

  response.json({ authenticated: false, clientId: session?.clientId ?? null });
});

app.get("/api/me", withSpotify(async (session) => spotifyGet<SpotifyProfile>(session, "/me")));
app.get("/api/top/artists", withSpotify(async (session, request) => {
  const timeRange = sanitizeTimeRange(request.query.time_range);
  const query = new URLSearchParams({ time_range: timeRange, limit: "24" });
  return spotifyGet<SpotifyPaging<unknown>>(session, `/me/top/artists?${query.toString()}`);
}));
app.get("/api/top/tracks", withSpotify(async (session, request) => {
  const timeRange = sanitizeTimeRange(request.query.time_range);
  const query = new URLSearchParams({ time_range: timeRange, limit: "24" });
  return spotifyGet<SpotifyPaging<unknown>>(session, `/me/top/tracks?${query.toString()}`);
}));
app.get("/api/recent", withSpotify(async (session) => spotifyGet<SpotifyPaging<unknown>>(session, "/me/player/recently-played?limit=50")));

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDist = resolve(__dirname, "../../client");

if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_request, response) => {
    response.sendFile(resolve(clientDist, "index.html"));
  });
}

app.listen(PORT, HOST, () => {
  console.log(`Spotistats API running at http://${HOST}:${PORT}`);
  console.log(`Spotify redirect URI: ${REDIRECT_URI}`);
});

function withSpotify<T>(handler: (session: SessionData, request: Request) => Promise<T>) {
  return async (request: Request, response: Response<T | ApiErrorResponse>) => {
    const session = getExistingSession(request);

    if (!session?.tokens) {
      response.status(401).json({ code: "not_authenticated", message: "Log in with Spotify first." });
      return;
    }

    try {
      const payload = await handler(session, request);
      response.json(payload);
    } catch (apiError) {
      if (apiError instanceof AuthExpiredError) {
        response.status(401).json({ code: apiError.code, message: apiError.message });
        return;
      }

      response.status(502).json({ code: "spotify_api_error", message: errorMessage(apiError) });
    }
  };
}

async function spotifyGet<T>(session: SessionData, path: string): Promise<T> {
  const accessToken = await ensureAccessToken(session);
  const response = await fetch(`${SPOTIFY_API_URL}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));

  if (response.status === 401) {
    clearTokens(session);
    throw new AuthExpiredError();
  }

  if (!response.ok) {
    const spotifyMessage = readSpotifyError(payload);
    throw new Error(`Spotify API ${response.status}: ${spotifyMessage}`);
  }

  return payload as T;
}

async function ensureAccessToken(session: SessionData): Promise<string> {
  if (!session.tokens) {
    throw new AuthExpiredError("Spotify session is missing. Please sign in again.");
  }

  if (Date.now() > session.tokens.expiresAt - 60_000) {
    await refreshAccessToken(session);
  }

  if (!session.tokens) {
    throw new AuthExpiredError();
  }

  return session.tokens.accessToken;
}

async function refreshAccessToken(session: SessionData): Promise<void> {
  if (!session.tokens?.refreshToken || !session.clientId) {
    clearTokens(session);
    throw new AuthExpiredError();
  }

  const previousRefreshToken = session.tokens.refreshToken;
  let payload: SpotifyTokenResponse;

  try {
    payload = await exchangeToken({
      grant_type: "refresh_token",
      refresh_token: previousRefreshToken,
      client_id: session.clientId
    });
  } catch (refreshError) {
    if (refreshError instanceof AuthExpiredError) {
      clearTokens(session);
    }

    throw refreshError;
  }

  if (!payload.access_token) {
    clearTokens(session);
    throw new AuthExpiredError();
  }

  session.tokens = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || previousRefreshToken,
    expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
    scope: payload.scope || session.tokens.scope,
    tokenType: payload.token_type || session.tokens.tokenType
  };
}

async function exchangeToken(params: Record<string, string>): Promise<SpotifyTokenResponse> {
  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params)
  });
  const payload = await response.json().catch(() => ({})) as SpotifyTokenResponse;

  if (!response.ok) {
    if (payload.error === "invalid_grant") {
      throw new AuthExpiredError("Your Spotify refresh token expired. Please sign in again.");
    }

    throw new Error(payload.error_description || payload.error || "Spotify token request failed.");
  }

  return payload;
}

function clearTokens(session: SessionData): void {
  session.tokens = undefined;
}

function getOrCreateSession(request: Request, response: Response): SessionData {
  const existing = getExistingSession(request);

  if (existing) {
    return existing;
  }

  const id = randomToken(32);
  const session: SessionData = { id };
  sessions.set(id, session);
  response.setHeader("set-cookie", serializeCookie(SESSION_COOKIE, id));
  return session;
}

function getExistingSession(request: Request): SessionData | null {
  const sessionId = parseCookies(request.headers.cookie || "")[SESSION_COOKIE];
  return sessionId ? sessions.get(sessionId) ?? null : null;
}

function parseCookies(cookieHeader: string): Record<string, string> {
  return cookieHeader.split(";").reduce<Record<string, string>>((cookies, pair) => {
    const [rawKey, ...rawValue] = pair.trim().split("=");

    if (!rawKey) {
      return cookies;
    }

    cookies[rawKey] = decodeURIComponent(rawValue.join("="));
    return cookies;
  }, {});
}

function serializeCookie(name: string, value: string): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`
  ];

  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function generateCodeVerifier(): string {
  return randomBytes(64).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function sanitizeTimeRange(value: unknown): "short_term" | "medium_term" | "long_term" {
  return value === "short_term" || value === "medium_term" || value === "long_term" ? value : "medium_term";
}

function stringQuery(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function redirectToClient(response: Response, params: Record<string, string>): void {
  const url = new URL(CLIENT_URL);

  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  response.redirect(url.toString());
}

function readSpotifyError(payload: unknown): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: { message?: string } | string }).error;

    if (typeof error === "string") {
      return error;
    }

    if (error?.message) {
      return error.message;
    }
  }

  return "Spotify request failed.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected server error.";
}
