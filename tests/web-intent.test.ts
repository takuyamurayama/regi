import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionIntents, inputFingerprint } from '../apps/web/src/action-intent';
import { ApiError, readApiResponse } from '../apps/web/src/api-response';

function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
const operation = {
  scope: 'tenant:actor:store',
  path: '/v1/cash-movements',
  method: 'POST',
  returnPath: '/shifts',
  input: { amount: '500', reason: 'private business detail', pin: '4321' },
  active: () => true,
};

void test('web intent retries a lost response with the same ID and persists only recovery metadata', async () => {
  const storage = memory(),
    intents = new ActionIntents(storage),
    committed = new Set<string>();
  const ids: string[] = [];
  const send = async (id: string) => {
    ids.push(id);
    committed.add(id);
    if (ids.length === 1) throw new ApiError('response lost');
    return Promise.resolve({ id, amount: '500' });
  };
  await assert.rejects(() => intents.run({ ...operation, send }), /response lost/);
  const serialized = [...storage.values.values()].join('');
  assert.ok(serialized.includes(ids[0]));
  assert.ok(!serialized.includes('private business detail'));
  const stored: unknown = JSON.parse(serialized);
  assert.ok(Array.isArray(stored));
  const first: unknown = stored[0];
  assert.ok(typeof first === 'object' && first !== null);
  assert.deepEqual(Object.keys(first).sort(), [
    'createdAt',
    'fingerprint',
    'id',
    'method',
    'path',
    'returnPath',
    'scope',
  ]);
  const result = await intents.run({ ...operation, send });
  assert.equal(result.id, ids[0]);
  assert.deepEqual(ids, [ids[0], ids[0]]);
  assert.equal(committed.size, 1);
  assert.equal(storage.values.size, 0);
});

void test('web unresolved intent rejects edits and replacement IDs and survives a later business rejection', async () => {
  const intents = new ActionIntents(memory());
  await assert.rejects(
    () =>
      intents.run({
        ...operation,
        send: () => Promise.reject(new ApiError('unknown', 503)),
      }),
    /unknown/,
  );
  const id = intents.pending(operation.scope)[0].id;
  await assert.rejects(
    () =>
      intents.run({ ...operation, input: { amount: '600' }, send: () => Promise.resolve('never') }),
    /先の操作/,
  );
  await assert.rejects(
    () =>
      intents.run({
        ...operation,
        operationId: crypto.randomUUID(),
        send: () => Promise.resolve('never'),
      }),
    /操作ID/,
  );
  // The frozen first sender still reports its unknown outcome; a later 4xx must not erase the ID.
  intents.forgetBodies();
  await assert.rejects(
    () =>
      intents.run({
        ...operation,
        send: () => Promise.reject(new ApiError('permission changed', 403)),
      }),
    /permission changed/,
  );
  assert.equal(intents.pending(operation.scope)[0].id, id);
  await assert.rejects(() => intents.retry(id, 'different-store'), /元の店舗/);
});

void test('web unknown intent followed by validation rejection keeps its ID and guides saved-result recovery without editing', async () => {
  for (const initialStatus of [undefined, 503]) {
    const storage = memory();
    const intents = new ActionIntents(storage);
    const ids: string[] = [];
    const committed = new Set<string>();
    const fieldErrors = [{ field: 'reason', message: '理由を入力してください。' }];
    const send = async (id: string) => {
      ids.push(id);
      committed.add(id);
      if (ids.length === 1) throw new ApiError('response outcome unknown', initialStatus);
      if (ids.length === 2)
        return readApiResponse(
          new Response(
            JSON.stringify({
              code: 'INVALID_INPUT',
              message: '理由を入力してください。',
              retryable: false,
              nextAction: '該当項目を修正してから送信してください。',
              fieldErrors,
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
        );
      return id;
    };
    await assert.rejects(() => intents.run({ ...operation, send }), /response outcome unknown/);
    const id = intents.pending(operation.scope)[0].id;
    await assert.rejects(
      () => intents.retry(id, operation.scope),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 400);
        assert.equal(error.code, 'INVALID_INPUT');
        assert.equal(error.retryable, false);
        assert.equal(error.uncertain, false);
        assert.deepEqual(error.fieldErrors, fieldErrors);
        assert.match(error.message, /未確認の操作.*保存結果/);
        assert.match(error.message, /入力を変更せず/);
        assert.doesNotMatch(error.message, /修正して|送信してください/);
        assert.match(error.nextAction ?? '', /未確認の操作.*保存結果/);
        return true;
      },
    );
    assert.equal(intents.pending(operation.scope)[0].id, id);
    assert.ok([...storage.values.values()].join('').includes(id));
    await assert.rejects(
      () =>
        intents.run({
          ...operation,
          input: { amount: '600' },
          send: () => Promise.resolve('never'),
        }),
      /先の操作/,
    );
    await assert.rejects(
      () => intents.run({ ...operation, operationId: crypto.randomUUID(), send }),
      /操作ID/,
    );
    assert.deepEqual(ids, [id, id]);
    assert.equal(await intents.retry(id, operation.scope), id);
    assert.deepEqual(ids, [id, id, id]);
    assert.equal(committed.size, 1);
    assert.equal(intents.pending(operation.scope).length, 0);
  }
});

void test('web confirmed mutations stay successful after a read failure and permit explicit new operations', async () => {
  const intents = new ActionIntents(memory());
  let sends = 0;
  const send = (id: string) => {
    sends++;
    return Promise.resolve({ id });
  };
  const first = await intents.run({ ...operation, send });
  const repeated = await intents.run({ ...operation, send });
  assert.equal(repeated.id, first.id);
  assert.equal(sends, 1);
  intents.startNew(operation.scope);
  const next = await intents.run({ ...operation, send });
  assert.notEqual(next.id, first.id);
  assert.equal(sends, 2);
});

void test('web reloaded intent resumes the same ID and initial validation rejection permits correction', async () => {
  const storage = memory(),
    initial = new ActionIntents(storage);
  await assert.rejects(
    () =>
      initial.run({
        ...operation,
        send: () => Promise.reject(new ApiError('lost')),
      }),
    /lost/,
  );
  const id = initial.pending(operation.scope)[0].id;
  const reloaded = new ActionIntents(storage);
  await assert.rejects(() => reloaded.retry(id, operation.scope), /再読み込み前/);
  assert.equal(await reloaded.run({ ...operation, send: (id) => Promise.resolve(id) }), id);
  const rejected = new ActionIntents(memory());
  await assert.rejects(
    () =>
      rejected.run({
        ...operation,
        send: () => Promise.reject(new ApiError('invalid', 400)),
      }),
    /invalid/,
  );
  assert.equal(rejected.pending(operation.scope).length, 0);
  assert.equal(
    await rejected.run({
      ...operation,
      input: { amount: '600' },
      send: () => Promise.resolve('corrected'),
    }),
    'corrected',
  );
});

void test('web intent fingerprint excludes only top level PIN and keeps input ordering semantics', async () => {
  assert.equal(
    await inputFingerprint({ b: 2, a: 1, pin: '1234' }),
    await inputFingerprint({ pin: '9876', a: 1, b: 2 }),
  );
  assert.notEqual(
    await inputFingerprint({ body: { pin: '1234' } }),
    await inputFingerprint({ body: { pin: '9876' } }),
  );
  assert.notEqual(await inputFingerprint([1, 2]), await inputFingerprint([2, 1]));
  const intents = new ActionIntents(memory());
  let sends = 0;
  await assert.rejects(
    () =>
      intents.run({
        ...operation,
        active: () => false,
        send: () => {
          sends++;
          return Promise.resolve('never');
        },
      }),
    /送信を中止/,
  );
  assert.equal(sends, 0);
  assert.equal(intents.pending(operation.scope).length, 0);
});

void test('web logout discards a late acknowledged response and retains only unknown recovery metadata', async () => {
  const storage = memory(),
    intents = new ActionIntents(storage);
  let resolve!: (value: { secret: string }) => void, dispatched!: () => void;
  const sending = new Promise<void>((done) => {
    dispatched = done;
  });
  const flight = intents.run({
    ...operation,
    send: () =>
      new Promise<{ secret: string }>((done) => {
        resolve = done;
        dispatched();
      }),
  });
  await sending;
  assert.equal(intents.pending(operation.scope).length, 1);
  intents.forgetBodies();
  resolve({ secret: 'private returned record' });
  await flight;
  assert.equal(intents.acknowledged(operation.scope), false);
  assert.equal(intents.pending(operation.scope).length, 0);
  assert.equal(storage.values.size, 0);
});

void test('web commit lookup after reload clears unknown metadata without reconstructing or resending the old request', async () => {
  const storage = memory(),
    initial = new ActionIntents(storage);
  await assert.rejects(
    () => initial.run({ ...operation, send: () => Promise.reject(new ApiError('lost')) }),
    /lost/,
  );
  const id = initial.pending(operation.scope)[0].id;
  const reloaded = new ActionIntents(storage);
  assert.throws(() => reloaded.confirmCommitted(id, 'another-store'), /元の店舗/);
  assert.equal(reloaded.pending(operation.scope)[0].id, id);
  reloaded.confirmCommitted(id, operation.scope);
  assert.equal(reloaded.pending(operation.scope).length, 0);
  assert.equal(reloaded.acknowledged(operation.scope), true);
  assert.equal(storage.values.size, 0);
  let sends = 0;
  const send = () => {
    sends++;
    return Promise.resolve('new fact');
  };
  await assert.rejects(() => reloaded.retry(id, operation.scope), /保存済みです/);
  for (const input of [operation.input, { amount: '600', expectedInvoiceVersion: 3 }]) {
    await assert.rejects(
      () => reloaded.run({ ...operation, input, operationId: crypto.randomUUID(), send }),
      /保存済みです/,
    );
  }
  assert.equal(sends, 0);
  reloaded.startNew(operation.scope);
  assert.equal(await reloaded.run({ ...operation, send }), 'new fact');
  assert.equal(sends, 1);
});
