import test from 'node:test';
import assert from 'node:assert/strict';

import { formatValidationChecks } from '../src/validation.js';

test('formats validation checks as a summary plus detail lines', () => {
  const checks = [
    { label: 'bundle import', state: 'passed' },
    { label: 'unit tests', state: 'passed' },
    { label: 'browser smoke', state: 'warning' },
  ];

  assert.equal(
    formatValidationChecks(checks),
    '3 checks: 2 passed, 1 warning\nbundle import: passed\nunit tests: passed\nbrowser smoke: warning',
  );
});

test('formats a single validation check with a singular summary line', () => {
  const checks = [{ label: 'bundle import', state: 'passed' }];

  assert.equal(formatValidationChecks(checks), '1 check: 1 passed\nbundle import: passed');
});

test('ignores sparse array holes when building the summary and details', () => {
  const checks = [
    { label: 'bundle import', state: 'passed' },
    ,
    { label: 'browser smoke', state: 'warning' },
  ];

  assert.equal(
    formatValidationChecks(checks),
    '2 checks: 1 passed, 1 warning\nbundle import: passed\nbrowser smoke: warning',
  );
});

test('sorts summary states deterministically', () => {
  const checks = [
    { label: 'browser smoke', state: 'warning' },
    { label: 'bundle import', state: 'passed' },
    { label: 'schema export', state: 'failed' },
  ];

  assert.equal(
    formatValidationChecks(checks),
    '3 checks: 1 failed, 1 passed, 1 warning\nbrowser smoke: warning\nbundle import: passed\nschema export: failed',
  );
});

test('formats an empty list as an empty string', () => {
  assert.equal(formatValidationChecks([]), '');
});
