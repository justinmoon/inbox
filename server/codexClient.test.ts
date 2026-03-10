import assert from 'node:assert/strict';
import test from 'node:test';

import { AppServerCodexClient } from './codexClient.ts';

test('steerTurn accepts the app-server turnId response shape', async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const processStub = {
    async start() {},
    async request(method: string, params: unknown) {
      requests.push({ method, params });
      if (method === 'turn/steer') {
        return { turnId: 'turn_456' };
      }
      throw new Error(`Unexpected request: ${method}`);
    },
    on() {},
    off() {},
    async respond() {},
    async respondError() {},
  };

  const client = new AppServerCodexClient({
    process: processStub as never,
    clientInfo: {
      name: 'test-client',
      title: 'Test Client',
      version: '0.0.0',
    },
    ensureStarted: async () => {},
  });

  const result = await client.steerTurn({
    threadId: 'thr_123',
    turnId: 'turn_456',
    text: 'Refine the active turn.',
  });

  assert.equal(result.turnId, 'turn_456');
  assert.deepEqual(requests, [
    {
      method: 'turn/steer',
      params: {
        threadId: 'thr_123',
        expectedTurnId: 'turn_456',
        input: [{ type: 'text', text: 'Refine the active turn.', textElements: [] }],
      },
    },
  ]);
});
