import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MAX_AGE_DAYS, DEFAULT_MAX_FILE_MB, HARD_MAX_FILE_MB, MB, parseLimits } from '../core/limits';

test('defaults apply when nothing is set', () => {
  assert.deepEqual(parseLimits({}), { maxFileBytes: DEFAULT_MAX_FILE_MB * MB, maxAgeDays: DEFAULT_MAX_AGE_DAYS });
});

test('valid settings are used as given', () => {
  assert.deepEqual(parseLimits({ maxFileSizeMB: 50, maxSessionAgeDays: 7 }), { maxFileBytes: 50 * MB, maxAgeDays: 7 });
});

test('the size limit can never exceed what GitHub accepts', () => {
  assert.equal(parseLimits({ maxFileSizeMB: 500 }).maxFileBytes, HARD_MAX_FILE_MB * MB);
});

test('0 days means no age limit', () => {
  assert.equal(parseLimits({ maxSessionAgeDays: 0 }).maxAgeDays, 0);
});

test('fractional days are floored', () => {
  assert.equal(parseLimits({ maxSessionAgeDays: 7.9 }).maxAgeDays, 7);
});

test('unusable values fall back to the defaults instead of breaking a push', () => {
  const defaults = { maxFileBytes: DEFAULT_MAX_FILE_MB * MB, maxAgeDays: DEFAULT_MAX_AGE_DAYS };
  assert.deepEqual(parseLimits({ maxFileSizeMB: 'big', maxSessionAgeDays: -3 }), defaults);
  assert.deepEqual(parseLimits({ maxFileSizeMB: Number.NaN, maxSessionAgeDays: Number.NaN }), defaults);
  assert.deepEqual(parseLimits({ maxFileSizeMB: 0.5, maxSessionAgeDays: null }), defaults);
});
