---
name: google-gemini-image
description: Generate raster images with Google Gemini through the official generateContent API. Use configurable base URL and API key, discover models from /v1/models on first setup, and save inlineData image responses locally; text-to-image only.
---

# Google Gemini Image

Use this skill for text-to-image generation through Google's Gemini `generateContent` endpoint. Do not route requests through OpenAI Images API endpoints or add reference-image editing unless the skill is explicitly extended.

## First-time setup

The skill keeps provider configuration in:

```
<skill-dir>/.env
```

Run setup before the first generation when `.env` is missing or incomplete:

```bash
node --experimental-strip-types scripts/setup.ts
```

Setup prompts for the base URL and API key, writes the file with mode `0600`, calls `GET /v1/models`, and presents the models that support `generateContent`. A blank model selection writes the required default `gemini-3.1-flash-image`.

The environment keys are:

```env
GEMINI_BASE_URL=https://generativelanguage.googleapis.com
GEMINI_API_KEY=replace-with-your-key
GEMINI_MODEL=gemini-3.1-flash-image
```

The `.env` value stores only the root base URL without a version suffix. Setup accepts both Google `models[]` and OpenAI-style `data[]` model responses. The scripts append `/v1` for model discovery and `/v1beta` for generateContent automatically. The API key is sent only in the `x-goog-api-key` request header; never put it in a URL, command output, error message, or response.

Process environment variables take precedence over values in `.env`, except that the model still defaults to `gemini-3.1-flash-image` when unset.

## Generation workflow

1. If setup has not completed, run `scripts/setup.ts` and show the returned model list to the user.
2. Run `scripts/generate_image.ts` with a complete prompt and an output path.
3. The script calls `POST <base-url>/v1beta/models/{model}:generateContent` with `contents` and `generationConfig.responseModalities: ["IMAGE"]`.
4. Save the first image found in `candidates[].content.parts[].inlineData` as the requested output file.
5. Report the absolute output path and selected model without exposing credentials.

Example:

```bash
node --experimental-strip-types scripts/generate_image.ts --prompt "A cinematic rainy street in Tokyo at night" --out output/tokyo.png
```

Optional image controls are `--aspect-ratio` and `--image-size`; they are sent inside `generationConfig.imageConfig` only when provided. The skill does not support reference images, editing, streaming, or batch generation.

Read [references/gemini-api.md](references/gemini-api.md) for the endpoint contract and setup behavior.
