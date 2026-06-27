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
