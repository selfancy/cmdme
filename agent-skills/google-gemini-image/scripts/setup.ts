#!/usr/bin/env -S node --experimental-strip-types

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");

const DEFAULT_MODEL = "gemini-3.1-flash-image";
const DEFAULT_TIMEOUT_SECONDS = 120;
const USER_AGENT = "google-gemini-image/1.0";

type JsonObject = Record<string, unknown>;
type ModelInfo = {
  id: string;
  name: string;
  displayName: string;
  methods: string[];
};
type ModelListResult = ModelInfo[];

class SetupError extends Error {}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  if (!fs.statSync(filePath).isFile()) throw new SetupError("configuration path is not a file: " + filePath);

  const values: Record<string, string> = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach((rawLine: string, index: number) => {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const separator = line.indexOf("=");
    if (separator < 1) throw new SetupError("invalid .env entry at " + filePath + ":" + (index + 1));
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new SetupError("invalid .env variable name at " + filePath + ":" + (index + 1));
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
  try { parsed = new URL(input.trim()); } catch { throw new SetupError("GEMINI_BASE_URL must be an absolute http(s) URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new SetupError("GEMINI_BASE_URL must use http or https");
  if (!parsed.hostname) throw new SetupError("GEMINI_BASE_URL must include a hostname");
  parsed.search = "";
  parsed.hash = "";
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname.endsWith("/v1beta") ? pathname.slice(0, -7) : pathname.endsWith("/v1") ? pathname.slice(0, -3) : pathname;
  return parsed.toString().replace(/\/+$/, "");
}

function redactedBody(body: string, apiKey: string): string {
  return body.replaceAll(apiKey, "[REDACTED]").slice(0, 3000);
}

async function requestJson(url: string, apiKey: string, method: "GET" | "POST", body: string | undefined, timeoutSeconds: number): Promise<JsonObject> {
  const controller = new AbortController();
  const timer = timeoutSeconds > 0 ? setTimeout(() => controller.abort(), timeoutSeconds * 1000) : undefined;
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          Connection: "close",
          "Accept-Encoding": "identity",
          "User-Agent": USER_AGENT,
          "x-goog-api-key": apiKey,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
        throw new SetupError("model request timed out after " + timeoutSeconds + " seconds");
      }
      throw new SetupError("unable to reach Gemini endpoint: " + (error instanceof Error ? error.message : String(error)));
    }

    const responseText = await response.text();
    if (!response.ok) throw new SetupError("Gemini endpoint returned HTTP " + response.status + ": " + redactedBody(responseText, apiKey));
    let payload: unknown;
    try { payload = JSON.parse(responseText); } catch { throw new SetupError("Gemini endpoint returned invalid JSON"); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new SetupError("Gemini endpoint response must be a JSON object");
    return payload as JsonObject;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function modelId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().replace(/^models\//, "");
}

async function listModels(baseUrl: string, apiKey: string, timeoutSeconds: number): Promise<ModelListResult> {
  const models: ModelInfo[] = [];
  let pageToken: string | undefined;
  let responseStyle: "google" | "openai" | undefined;
  do {
    const url = new URL(baseUrl + "/v1/models");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = await requestJson(url.toString(), apiKey, "GET", undefined, timeoutSeconds);
    const entries = Array.isArray(payload.models)
      ? payload.models
      : Array.isArray(payload.data)
        ? payload.data
        : undefined;
    if (!entries) throw new SetupError("Gemini model response has neither models nor data array");
    const currentStyle = Array.isArray(payload.models) ? "google" : "openai";
    if (responseStyle && responseStyle !== currentStyle) throw new SetupError("Gemini model response changed format between pages");
    responseStyle = currentStyle;
    for (const rawModel of entries) {
      if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) continue;
      const item = rawModel as JsonObject;
      const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods.filter((value): value is string => typeof value === "string") : [];
      const openaiStyle = currentStyle === "openai";
      if (!openaiStyle && !methods.includes("generateContent")) continue;
      const id = modelId(openaiStyle ? item.id : item.baseModelId) || modelId(item.name) || modelId(item.id);
      if (!id) continue;
      if (openaiStyle) methods.push("generateContent");
      models.push({
        id,
        name: typeof item.name === "string" ? item.name : "models/" + id,
        displayName: typeof item.displayName === "string" ? item.displayName : typeof item.display_name === "string" ? item.display_name : id,
        methods,
      });
    }
    pageToken = typeof payload.nextPageToken === "string" && payload.nextPageToken ? payload.nextPageToken : undefined;
  } while (pageToken);
  return models;
}

function writeConfig(filePath: string, baseUrl: string, apiKey: string, model: string): void {
  const contents = [
    "GEMINI_BASE_URL=" + baseUrl,
    "GEMINI_API_KEY=" + apiKey,
    "GEMINI_MODEL=" + model,
    "",
  ].join("\n");
  fs.writeFileSync(filePath, contents, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

async function promptLine(label: string, defaultValue: string | undefined): Promise<string> {
  if (!process.stdin.isTTY) {
    if (defaultValue) return defaultValue;
    throw new SetupError("interactive setup requires a TTY; set GEMINI_BASE_URL and GEMINI_API_KEY in the environment");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? " [" + defaultValue + "]" : "";
    const value = (await rl.question(label + suffix + ": ")).trim();
    return value || defaultValue || "";
  } finally {
    rl.close();
  }
}

async function promptSecret(label: string, defaultValue: string | undefined): Promise<string> {
  return promptLine(label, defaultValue);
}

function chooseModel(models: ModelInfo[], input: string): string {
  if (!input.trim()) return DEFAULT_MODEL;
  const trimmed = input.trim();
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= models.length) return models[numeric - 1].id;
  const normalized = trimmed.replace(/^models\//, "");
  const match = models.find((model) => model.id === normalized);
  if (!match) throw new SetupError("model selection is not in the displayed model list: " + trimmed);
  return match.id;
}

function parseArgs(argv: string[]): { baseUrl?: string; timeout: number } {
  let baseUrl: string | undefined;
  let timeout = DEFAULT_TIMEOUT_SECONDS;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      console.log("Usage: node --experimental-strip-types scripts/setup.ts [--base-url URL] [--timeout SECONDS]");
      process.exit(0);
    }
    if (flag === "--base-url") {
      baseUrl = argv[++index];
      if (!baseUrl || baseUrl.startsWith("--")) throw new SetupError("--base-url requires a value");
      continue;
    }
    if (flag === "--timeout") {
      timeout = Number(argv[++index]);
      if (!Number.isFinite(timeout) || timeout < 0) throw new SetupError("--timeout must be a non-negative number of seconds");
      continue;
    }
    throw new SetupError("unknown argument: " + flag);
  }
  return { baseUrl, timeout };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const skillDir = path.resolve(__dirname, "..");
  const envPath = path.join(skillDir, ".env");
  const fileValues = parseEnvFile(envPath);
  const configuredBaseUrl = args.baseUrl || process.env.GEMINI_BASE_URL || fileValues.GEMINI_BASE_URL;
  const configuredApiKey = process.env.GEMINI_API_KEY || fileValues.GEMINI_API_KEY;
  const rawBaseUrl = configuredBaseUrl || await promptLine("Gemini base URL", undefined);
  const rawApiKey = await promptSecret("Gemini API key", configuredApiKey);
  if (!rawBaseUrl.trim()) throw new SetupError("GEMINI_BASE_URL is required");
  if (!rawApiKey.trim()) throw new SetupError("GEMINI_API_KEY is required");
  const baseUrl = normalizeBaseUrl(rawBaseUrl);

  console.log("\nFetching models from " + baseUrl + "/v1/models ...");
  const models = await listModels(baseUrl, rawApiKey, args.timeout);
  if (!models.length) throw new SetupError("no model supporting generateContent was returned by /v1/models");
  console.log("\nModels supporting generateContent:");
  models.forEach((model, index) => {
    const label = model.displayName ? " — " + model.displayName : "";
    console.log("  " + (index + 1) + ". " + model.id + label);
  });

  const selectedInput = process.stdin.isTTY ? await promptLine("Select a model by number or ID; press Enter for " + DEFAULT_MODEL, undefined) : "";
  const selectedModel = chooseModel(models, selectedInput);
  if (!models.some((model) => model.id === selectedModel)) {
    console.warn("Default model " + DEFAULT_MODEL + " was not returned; preserving the requested default.");
  }
  writeConfig(envPath, baseUrl, rawApiKey, selectedModel);
  console.log("Saved Gemini configuration to " + envPath);
  console.log("Selected model: " + selectedModel);
}

main().catch((error) => {
  console.error("Error: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 2;
});
