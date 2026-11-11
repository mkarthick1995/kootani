/**
 * Signaling core tests — real WebSockets against a real server on a free port.
 * Run: npm test --workspace server
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createSignalingServer, type SignalingHandle, type SignalingOptions } from "../src/signaling.js";
import { PROTOCOL_VERSION, type ServerMessage } from "../src/protocol.js";

/** A test client that records every message and lets tests await specific ones. */
class Client {
  readonly ws: WebSocket;
  readonly inbox: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  closed = false;

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      this.inbox.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
    this.ws.on("close", () => (this.closed = true));
  }

  open(): Promise<void> {
    return new Promise((res, rej) => {
      if (this.ws.readyState === WebSocket.OPEN) return res();
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  send(msg: object): void {
    this.ws.send(JSON.stringify(msg));
  }

  next<T extends ServerMessage["type"]>(type: T, timeoutMs = 2000): Promise<Extract<ServerMessage, { type: T }>> {
    const existing = this.inbox.find((m) => m.type === type);
    if (existing) {
      this.inbox.splice(this.inbox.indexOf(existing), 1);
      return Promise.resolve(existing as Extract<ServerMessage, { type: T }>);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        pred: (m) => m.type === type,
        resolve: (m) => {
          clearTimeout(t);
          this.inbox.splice(this.inbox.indexOf(m), 1);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }

  /** Assert nothing of `type` arrives within `ms`. */
  async none(type: ServerMessage["type"], ms = 150): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    assert.equal(this.inbox.filter((m) => m.type === type).length, 0, `unexpected ${type}`);
  }

  async join(room: string, name: string, extra: object = {}) {
    await this.open();
    this.send({ type: "join", room, user: { name }, version: PROTOCOL_VERSION, ...extra });
    return this.next("joined");
  }

  close(): void {
    this.ws.close();
  }
}

async function withServer(opts: SignalingOptions, fn: (s: SignalingHandle) => Promise<void>): Promise<void> {
  const server = await createSignalingServer({ port: 0, ...opts });
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

describe("rooms and host role", () => {
  let server: SignalingHandle;
  before(async () => (server = await createSignalingServer({ port: 0 })));
  after(() => server.close());

  test("first member creates the room and is host; second sees the first", async () => {
    const a = new Client(server.port);
    const b = new Client(server.port);
    const ja = await a.join("ROOM1", "Alice");
    assert.equal(ja.hostId, ja.selfId);
    assert.deepEqual(ja.peers, []);
    assert.equal(ja.resumed, false);
    assert.ok(ja.token.length > 20);

    const jb = await b.join("ROOM1", "Bob");
    assert.equal(jb.hostId, ja.selfId);
    assert.equal(jb.peers.length, 1);
    assert.equal(jb.peers[0].user.name, "Alice");
    assert.equal(jb.peers[0].isHost, true);

    const pj = await a.next("peer-joined");
    assert.equal(pj.peer.id, jb.selfId);
    a.close();
    b.close();
  });

  test("signals are relayed with the sender's id", async () => {
    const a = new Client(server.port);
    const b = new Client(server.port);
    const ja = await a.join("ROOM2", "Alice");
    const jb = await b.join("ROOM2", "Bob");
    b.send({ type: "signal", to: ja.selfId, data: { kind: "sdp", x: 1 } });
    const sig = await a.next("signal");
    assert.equal(sig.from, jb.selfId);
    assert.deepEqual(sig.data, { kind: "sdp", x: 1 });
    a.close();
    b.close();
  });

  test("only the host can transfer the role", async () => {
    const a = new Client(server.port);
    const b = new Client(server.port);
    const ja = await a.join("ROOM3", "Alice");
    const jb = await b.join("ROOM3", "Bob");
    b.send({ type: "transfer-host", to: jb.selfId });
    assert.equal((await b.next("error")).code, "not-host");

    a.send({ type: "transfer-host", to: jb.selfId });
    assert.equal((await a.next("host-changed")).hostId, jb.selfId);
    assert.equal((await b.next("host-changed")).hostId, jb.selfId);
    assert.notEqual(ja.selfId, jb.selfId);
    a.close();
    b.close();
  });

  test("clean leave promotes the oldest remaining member immediately", async () => {
    const a = new Client(server.port);
    const b = new Client(server.port);
    const c = new Client(server.port);
    const ja = await a.join("ROOM4", "Alice");
    const jb = await b.join("ROOM4", "Bob");
    await c.join("ROOM4", "Carol");
    a.send({ type: "leave" });
    assert.equal((await c.next("host-changed")).hostId, jb.selfId);
    assert.equal((await c.next("peer-left")).peerId, ja.selfId);
    b.close();
    c.close();
  });
});

describe("hostile or malformed input never crashes the server", () => {
  test("null, arrays, junk, bad types and huge names are rejected politely", async () => {
    await withServer({}, async (server) => {
      const a = new Client(server.port);
      await a.open();
      for (const junk of ["null", "[]", "42", "not json", '"str"', "{}", '{"type":"nope"}']) {
        a.sendRaw(junk);
        assert.equal((await a.next("error")).code, "bad-request", `for ${junk}`);
      }
      a.send({ type: "join", room: "../../etc", user: { name: "x" }, version: PROTOCOL_VERSION });
      assert.equal((await a.next("error")).code, "bad-request");
      a.send({ type: "join", room: "OK", user: null, version: PROTOCOL_VERSION });
      assert.equal((await a.next("error")).code, "bad-request");
      a.send({ type: "join", room: "OK", user: { name: "   " }, version: PROTOCOL_VERSION });
      assert.equal((await a.next("error")).code, "bad-request");

      const j = await a.join("OK", "x".repeat(500), { user: { name: "x".repeat(500), picture: "javascript:alert(1)" } });
      assert.equal(j.selfId.length > 0, true);
      const b = new Client(server.port);
      const jb = await b.join("OK", "Bob");
      assert.equal(jb.peers[0].user.name.length, 48);
      assert.equal(jb.peers[0].user.picture, undefined);

      // Still alive and serving.
      a.send({ type: "ping" });
      await a.next("pong");
      a.close();
      b.close();
    });
  });

  test("oversized frames are refused without affecting others", async () => {
    await withServer({}, async (server) => {
      const a = new Client(server.port);
      const b = new Client(server.port);
      await a.join("BIG", "Alice");
      await b.join("BIG", "Bob");
      a.sendRaw(JSON.stringify({ type: "signal", to: "x", data: "y".repeat(400 * 1024) }));
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(a.closed, true);
      b.send({ type: "ping" });
      await b.next("pong");
      b.close();
    });
  });

  test("outdated clients get a fatal, friendly error", async () => {
    await withServer({}, async (server) => {
      const a = new Client(server.port);
      await a.open();
      a.send({ type: "join", room: "R", user: { name: "Old" } }); // no version = v1
      const err = await a.next("error");
      assert.equal(err.code, "outdated-client");
      assert.equal(err.fatal, true);
      assert.match(err.message, /out of date/);
    });
  });
});

describe("limits and locking", () => {
  test("rooms are capped", async () => {
    await withServer({ maxMembers: 2 }, async (server) => {
      const a = new Client(server.port);
      const b = new Client(server.port);
      const c = new Client(server.port);
      await a.join("CAP", "A");
      await b.join("CAP", "B");
      await c.open();
      c.send({ type: "join", room: "CAP", user: { name: "C" }, version: PROTOCOL_VERSION });
      const err = await c.next("error");
      assert.equal(err.code, "room-full");
      assert.equal(err.fatal, true);
      a.close();
      b.close();
    });
  });

  test("lockToFirstRoom refuses strangers' rooms", async () => {
    await withServer({ lockToFirstRoom: true }, async (server) => {
      const a = new Client(server.port);
      await a.join("MINE", "Host");
      const x = new Client(server.port);
      await x.open();
      x.send({ type: "join", room: "THEIRS", user: { name: "Stranger" }, version: PROTOCOL_VERSION });
      assert.equal((await x.next("error")).code, "no-such-room");
      const b = new Client(server.port);
      const jb = await b.join("MINE", "Friend");
      assert.equal(jb.peers.length, 1);
      a.close();
      b.close();
    });
  });

  test("ICE servers are shared in joined", async () => {
    const ice = [{ urls: "turn:relay.example.com:3478", username: "u", credential: "p" }];
    await withServer({ iceServers: ice }, async (server) => {
      const a = new Client(server.port);
      assert.deepEqual((await a.join("ICE", "A")).iceServers, ice);
      a.close();
    });
  });
});

describe("resume after a dropped connection", () => {
  test("a resumed member keeps their id; peers see away/back but never peer-left", async () => {
    await withServer({ graceMs: 2000 }, async (server) => {
      const a = new Client(server.port);
      const b = new Client(server.port);
      const ja = await a.join("RES", "Alice");
      const jb = await b.join("RES", "Bob");
      await a.next("peer-joined");

      b.ws.terminate(); // abrupt drop, no leave
      const away = await a.next("peer-status");
      assert.deepEqual([away.peerId, away.away], [jb.selfId, true]);

      // Messages sent while Bob is away are queued…
      a.send({ type: "signal", to: jb.selfId, data: "while-away" });

      const b2 = new Client(server.port);
      const jb2 = await b2.join("RES", "Bob", { resume: { memberId: jb.selfId, token: jb.token } });
      assert.equal(jb2.resumed, true);
      assert.equal(jb2.selfId, jb.selfId);
      assert.equal(jb2.hostId, ja.selfId);
      // …and delivered on resume.
      assert.equal((await b2.next("signal")).data, "while-away");

      const back = await a.next("peer-status");
      assert.deepEqual([back.peerId, back.away], [jb.selfId, false]);
      await a.none("peer-left");
      a.close();
      b2.close();
    });
  });

  test("a wrong token can't hijack a seat", async () => {
    await withServer({ graceMs: 2000 }, async (server) => {
      const a = new Client(server.port);
      const ja = await a.join("HIJ", "Alice");
      const x = new Client(server.port);
      const jx = await x.join("HIJ", "Mallory", { resume: { memberId: ja.selfId, token: "guess" } });
      assert.equal(jx.resumed, false);
      assert.notEqual(jx.selfId, ja.selfId);
      a.close();
      x.close();
    });
  });

  test("after the grace period the member is removed and the host role moves", async () => {
    await withServer({ graceMs: 150 }, async (server) => {
      const a = new Client(server.port);
      const b = new Client(server.port);
      const ja = await a.join("GRACE", "Alice");
      const jb = await b.join("GRACE", "Bob");
      a.ws.terminate();
      assert.equal((await b.next("peer-status")).away, true);
      assert.equal((await b.next("host-changed")).hostId, jb.selfId);
      assert.equal((await b.next("peer-left")).peerId, ja.selfId);

      // A late resume becomes a fresh join.
      const a2 = new Client(server.port);
      const ja2 = await a2.join("GRACE", "Alice", { resume: { memberId: ja.selfId, token: ja.token } });
      assert.equal(ja2.resumed, false);
      assert.notEqual(ja2.selfId, ja.selfId);
      a2.close();
      b.close();
    });
  });

  test("resuming while the old socket is still half-open replaces it", async () => {
    await withServer({ graceMs: 2000 }, async (server) => {
      const a = new Client(server.port);
      const b = new Client(server.port);
      await a.join("HALF", "Alice");
      const jb = await b.join("HALF", "Bob");
      const b2 = new Client(server.port);
      const jb2 = await b2.join("HALF", "Bob", { resume: { memberId: jb.selfId, token: jb.token } });
      assert.equal(jb2.resumed, true);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(b.closed, true, "old socket should be terminated");
      await a.none("peer-left");
      assert.equal(server.stats().members, 2);
      a.close();
      b2.close();
    });
  });
});
