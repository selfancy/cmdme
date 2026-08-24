#!/usr/bin/env -S node --experimental-strip-types

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MODEL = "gemini-3.1-flash-image";
const DEFAULT_TIMEOUT_SECONDS = 600;

type JsonObject = Record<string, unknown>;
type Args = {
  prompt: string;
  out: string;
  aspectRatio?: string;
  imageSize?: string;
  timeout: number;
};
type Config = { baseUrl: string; generateBaseUrl: string; apiKey: string; model: string };
type ImageData = { mimeType: string; data: Buffer };

class ConfigurationError extends Error {}
class RequestError extends Error {}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  if (!fs.statSync(filePath).isFile()) throw new ConfigurationError("configuration path is not a file: " + filePath);
  const values: Record<string, string> = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach((rawLine: string, index: number) => {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const separator = line.indexOf("=");
    if (separator < 1) throw new ConfigurationError("invalid .env entry at " + filePath + ":" + (index + 1));
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ConfigurationError("invalid .env variable name at " + filePath + ":" + (index + 1));
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === "\"" || value[0] === "'")) {
      if (value[0] === "\"") {
        try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
      } else {
        value = value.slice(1, -1);
      }
    }
    values[name] = value;
  });
  return values;
}

function normalizeBaseUrl(input: string): string {
  let parsed: URL;
  try { parsed = new URL(input.trim()); } catch { throw new ConfigurationError("GEMINI_BASE_URL must be an absolute http(s) URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ConfigurationError("GEMINI_BASE_URL must use http or https");
  if (!parsed.hostname) throw new ConfigurationError("GEMINI_BASE_URL must include a hostname");
  parsed.search = "";
  parsed.hash = "";
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname.endsWith("/v1") ? pathname : pathname + "/v1";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeGenerateBaseUrl(input: string): string {
  let parsed: URL;
  try { parsed = new URL(input.trim()); } catch { throw new ConfigurationError("GEMINI_GENERATE_BASE_URL must be an absolute http(s) URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ConfigurationError("GEMINI_GENERATE_BASE_URL must use http or https");
  if (!parsed.hostname) throw new ConfigurationError("GEMINI_GENERATE_BASE_URL must include a hostname");
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  if (!parsed.pathname.endsWith("/v1") && !parsed.pathname.endsWith("/v1beta")) parsed.pathname += "/v1";
  return parsed.toString().replace(/\/+$/, "");
}

function redact(text: string, apiKey: string): string {
  return text.replaceAll(apiKey, "[REDACTED]").slice(0, 3000);
}

async function requestJson(url: string, apiKey: string, body: JsonObject, timeoutSeconds: number): Promise<JsonObject> {
  const controller = new AbortController();
  const timer = timeoutSeconds > 0 ? setTimeout(() => controller.abort(), timeoutSeconds * 1000) : undefined;
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Connection: "close",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
        throw new RequestError("image request timed out after " + timeoutSeconds + " seconds");
      }
      throw new RequestError("unable to reach Gemini endpoint: " + (error instanceof Error ? error.message : String(error)));
    }

    const responseText = await response.text();
    if (!response.ok) throw new RequestError("Gemini endpoint returned HTTP " + response.status + ": " + redact(responseText, apiKey));
    let payload: unknown;
    try { payload = JSON.parse(responseText); } catch { throw new RequestError("Gemini endpoint returned invalid JSON"); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new RequestError("Gemini endpoint response must be a JSON object");
    return payload as JsonObject;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = { prompt: "", out: "", timeout: DEFAULT_TIMEOUT_SECONDS };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      console.log([
        "Usage: node --experimental-strip-types scripts/generate_image.ts --prompt TEXT --out FILE [options]",
        "",
        "Options:",
        "  --aspect-ratio VALUE  Image aspect ratio, forwarded as imageConfig.aspectRatio",
        "  --image-size VALUE    Image size, forwarded as imageConfig.imageSize",
        "  --timeout SECONDS     HTTP timeout; default 600, 0 disables it",
      ].join("\n"));
      process.exit(0);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new RequestError(flag + " requires a value");
    if (flag === "--prompt") args.prompt = value;
    else if (flag === "--out") args.out = value;
    else if (flag === "--aspect-ratio") args.aspectRatio = value;
    else if (flag === "--image-size") args.imageSize = value;
    else if (flag === "--timeout") args.timeout = Number(value);
    else throw new RequestError("unknown argument: " + flag);
  }
  if (!args.prompt.trim()) throw new RequestError("--prompt is required");
  if (!args.out.trim()) throw new RequestError("--out is required");
  if (!Number.isFinite(args.timeout) || args.timeout < 0) throw new RequestError("--timeout must be a non-negative number of seconds");
  return args;
}

function loadConfig(skillDir: string): Config {
  const fileValues = parseEnvFile(path.join(skillDir, ".env"));
  const baseUrlValue = process.env.GEMINI_BASE_URL || fileValues.GEMINI_BASE_URL;
  const generateBaseUrlValue = process.env.GEMINI_GENERATE_BASE_URL || fileValues.GEMINI_GENERATE_BASE_URL || baseUrlValue;
  const apiKey = process.env.GEMINI_API_KEY || fileValues.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || fileValues.GEMINI_MODEL || DEFAULT_MODEL;
  const missing: string[] = [];
  if (!baseUrlValue) missing.push("GEMINI_BASE_URL");
  if (!apiKey) missing.push("GEMINI_API_KEY");
  if (!generateBaseUrlValue) missing.push("GEMINI_GENERATE_BASE_URL");
  if (missing.length) throw new ConfigurationError("missing " + missing.join(", ") + "; run node --experimental-strip-types scripts/setup.ts first");
  return { baseUrl: normalizeBaseUrl(baseUrlValue), generateBaseUrl: normalizeGenerateBaseUrl(generateBaseUrlValue), apiKey, model: model.replace(/^models\//, "") };
}

function buildPayload(args: Args): JsonObject {
  const generationConfig: JsonObject = { responseModalities: ["IMAGE"] };
  if (args.aspectRatio !== undefined || args.imageSize !== undefined) {
    const imageConfig: JsonObject = {};
    if (args.aspectRatio !== undefined) imageConfig.aspectRatio = args.aspectRatio;
    if (args.imageSize !== undefined) imageConfig.imageSize = args.imageSize;
    generationConfig.imageConfig = imageConfig;
  }
  return {
    contents: [{ role: "user", parts: [{ text: args.prompt }] }],
    generationConfig,
  };
}

function isValidBase64(value: string): boolean {
  const normalized = value.replace(/\s+/g, "");
  return normalized.length > 0 && normalized.length % 4 !== 1 && /^[A-Za-z0-9+/]*={0,2}$/.test(normalized);
}

function extractImage(payload: JsonObject): ImageData {
  if (!Array.isArray(payload.candidates)) throw new RequestError("Gemini response has no candidates array");
  for (const rawCandidate of payload.candidates) {
    if (!rawCandidate || typeof rawCandidate !== "object" || Array.isArray(rawCandidate)) continue;
    const candidate = rawCandidate as JsonObject;
    const content = candidate.content;
    if (!content || typeof content !== "object" || Array.isArray(content)) continue;
    const parts = (content as JsonObject).parts;
    if (!Array.isArray(parts)) continue;
    for (const rawPart of parts) {
      if (!rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) continue;
      const inlineData = (rawPart as JsonObject).inlineData;
      if (!inlineData || typeof inlineData !== "object" || Array.isArray(inlineData)) continue;
      const image = inlineData as JsonObject;
      const mimeType = typeof image.mimeType === "string" ? image.mimeType : "";
      const data = typeof image.data === "string" ? image.data : "";
      if (!mimeType.startsWith("image/")) throw new RequestError("Gemini image response has an unsupported MIME type");
      if (!isValidBase64(data)) throw new RequestError("Gemini image response has invalid Base64 data");
      const bytes = Buffer.from(data.replace(/\s+/g, ""), "base64");
      if (!bytes.length) throw new RequestError("Gemini image response contains empty image data");
      return { mimeType, data: bytes };
    }
  }
  throw new RequestError("Gemini response did not contain an inlineData image");
}

function writeImage(outputPath: string, image: ImageData): string {
  const absolutePath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, image.data);
  return absolutePath;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const skillDir = path.resolve(__dirname, "..");
  const config = loadConfig(skillDir);
  const endpoint = config.generateBaseUrl + "/models/" + encodeURIComponent(config.model) + ":generateContent";
  const payload = await requestJson(endpoint, config.apiKey, buildPayload(args), args.timeout);
  const image = extractImage(payload);
  const outputPath = writeImage(args.out, image);
  console.log("Wrote " + outputPath + " (" + image.mimeType + ")");
  console.log("Model: " + config.model);
}

main().catch((error) => {
  console.error("Error: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 2;
});
