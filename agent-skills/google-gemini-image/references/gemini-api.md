# Gemini image generation API

This skill uses Google's `generateContent` API with image output. The request version prefix is intentionally `/v1`, because the skill normalizes the configured base URL to that prefix.

## Endpoints

```
GET  <base-url>/v1/models
POST <base-url>/../v1beta/models/<model>:generateContent
```

The model list accepts both the official `models` array and OpenAI-style `data` arrays. Pages are followed with `pageToken` when provided. The generation script derives the `/v1beta` generateContent route from the configured base URL.

## Generation request

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [{ "text": "A short image prompt" }]
    }
  ],
  "generationConfig": {
    "responseModalities": ["IMAGE"]
  }
}
```

When supplied, `--aspect-ratio` and `--image-size` add this object under `generationConfig`:

```json
{
  "imageConfig": {
    "aspectRatio": "16:9",
    "imageSize": "1K"
  }
}
```

The API key is sent using the `x-goog-api-key` header. It is never placed in the URL.

## Generation response

The script searches `candidates[].content.parts[]` for the first object shaped like:

```json
{
  "inlineData": {
    "mimeType": "image/png",
    "data": "<base64 image bytes>"
  }
}
```

The Base64 bytes are decoded and written exactly to `--out`. A non-2xx response, invalid JSON, missing candidates, missing image data, unsupported MIME type, or invalid Base64 is an explicit error.

## Setup

`scripts/setup.ts` asks for the base URL and key, normalizes the base URL, calls `/v1/models`, prints supported generation models, and writes:

```env
GEMINI_BASE_URL=<normalized URL>
GEMINI_API_KEY=<key>
GEMINI_MODEL=<selected model or gemini-3.1-flash-image>
```

The generated `.env` is local configuration and must not be committed.
