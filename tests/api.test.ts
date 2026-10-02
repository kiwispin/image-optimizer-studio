import { describe, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { createApp } from "../src/server/app.js";

async function sampleJpeg() {
  return sharp({
    create: {
      width: 80,
      height: 60,
      channels: 3,
      background: { r: 210, g: 92, b: 71 }
    }
  })
    .jpeg()
    .toBuffer();
}

describe("local Tinify-compatible API", () => {
  it("reports built-in codecs and optional specialist tool status", async () => {
    const app = await createApp();

    const response = await request(app).get("/api/health").expect(200);

    expect(response.body.codecs).toContain("auto");
    expect(Array.isArray(response.body.specialistTools)).toBe(true);
  });

  it("accepts binary shrink uploads and exposes a downloadable output", async () => {
    const app = await createApp();
    const image = await sampleJpeg();

    const shrink = await request(app)
      .post("/shrink")
      .set("Content-Type", "image/jpeg")
      .send(image)
      .expect(201);

    expect(shrink.body.output.type).toBe("image/jpeg");
    expect(shrink.headers.location).toMatch(/^\/output\//);

    await request(app).get(shrink.headers.location).expect(200).expect("Content-Type", /image\/jpeg/);
  });

  it("accepts batch uploads through the web API", async () => {
    const app = await createApp();
    const image = await sampleJpeg();

    const response = await request(app)
      .post("/api/jobs")
      .field("options", JSON.stringify({ preset: "balanced", formats: ["webp"] }))
      .attach("images", image, "photo.jpg")
      .expect(200);

    expect(response.body.jobs).toHaveLength(1);
    expect(response.body.jobs[0].input.previewUrl).toMatch(/^\/input\//);
    expect(response.body.jobs[0].variants[0].previewUrl).toMatch(/^\/preview\//);
    expect(response.body.jobs[0].variants[0].type).toBe("image/webp");

    await request(app).get(response.body.jobs[0].input.previewUrl).expect(200).expect("Content-Type", /image\/jpeg/);
    await request(app).get(response.body.jobs[0].variants[0].previewUrl).expect(200).expect("Content-Type", /image\/webp/);
  });

  it("reprocesses an existing job with updated options", async () => {
    const app = await createApp();
    const image = await sampleJpeg();

    const created = await request(app)
      .post("/api/jobs")
      .field("options", JSON.stringify({ preset: "balanced", formats: ["webp"] }))
      .attach("images", image, "photo.jpg")
      .expect(200);

    const reprocessed = await request(app)
      .post(`/api/jobs/${created.body.jobs[0].id}/reprocess`)
      .send({ options: { preset: "fidelity", formats: ["png"], enhance: { denoise: 1, sharpen: 3 } } })
      .expect(200);

    expect(reprocessed.body.id).not.toBe(created.body.jobs[0].id);
    expect(reprocessed.body.variants[0].type).toBe("image/png");
    expect(reprocessed.body.variants[0].previewUrl).toMatch(/^\/preview\//);
  });
});

describe("batch downloads and storage", () => {
  it("zips only the requested outputs", async () => {
    const app = await createApp();
    const image = await sampleJpeg();

    const first = await request(app)
      .post("/api/jobs")
      .field("options", JSON.stringify({ preset: "balanced", formats: ["webp"] }))
      .attach("images", image, "first.jpg")
      .expect(200);
    await request(app)
      .post("/api/jobs")
      .field("options", JSON.stringify({ preset: "balanced", formats: ["webp"] }))
      .attach("images", image, "second.jpg")
      .expect(200);

    expect(first.body.zipUrl).toContain(first.body.jobs[0].variants[0].id);
    const zip = await request(app)
      .get(first.body.zipUrl)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const listing = (zip.body as Buffer).toString("latin1");
    expect(listing).toContain("first-webp.webp");
    expect(listing).not.toContain("second-webp.webp");
  });

  it("refuses to zip without explicit output ids", async () => {
    const app = await createApp();
    await request(app).get("/api/download.zip").expect(404);
  });

  it("does not keep the upload staging file after processing", async () => {
    const app = await createApp();
    const image = await sampleJpeg();
    const { readdir } = await import("node:fs/promises");
    const { incomingDir } = await import("../src/server/store.js");

    await request(app)
      .post("/api/jobs")
      .field("options", JSON.stringify({ preset: "balanced", formats: ["jpeg"] }))
      .attach("images", image, "staged.jpg")
      .expect(200);

    expect(await readdir(incomingDir)).toHaveLength(0);
  });
});

describe("file serving safety", () => {
  it("never serves a non-image upload inline", async () => {
    const app = await createApp();
    const xhtml = Buffer.from('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>');
    const created = await request(app)
      .post("/api/jobs")
      .field("options", JSON.stringify({ preset: "balanced", formats: ["webp"] }))
      .attach("images", xhtml, "evil.xhtml")
      .expect(200);

    const preview = await request(app).get(created.body.jobs[0].input.previewUrl).expect(200);
    expect(preview.headers["content-disposition"]).toMatch(/^attachment/);
    expect(preview.headers["x-content-type-options"]).toBe("nosniff");
  });
});
