# Image Optimizer Studio

A free local and self-hostable TinyPNG-style image optimizer. In local mode it runs a browser UI against a local Node API, so files stay on your machine unless you explicitly use URL import through the Tinify-compatible `/shrink` endpoint.

## Features

- Batch drag/drop compression with no artificial 20-file or 5 MB limit.
- Auto output mode races AVIF, WebP, JPEG, and PNG where safe, then picks the smallest quality-passing result.
- Outputs optimized originals plus AVIF, WebP, JPEG, and PNG variants.
- Recognizes JPEG XL as a target and reports when the local codec build cannot write it.
- Resize modes for fit, cover, smart thumbnail, and scale.
- Photoshop-style resize quality options from nearest neighbor through bicubic sharper.
- Optional noise reduction and sharpening controls before compression.
- Metadata stripping by default with an opt-in preservation mode.
- Local Tinify-like API:
  - `POST /shrink`
  - `GET /output/:id`
  - `POST /output/:id`
- Per-file savings, dimensions, output type, download links, and lightweight PSNR/size metrics.
- Best-in-class `ultra` mode races multiple encoder candidates per format and chooses the smallest output that clears a perceptual SSIM threshold.
- Content-aware encoder tuning for photos, screenshots, flat graphics, transparency-heavy images, and animations.
- Presets are shown as `Compact`, `Balanced`, `Optimal`, and `Pristine`, ordered from smallest files to closest visual match.
- Optional specialist hooks activate automatically when command-line tools such as `oxipng`, `cjxl`, `butteraugli`, or `ssimulacra2` are installed and available on `PATH`.

## Run

For normal local use on Windows, double-click:

```text
Start Image Optimizer Studio.cmd
```

It opens the app at `http://127.0.0.1:4174`. If the local server is already running, it just opens the browser. If it is not running, it installs dependencies when `package-lock.json` has changed, rebuilds when the source is newer than the last build (so `git pull` updates take effect), and starts the local production server listening on this computer only.

Running locally is the recommended way to use the app: it uses your computer's full CPU and memory, so large photos and big batches are not limited by a hosting plan.

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

For a production-style local run:

```powershell
npm run build
npm start
```

Open `http://127.0.0.1:4174`.

## Test

```powershell
npm test
```

## Benchmark

```powershell
npm run benchmark
```

The benchmark command generates a repeatable local corpus and writes `.local-tinypng/benchmark-report.json` with size savings and PSNR-style metrics. If you add `benchmarks/tinypng-baseline.json`, the report records that baseline alongside the local run.

## Deploy

This app needs a Node host because the optimizer API uses Express, Sharp/libvips, local file handling, and ZIP generation. GitHub Pages can host static files only, so it cannot run the compressor by itself.

The repo includes:

- `render.yaml` for Render Blueprint deployment.
- `Dockerfile` for Docker-capable hosts such as Fly.io, Railway, Render Docker, or a VPS.

For a generic Node host:

```powershell
npm ci
npm run build
npm start
```

Set `PORT` to the host-provided port. The server binds to `0.0.0.0` by default for live hosting.

### Hosting limits

Image encoding is CPU and memory heavy, and AVIF is by far the hungriest encoder: about 330 MB peak at 8 MP, ~500 MB at 12 MP and ~900 MB at 24 MP. Render's **free** plan (512 MB RAM, a fraction of one CPU) is therefore only suitable for light use. To keep it from being killed mid-job, hosted mode leaves AVIF out of Auto above 8 MP and skips explicit AVIF requests above that size with a note on the result card (WebP/JPEG are used instead). Measured in hosted mode, a 12 MP photo on Auto finishes in ~5 seconds of a modern CPU core with ~360 MB peak. Use a plan with at least 1 GB RAM, or run locally, if you want AVIF for large photos.

When hosted (`PUBLIC_DEPLOYMENT=true` or on Render) the server automatically applies safer defaults, all overridable with environment variables:

| Variable | Hosted default | Local default | Purpose |
| --- | --- | --- | --- |
| `MAX_UPLOAD_MB` | 50 | 1024 | Largest single image accepted |
| `RETENTION_HOURS` | 1 | 24 | Originals and outputs are deleted after this long |
| `PROCESS_CONCURRENCY` | 1 | 1 | Images optimized at the same time (each can use hundreds of MB) |
| `ALLOW_URL_IMPORT` | false | true | Whether `/shrink` may fetch a `source.url` |
| `MAX_MEGAPIXELS` | 40 | no limit | Largest image decoded (guards against decompression bombs) |
| `AVIF_MAX_MEGAPIXELS` | 8 | no limit | Above this output size AVIF is skipped to stay within memory |
| `MALLOC_ARENA_MAX` | 2 (in `render.yaml`/`Dockerfile`) | unset | Reduces memory fragmentation with sharp on Linux |

"Download all" only zips the outputs of the images currently shown in your browser, so one visitor can never download another visitor's files.

## How large images are processed

For still images over about 1 MP, the quality search (several candidate qualities per format) runs on a 1024 px proxy of the prepared image, and only the chosen format and quality are then encoded at full size. The quality gates are measured on 160 px thumbnails, so results match a full-size search while being roughly 10-15x faster and using far less memory. Small images are searched at full size exactly as before.

## Notes

TinyPNG's exact encoder and smart crop model are proprietary. This app mirrors the local user-facing workflow and API shape while using local open-source codecs through Sharp/libvips.
