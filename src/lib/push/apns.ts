import http2 from "node:http2";
import { readFileSync } from "node:fs";
import { SignJWT, importPKCS8 } from "jose";

/**
 * Minimal APNs client (token-based auth, HTTP/2). The NAS only needs outbound
 * HTTPS to Apple; nothing here listens for connections.
 *
 * Config (env):
 *   APNS_KEY_ID     10-char id of the .p8 key (Apple Developer > Keys)
 *   APNS_TEAM_ID    10-char team id
 *   APNS_BUNDLE_ID  app bundle id (default com.dbullard.ledgr)
 *   APNS_KEY_FILE   path to the AuthKey_XXXX.p8 inside the container (e.g. /data/apns.p8)
 *   APNS_KEY        ...or the PEM contents inline (\n escapes allowed)
 */

export type ApnsEnvironment = "sandbox" | "production";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  privateKeyPem: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Collapses related notifications on the lock screen. */
  threadId?: string;
  /** Opaque data the app can use to deep-link, e.g. { kind: "bill" }. */
  data?: Record<string, string>;
}

export type ApnsResult =
  | { ok: true; environment: ApnsEnvironment }
  | { ok: false; status: number; reason: string; invalidToken: boolean };

export interface TransportResponse {
  status: number;
  body: string;
}

export type ApnsTransport = (
  environment: ApnsEnvironment,
  deviceToken: string,
  headers: Record<string, string>,
  body: string,
) => Promise<TransportResponse>;

const HOSTS: Record<ApnsEnvironment, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

/** Reads config from env. Returns null (push disabled) when anything is missing. */
export function getApnsConfig(env: Record<string, string | undefined> = process.env): ApnsConfig | null {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  if (!keyId || !teamId) return null;

  let pem = env.APNS_KEY?.trim();
  if (!pem && env.APNS_KEY_FILE?.trim()) {
    try {
      pem = readFileSync(env.APNS_KEY_FILE.trim(), "utf8");
    } catch (err) {
      console.error(`[push] cannot read APNS_KEY_FILE (${env.APNS_KEY_FILE}):`, (err as Error).message);
      return null;
    }
  }
  if (!pem) return null;

  return {
    keyId,
    teamId,
    bundleId: env.APNS_BUNDLE_ID?.trim() || "com.dbullard.ledgr",
    privateKeyPem: pem.replace(/\\n/g, "\n"),
  };
}

// Apple rejects a provider token refreshed more often than every 20 minutes and
// one older than 60, so cache for 50.
const TOKEN_TTL_MS = 50 * 60 * 1000;
let cachedJwt: { key: string; jwt: string; at: number } | null = null;

export async function providerToken(config: ApnsConfig, now = Date.now()): Promise<string> {
  const cacheKey = `${config.keyId}:${config.teamId}`;
  if (cachedJwt && cachedJwt.key === cacheKey && now - cachedJwt.at < TOKEN_TTL_MS) return cachedJwt.jwt;
  const key = await importPKCS8(config.privateKeyPem, "ES256");
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: config.keyId })
    .setIssuer(config.teamId)
    .setIssuedAt(Math.floor(now / 1000))
    .sign(key);
  cachedJwt = { key: cacheKey, jwt, at: now };
  return jwt;
}

/** Test-only. */
export function __resetApnsState(): void {
  cachedJwt = null;
  for (const s of sessions.values()) s.destroy();
  sessions.clear();
}

const sessions = new Map<ApnsEnvironment, http2.ClientHttp2Session>();

function getSession(environment: ApnsEnvironment): http2.ClientHttp2Session {
  const existing = sessions.get(environment);
  if (existing && !existing.closed && !existing.destroyed) return existing;
  const session = http2.connect(HOSTS[environment]);
  const drop = () => {
    if (sessions.get(environment) === session) sessions.delete(environment);
  };
  session.on("error", drop);
  session.on("close", drop);
  session.on("goaway", drop);
  session.setTimeout(60_000, () => session.close());
  // Don't keep the Node process alive just for an idle APNs connection.
  session.unref();
  sessions.set(environment, session);
  return session;
}

const httpTransport: ApnsTransport = (environment, deviceToken, headers, body) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const session = getSession(environment);
    const req = session.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      ...headers,
    });
    let status = 0;
    let data = "";
    req.setEncoding("utf8");
    req.setTimeout(10_000, () => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      finish(() => reject(new Error("APNs request timed out")));
    });
    req.on("response", (h) => {
      status = Number(h[":status"]);
    });
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => finish(() => resolve({ status, body: data })));
    req.on("error", (err) => finish(() => reject(err)));
    req.end(body);
  });

function buildPayload(message: PushMessage): string {
  return JSON.stringify({
    aps: {
      alert: { title: message.title, body: message.body },
      sound: "default",
      ...(message.threadId ? { "thread-id": message.threadId } : {}),
    },
    ...(message.data ?? {}),
  });
}

function parseReason(body: string): string {
  try {
    const r = JSON.parse(body) as { reason?: string };
    return r.reason ?? "Unknown";
  } catch {
    return "Unknown";
  }
}

/**
 * Sends one notification. If APNs says BadDeviceToken the token may simply have
 * been issued for the other environment (a Release build installed from Xcode
 * gets a sandbox token), so it's retried once against the other host before the
 * token is declared dead.
 */
export async function sendApns(
  config: ApnsConfig,
  device: { token: string; environment: ApnsEnvironment },
  message: PushMessage,
  transport: ApnsTransport = httpTransport,
): Promise<ApnsResult> {
  const jwt = await providerToken(config);
  const body = buildPayload(message);
  const headers = {
    authorization: `bearer ${jwt}`,
    "apns-topic": config.bundleId,
    "apns-push-type": "alert",
    "apns-priority": "10",
    // Drop it if the phone has been off for a day; a stale bill alert is noise.
    "apns-expiration": String(Math.floor(Date.now() / 1000) + 86_400),
    "content-type": "application/json",
  };

  const other: ApnsEnvironment = device.environment === "sandbox" ? "production" : "sandbox";
  const order: ApnsEnvironment[] = [device.environment, other];

  let last: { status: number; reason: string } = { status: 0, reason: "NotSent" };
  for (const environment of order) {
    const res = await transport(environment, device.token, headers, body);
    if (res.status === 200) return { ok: true, environment };
    const reason = parseReason(res.body);
    last = { status: res.status, reason };
    if (reason !== "BadDeviceToken") break; // only that error means "try the other host"
  }

  const invalidToken =
    last.reason === "Unregistered" || last.reason === "BadDeviceToken" || last.status === 410;
  return { ok: false, status: last.status, reason: last.reason, invalidToken };
}
