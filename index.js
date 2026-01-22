import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_, res) => res.status(200).send("ok"));

app.post("/tv", async (req, res) => {
  try {
    const body = req.body || {};

    const secret = process.env.TV_SECRET;
    if (!secret || body.key !== secret) {
      return res.status(401).json({ ok: false, error: "bad key" });
    }

    const url = process.env.APPS_SCRIPT_URL;
    if (!url) return res.status(500).json({ ok: false, error: "missing APPS_SCRIPT_URL" });

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const text = await r.text();
    return res.status(200).json({ ok: true, forwarded_status: r.status, forwarded_body: text });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
