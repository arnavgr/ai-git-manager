'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  executeTool, countOccurrences, flexMatchUnique, applyReplacements, globToRegex
} = require('../harness/tools');

function withTempDir(fn) {
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  process.chdir(dir);
  try { return fn(dir); }
  finally { process.chdir(prev); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('countOccurrences counts non-overlapping matches', () => {
  assert.strictEqual(countOccurrences('aaaa', 'aa'), 2);
  assert.strictEqual(countOccurrences('abcabc', 'abc'), 2);
  assert.strictEqual(countOccurrences('abc', 'z'), 0);
});

test('flexMatchUnique finds whitespace-tolerant unique match', () => {
  const src = 'function foo() {\n    return 1;\n}';
  const m = flexMatchUnique(src, 'function foo() { return 1; }');
  assert.ok(m && !m.ambiguous);
  assert.strictEqual(src.slice(m.start, m.end).replace(/\s+/g, ' ').trim(), 'function foo() { return 1; }');
});

test('flexMatchUnique flags ambiguity', () => {
  const m = flexMatchUnique('x x', 'x');
  assert.deepStrictEqual(m, { ambiguous: true });
});

test('applyReplacements exact match', () => {
  const { content } = applyReplacements('hello world', [{ search: 'world', replace: 'there' }]);
  assert.strictEqual(content, 'hello there');
});

test('applyReplacements rejects not-found', () => {
  assert.throws(() => applyReplacements('abc', [{ search: 'xyz', replace: 'q' }]), /not found/);
});

test('applyReplacements rejects ambiguous exact match', () => {
  assert.throws(() => applyReplacements('a a', [{ search: 'a', replace: 'b' }]), /matches 2 locations/);
});

test('globToRegex handles ** and *', () => {
  assert.ok(globToRegex('**/*.test.js').test('tests/a/b/c.test.js'));
  assert.ok(globToRegex('*.py').test('main.py'));
  assert.ok(!globToRegex('*.py').test('src/main.py'));
});

test('write_file + read_file roundtrip', () => {
  withTempDir(() => {
    executeTool('write_file', { path: 'a/b.txt', content: 'line1\nline2\nline3' });
    const out = executeTool('read_file', { path: 'a/b.txt' });
    assert.ok(out.includes('line1'));
    assert.ok(out.includes('(3 lines)'));
  });
});

test('write_file prevents destructive wipe of large existing file', () => {
  withTempDir(() => {
    const largeContent = 'a'.repeat(1000);
    executeTool('write_file', { path: 'README.md', content: largeContent });
    const res = executeTool('write_file', { path: 'README.md', content: 'short snippet' });
    assert.ok(res.includes('Safety rejection'));
    assert.strictEqual(fs.readFileSync('README.md', 'utf8'), largeContent);
  });
});

test('replace_in_file edits existing file', () => {
  withTempDir(() => {
    executeTool('write_file', { path: 'f.js', content: 'const x = 1;\nconst y = 2;\n' });
    const res = executeTool('replace_in_file', {
      path: 'f.js',
      replacements: [{ search: 'const y = 2;', replace: 'const y = 42;' }]
    });
    assert.ok(res.includes('applied'));
    assert.strictEqual(fs.readFileSync('f.js', 'utf8'), 'const x = 1;\nconst y = 42;\n');
  });
});

test('replace_in_file errors on missing file', () => {
  withTempDir(() => {
    const res = executeTool('replace_in_file', { path: 'nope.js', replacements: [{ search: 'a', replace: 'b' }] });
    assert.ok(res.includes('Tool error'));
  });
});

test('grep_search finds matches', () => {
  withTempDir(() => {
    executeTool('write_file', { path: 'src/app.js', content: 'function hello(){}\nfunction world(){}\n' });
    const out = executeTool('grep_search', { pattern: 'world' });
    assert.ok(out.includes('src/app.js:2'));
  });
});

test('find_files matches globs', () => {
  withTempDir(() => {
    executeTool('write_file', { path: 'src/a.test.js', content: '' });
    executeTool('write_file', { path: 'src/b.js', content: '' });
    const out = executeTool('find_files', { pattern: '**/*.test.js' });
    assert.ok(out.includes('a.test.js'));
    assert.ok(!out.includes('b.js'));
  });
});

test('list_dir lists entries', () => {
  withTempDir(() => {
    executeTool('write_file', { path: 'dir/x.txt', content: '' });
    const out = executeTool('list_dir', { path: 'dir' });
    assert.ok(out.includes('x.txt'));
  });
});

test('path traversal is blocked', () => {
  withTempDir(() => {
    const res = executeTool('read_file', { path: '../../etc/passwd' });
    assert.ok(res.includes('Tool error'));
  });
});
