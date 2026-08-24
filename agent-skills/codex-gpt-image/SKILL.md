---
name: codex-gpt-image
description: Generate and edit raster images through an OpenAI-compatible Images API using /images/generations and /images/edits, with configurable base URL and API key. Use for text-to-image, reference-image generation, image editing, inpainting, masks, and image variants; do not use for Responses API image bridges.
---

# Codex GPT Image

Use this skill for image generation and image editing through the provider's dedicated OpenAI-compatible Images API. The skill never uses the Responses API and never routes image work through `/responses`.

## Configuration

The skill stores its provider configuration in the skill directory:

```text
<skill-dir>/.env
```

The required keys are:

```env
CODEX_GPT_IMAGE_BASE_URL=https://provider.example/v1
CODEX_GPT_IMAGE_API_KEY=replace-with-your-key
CODEX_GPT_IMAGE_MODEL=gpt-image-2
```

On first setup, if the `.env` file or its model entry is missing, run:

```bash
node --experimental-strip-types scripts/setup.ts
```

Setup prompts for the base URL and API key, normalizes the base URL to include `/v1`, calls `GET <base-url>/v1/models`, presents the returned model IDs, and writes the user's selection to `.env` with permissions `0600`. Pressing Enter keeps the default `gpt-image-2`. Never repeat the key in a response, prompt, log, or generated file. The repository's `.gitignore` excludes `.env`.

Configuration precedence is:

1. `--base-url` on the command line (base URL only).
2. Process environment variables.
3. `<skill-dir>/.env`.

The API key is read from `CODEX_GPT_IMAGE_API_KEY` only. Do not accept a plaintext key command-line argument.

When a configured base URL does not end with `/v1`, the script appends `/v1` automatically before adding the Images API path.

## Routing

- Text-only requests use `POST <base_url>/images/generations`.
- Requests with one or more input images or a mask use `POST <base_url>/images/edits`.
- A mask requires at least one input image; the first input image is the edit target.
- The model configured in `.env` defaults to `gpt-image-2`; first setup can change it to a model returned by the provider's model list.
- Use the bundled `scripts/generate_image.ts`; do not create an ad-hoc API runner.

## Workflow

1. Determine whether the request is generation or editing and label input files in the prompt when their role matters (edit target, reference, mask, or compositing source).
2. Preserve explicit user constraints, especially for edits: state what may change and what must remain unchanged.
3. On first setup, run `node --experimental-strip-types scripts/setup.ts` and let the user select a returned model (or accept the default `gpt-image-2`).
4. Run `scripts/generate_image.ts` with Node's TypeScript type stripping and the requested prompt and parameters.
5. Do not inspect, identify, describe, OCR, classify, or otherwise analyze the generated image content after the API returns it. Treat the returned bytes as an opaque output artifact.
6. Report the absolute output path and the selected model/endpoint, but never report credentials.

## Supported controls

The script supports the dedicated Images API controls below:

- `--list-models`
- `--prompt`
- `--n` (`1`–`10`)
- `--size`
- `--quality` (`low`, `medium`, `high`, `auto`)
- `--background` (`auto`, `opaque`, `transparent`)
- `--output-format` (`png`, `jpeg`, `webp`)
- `--output-compression` (`0`–`100`, only for JPEG/WebP)
- `--moderation` (`auto`, `low`)
- repeated `--image` (up to 16 files)
- `--mask`

The script prefers `data[].b64_json`. If that field is absent, it downloads `data[].url` over HTTP(S) without forwarding the API key. It fails clearly when neither representation is usable and does not fall back to another endpoint.

Read [references/image-api.md](references/image-api.md) for `gpt-image-2` parameter rules, size validation, multipart field names, and examples. Use `node --experimental-strip-types scripts/generate_image.ts --help` for the complete CLI. The default HTTP timeout is 600 seconds (10 minutes); pass `--timeout 0` to disable it.

## Examples

```bash
node --experimental-strip-types scripts/generate_image.ts \
  --prompt "电影感雨夜东京街头，霓虹灯倒影，真实摄影风格" \
  --size 1536x1024 \
  --quality high \
  --out output.png
```

```bash
node --experimental-strip-types scripts/generate_image.ts \
  --image input.png \
  --prompt "只替换背景为日落海滩，保持主体和边缘不变" \
  --out edited.png
```

```bash
node --experimental-strip-types scripts/generate_image.ts \
  --image input.png \
  --mask mask.png \
  --prompt "只修改 mask 区域，添加一盏暖色台灯" \
  --out edited.png
```
