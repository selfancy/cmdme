#!/usr/bin/env -S node --experimental-strip-types
/**
 * Generate or edit images through an OpenAI-compatible Images API.
 *
 * This script intentionally calls only /images/generations and /images/edits.
 * It uses Node's built-in fetch, FormData, and Blob APIs; no npm dependency is
 * required.
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_INPUT_IMAGES = 16;
const SIZE_RE = /^(\d+)x(\d+)$/;
const QUALITY_VALUES = new Set(["low", "medium", "high", "auto"]);
const BACKGROUND_VALUES = new Set(["auto", "opaque", "transparent"]);
const OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);
const MODERATION_VALUES = new Set(["auto", "low"]);

type Args = {
  listModels: boolean;
  prompt: string;
  out: string;
  images: string[];
  mask?: string;
  baseUrl?: string;
  n: number;
  size?: string;
  quality?: string;
  background?: string;
  outputFormat: string;
  outputCompression?: number;
  moderation?: string;
  timeout: number;
  force: boolean;
};

class ConfigurationError extends Error {}
class RequestValidationError extends Error {}
class ProviderError extends Error {}

function die(message: string, exitCode = 2): never {
  console.error(`Error: ${message}`);
  process.exit(exitCode);
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  if (!fs.statSync(filePath).isFile()) {
    throw new ConfigurationError(`configuration path is not a file: ${filePath}`);
  }

  const values: Record<string, string> = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach((rawLine: string, index: number) => {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const separator = line.indexOf("=");
    if (separator < 1) throw new ConfigurationError(`invalid .env entry at ${filePath}:${index + 1}`);
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new ConfigurationError(`invalid .env variable name at ${filePath}:${index + 1}`);
    }
    if (value.length >= 2 && value[0] === value[value.length - 1] && ["\"", "'"].includes(value[0])) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  });
  return values;
}

function loadConfig(skillDir: string, explicitBaseUrl?: string): { baseUrl: string; apiKey: string; model: string } {
  const fileValues = parseEnvFile(path.join(skillDir, ".env"));
  const baseUrl = explicitBaseUrl || process.env.GPT_IMAGE_BASE_URL || fileValues.GPT_IMAGE_BASE_URL;
  const apiKey = process.env.GPT_IMAGE_API_KEY || fileValues.GPT_IMAGE_API_KEY;
  const model = process.env.GPT_IMAGE_MODEL || fileValues.GPT_IMAGE_MODEL || DEFAULT_MODEL;
  const missing: string[] = [];
  if (!baseUrl) missing.push("GPT_IMAGE_BASE_URL");
  if (!apiKey) missing.push("GPT_IMAGE_API_KEY");
  if (missing.length) {
    throw new ConfigurationError(
      `missing provider configuration: ${missing.join(", ")}. Ask the user for the missing values and create ${path.join(skillDir, ".env")} with one KEY=VALUE entry per line.`,
    );
  }

  const parsed = new URL(baseUrl);
  if (!(["http:", "https:"].includes(parsed.protocol)) || !parsed.hostname) {
    throw new ConfigurationError("GPT_IMAGE_BASE_URL must be an absolute http(s) URL");
  }
  parsed.search = "";
  parsed.hash = "";
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  const storedPath = normalizedPath.endsWith("/v1") ? normalizedPath.slice(0, -3) : normalizedPath;
  parsed.pathname = storedPath || "/";
  return { baseUrl: parsed.toString().replace(/\/+$/, ""), apiKey, model };
}

function apiBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname.endsWith("/v1") ? pathname : `${pathname}/v1`;
  return parsed.toString().replace(/\/+$/, "");
}

function validateSize(size: string | undefined): void {
  if (!size || size === "auto") return;
  const match = size.match(SIZE_RE);
  if (!match) throw new RequestValidationError("--size must be auto or WIDTHxHEIGHT");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) throw new RequestValidationError("--size dimensions must be positive");

  if (width > 3840 || height > 3840) throw new RequestValidationError("gpt-image-2 dimensions must be at most 3840px");
  if (width % 16 || height % 16) throw new RequestValidationError("gpt-image-2 dimensions must be multiples of 16");
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  if (longEdge > shortEdge * 3) throw new RequestValidationError("gpt-image-2 size ratio cannot exceed 3:1");
  const pixels = width * height;
  if (pixels < 655_360 || pixels > 8_294_400) {
    throw new RequestValidationError("gpt-image-2 size must contain between 655360 and 8294400 total pixels");
  }
}

function validateArgs(args: Args): void {
  if (args.listModels) return;
  validateSize(args.size);
  if (!args.prompt.trim()) throw new RequestValidationError("--prompt cannot be empty");
  if (!Number.isInteger(args.n) || args.n < 1 || args.n > 10) throw new RequestValidationError("--n must be between 1 and 10");
  if (args.quality !== undefined && !QUALITY_VALUES.has(args.quality)) throw new RequestValidationError("--quality must be low, medium, high, or auto");
  if (args.background !== undefined && !BACKGROUND_VALUES.has(args.background)) throw new RequestValidationError("--background must be auto, opaque, or transparent");
  if (!OUTPUT_FORMATS.has(args.outputFormat)) throw new RequestValidationError("--output-format must be png, jpeg, or webp");
  if (args.outputCompression !== undefined) {
    if (!["jpeg", "webp"].includes(args.outputFormat)) throw new RequestValidationError("--output-compression is only valid for jpeg or webp");
    if (!Number.isInteger(args.outputCompression) || args.outputCompression < 0 || args.outputCompression > 100) {
      throw new RequestValidationError("--output-compression must be between 0 and 100");
    }
  }
  if (args.moderation !== undefined && !MODERATION_VALUES.has(args.moderation)) throw new RequestValidationError("--moderation must be auto or low");
  if (args.background === "transparent" && !["png", "webp"].includes(args.outputFormat)) throw new RequestValidationError("transparent background requires png or webp output");
  if (args.mask && !args.images.length) throw new RequestValidationError("--mask requires at least one --image");
  if (args.images.length > MAX_INPUT_IMAGES) throw new RequestValidationError(`at most ${MAX_INPUT_IMAGES} --image files are supported`);

  const files = args.images.map((filePath) => ["image", filePath] as const);
  if (args.mask) files.push(["mask", args.mask]);
  for (const [label, filePath] of files) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new RequestValidationError(`${label} file does not exist: ${filePath}`);
    if (fs.statSync(filePath).size > MAX_IMAGE_BYTES) throw new RequestValidationError(`${label} file exceeds the 50 MB limit: ${filePath}`);
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = { listModels: false, prompt: "", out: "", images: [], n: 1, outputFormat: "png", timeout: DEFAULT_TIMEOUT_SECONDS, force: false };
  const valueFlags = new Set(["--prompt", "--out", "--image", "--mask", "--base-url", "--n", "--size", "--quality", "--background", "--output-format", "--output-compression", "--moderation", "--timeout"]);
  if (argv.includes("--help") || argv.includes("-h")) printHelp();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--list-models") { args.listModels = true; continue; }
    if (flag === "--force") { args.force = true; continue; }
    if (!valueFlags.has(flag)) throw new RequestValidationError(`unknown argument: ${flag}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new RequestValidationError(`${flag} requires a value`);
    if (flag === "--prompt") args.prompt = value;
    else if (flag === "--out") args.out = value;
    else if (flag === "--image") args.images.push(value);
    else if (flag === "--mask") args.mask = value;
    else if (flag === "--base-url") args.baseUrl = value;
    else if (flag === "--n") args.n = Number(value);
    else if (flag === "--size") args.size = value;
    else if (flag === "--quality") args.quality = value;
    else if (flag === "--background") args.background = value;
    else if (flag === "--output-format") args.outputFormat = value;
    else if (flag === "--output-compression") args.outputCompression = Number(value);
    else if (flag === "--moderation") args.moderation = value;
    else if (flag === "--timeout") args.timeout = Number(value);
  }
  if (!args.listModels && !args.prompt) throw new RequestValidationError("--prompt is required");
  if (!args.listModels && !args.out) throw new RequestValidationError("--out is required");
  if (!Number.isFinite(args.timeout) || args.timeout < 0) throw new RequestValidationError("--timeout must be a non-negative number of seconds");
  return args;
}

function printHelp(): never {
  console.log(`Usage: node --experimental-strip-types scripts/generate_image.ts --prompt TEXT --out FILE [options]

Options:
  --list-models                List models supported by the configured provider
  --image FILE                 Input/reference image; repeatable (switches to edits)
  --mask FILE                  Mask image for localized edits
  --base-url URL               Temporary Images API base URL override
  --n NUMBER                   Number of variants, 1-10 (default: 1)
  --size SIZE                  auto or WIDTHxHEIGHT
  --quality VALUE              low, medium, high, or auto
  --background VALUE           auto, opaque, or transparent
  --output-format VALUE        png, jpeg, or webp (default: png)
  --output-compression NUMBER  JPEG/WebP compression, 0-100
  --moderation VALUE            auto or low
  --timeout SECONDS            HTTP timeout (default: 600; 0 disables it)
  --force                      Overwrite existing output files
  --help                      Show this help
`);
  process.exit(0);
}

function mimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<string, string>)[extension] || "application/octet-stream";
}

function addOptional(target: Record<string, string>, key: string, value: string | number | undefined): void {
  if (value !== undefined) target[key] = String(value);
}

function buildGenerationPayload(args: Args, model: string): Record<string, unknown> {
  const payload: Record<string, unknown> = { model, prompt: args.prompt, n: args.n, output_format: args.outputFormat };
  addOptional(payload as Record<string, string>, "size", args.size);
  addOptional(payload as Record<string, string>, "quality", args.quality);
  addOptional(payload as Record<string, string>, "background", args.background);
  addOptional(payload as Record<string, string>, "moderation", args.moderation);
  addOptional(payload as Record<string, string>, "output_compression", args.outputCompression);
  return payload;
}

function buildEditForm(args: Args, model: string): FormData {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", args.prompt);
  form.append("n", String(args.n));
  form.append("output_format", args.outputFormat);
  if (args.size !== undefined) form.append("size", args.size);
  if (args.quality !== undefined) form.append("quality", args.quality);
  if (args.background !== undefined) form.append("background", args.background);
  if (args.moderation !== undefined) form.append("moderation", args.moderation);
  if (args.outputCompression !== undefined) form.append("output_compression", String(args.outputCompression));
  for (const imagePath of args.images) {
    form.append("image[]", new Blob([fs.readFileSync(imagePath)], { type: mimeType(imagePath) }), path.basename(imagePath));
  }
  if (args.mask) form.append("mask", new Blob([fs.readFileSync(args.mask)], { type: mimeType(args.mask) }), path.basename(args.mask));
  return form;
}

async function fetchBytes(url: string, init: RequestInit, timeoutSeconds: number): Promise<{ response: Response; bytes: Buffer }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutSeconds > 0) timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { response, bytes };
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
      throw new ProviderError(`request timed out after ${timeoutSeconds} seconds`);
    }
    throw new ProviderError(`unable to reach image provider: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function requestJson(url: string, apiKey: string, method: "GET" | "POST", body: BodyInit | undefined, headers: Record<string, string>, timeoutSeconds: number): Promise<Record<string, unknown>> {
  const { response, bytes } = await fetchBytes(url, { method, headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", Connection: "close", "Accept-Encoding": "identity", ...headers }, body }, timeoutSeconds);
  const text = bytes.toString("utf8");
  if (!response.ok) throw new ProviderError(`provider returned HTTP ${response.status}: ${text.slice(0, 4000)}`);
  let payload: unknown;
  try { payload = JSON.parse(text); } catch (error) { throw new ProviderError("provider returned a non-JSON response"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ProviderError("provider response must be a JSON object");
  return payload as Record<string, unknown>;
}

function modelIds(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.data)) throw new ProviderError("provider model response has no data array");
  const ids = payload.data.flatMap((item) => item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).id === "string" ? [(item as Record<string, string>).id] : []);
  if (!ids.length) throw new ProviderError("provider model response has no usable model ids");
  return ids;
}

async function downloadImageUrl(url: string, timeoutSeconds: number, index: number): Promise<Buffer> {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) throw new ProviderError(`provider response item ${index} contains a non-HTTP(S) image URL`);
  const { response, bytes } = await fetchBytes(url, { method: "GET", headers: { Accept: "image/*,application/octet-stream;q=0.9", "User-Agent": "codex-gpt-image/1.0", Connection: "close", "Accept-Encoding": "identity" } }, timeoutSeconds);
  if (!response.ok) throw new ProviderError(`unable to download provider image URL for item ${index}: HTTP ${response.status}`);
  if (bytes.length > MAX_IMAGE_BYTES) throw new ProviderError(`provider response item ${index} URL content exceeds the 50 MB limit`);
  if (!bytes.length) throw new ProviderError(`provider response item ${index} URL returned an empty file`);
  return bytes;
}

function decodeBase64(value: string, index: number): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) throw new ProviderError(`provider response item ${index} contains invalid base64 data`);
  const decoded = Buffer.from(value, "base64");
  if (!decoded.length) throw new ProviderError(`provider response item ${index} contains empty image data`);
  return decoded;
}

async function decodeImages(payload: Record<string, unknown>, timeoutSeconds: number): Promise<Buffer[]> {
  const data = payload.data;
  if (!Array.isArray(data) || !data.length) throw new ProviderError("provider response has no non-empty data array");
  const decoded: Buffer[] = [];
  for (let index = 0; index < data.length; index += 1) {
    const item = data[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ProviderError(`provider response item ${index + 1} must be an object`);
    const record = item as Record<string, unknown>;
    if (typeof record.b64_json === "string" && record.b64_json) {
      decoded.push(decodeBase64(record.b64_json, index + 1));
    } else if (typeof record.url === "string" && record.url) {
      decoded.push(await downloadImageUrl(record.url, timeoutSeconds, index + 1));
    } else {
      throw new ProviderError(`provider response item ${index + 1} contains neither b64_json nor a usable url`);
    }
  }
  return decoded;
}

function outputPaths(outPath: string, count: number): string[] {
  if (count === 1) return [outPath];
  const extension = path.extname(outPath);
  const stem = extension ? path.basename(outPath, extension) : path.basename(outPath);
  const directory = path.dirname(outPath);
  return Array.from({ length: count }, (_, index) => path.join(directory, `${stem}-${index + 1}${extension}`));
}

function writeImages(images: Buffer[], outPath: string, force: boolean): string[] {
  const paths = outputPaths(outPath, images.length);
  for (const filePath of paths) {
    if (fs.existsSync(filePath) && !force) throw new RequestValidationError(`output already exists: ${filePath} (use --force to overwrite)`);
  }
  paths.forEach((filePath, index) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, images[index]);
  });
  return paths;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const skillDir = path.resolve(__dirname, "..");
  validateArgs(args);
  const { baseUrl, apiKey, model } = loadConfig(skillDir, args.baseUrl);
  if (args.listModels) {
    modelIds(await requestJson(`${apiBaseUrl(baseUrl)}/models`, apiKey, "GET", undefined, {}, args.timeout)).forEach((id) => console.log(id));
    return;
  }
  const endpoint = `${apiBaseUrl(baseUrl)}/images/${args.images.length ? "edits" : "generations"}`;
  const payload = args.images.length
    ? await requestJson(endpoint, apiKey, "POST", buildEditForm(args, model), {}, args.timeout)
    : await requestJson(endpoint, apiKey, "POST", JSON.stringify(buildGenerationPayload(args, model)), { "Content-Type": "application/json" }, args.timeout);
  const images = await decodeImages(payload, args.timeout);
  const written = writeImages(images, args.out, args.force);
  written.forEach((filePath) => console.log(`Wrote ${path.resolve(filePath)}`));
}

main().catch((error) => {
  if (error instanceof ConfigurationError || error instanceof RequestValidationError || error instanceof ProviderError) die(error.message);
  die(error instanceof Error ? error.message : String(error));
});
