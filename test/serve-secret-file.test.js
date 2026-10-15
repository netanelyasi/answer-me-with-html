import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, chmodSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { main } from '../src/cli.js';
import { pageLink, startServer, readSecretFile, ServeError } from '../src/serve.js';

// Windows has no POSIX file modes (Node reports 0o666), so the mode checks run on POSIX only.
const isWin = process.platform === 'win32';
const SECRET = 'a'.repeat(64);

function status(link) {
  const { port, pathname } = new URL(link);
  return new Promise((resolve, reject) => {
    // agent: false, so a request after a restart never reuses a connection to the server that was closed.
    const req = request({ host: '127.0.0.1', port, path: pathname, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'am-secret-'));
  mkdirSync(join(home, 'pages'));
  writeFileSync(join(home, 'pages', 'a.html'), '<h1>A</h1>');
  return home;
}

function sink() {
  let text = '';
  return { stream: new Writable({ write(c, _e, cb) { text += c; cb(); } }), get text() { return text; } };
}

test('secret file: a link from the first start still opens after a restart with the same file', async () => {
  const home = makeHome();
  const file = join(home, 'serve-secret');
  try {
    const first = await startServer({ home, port: 0, secretFile: file });
    const link = pageLink(first, 'pages', 'a.html');
    assert.equal(await status(link), 200);
    await first.close();
    assert.match(readFileSync(file, 'utf8'), /^[0-9a-f]{64}\n$/);
    if (!isWin) assert.equal(statSync(file).mode & 0o777, 0o600);
    const second = await startServer({ home, port: new URL(link).port, secretFile: file });
    try {
      assert.equal(second.secret, first.secret);
      assert.equal(pageLink(second, 'pages', 'a.html'), link);
      assert.equal(await status(link), 200);
    } finally {
      await second.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('secret file: an existing file is used as it is, with or without a line ending', () => {
  const home = makeHome();
  try {
    for (const content of [SECRET, `${SECRET}\n`, `${SECRET}\r\n`]) {
      const file = join(home, `s-${content.length}`);
      writeFileSync(file, content, { mode: 0o600 });
      assert.equal(readSecretFile(file), SECRET);
      assert.equal(readFileSync(file, 'utf8'), content, 'the file is not rewritten');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('secret file: a symlink to a private file is followed, as in a mounted secret', { skip: isWin && 'symlinks need extra rights on Windows' }, () => {
  const home = makeHome();
  try {
    writeFileSync(join(home, 'real'), `${SECRET}
`, { mode: 0o600 });
    symlinkSync(join(home, 'real'), join(home, 'link'));
    assert.equal(readSecretFile(join(home, 'link')), SECRET);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('secret file: without it each start makes a new secret, and the old link is a 404', async () => {
  const home = makeHome();
  try {
    const first = await startServer({ home, port: 0 });
    const link = pageLink(first, 'pages', 'a.html');
    await first.close();
    const second = await startServer({ home, port: new URL(link).port });
    try {
      assert.notEqual(second.secret, first.secret);
      assert.equal(await status(link), 404);
      assert.equal(await status(pageLink(second, 'pages', 'a.html')), 200);
    } finally {
      await second.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('secret file: bad content, a folder or a missing parent folder is refused before the server starts', async () => {
  const home = makeHome();
  try {
    const bad = {
      empty: '',
      short: 'a'.repeat(63),
      long: 'a'.repeat(65),
      upper: 'A'.repeat(64),
      'not hex': 'g'.repeat(64),
      'two lines': `${SECRET}\n${SECRET}\n`,
      'leading space': ` ${SECRET}`,
      big: 'a'.repeat(4096),
    };
    for (const [name, content] of Object.entries(bad)) {
      const file = join(home, `bad-${name.replace(/ /g, '-')}`);
      writeFileSync(file, content, { mode: 0o600 });
      await assert.rejects(startServer({ home, port: 0, secretFile: file }), (e) => e instanceof ServeError && /64 hex characters/.test(e.message), name);
      assert.equal(readFileSync(file, 'utf8'), content, `${name}: the file is not replaced`);
    }
    mkdirSync(join(home, 'folder'));
    await assert.rejects(startServer({ home, port: 0, secretFile: join(home, 'folder') }), /not a regular file/);
    await assert.rejects(startServer({ home, port: 0, secretFile: join(home, 'no-such-dir', 'secret') }), (e) => e instanceof ServeError && /Cannot create --secret-file/.test(e.message));
    assert.equal(existsSync(join(home, 'serve.json')), false, 'no server was recorded');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('secret file: a file that group or others can read is refused', { skip: isWin && 'no POSIX file modes on Windows' }, async () => {
  const home = makeHome();
  try {
    for (const mode of [0o644, 0o640, 0o604, 0o660]) {
      const file = join(home, `secret-${mode.toString(8)}`);
      writeFileSync(file, SECRET);
      chmodSync(file, mode);
      await assert.rejects(startServer({ home, port: 0, secretFile: file }), (e) => e instanceof ServeError && /chmod 600/.test(e.message), mode.toString(8));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('am serve --secret-file: a bad file exits 1 with the reason', async () => {
  const home = makeHome();
  const file = join(home, 'bad');
  writeFileSync(file, 'not a secret', { mode: 0o600 });
  try {
    const err = sink();
    const code = await main(['serve', '--port', '0', '--secret-file', file], { stdout: sink().stream, stderr: err.stream, env: { AM_HOME: home } });
    assert.equal(code, 1);
    assert.match(err.text, /--secret-file .* does not hold a secret: expected 64 hex characters/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
