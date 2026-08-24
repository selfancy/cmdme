# Images API reference

This skill intentionally uses the dedicated Images API rather than the Responses API.

## Endpoints

The configured base URL is stored as an OpenAI-compatible API prefix without a trailing `/v1`. Request scripts append `/v1` automatically and support these paths:

```text
GET  <base_url>/v1/models
POST <base_url>/v1/images/generations
POST <base_url>/v1/images/edits
```

`scripts/setup.ts` prints the `id` values from the provider's `data` array, lets the user select by number or ID, and writes the selected model to `.env`. A blank selection keeps the default `gpt-image-2`. The generation script's `--list-models` option remains available for listing models after setup.

Text-only generation sends JSON. Editing and reference-image generation send `multipart/form-data`.
API requests include `Connection: close` and `Accept-Encoding: identity` headers. When downloading a provider-returned image URL, the API key is not forwarded.

## Generation JSON

```json
{
  "model": "gpt-image-2",
  "prompt": "...",
  "n": 1,
  "size": "auto",
  "quality": "medium",
  "background": "auto",
  "output_format": "png",
  "moderation": "auto"
}
```

Only explicitly supplied optional values are sent. `output_compression` is sent only for JPEG or WebP output. The model is read from `.env` and defaults to `gpt-image-2`.

## Edit multipart fields

The script sends the first input image and any additional references as repeated `image[]` fields:

```text
model=gpt-image-2
prompt=<prompt>
image[]=@edit-target.png
image[]=@style-reference.png
mask=@mask.png
size=1024x1024
quality=high
n=1
```

The first image is the edit target when a mask is present. All input images must be readable files no larger than 50 MB each; a mask must also be no larger than 50 MB.

## Parameter rules

- `n`: integer from `1` through `10`.
- `quality`: `low`, `medium`, `high`, or `auto`.
- `background`: `auto`, `opaque`, or `transparent`.
- `output_format`: `png`, `jpeg`, or `webp`.
- `output_compression`: integer from `0` through `100`, only with `jpeg` or `webp`.
- `moderation`: `auto` or `low`.
- `background=transparent` requires `png` or `webp`.

For `gpt-image-2`, `size` may be `auto` or a `WIDTHxHEIGHT` value satisfying all of these constraints:

- both dimensions are multiples of 16;
- each dimension is at most 3840;
- the long-to-short edge ratio is at most 3:1;
- total pixels are between 655,360 and 8,294,400.

## Response

The script requires a JSON response with a non-empty `data` array. For each item it prefers a valid base64-encoded `b64_json` string. If `b64_json` is absent, it downloads an HTTP(S) `url` without forwarding the API key. URL content is capped at 50 MB. Items containing neither representation, invalid base64, or an unusable URL are rejected explicitly.

## Useful commands

The bundled script is TypeScript and runs with Node's built-in type stripping. Its default HTTP timeout is 600 seconds (10 minutes); pass `--timeout 0` to disable the timeout.

```bash
node --experimental-strip-types scripts/generate_image.ts --help
```

```bash
node --experimental-strip-types scripts/generate_image.ts \
  --base-url https://provider.example \
  --prompt "A clean product photograph of a ceramic mug" \
  --out output/mug.png
```
