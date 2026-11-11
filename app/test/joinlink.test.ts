/** Invite-link tests. Run: npm test --workspace app */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeJoinLink, encodeJoinLink, isLoopbackUrl, normalizeWsUrl } from "../src/renderer/src/lib/joinlink";

const target = { url: "wss://quiet-river-1234.trycloudflare.com", room: "ABC234" };
const link = encodeJoinLink(target);

test("round-trips", () => {
  assert.deepEqual(decodeJoinLink(link), target);
});

test("survives the ways chat apps mangle a paste", () => {
  assert.deepEqual(decodeJoinLink(`  ${link}\n`), target);
  assert.deepEqual(decodeJoinLink(`join us tonight: ${link} 🎮`), target);
  assert.deepEqual(decodeJoinLink(`"${link}"`), target);
  const wrapped = link.slice(0, 20) + "\n" + link.slice(20);
  assert.deepEqual(decodeJoinLink(wrapped), target);
});

test("rejects things that aren't invites", () => {
  assert.equal(decodeJoinLink("ABC234"), null);
  assert.equal(decodeJoinLink(""), null);
  assert.equal(decodeJoinLink("hello there friend, how are you"), null);
  assert.equal(decodeJoinLink(encodeJoinLink({ url: "wss://x.example", room: "../../etc" })), null);
});

test("handles non-ASCII safely", () => {
  const t = { url: "wss://example.com/கூட்டணி", room: "R1" };
  assert.deepEqual(decodeJoinLink(encodeJoinLink(t)), t);
});

test("normalizes server addresses", () => {
  assert.equal(normalizeWsUrl("https://a.trycloudflare.com/"), "wss://a.trycloudflare.com");
  assert.equal(normalizeWsUrl("http://localhost:8787"), "ws://localhost:8787");
  assert.equal(normalizeWsUrl("a.trycloudflare.com"), "wss://a.trycloudflare.com");
  assert.equal(normalizeWsUrl(" wss://x.y "), "wss://x.y");
});

test("spots loopback addresses", () => {
  assert.equal(isLoopbackUrl("ws://localhost:8787"), true);
  assert.equal(isLoopbackUrl("ws://127.0.0.1:5000"), true);
  assert.equal(isLoopbackUrl("wss://localhost.example.com"), false);
  assert.equal(isLoopbackUrl("wss://a.trycloudflare.com"), false);
});
