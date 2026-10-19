import { test } from "node:test";
import assert from "node:assert/strict";
import { NativeObservation } from "../../src/lib/desktop/observation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("native polling only reconciles files when the watcher reports changes", async () => {
  const tasks: (() => Promise<unknown>)[] = [];
  let changed = false;
  let observations = 0;
  const observation = new NativeObservation(
    (task) => tasks.push(task),
    async () => changed,
    async () => {
      observations++;
    },
  );
  observation.request();
  await tasks.shift()!();
  assert.equal(observations, 0);
  changed = true;
  observation.request();
  await tasks.shift()!();
  assert.equal(observations, 1);
  assert.equal(tasks.length, 0);
});

test("native polling and focus coalesce before and during a slow check and yield to editing", async () => {
  const tasks: (() => Promise<unknown>)[] = [];
  const firstCheck = deferred<boolean>();
  const order: string[] = [];
  let checks = 0;
  const observation = new NativeObservation(
    (task) => tasks.push(task),
    () => {
      checks++;
      return checks === 1 ? firstCheck.promise : Promise.resolve(false);
    },
    async () => {
      order.push("observe");
    },
  );
  for (let i = 0; i < 1000; i++) observation.request();
  assert.equal(tasks.length, 1);
  const running = tasks.shift()!();
  tasks.push(async () => {
    order.push("edit");
  });
  observation.request(true);
  for (let i = 0; i < 1000; i++) observation.request();
  assert.equal(tasks.length, 1);
  firstCheck.resolve(false);
  await running;
  assert.equal(tasks.length, 2);
  await tasks.shift()!();
  await tasks.shift()!();
  assert.deepEqual(order, ["edit", "observe"]);
  assert.equal(checks, 2);
  assert.equal(tasks.length, 0);

  observation.request(true);
  for (let i = 0; i < 1000; i++) observation.request();
  assert.equal(tasks.length, 1);
  await tasks.shift()!();
  assert.deepEqual(order, ["edit", "observe", "observe"]);
});

test("a failed native check remains retryable and retains a forced focus reconciliation", async () => {
  const tasks: (() => Promise<unknown>)[] = [];
  let fail = true;
  let observations = 0;
  const observation = new NativeObservation(
    (task) => tasks.push(task),
    async () => {
      if (fail) throw new Error("temporary IPC error");
      return false;
    },
    async () => {
      observations++;
    },
  );
  observation.request(true);
  await assert.rejects(tasks.shift()!(), /temporary IPC error/);
  assert.equal(tasks.length, 0);
  fail = false;
  observation.request();
  await tasks.shift()!();
  assert.equal(observations, 1);
});

test("stopping native observation cancels queued and pending work without touching released owners", async () => {
  const tasks: (() => Promise<unknown>)[] = [];
  let checks = 0;
  let observations = 0;
  const check = deferred<boolean>();
  const create = () =>
    new NativeObservation(
      (task) => tasks.push(task),
      async () => {
        checks++;
        return check.promise;
      },
      async () => {
        observations++;
      },
    );
  const queued = create();
  queued.request(true);
  queued.stop();
  await tasks.shift()!();
  assert.equal(checks, 0);

  const running = create();
  running.request();
  const pending = tasks.shift()!();
  running.request(true);
  running.stop();
  running.request(true);
  check.resolve(true);
  await pending;
  assert.equal(checks, 1);
  assert.equal(observations, 0);
  assert.equal(tasks.length, 0);
});
