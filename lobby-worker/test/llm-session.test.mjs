import assert from "node:assert/strict";
import { test } from "node:test";

import { seal, unseal } from "../src/llm-session.ts";

/** A deterministic 32-byte key, base64 — the shape `LLM_SEAL_KEY` must hold. */
const KEY = Buffer.alloc(32, 7).toString("base64");
const env = { LLM_SEAL_KEY: KEY };

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CREDENTIAL = "sk-ant-api03-not-a-real-key-0123456789";

test("a sealed credential round-trips for the account it was sealed for", async () => {
  const sealed = await seal(env, ALICE, CREDENTIAL);
  assert.ok(sealed, "sealing must succeed with a valid key");
  assert.equal(await unseal(env, ALICE, sealed), CREDENTIAL);
});

test("the sealed blob does not contain the credential", async () => {
  const sealed = await seal(env, ALICE, CREDENTIAL);
  // The whole point of storing ciphertext: a database dump must be inert.
  assert.ok(!sealed.includes(CREDENTIAL));
  assert.ok(!Buffer.from(sealed, "base64").toString("utf8").includes("sk-ant"));
});

test("a blob sealed for one account cannot be opened for another", async () => {
  // This is the property that makes a stolen row worthless: the user id is
  // GCM Additional Authenticated Data, and the Worker only ever passes the id
  // of the caller it just verified.
  const sealed = await seal(env, ALICE, CREDENTIAL);
  assert.equal(await unseal(env, BOB, sealed), null);
});

test("a tampered blob fails authentication rather than decrypting", async () => {
  const sealed = await seal(env, ALICE, CREDENTIAL);
  const bytes = Buffer.from(sealed, "base64");
  // Flip a bit in the ciphertext body, past the 12-byte nonce.
  bytes[bytes.length - 1] ^= 0x01;
  assert.equal(await unseal(env, ALICE, bytes.toString("base64")), null);
});

test("each sealing uses a fresh nonce", async () => {
  // Equal plaintexts must not produce equal ciphertexts, or the store leaks
  // which accounts share a credential.
  const first = await seal(env, ALICE, CREDENTIAL);
  const second = await seal(env, ALICE, CREDENTIAL);
  assert.notEqual(first, second);
  assert.equal(await unseal(env, ALICE, first), CREDENTIAL);
  assert.equal(await unseal(env, ALICE, second), CREDENTIAL);
});

test("garbage input is rejected without throwing", async () => {
  assert.equal(await unseal(env, ALICE, "not base64 at all !!!"), null);
  assert.equal(await unseal(env, ALICE, ""), null);
  // Shorter than the nonce, so there is no ciphertext to authenticate.
  assert.equal(await unseal(env, ALICE, Buffer.alloc(4).toString("base64")), null);
});

test("a missing or wrong-sized key disables sealing rather than weakening it", async () => {
  assert.equal(await seal({}, ALICE, CREDENTIAL), null);
  const shortKey = { LLM_SEAL_KEY: Buffer.alloc(16, 7).toString("base64") };
  assert.equal(await seal(shortKey, ALICE, CREDENTIAL), null);
});

test("a rotated key cannot open blobs sealed under the old one", async () => {
  const sealed = await seal(env, ALICE, CREDENTIAL);
  const rotated = { LLM_SEAL_KEY: Buffer.alloc(32, 9).toString("base64") };
  assert.equal(await unseal(rotated, ALICE, sealed), null);
});
