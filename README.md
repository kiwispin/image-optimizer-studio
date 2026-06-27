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

## Notes

TinyPNG's exact encoder and smart crop model are proprietary. This app mirrors the local user-facing workflow and API shape while using local open-source codecs through Sharp/libvips.
