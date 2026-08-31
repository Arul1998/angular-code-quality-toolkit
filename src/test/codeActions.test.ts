import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dependencyNameFromMessage,
  removeDependencyFromPackageJson,
} from '../codeActions';

test('dependencyNameFromMessage extracts the package name', () => {
  assert.equal(dependencyNameFromMessage('Unused dependency: lodash'), 'lodash');
  assert.equal(dependencyNameFromMessage('Unused dependency: @my-scope/util'), '@my-scope/util');
});

test('dependencyNameFromMessage ignores unrelated messages', () => {
  assert.equal(dependencyNameFromMessage('Missing dependency: lodash (used here)'), undefined);
  assert.equal(dependencyNameFromMessage('Unused export: foo'), undefined);
  assert.equal(dependencyNameFromMessage('Unused dependency: '), undefined);
});

test('removeDependencyFromPackageJson removes a middle dependency', () => {
  const content = [
    '{',
    '  "dependencies": {',
    '    "a": "^1.0.0",',
    '    "lodash": "^4.17.0",',
    '    "b": "^2.0.0"',
    '  }',
    '}',
  ].join('\n');
  const result = removeDependencyFromPackageJson(content, 'lodash');
  assert.equal(
    result,
    ['{', '  "dependencies": {', '    "a": "^1.0.0",', '    "b": "^2.0.0"', '  }', '}'].join('\n')
  );
  assert.doesNotThrow(() => JSON.parse(result!));
});

test('removeDependencyFromPackageJson fixes the trailing comma when removing the last entry', () => {
  const content = [
    '{',
    '  "dependencies": {',
    '    "a": "^1.0.0",',
    '    "lodash": "^4.17.0"',
    '  }',
    '}',
  ].join('\n');
  const result = removeDependencyFromPackageJson(content, 'lodash');
  assert.equal(
    result,
    ['{', '  "dependencies": {', '    "a": "^1.0.0"', '  }', '}'].join('\n')
  );
  assert.doesNotThrow(() => JSON.parse(result!));
});

test('removeDependencyFromPackageJson handles the only entry in a block', () => {
  const content = ['{', '  "devDependencies": {', '    "lodash": "^4.17.0"', '  }', '}'].join('\n');
  const result = removeDependencyFromPackageJson(content, 'lodash');
  assert.equal(result, ['{', '  "devDependencies": {', '  }', '}'].join('\n'));
  assert.doesNotThrow(() => JSON.parse(result!));
});

test('removeDependencyFromPackageJson preserves CRLF line endings', () => {
  const content = ['{', '  "dependencies": {', '    "lodash": "^4.17.0"', '  }', '}'].join('\r\n');
  const result = removeDependencyFromPackageJson(content, 'lodash');
  assert.ok(result!.includes('\r\n'));
  assert.ok(!/(?<!\r)\n/.test(result!));
});

test('removeDependencyFromPackageJson returns undefined when not found or ambiguous', () => {
  const content = ['{', '  "dependencies": {', '    "a": "^1.0.0"', '  }', '}'].join('\n');
  assert.equal(removeDependencyFromPackageJson(content, 'nope'), undefined);

  // Same name declared in both dependencies and devDependencies: ambiguous.
  const dup = [
    '{',
    '  "dependencies": {',
    '    "lodash": "^4.17.0"',
    '  },',
    '  "devDependencies": {',
    '    "lodash": "^4.17.0"',
    '  }',
    '}',
  ].join('\n');
  assert.equal(removeDependencyFromPackageJson(dup, 'lodash'), undefined);
});

test('removeDependencyFromPackageJson does not match a substring package name', () => {
  const content = [
    '{',
    '  "dependencies": {',
    '    "lodash.merge": "^4.6.0",',
    '    "lodash": "^4.17.0"',
    '  }',
    '}',
  ].join('\n');
  const result = removeDependencyFromPackageJson(content, 'lodash');
  assert.ok(result!.includes('"lodash.merge"'));
  assert.ok(!/"lodash":/.test(result!));
  assert.doesNotThrow(() => JSON.parse(result!));
});
