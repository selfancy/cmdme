#!/usr/bin/env -S node --experimental-strip-types

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');

const DEFAULT_MODEL = 'gpt-image-2';
const DEFAULT_TIMEOUT_SECONDS = 120;

type JsonObject = Record<string, unknown>;

class SetupError extends Error {}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  if (!fs.statSync(filePath).isFile()) throw new SetupError('configuration path is not a file: ' + filePath);

  const values: Record<string, string> = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  lines.forEach((rawLine: string, index: number) => {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('export ')) line = line.slice(7).trimStart();
    const separator = line.indexOf('=');
    if (separator < 1) throw new SetupError('invalid .env entry at ' + filePath + ':' + (index + 1));
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new SetupError('invalid .env variable name at ' + filePath + ':' + (index + 1));
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1);
    values[name] = value;
  });
  return values;
}

function normalizeBaseUrl(input: string): string {
  let parsed: URL;
  try { parsed = new URL(input.trim()); } catch { throw new SetupError('CODEX_GPT_IMAGE_BASE_URL must be an absolute http(s) URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new SetupError('CODEX_GPT_IMAGE_BASE_URL must use http or https');
  if (!parsed.hostname) throw new SetupError('CODEX_GPT_IMAGE_BASE_URL must include a hostname');
  parsed.search = '';
  parsed.hash = '';
  const pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = pathname.endsWith('/v1') ? pathname : pathname + '/v1';
  return parsed.toString().replace(/\/+$/, '');
}

function redactedBody(body: string, apiKey: string): string {
  return body.replaceAll(apiKey, '[REDACTED]').slice(0, 3000);
}

async function requestJson(url: string, apiKey: string, timeoutSeconds: number): Promise<JsonObject> {
  const controller = new AbortController();
  const timer = timeoutSeconds > 0 ? setTimeout(() => controller.abort(), timeoutSeconds * 1000) : undefined;
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + apiKey,
          Connection: 'close',
          'Accept-Encoding': 'identity',
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
        throw new SetupError('model request timed out after ' + timeoutSeconds + ' seconds');
      }
      throw new SetupError('unable to reach image provider: ' + (error instanceof Error ? error.message : String(error)));
    }

    const responseText = await response.text();
    if (!response.ok) throw new SetupError('image provider returned HTTP ' + response.status + ': ' + redactedBody(responseText, apiKey));
    let payload: unknown;
    try { payload = JSON.parse(responseText); } catch { throw new SetupError('image provider returned invalid JSON'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SetupError('image provider response must be a JSON object');
    return payload as JsonObject;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function modelIds(payload: JsonObject): string[] {
  if (!Array.isArray(payload.data)) throw new SetupError('image provider model response has no data array');
  const ids = payload.data.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const id = (item as JsonObject).id;
    return typeof id === 'string' && id.trim() ? [id.trim()] : [];
  });
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) throw new SetupError('image provider model response has no usable model ids');
  return uniqueIds;
}

function writeConfig(filePath: string, baseUrl: string, apiKey: string, model: string): void {
  const contents = [
    'CODEX_GPT_IMAGE_BASE_URL=' + baseUrl,
    'CODEX_GPT_IMAGE_API_KEY=' + apiKey,
    'CODEX_GPT_IMAGE_MODEL=' + model,
    '',
  ].join('\n');
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

async function promptLine(label: string, defaultValue: string | undefined): Promise<string> {
  if (!process.stdin.isTTY) {
    if (defaultValue) return defaultValue;
    throw new SetupError('interactive setup requires a TTY; set CODEX_GPT_IMAGE_BASE_URL and CODEX_GPT_IMAGE_API_KEY in the environment');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ' [' + defaultValue + ']' : '';
    const value = (await rl.question(label + suffix + ': ')).trim();
    return value || defaultValue || '';
  } finally {
    rl.close();
  }
}

function chooseModel(ids: string[], input: string): string {
  if (!input.trim()) return DEFAULT_MODEL;
  const trimmed = input.trim();
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= ids.length) return ids[numeric - 1];
  if (!ids.includes(trimmed)) throw new SetupError('model selection is not in the displayed model list: ' + trimmed);
  return trimmed;
}

function parseArgs(argv: string[]): { baseUrl?: string; timeout: number } {
  let baseUrl: string | undefined;
  let timeout = DEFAULT_TIMEOUT_SECONDS;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      console.log('Usage: node --experimental-strip-types scripts/setup.ts [--base-url URL] [--timeout SECONDS]');
      process.exit(0);
    }
    if (flag === '--base-url') {
      baseUrl = argv[++index];
      if (!baseUrl || baseUrl.startsWith('--')) throw new SetupError('--base-url requires a value');
      continue;
    }
    if (flag === '--timeout') {
      timeout = Number(argv[++index]);
      if (!Number.isFinite(timeout) || timeout < 0) throw new SetupError('--timeout must be a non-negative number of seconds');
      continue;
    }
    throw new SetupError('unknown argument: ' + flag);
  }
  return { baseUrl, timeout };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const skillDir = path.resolve(__dirname, '..');
  const envPath = path.join(skillDir, '.env');
  const fileValues = parseEnvFile(envPath);
  const configuredBaseUrl = args.baseUrl || process.env.CODEX_GPT_IMAGE_BASE_URL || fileValues.CODEX_GPT_IMAGE_BASE_URL;
  const configuredApiKey = process.env.CODEX_GPT_IMAGE_API_KEY || fileValues.CODEX_GPT_IMAGE_API_KEY;
  const rawBaseUrl = configuredBaseUrl || await promptLine('Images API base URL', undefined);
  const rawApiKey = configuredApiKey || await promptLine('Images API key', undefined);
  if (!rawBaseUrl.trim()) throw new SetupError('CODEX_GPT_IMAGE_BASE_URL is required');
  if (!rawApiKey.trim()) throw new SetupError('CODEX_GPT_IMAGE_API_KEY is required');
  const baseUrl = normalizeBaseUrl(rawBaseUrl);

  console.log('\nFetching models from ' + baseUrl + '/models ...');
  const ids = modelIds(await requestJson(baseUrl + '/models', rawApiKey, args.timeout));
  console.log('\nAvailable models:');
  ids.forEach((id, index) => console.log('  ' + (index + 1) + '. ' + id));

  const selectedInput = process.stdin.isTTY ? await promptLine('Select a model by number or ID; press Enter for ' + DEFAULT_MODEL, undefined) : '';
  const selectedModel = chooseModel(ids, selectedInput);
  writeConfig(envPath, baseUrl, rawApiKey, selectedModel);
  console.log('Saved image configuration to ' + envPath);
  console.log('Selected model: ' + selectedModel);
}

main().catch((error) => {
  console.error('Error: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 2;
});
