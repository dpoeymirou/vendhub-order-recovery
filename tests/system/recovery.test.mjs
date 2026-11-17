import test from 'node:test';
import assert from 'node:assert/strict';
import {
  app1, app2, compose, newOrder, newOrders, sendEvent, retry, orderVia, supplierOrders, setMode, until, confirmedVia,
  restartApp1, killApp1, startApp1, app1ExitCode, supplierCalls, noPendingWork
} from './stack.mjs';

// Run from the host with `npm run test:system` while the stack is up. Not at the same time as
// the in-container suite: these tests crash, kill and restart the app.
test.before(() => compose(['up', '-d', '--build', '--wait', 'app', 'app2']));
test.after(async () => {
  await compose(['rm', '-sf', 'app2']);
  await restartApp1();
});

test('two app instances, overlapping requests: one supplier call and one supplier order per order', async () => {
  for (let round = 0; round < 5; round++) {
    const id = await newOrder();
    const responses = await Promise.all([
      sendEvent(app1, `evt-${id}-a`, id), sendEvent(app2, `evt-${id}-a`, id), sendEvent(app2, `evt-${id}-b`, id),
      retry(app1, id), retry(app2, id), sendEvent(app1, `evt-${id}-c`, id)
    ]);
    for (const response of responses) assert.equal(response.status, 200);
    const row = await confirmedVia(app2, id);
    const atSupplier = await supplierOrders(id);
    assert.equal(atSupplier.length, 1, `${id} has ${atSupplier.length} supplier orders`);
    assert.equal(row.supplier_order_id, atSupplier[0].supplier_order_id);
    const calls = await until(() => supplierCalls(id), `the supplier call for ${id} in the logs`);
    assert.equal(calls, 1, `${id} was sent ${calls} times: the row lock did not keep the instances apart`);
  }
});

test('two app instances, reply lost after acceptance: one supplier order with the original id', async () => {
  const id = await newOrder();
  await setMode(id, 'accept_then_disconnect_once');
  try {
    const responses = await Promise.all([sendEvent(app2, `evt-${id}`, id), retry(app1, id), sendEvent(app1, `evt-${id}`, id)]);
    for (const response of responses) assert.equal(response.status, 200);
    const row = await confirmedVia(app1, id);
    const atSupplier = await supplierOrders(id);
    assert.equal(atSupplier.length, 1);
    assert.equal(row.supplier_order_id, atSupplier[0].supplier_order_id);
  } finally {
    await setMode(id, 'normal');
  }
});

test('first instance crashes after supplier success: the second finishes the order while the first is down', async () => {
  await noPendingWork();
  await restartApp1({ crash: true });
  try {
    for (let tries = 0; tries < 3; tries++) {
      const id = await newOrder();
      await sendEvent(app1, `evt-${id}`, id).catch(() => {}); // the first instance exits mid-request
      const outcome = await until(async () =>
        (await app1ExitCode()) === 91 ? 'crashed'
          : (await orderVia(app2, id))?.fulfillment_status === 'confirmed' ? 'taken by the second' : undefined,
        `${id}: a crash or a confirmation`);
      if (outcome !== 'crashed') continue; // the second instance happened to take it first: use a fresh order
      const row = await confirmedVia(app2, id);
      assert.equal(await app1ExitCode(), 91, 'the first instance is still down');
      const atSupplier = await supplierOrders(id);
      assert.equal(atSupplier.length, 1);
      assert.equal(row.supplier_order_id, atSupplier[0].supplier_order_id);
      return;
    }
    assert.fail('the second instance took every order before the first could crash');
  } finally {
    await restartApp1();
  }
});

test('restart after supplier success but before local confirmation: confirmed by itself with the same id', async () => {
  await compose(['stop', '-t', '1', 'app2']);
  await noPendingWork();
  await restartApp1({ crash: true });
  const id = await newOrder();
  await sendEvent(app1, `evt-${id}`, id).catch(() => {});
  await until(async () => (await app1ExitCode()) === 91, 'the app to stop at the checkpoint');
  const atSupplier = await supplierOrders(id);
  assert.equal(atSupplier.length, 1, 'the supplier accepted before the crash');
  await restartApp1();
  const row = await confirmedVia(app1, id);
  assert.equal(row.supplier_order_id, atSupplier[0].supplier_order_id);
  assert.equal((await supplierOrders(id)).length, 1);
});

test('restart during a supplier outage: the work survives and completes once the supplier is back', async () => {
  const id = await newOrder();
  await setMode(id, 'unavailable');
  try {
    assert.equal((await sendEvent(app1, `evt-${id}`, id)).status, 200);
    await killApp1();
    await startApp1();
    const row = await orderVia(app1, id);
    assert.equal(row.fulfillment_status, 'pending');
    assert.ok(row.attempts >= 1);
    assert.match(row.last_error, /503/);
    assert.equal((await supplierOrders(id)).length, 0);
  } finally {
    await setMode(id, 'normal');
  }
  const row = await confirmedVia(app1, id);
  const atSupplier = await supplierOrders(id);
  assert.equal(atSupplier.length, 1);
  assert.equal(row.supplier_order_id, atSupplier[0].supplier_order_id);
});

test('hard kill at a random moment in a stream of orders: never two supplier orders, recorded work finishes by itself', async t => {
  const ids = await newOrders(50);
  // Fault injection: one notice every 15 ms for about 750 ms, and a hard kill issued at a random
  // moment 150 to 350 ms in, so some requests are in flight when the app dies.
  const kill = new Promise(resolve => setTimeout(resolve, 150 + Math.floor(Math.random() * 200))).then(killApp1);
  const answers = [];
  for (const id of ids) {
    answers.push(sendEvent(app1, `evt-${id}`, id).then(response => response.status, () => 'no answer'));
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  await kill;
  const statuses = await Promise.all(answers);
  t.diagnostic(`kill landed after ${statuses.filter(status => status === 200).length} of ${ids.length} notices were answered`);
  for (const id of ids) assert.ok((await supplierOrders(id)).length <= 1, `${id} has more than one supplier order`);
  await startApp1();
  for (const [i, id] of ids.entries()) {
    const row = await orderVia(app1, id);
    if (statuses[i] === 200) assert.notEqual(row.fulfillment_status, 'not_submitted', `${id} was answered 200 but not recorded`);
    // Like a payment provider, re-send a notice the app never recorded. Recorded orders must finish by themselves.
    if (row.fulfillment_status === 'not_submitted') await sendEvent(app1, `evt-${id}`, id);
  }
  for (const id of ids) {
    const row = await confirmedVia(app1, id);
    const atSupplier = await supplierOrders(id);
    assert.equal(atSupplier.length, 1, `${id} has ${atSupplier.length} supplier orders`);
    assert.equal(row.supplier_order_id, atSupplier[0].supplier_order_id);
  }
});
