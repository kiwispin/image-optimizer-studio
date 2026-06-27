import { createApp } from "./app.js";

const port = Number(process.env.PORT || 4174);
const host = process.env.HOST || "0.0.0.0";
const app = await createApp();

app.listen(port, host, () => {
  console.log(`Local Tiny Optimizer API listening on http://${host}:${port}`);
});
