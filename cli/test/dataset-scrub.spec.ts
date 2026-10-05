import { describe, expect, it } from 'vitest';
import { ENTROPY, scrub, scrubText, shannonEntropy } from '../src/dataset/scrub.ts';

// Deterministic pseudo-random strings (no Math.random: tests must be stable).
function rnd(alphabet: string, len: number, seed: number): string {
  let x = seed >>> 0;
  let out = '';
  for (let i = 0; i < len; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out += alphabet[(x >>> 8) % alphabet.length];
  }
  return out;
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';

describe('scrub: tokens and keys', () => {
  const cases: Array<[string, string, string]> = [
    ['anthropic', `key: sk-ant-api03-${rnd(ALNUM, 40, 1)}-AA`, 'api-key'],
    ['short anthropic', 'use sk-ant-abcd1234efgh please', 'api-key'],
    ['openai', `OPENAI sk-${rnd(ALNUM, 48, 2)}`, 'api-key'],
    ['openai project', `sk-proj-${rnd(ALNUM, 30, 3)}_x-y`, 'api-key'],
    ['github ghp', `ghp_${rnd(ALNUM, 36, 4)}`, 'api-key'],
    ['github gho', `token gho_${rnd(ALNUM, 36, 5)} end`, 'api-key'],
    ['github pat', `github_pat_${rnd(ALNUM, 22, 6)}_${rnd(ALNUM, 40, 7)}`, 'api-key'],
    ['aws', 'AKIAIOSFODNN7EXAMPLE', 'api-key'],
    ['aws temp', 'ASIAIOSFODNN7EXAMPLE', 'api-key'],
    ['slack bot', 'xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx', 'api-key'],
    ['slack app', 'xoxa-2-123456789012-abcdef', 'api-key'],
    ['google', `AIza${rnd(ALNUM + '_-', 35, 8)}`, 'api-key'],
    ['stripe', `sk_live_${rnd(ALNUM, 24, 9)}`, 'api-key'],
    ['npm', `npm_${rnd(ALNUM, 36, 10)}`, 'api-key'],
    ['gitlab', `glpat-${rnd(ALNUM, 20, 11)}`, 'api-key'],
    ['bearer', 'Authorization: Bearer abcdef1234567890.xyz', 'bearer'],
    ['bearer lowercase', 'curl -H "authorization: bearer a1b2c3d4e5f6g7"', 'bearer'],
    ['jwt', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'jwt'],
  ];
  for (const [name, input, kind] of cases) {
    it(`redacts ${name}`, () => {
      const r = scrub(input);
      expect(r.hits[kind as keyof typeof r.hits]).toBeGreaterThanOrEqual(1);
      expect(r.text).toContain('[SECRET]');
      // nothing of the secret body survives
      const body = input.replace(/^.*?(sk-|ghp_|gho_|github_pat_|AKIA|ASIA|xox|AIza|sk_live_|npm_|glpat-|eyJ|Bearer |bearer )/i, '$1');
      expect(r.text).not.toContain(body.slice(0, 24));
    });
  }

  it('keeps the surrounding text', () => {
    expect(scrubText('please use sk-ant-abcd1234efgh for the call')).toBe('please use [SECRET] for the call');
  });

  it('redacts several secrets in one string and counts them', () => {
    const r = scrub(`a ghp_${rnd(ALNUM, 36, 1)} b AKIAIOSFODNN7EXAMPLE c`);
    expect(r.hits['api-key']).toBe(2);
    expect(r.text).toBe('a [SECRET] b [SECRET] c');
  });

  it('removes private key blocks, also unterminated ones', () => {
    const block = `-----BEGIN RSA PRIVATE KEY-----\n${rnd(B64, 64, 3)}\n${rnd(B64, 64, 4)}\n-----END RSA PRIVATE KEY-----`;
    const r = scrub(`before\n${block}\nafter`);
    expect(r.text).toBe('before\n[SECRET]\nafter');
    expect(r.hits['private-key']).toBe(1);
    const cut = scrub(`x\n-----BEGIN OPENSSH PRIVATE KEY-----\n${rnd(B64, 64, 5)}\n${rnd(B64, 30, 6)}`);
    expect(cut.text).toBe('x\n[SECRET]');
    expect(scrubText('-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc\n-----END PGP PRIVATE KEY BLOCK-----')).toBe('[SECRET]');
    expect(scrubText('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----')).toBe('[SECRET]');
  });

  it('does not touch a public key or a certificate', () => {
    const cert = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    expect(scrubText(cert)).toBe(cert);
  });
});

describe('scrub: assignments', () => {
  const secretValue: Array<[string, string]> = [
    ['password = hunter2', 'hunter2'],
    ['password: "correct horse battery"', 'correct horse battery'],
    ["PASSWORD='p@ss w0rd'", 'p@ss w0rd'],
    ['passwd=abc123xyz', 'abc123xyz'],
    ['DB_PASSWORD=Sup3rS3cret!', 'Sup3rS3cret'],
    ['export API_KEY=abcd1234efgh', 'abcd1234efgh'],
    ['api_key: "k-12345"', 'k-12345'],
    ['apiKey = "zzzzzzzz"', 'zzzzzzzz'],
    ['client_secret=0a1b2c3d', '0a1b2c3d'],
    ['SECRET_KEY = "django-insecure-xyz"', 'django-insecure-xyz'],
    ['"token": "tok_1234567890"', 'tok_1234567890'],
    ['{"password":"letmein"}', 'letmein'],
    ['access_token=abcdef0123', 'abcdef0123'],
    ['--password hunter2 --verbose', 'hunter2'],
    ['--api-key=abc12345', 'abc12345'],
    ['token := "abc"', 'abc'],
  ];
  for (const [input, value] of secretValue) {
    it(`redacts the value in ${input}`, () => {
      const r = scrub(input);
      expect(r.text).not.toContain(value);
      expect(r.text).toContain('[SECRET]');
      expect(r.hits.assignment).toBeGreaterThanOrEqual(1);
    });
  }

  it('keeps the key name', () => {
    expect(scrubText('password = hunter2')).toBe('password = [SECRET]');
    expect(scrubText('{"password":"letmein"}')).toBe('{"password":"[SECRET]"}');
  });

  const keep = [
    'password: string',
    'token: number',
    'const token = process.env.GITHUB_TOKEN',
    'password = os.environ["PW"]',
    'api_key = ${API_KEY}',
    'secret: $SECRET',
    'token = <your token>',
    'max_tokens: 4096',
    'the token is expired',
    'we reset the password and moved on',
    'tokens used so far',
    'password: null',
    'secret = undefined',
  ];
  for (const input of keep) {
    it(`keeps ${input}`, () => {
      expect(scrubText(input)).toBe(input);
    });
  }
});

describe('scrub: urls, emails, paths', () => {
  it('removes credentials from URLs but keeps scheme and host', () => {
    expect(scrubText('git clone https://user:pa55w0rd@github.com/org/repo.git')).toBe('git clone https://[SECRET]@github.com/org/repo.git');
    expect(scrubText('postgres://admin:p@ss:word@db.internal:5432/app')).toBe('postgres://[SECRET]@db.internal:5432/app');
    expect(scrubText('redis://:onlypass@cache:6379')).toContain('cache:6379');
    expect(scrub('amqp://guest:guest@rabbit').hits['url-credentials']).toBe(1);
  });

  it('leaves ordinary URLs alone', () => {
    const u = 'https://example.com:8080/path?x=1#frag and ssh://git@github.com/x';
    expect(scrubText(u)).toContain('https://example.com:8080/path?x=1#frag');
  });

  it('replaces emails', () => {
    expect(scrubText('write to john.doe+tag@example.co.uk now')).toBe('write to [EMAIL] now');
    expect(scrubText('a@b.io, c@d.org')).toBe('[EMAIL], [EMAIL]');
    expect(scrub('x@y.com').hits.email).toBe(1);
  });

  it('does not treat package specs as emails', () => {
    for (const s of ['import x from "@types/node"', 'npm i lodash@4.17.21', 'pkg@latest', '@scope/pkg', 'user@localhost', 'a @ b.com']) {
      expect(scrubText(s)).toBe(s);
    }
  });

  it('turns absolute home paths into ~', () => {
    expect(scrubText('see /Users/alice/Projects/agento/cli/src/x.ts')).toBe('see ~/Projects/agento/cli/src/x.ts');
    expect(scrubText('cd /home/alice/work && ls')).toBe('cd ~/work && ls');
    expect(scrubText('"/Users/bob"')).toBe('"~"');
    expect(scrubText('C:\\Users\\Carol\\Documents\\x.txt')).toBe('~\\Documents\\x.txt');
    expect(scrub('/Users/a/b /home/c/d').hits['home-path']).toBe(2);
  });

  it('leaves other absolute paths alone', () => {
    for (const s of ['/usr/local/bin/node', '/etc/hosts', '/var/log/app.log', 'src/Users/x.ts', 'https://x.io/Users/foo']) {
      expect(scrubText(s)).toBe(s);
    }
  });
});

describe('scrub: high-entropy strings', () => {
  it('redacts long random base64, urlsafe and hex strings', () => {
    const b64 = rnd(B64, 44, 21);
    const url = rnd(ALNUM + '_-', 40, 22);
    const hex = rnd(HEX, 64, 23);
    const awsSecret = rnd(B64, 40, 24);
    for (const tok of [b64, url, hex, awsSecret, rnd(HEX, 32, 25), rnd(ALNUM, 32, 26) + '==']) {
      const r = scrub(`value ${tok} end`);
      expect(r.text).toBe('value [SECRET] end');
      expect(r.hits['high-entropy']).toBe(1);
    }
  });

  it('measures entropy as expected', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abab')).toBeCloseTo(1);
    expect(shannonEntropy(rnd(B64, 40, 31))).toBeGreaterThan(ENTROPY.mixed);
  });

  const harmless = [
    'a'.repeat(40),
    'abcdefghijklmnopqrstuvwxyzabcdefghijkl',
    'getUserAccountByEmailAddressAndPasswordResetToken',
    'THIS_IS_A_VERY_LONG_CONSTANT_NAME_FOR_THE_CONFIG_VALUE',
    '550e8400-e29b-41d4-a716-446655440000', // uuid
    'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3', // git sha
    'src/components/dashboard/widgets/chart-line-2024.tsx',
    'cli/test/fixtures/session-2026-09-01/subagents/agent-abc.jsonl',
    'node_modules/.pnpm/something-very-long-name-1.2.3/node_modules/x',
    'https://example.com/some/very/long/path/with/segments/2024/index.html',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
    'a-very-long-kebab-case-slug-with-a-number-42-in-it',
    'Short1234',
    'The quick brown fox jumps over the lazy dog 1234567890 times',
  ];
  for (const s of harmless) {
    it(`keeps ${s.slice(0, 40)}`, () => {
      expect(scrubText(s)).toBe(s);
    });
  }

  it('does not redact a 31-char random string (below the length floor)', () => {
    const tok = rnd(B64, 31, 41);
    expect(scrubText(tok)).toBe(tok);
  });
});

describe('scrub: general', () => {
  it('is idempotent', () => {
    const input = `pw password=hunter2 ${rnd(B64, 44, 51)} /Users/me/x a@b.com sk-ant-abcd1234efgh Bearer abcdefgh12345`;
    const once = scrubText(input);
    expect(scrubText(once)).toBe(once);
  });

  it('returns plain text unchanged with zero hits', () => {
    const r = scrub('Исправь опечатку в README и обнови версию');
    expect(r.text).toBe('Исправь опечатку в README и обнови версию');
    expect(Object.values(r.hits).every((n) => n === 0)).toBe(true);
  });

  it('handles empty input', () => {
    expect(scrub('').text).toBe('');
  });

  it('handles mixed multi-line prompts', () => {
    const input = ['Запусти деплой:', 'export AWS_SECRET_ACCESS_KEY=' + rnd(B64, 40, 61), 'curl -u admin:pw https://admin:s3cr3t@host.example/api', 'пиши на me@example.com'].join('\n');
    const out = scrubText(input);
    expect(out).not.toMatch(/s3cr3t|me@example/);
    expect(out).toContain('Запусти деплой:');
    expect(out).toContain('host.example/api');
  });
});
