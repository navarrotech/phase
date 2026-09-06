import assert from "node:assert/strict";
import { test } from "node:test";

import { isOriginAllowed, llmCorsHeaders, withinRateLimit } from "../src/llm-decide.ts";

function requestFrom(origin, ip = "203.0.113.1") {
  const headers = new Headers({ "CF-Connecting-IP": ip });
  if (origin) headers.set("Origin", origin);
  return new Request("https://lobby.example/llm/decide", { method: "POST", headers });
}

test("an unset allowlist admits any origin", () => {
  // Self-hosted deployments run without configuration; the rate limit is what
  // bounds them, not the origin check.
  assert.equal(isOriginAllowed(requestFrom("https://anywhere.example"), {}), true);
  assert.equal(isOriginAllowed(requestFrom("https://anywhere.example"), { ALLOWED_ORIGINS: "*" }), true);
});

test("a configured allowlist admits only its own origins", () => {
  const env = { ALLOWED_ORIGINS: "https://phase-rs.dev, http://localhost:5173" };
  assert.equal(isOriginAllowed(requestFrom("https://phase-rs.dev"), env), true);
  assert.equal(isOriginAllowed(requestFrom("http://localhost:5173"), env), true);
  assert.equal(isOriginAllowed(requestFrom("https://evil.example"), env), false);
});

test("a request with no Origin is admitted and left to the rate limit", () => {
  // Same-origin and non-browser callers may omit Origin entirely. Rejecting
  // them here would break the former and only inconvenience the latter, which
  // can forge any header it likes anyway.
  const env = { ALLOWED_ORIGINS: "https://phase-rs.dev" };
  assert.equal(isOriginAllowed(requestFrom(null), env), true);
});

test("CORS echoes an allowlisted origin and varies on it", () => {
  const env = { ALLOWED_ORIGINS: "https://phase-rs.dev" };
  const headers = llmCorsHeaders(requestFrom("https://phase-rs.dev"), env);
  assert.equal(headers["Access-Control-Allow-Origin"], "https://phase-rs.dev");
  assert.equal(headers.Vary, "Origin");
});

test("CORS does not echo an origin that is not allowlisted", () => {
  const env = { ALLOWED_ORIGINS: "https://phase-rs.dev" };
  const headers = llmCorsHeaders(requestFrom("https://evil.example"), env);
  assert.notEqual(headers["Access-Control-Allow-Origin"], "https://evil.example");
});

test("the rate limit admits a burst then turns the same address away", () => {
  const address = "198.51.100.7";
  const now = 1_000_000;
  // The 30-request budget is well above honest play: a game escalates a few
  // dozen decisions total, each gated behind a model round-trip.
  for (let attempt = 0; attempt < 30; attempt++) {
    assert.equal(withinRateLimit(requestFrom(null, address), now), true, `attempt ${attempt}`);
  }
  assert.equal(withinRateLimit(requestFrom(null, address), now), false);
});

test("the budget refills once the window lapses", () => {
  const address = "198.51.100.8";
  const now = 2_000_000;
  for (let attempt = 0; attempt < 30; attempt++) withinRateLimit(requestFrom(null, address), now);
  assert.equal(withinRateLimit(requestFrom(null, address), now), false);
  assert.equal(withinRateLimit(requestFrom(null, address), now + 60_001), true);
});

test("one address exhausting its budget does not affect another", () => {
  const now = 3_000_000;
  for (let attempt = 0; attempt < 30; attempt++) withinRateLimit(requestFrom(null, "198.51.100.9"), now);
  assert.equal(withinRateLimit(requestFrom(null, "198.51.100.9"), now), false);
  assert.equal(withinRateLimit(requestFrom(null, "198.51.100.10"), now), true);
});
