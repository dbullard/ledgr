import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair, decodeJwt, decodeProtectedHeader } from "jose";
import {
  __resetApnsState,
  getApnsConfig,
  providerToken,
  sendApns,
  type ApnsConfig,
  type ApnsTransport,
} from "./apns";

let config: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  config = {
    keyId: "ABC123DEFG",
    teamId: "TEAM123456",
    bundleId: "com.example.app",
    privateKeyPem: await exportPKCS8(privateKey),
  };
});

beforeEach(() => __resetApnsState());

const msg = { title: "Hi", body: "There", threadId: "bills", data: { kind: "bill" } };
const resp = (status: number, reason?: string) => ({ status, body: reason ? JSON.stringify({ reason }) : "" });

describe("getApnsConfig", () => {
  it("is null until key id, team id and a key are all present", () => {
    expect(getApnsConfig({})).toBeNull();
    expect(getApnsConfig({ APNS_KEY_ID: "K", APNS_TEAM_ID: "T" })).toBeNull();
    expect(getApnsConfig({ APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_KEY: "pem" })).toMatchObject({
      keyId: "K",
      teamId: "T",
      bundleId: "com.dbullard.ledgr",
      privateKeyPem: "pem",
    });
  });

  it("accepts \\n escapes in an inline key and a custom bundle id", () => {
    const c = getApnsConfig({ APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_KEY: "a\\nb", APNS_BUNDLE_ID: "x.y" });
    expect(c?.privateKeyPem).toBe("a\nb");
    expect(c?.bundleId).toBe("x.y");
  });

  it("is null when the key file cannot be read", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(getApnsConfig({ APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_KEY_FILE: "/nonexistent/key.p8" })).toBeNull();
    err.mockRestore();
  });
});

describe("providerToken", () => {
  it("signs an ES256 JWT with the key id and team id", async () => {
    const jwt = await providerToken(config);
    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: "ES256", kid: "ABC123DEFG" });
    expect(decodeJwt(jwt).iss).toBe("TEAM123456");
  });

  it("reuses the token for 50 minutes, then refreshes", async () => {
    const t0 = 1_800_000_000_000;
    const a = await providerToken(config, t0);
    expect(await providerToken(config, t0 + 49 * 60_000)).toBe(a);
    expect(await providerToken(config, t0 + 51 * 60_000)).not.toBe(a);
  });
});

describe("sendApns", () => {
  it("posts the alert payload with the topic and bearer token", async () => {
    const transport = vi.fn<ApnsTransport>().mockResolvedValue(resp(200));
    const res = await sendApns(config, { token: "aa", environment: "production" }, msg, transport);

    expect(res).toEqual({ ok: true, environment: "production" });
    const [env, token, headers, body] = transport.mock.calls[0];
    expect(env).toBe("production");
    expect(token).toBe("aa");
    expect(headers["apns-topic"]).toBe("com.example.app");
    expect(headers["apns-push-type"]).toBe("alert");
    expect(headers.authorization).toMatch(/^bearer ey/);
    expect(JSON.parse(body)).toEqual({
      aps: { alert: { title: "Hi", body: "There" }, sound: "default", "thread-id": "bills" },
      kind: "bill",
    });
  });

  it("retries the other environment on BadDeviceToken and reports where it worked", async () => {
    const transport = vi
      .fn<ApnsTransport>()
      .mockResolvedValueOnce(resp(400, "BadDeviceToken"))
      .mockResolvedValueOnce(resp(200));
    const res = await sendApns(config, { token: "aa", environment: "production" }, msg, transport);

    expect(res).toEqual({ ok: true, environment: "sandbox" });
    expect(transport.mock.calls.map((c) => c[0])).toEqual(["production", "sandbox"]);
  });

  it("marks a token invalid when both hosts say BadDeviceToken", async () => {
    const transport = vi.fn<ApnsTransport>().mockResolvedValue(resp(400, "BadDeviceToken"));
    const res = await sendApns(config, { token: "aa", environment: "sandbox" }, msg, transport);
    expect(res).toMatchObject({ ok: false, invalidToken: true, reason: "BadDeviceToken" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("marks Unregistered (410) invalid without trying the other host", async () => {
    const transport = vi.fn<ApnsTransport>().mockResolvedValue(resp(410, "Unregistered"));
    const res = await sendApns(config, { token: "aa", environment: "sandbox" }, msg, transport);
    expect(res).toMatchObject({ ok: false, invalidToken: true, status: 410 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not drop the device for other failures", async () => {
    const transport = vi.fn<ApnsTransport>().mockResolvedValue(resp(403, "InvalidProviderToken"));
    const res = await sendApns(config, { token: "aa", environment: "sandbox" }, msg, transport);
    expect(res).toMatchObject({ ok: false, invalidToken: false, reason: "InvalidProviderToken" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
