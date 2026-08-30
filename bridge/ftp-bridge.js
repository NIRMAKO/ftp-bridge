import express from "express";
import * as ftp from "basic-ftp";
import { Readable, Writable } from "stream";
import { Buffer } from "buffer";

const app = express();
app.use(express.json({ limit: "50mb" }));

const API_KEY = "jaws-bridge-nirmako-2026";

// ── Multi-server config ───────────────────────────
const SERVERS = {
  tabxle: {
    name: "tabxle.com",
    host: process.env.FTP_HOST || "giowm1082.siteground.biz",
    user: process.env.FTP_USER || "nirmako@tabxle.com",
    pass: process.env.FTP_PASS || "",
    port: parseInt(process.env.FTP_PORT || "21"),
    secure: process.env.FTP_SECURE !== "false",
    rootPath: "/tabxle.com/public_html/",
  },
  entabx: {
    name: "en.tabx.co.il",
    host: process.env.FTP_ENTABX_HOST || "ftp.s267.upress.link",
    user: process.env.FTP_ENTABX_USER || "nir@en.tabx.co.il",
    pass: process.env.FTP_ENTABX_PASS || "zlNyIoiDp4C3tzUx",
    port: parseInt(process.env.FTP_ENTABX_PORT || "21"),
    secure: process.env.FTP_ENTABX_SECURE !== "false",
    rootPath: "/",
  },
  tabx: {
    name: "tabx.co.il",
    host: process.env.FTP_TABX_HOST || "ftp.s267.upress.link",
    user: process.env.FTP_TABX_USER || "nir@tabx.co.il",
    pass: process.env.FTP_TABX_PASS || "",
    port: parseInt(process.env.FTP_TABX_PORT || "21"),
    secure: process.env.FTP_TABX_SECURE !== "false",
    rootPath: "/",
  },
};

function getServerConfig(serverId) {
  const id = serverId || "tabxle";
  const config = SERVERS[id];
  if (!config) throw new Error(`Unknown server: ${id}`);
  return { id, ...config };
}

function authMiddleware(req, res, next) {
  if (req.path === "/health" || req.path === "/servers") return next();
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.use(authMiddleware);

async function getClient(serverId) {
  const config = getServerConfig(serverId);
  const client = new ftp.Client(30000);
  client.ftp.verbose = false;
  await client.access({
    host: config.host,
    user: config.user,
    password: config.pass,
    port: config.port,
    secure: config.secure,
  });
  return { client, config };
}

// ── List servers ────────────────────────────────────
app.get("/servers", async (req, res) => {
  const result = {};
  for (const [id, config] of Object.entries(SERVERS)) {
    result[id] = {
      name: config.name,
      host: config.host,
      user: config.user,
      rootPath: config.rootPath,
      hasPass: !!config.pass,
    };
  }
  res.json({ ok: true, servers: result });
});

// ── Health (default server or specified) ───────────
app.get("/health", async (req, res) => {
  const serverId = req.query.server;
  const results = {};
  
  if (serverId) {
    // Check specific server
    try {
      const { client, config } = await getClient(serverId);
      const list = await client.list(config.rootPath);
      await client.close();
      results[serverId] = {
        ok: true,
        host: config.host,
        name: config.name,
        rootItems: list.length,
      };
    } catch (err) {
      results[serverId] = { ok: false, error: err.message, name: SERVERS[serverId]?.name };
    }
  } else {
    // Check all servers
    for (const [id, config] of Object.entries(SERVERS)) {
      if (!config.pass && id !== "tabxle") {
        results[id] = { ok: false, error: "No password configured", name: config.name };
        continue;
      }
      try {
        const { client } = await getClient(id);
        const list = await client.list(config.rootPath);
        await client.close();
        results[id] = {
          ok: true,
          host: config.host,
          name: config.name,
          rootItems: list.length,
        };
      } catch (err) {
        results[id] = { ok: false, error: err.message, name: config.name };
      }
    }
  }
  res.json({ ok: true, servers: results });
});

// ── List directory ─────────────────────────────────
app.get("/list", async (req, res) => {
  const serverId = req.query.server || "tabxle";
  const dir = req.query.path || getServerConfig(serverId).rootPath;
  try {
    const { client } = await getClient(serverId);
    const list = await client.list(dir);
    await client.close();
    res.json({
      ok: true,
      server: serverId,
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
  const serverId = req.query.server || "tabxle";
  const remotePath = req.query.path;
  if (!remotePath) return res.status(400).json({ error: "Missing 'path'" });
  try {
    const { client } = await getClient(serverId);
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
      server: serverId,
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
  const serverId = req.query.server || "tabxle";
  const remotePath = req.query.path;
  if (!remotePath) return res.status(400).json({ error: "Missing 'path'" });
  try {
    const { client } = await getClient(serverId);
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
      server: serverId,
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
  const serverId = req.body.server || "tabxle";
  const { path: remotePath, content, encoding } = req.body;
  if (!remotePath || content === undefined) {
    return res.status(400).json({ error: "Missing 'path' or 'content'" });
  }
  try {
    const { client } = await getClient(serverId);
    const buffer = Buffer.from(content, encoding || "utf-8");
    const stream = Readable.from([buffer]);
    await client.uploadFrom(stream, remotePath);
    await client.close();
    res.json({ ok: true, server: serverId, path: remotePath, size: buffer.length });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Upload binary (base64) ──────────────────────────
app.post("/upload-binary", async (req, res) => {
  const serverId = req.body.server || "tabxle";
  const { path: remotePath, contentBase64 } = req.body;
  if (!remotePath || !contentBase64) {
    return res.status(400).json({ error: "Missing 'path' or 'contentBase64'" });
  }
  try {
    const { client } = await getClient(serverId);
    const buffer = Buffer.from(contentBase64, "base64");
    const stream = Readable.from([buffer]);
    await client.uploadFrom(stream, remotePath);
    await client.close();
    res.json({ ok: true, server: serverId, path: remotePath, size: buffer.length });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Delete file ─────────────────────────────────────
app.post("/delete", async (req, res) => {
  const serverId = req.body.server || "tabxle";
  const { path: remotePath } = req.body;
  if (!remotePath) return res.status(400).json({ error: "Missing 'path'" });
  try {
    const { client } = await getClient(serverId);
    await client.remove(remotePath);
    await client.close();
    res.json({ ok: true, server: serverId, deleted: remotePath });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Create directory ───────────────────────────────
app.post("/mkdir", async (req, res) => {
  const serverId = req.body.server || "tabxle";
  const { path: remotePath } = req.body;
  if (!remotePath) return res.status(400).json({ error: "Missing 'path'" });
  try {
    const { client } = await getClient(serverId);
    await client.ensureDir(remotePath);
    await client.close();
    res.json({ ok: true, server: serverId, created: remotePath });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Rename ──────────────────────────────────────────
app.post("/rename", async (req, res) => {
  const serverId = req.body.server || "tabxle";
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: "Missing 'from' or 'to'" });
  try {
    const { client } = await getClient(serverId);
    await client.rename(from, to);
    await client.close();
    res.json({ ok: true, server: serverId, renamed: { from, to } });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Get file info (stat) ───────────────────────────
app.get("/stat", async (req, res) => {
  const serverId = req.query.server || "tabxle";
  const remotePath = req.query.path;
  if (!remotePath) return res.status(400).json({ error: "Missing 'path'" });
  try {
    const { client } = await getClient(serverId);
    const dir = remotePath.includes("/") ? remotePath.substring(0, remotePath.lastIndexOf("/")) || "/" : "/";
    const fileName = remotePath.includes("/") ? remotePath.substring(remotePath.lastIndexOf("/") + 1) : remotePath;
    const list = await client.list(dir);
    await client.close();
    const found = list.find((item) => item.name === fileName);
    if (!found) return res.status(404).json({ error: "Not found", path: remotePath });
    res.json({
      ok: true,
      server: serverId,
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

// ── Transfer file between servers ──────────────────
app.post("/transfer", async (req, res) => {
  const { fromServer, fromPath, toServer, toPath } = req.body;
  if (!fromServer || !fromPath || !toServer || !toPath) {
    return res.status(400).json({ error: "Missing fromServer, fromPath, toServer, or toPath" });
  }
  try {
    // Download from source
    const { client: srcClient } = await getClient(fromServer);
    const chunks = [];
    const writable = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    await srcClient.downloadTo(writable, fromPath);
    await srcClient.close();
    const content = Buffer.concat(chunks);
    
    // Upload to destination
    const { client: dstClient } = await getClient(toServer);
    const stream = Readable.from([content]);
    await dstClient.uploadFrom(stream, toPath);
    await dstClient.close();
    
    res.json({
      ok: true,
      transferred: true,
      from: { server: fromServer, path: fromPath },
      to: { server: toServer, path: toPath },
      size: content.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false, transfer: false });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`FTP Bridge running on port ${PORT}`);
  console.log(`Servers: ${Object.keys(SERVERS).join(", ")}`);
});
