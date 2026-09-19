// The consent screen's shared request handling, on both surfaces.
//
// `authorize-request.ts` is new in i2 and both flows use it, so the parameter
// refusals and the redirect check are tested once here rather than twice through
// two components. Neither check is the authoritative one -- the complete route
// revalidates everything server side -- but the redirect check is the only thing
// standing between a bad consent response and an open redirect in the browser,
// which is why it is asserted rather than assumed.

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  readAuthorizeRequest,
  submitConsent,
  submitDenial,
} from "./authorize-request";

const REDIRECT_URI = "https://client.example.test/callback";

function params(overrides: Record<string, string | null> = {}) {
  const base: Record<string, string> = {
    client_id: "obcr1.synthetic",
    redirect_uri: REDIRECT_URI,
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    response_type: "code",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete base[key];
    else base[key] = value;
  }
  return new URLSearchParams(base);
}

describe("readAuthorizeRequest", () => {
  test("accepts a complete request and names the destination host", () => {
    const request = readAuthorizeRequest(params({ state: "abc" }));
    expect(request).toMatchObject({
      clientId: "obcr1.synthetic",
      redirectUri: REDIRECT_URI,
      state: "abc",
      redirectDestination: "client.example.test",
    });
  });

  test.each([
    ["no client", { client_id: null }],
    ["no redirect", { redirect_uri: null }],
    ["a relative redirect", { redirect_uri: "/callback" }],
    ["no challenge", { code_challenge: null }],
    ["a plain challenge method", { code_challenge_method: "plain" }],
    ["a token response type", { response_type: "token" }],
    ["another scope", { scope: "admin" }],
  ])("refuses %s", (_name, overrides) => {
    expect(readAuthorizeRequest(params(overrides))).toBeNull();
  });
});

describe("submitConsent", () => {
  const request = readAuthorizeRequest(params())!;

  afterEach(() => vi.unstubAllGlobals());

  function respondWith(body: unknown, ok = true) {
    const fetchMock = vi.fn(async () => ({
      ok,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  test("returns the redirect and sends only the consent decision", async () => {
    const fetchMock = respondWith({
      redirect_url: `${REDIRECT_URI}?code=obac1.synthetic&state=abc`,
    });

    const redirect = await submitConsent(request, {
      spaceIds: ["space-a"],
      capabilities: ["read"],
    });
    expect(redirect).toBe(`${REDIRECT_URI}?code=obac1.synthetic&state=abc`);

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe("/api/mcp/authorize/complete");
    expect(JSON.parse(init.body)).toMatchObject({
      clientId: "obcr1.synthetic",
      spaceIds: ["space-a"],
      capabilities: ["read"],
    });
  });

  test.each([
    ["a different origin", "https://attacker.example.test/callback?code=x"],
    ["a different path", `https://client.example.test/other?code=x`],
    ["a non-URL", "not-a-url"],
  ])("refuses a redirect to %s", async (_name, redirectUrl) => {
    respondWith({ redirect_url: redirectUrl });
    await expect(
      submitConsent(request, { spaceIds: ["space-a"], capabilities: ["read"] }),
    ).rejects.toThrow();
  });

  test("refuses a response with no redirect at all", async () => {
    respondWith({ ok: true });
    await expect(
      submitConsent(request, { spaceIds: ["space-a"], capabilities: ["read"] }),
    ).rejects.toThrow("Authorization returned an invalid redirect");
  });

  test("propagates a refusal from the route", async () => {
    respondWith({ error: "Selected access is no longer available" }, false);
    await expect(
      submitConsent(request, { spaceIds: ["space-a"], capabilities: ["read"] }),
    ).rejects.toThrow("Selected access is no longer available");
  });
});

describe("submitDenial", () => {
  const request = readAuthorizeRequest(params({ state: "abc" }))!;

  afterEach(() => vi.unstubAllGlobals());

  function respondWith(body: unknown) {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  test("posts a denial with no grant and returns the error redirect", async () => {
    const denied = `${REDIRECT_URI}?error=access_denied&state=abc`;
    const fetchMock = respondWith({ redirect_url: denied });

    expect(await submitDenial(request)).toBe(denied);
    const [, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      { body: string },
    ];
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ decision: "deny", state: "abc" });
    expect(body).not.toHaveProperty("spaceIds");
    expect(body).not.toHaveProperty("capabilities");
  });

  test("refuses a denial redirect to another origin", async () => {
    respondWith({
      redirect_url: "https://attacker.example.test/callback?error=access_denied",
    });
    await expect(submitDenial(request)).rejects.toThrow(
      "Authorization returned an invalid redirect",
    );
  });
});
