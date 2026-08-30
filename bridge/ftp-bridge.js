import express from "express";
import * as ftp from "basic-ftp";
import { Readable, Writable } from "stream";
import { Buffer } from "buffer";

const app = express();
app.use(express.json({ limit: "50mb" }));

const API_KEY = process.env.BRIDGE_API_KEY || "jaws-ftp-bridge-2026";
const FTP_HOST = process.env.FTP_HOST || "giowm1082.siteground.biz";
const FTP_USER = process.env.FTP_USER || "nirmako@tabxle.com";
const FTP_PASS = process.env.FTP_PASS || "";
const FTP_PORT = parseInt(process.env.FTP_PORT || "21");
const FTP_SECURE = process.env.FTP_SECURE !== "false"; // default true

function authMiddleware(req, res, next) {
  // Skip auth for health check
  if (req.path === "/health") return next();
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.use(authMiddleware);

async function getClient() {
  const client = new ftp.Client(30000);
  client.ftp.verbose = false;
  await client.access({
    host: FTP_HOST,
    user: FTP_USER,
    password: FTP_PASS,
    port: FTP_PORT,
    secure: FTP_SECURE,
  });
  return client;
}

// ── Health ──────────────────────────────────────────
app.get("/health", async (req, res) => {
  try {
    const client = await getClient();
    const list = await client.list("/");
    await client.close();
    res.json({
      ok: true,
      host: FTP_HOST,
      protocol: "ftp",
      secure: FTP_SECURE,
      user: FTP_USER,
      rootItems: list.length,
    });
  } catch (err) {
    res.status(200).json({
      ok: false,
      error: err.message || String(err),
      host: FTP_HOST,
      protocol: "ftp",
    });
  }
});

// ── List directory ─────────────────────────────────
app.get("/list", async (req, res) => {
  const dir = req.query.path || "/";
  try {
    const client = await getClient();
    const list = await client.list(dir);
    await client.close();
    res.json({
      ok: true,
      path: dir,
      items: list.map((item) => ({
        name: item.name,
        type: item.type === 1 ? "file" : item.type === 2 ? "directory" : "other",
        size: item.size,
        modifiedDate: item.modifiedAt,
        permissions: item.permissions,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Download file ───────────────────────────────────
app.get("/download", async (req, res) => {
  const remotePath = req.query.path;
  if (!remotePath) return res.status(400).json({ error: "Missing 'path'" });
  try {
    const client = await getClient();
    const chunks = [];
    const writable = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    await client.downloadTo(writable, remotePath);
    await client.close();
    const content = Buffer.concat(chunks);
    res.json({
      ok: true,
      path: remotePath,
      content: content.toString("utf-8"),
      size: content.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Download as binary (base64) ─────────────────────
app.get("/download-binary", async (req, res) => {
  const remotePath = req.query.path;
  if (!remotePath) return res.status(400).json({ error: "Missing 'path'" });
  try {
    const client = await getClient();
    const chunks = [];
    const writable = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    await client.downloadTo(writable, remotePath);
    await client.close();
    const content = Buffer.concat(chunks);
    res.json({
      ok: true,
      path: remotePath,
      contentBase64: content.toString("base64"),
      size: content.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Upload file ─────────────────────────────────────
app.post("/upload", async (req, res) => {
  const { path: remotePath, content, encoding } = req.body;
  if (!remotePath || content === undefined) {
    return res.status(400).json({ error: "Missing 'path' or 'content'" });
  }
  try {
    const client = await getClient();
    const buffer = Buffer.from(content, encoding || "utf-8");
    const stream = Readable.from([buffer]);
    await client.uploadFrom(stream, remotePath);
    await client.close();
    res.json({ ok: true, path: remotePath, size: buffer.length });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Upload binary (base64) ──────────────────────────
app.post("/upload-binary", async (req, res) => {
  const { path: remotePath, contentBase64 } = req.body;
  if (!remotePath || !contentBase64) {
    return res.status(400).json({ error: "Missing 'path' or 'contentBase64'" });
  }
  try {
    const client = await getClient();
    const buffer = Buffer.from(contentBase64, "base64");
    const stream = Readable.from([buffer]);
    await client.uploadFrom(stream, remotePath);
    await client.close();
    res.json({ ok: true, path: remotePath, size: buffer.length });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Delete file ─────────────────────────────────────
app.post("/delete", async (req, res) => {
  const { path: remotePath } = req.body;
  if (!remotePath) return res.status(400).json({ error: "Missing 'path'" });
  try {
    const client = await getClient();
    await client.remove(remotePath);
    await client.close();
    res.json({ ok: true, deleted: remotePath });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Create directory ───────────────────────────────
app.post("/mkdir", async (req, res) => {
  const { path: remotePath } = req.body;
  if (!remotePath) return res.status(400).json({ error: "Missing 'path'" });
  try {
    const client = await getClient();
    await client.ensureDir(remotePath);
    await client.close();
    res.json({ ok: true, created: remotePath });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Rename ──────────────────────────────────────────
app.post("/rename", async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: "Missing 'from' or 'to'" });
  try {
    const client = await getClient();
    await client.rename(from, to);
    await client.close();
    res.json({ ok: true, renamed: { from, to } });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Get file info (stat) ───────────────────────────
app.get("/stat", async (req, res) => {
  const remotePath = req.query.path;
  if (!remotePath) return res.status(400).json({ error: "Missing 'path'" });
  try {
    const client = await getClient();
    const dir = remotePath.includes("/") ? remotePath.substring(0, remotePath.lastIndexOf("/")) || "/" : "/";
    const fileName = remotePath.includes("/") ? remotePath.substring(remotePath.lastIndexOf("/") + 1) : remotePath;
    const list = await client.list(dir);
    await client.close();
    const found = list.find((item) => item.name === fileName);
    if (!found) return res.status(404).json({ error: "Not found", path: remotePath });
    res.json({
      ok: true,
      path: remotePath,
      name: found.name,
      type: found.type === 1 ? "file" : "directory",
      size: found.size,
      modifiedDate: found.modifiedAt,
      permissions: found.permissions,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`FTP Bridge running on port ${PORT}`);
  console.log(`Host: ${FTP_HOST} | User: ${FTP_USER} | Secure: ${FTP_SECURE}`);
});
