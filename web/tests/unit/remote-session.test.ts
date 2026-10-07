import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SyncSession,
  containsVersion,
} from "../../src/lib/editor/remote/session";
import type { Version, SyncPacket } from "../../src/lib/editor/contract";
const version = (clock: number, id = "a"): Version => ({
  identity: { document_id: id, history_id: "history" },
  clocks: { "1": clock },
});
const packet = (id = "a"): SyncPacket => ({
  identity: version(0, id).identity,
  kind: "updates",
  data: [1, 2],
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function setup(limits?: { operations: number; bytes: number }) {
  const sent: { operation: number; id: string; version: Version }[] = [];
  const replies: ((reply: { operation: number; version: Version }) => void)[] =
    [];
  const failures: unknown[] = [];
  const states: boolean[] = [];
  const session = new SyncSession(
    (update) => {
      sent.push(update);
      return new Promise((resolve) => replies.push(resolve));
    },
    (state) => states.push(state),
    (error) => failures.push(error),
    limits,
  );
  return { session, sent, replies, failures, states };
}
test("edits enqueue immediately while host acknowledgements are delayed, with ordered transmission", async () => {
  const { session, sent, replies, states } = setup();
  session.acknowledge("a", version(0));
  session.acknowledge("b", version(0, "b"));
  session.enqueue("a", packet(), version(1));
  session.enqueue("a", packet(), version(2));
  assert.equal(sent.length, 1);
  assert.equal(session.unconfirmed, true);
  await session.wait("b", version(0, "b"));
  let confirmedSecond = false;
  const second = session.wait("a", version(2)).then(() => {
    confirmedSecond = true;
  });
  const drained = session.drain();
  replies[0]({ operation: 1, version: version(1) });
  await tick();
  assert.equal(sent.length, 2);
  assert.equal(confirmedSecond, false);
  replies[1]({ operation: 2, version: version(2) });
  await second;
  await drained;
  assert.equal(session.unconfirmed, false);
  assert.deepEqual(states, [true, true, true, false]);
});
test("a pushed host version satisfies a causal save barrier while the operation receipt is still pending", async () => {
  const { session, replies } = setup();
  session.enqueue("a", packet(), version(1));
  session.acknowledge("a", version(1));
  await session.wait("a", version(1));
  assert.equal(session.unconfirmed, true);
  const drained = session.drain();
  replies[0]({ operation: 1, version: version(1) });
  await drained;
});
test("invalid receipts preserve unconfirmed history and reject save/close barriers", async () => {
  const { session, replies, failures } = setup();
  session.enqueue("a", packet(), version(1));
  session.enqueue("b", packet("b"), version(1, "b"));
  const wait = assert.rejects(session.wait("a", version(1)), /不匹配/);
  const drain = assert.rejects(session.drain(), /不匹配/);
  replies[0]({ operation: 1, version: version(1, "another-history") });
  await wait;
  await drain;
  assert.equal(failures.length, 1);
  assert.equal(session.unconfirmed, true);
});
test("replacing a session rejects old barriers and ignores late acknowledgements", async () => {
  const { session, replies, states } = setup();
  session.enqueue("a", packet(), version(1));
  const wait = assert.rejects(session.wait("a", version(1)), /replaced/);
  session.stop(new Error("replaced"), false);
  await wait;
  replies[0]({ operation: 1, version: version(1) });
  await tick();
  assert.deepEqual(states, [true]);
  assert.equal(session.unconfirmed, true);
});
test("queue limits count in-flight operations and pause without losing the accepted checkpoint", () => {
  const { session, failures, sent } = setup({ operations: 2, bytes: 100 });
  session.enqueue("a", packet(), version(1));
  session.enqueue("a", packet(), version(2));
  session.enqueue("a", packet(), version(3));
  assert.equal(sent.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(session.unconfirmed, true);
  assert.throws(() => session.enqueue("a", packet(), version(4)), /队列已满/);
  const bounded = setup({ operations: 100, bytes: 1 });
  bounded.session.enqueue("a", packet(), version(1));
  assert.equal(bounded.sent.length, 0);
  assert.equal(bounded.failures.length, 1);
});
test("causal containment rejects another document history and negative checkpoints", () => {
  assert.equal(containsVersion(version(3), version(2)), true);
  assert.equal(containsVersion(version(3), version(4)), false);
  assert.equal(containsVersion(version(3), version(2, "b")), false);
  assert.equal(containsVersion(version(3), version(-1)), false);
});
