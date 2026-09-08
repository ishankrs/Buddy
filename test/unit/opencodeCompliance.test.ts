import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

function allFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') {
        continue;
      }
      out.push(...allFiles(full, exts));
    } else if (exts.some((e) => full.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

function grepFiles(files: string[], re: RegExp): Array<{ file: string; line: string }> {
  const hits: Array<{ file: string; line: string }> = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (re.test(line)) {
        hits.push({ file: file.replace(root + '/', ''), line: `${i + 1}: ${line.trim().slice(0, 160)}` });
      }
    });
  }
  return hits;
}

describe('OpenCode compliance scans', () => {
  const srcFiles = allFiles(join(root, 'src'), ['.ts']);
  const backendFiles = allFiles(join(root, 'src', 'llm', 'opencode'), ['.ts']);

  it('never calls hosted OpenCode endpoints', () => {
    const hits = grepFiles(srcFiles, /opencode\.ai\/(zen|inference)|zen\/v1/i);
    assert.deepEqual(hits, []);
  });

  it('stores no OpenCode credentials (legacy delete is the only exception)', () => {
    const hits = grepFiles(backendFiles, /secrets\.(store|get)\(['"]buddy\.apiKey\.opencode|setApiKey\(.*opencode|getApiKey\(.*opencode/i);
    assert.deepEqual(hits, []);
    // The single allowed touch: deleting a legacy key, never reading/writing one.
    const deletes = grepFiles(backendFiles, /context\.secrets\.delete\('buddy\.apiKey\.opencode'\)/);
    assert.equal(deletes.length, 1);
    const stores = grepFiles(backendFiles, /secrets\.store|setApiKey|apiKey\s*[:=]\s*['"][A-Za-z0-9]/i);
    assert.deepEqual(stores, []);
  });

  it('backend requests no bearer tokens and embeds no tokens', () => {
    const hits = grepFiles(backendFiles, /bearer|authorization['"]?\s*:|sk-[A-Za-z0-9]{4,}|api[_-]?key/i)
      // The legacy key *deletion* (covered above) is not a credential touch.
      .filter((h) => !h.line.includes('secrets.delete'));
    assert.deepEqual(hits, []);
  });

  it('contains no hardcoded model ids', () => {
    const hits = grepFiles(
      backendFiles,
      /kimi|big-pickle|mimo|deepseek|glm-[0-9]|gpt-[0-9o]|claude|qwen|llama|codellama|mistral|gemini|grok|minimax/i
    );
    assert.deepEqual(hits, []);
  });

  it('package.json has no OpenCode endpoint setting', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8') as string) as {
      contributes: { configuration: { properties: Record<string, unknown> } };
    };
    const props = pkg.contributes.configuration.properties;
    assert.ok(!('buddy.opencodeBaseUrl' in props));
    assert.ok('buddy.opencodeBinary' in props);
    const commands = (pkg.contributes as unknown as { commands: Array<{ command: string }> }).commands;
    assert.ok(commands.some((c) => c.command === 'buddy.checkOpencode'));
  });

  it('declares no new runtime dependencies for the ACP backend', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8') as string) as {
      dependencies: Record<string, string>;
    };
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@anthropic-ai/sdk', 'openai']);
  });
});
