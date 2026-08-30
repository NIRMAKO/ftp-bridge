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
    protocol: "ftp",
    host: process.env.FTP_HOST || "giowm1082.siteground.biz",
    user: process.env.FTP_USER || "nirmako@tabxle.com",
    pass: process.env.FTP_PASS || "",
    port: parseInt(process.env.FTP_PORT || "21"),
    secure: process.env.FTP_SECURE !== "false",
    rootPath: "/tabxle.com/public_html/",
  },
  entabx: {
    name: "en.tabx.co.il",
    protocol: "wp",
    wpUrl: "https://en.tabx.co.il",
    wpUser: "JAWS2",
    wpPass: process.env.FTP_ENTABX_PASS || "Z^6hjpGQ2KJBJ!!bRmMM8WKQ",
    wpAuthKey: "JAWS_TABX_2026",
    rootPath: "/wp-content/uploads/",
  },
  tabx: {
    name: "tabx.co.il",
    protocol: "wp",
    wpUrl: "https://www.tabx.co.il",
    wpUser: "JAWS2",
    wpPass: process.env.FTP_TABX_PASS || "Z^6hjpGQ2KJBJ!!bRmMM8WKQ",
    wpAuthKey: "JAWS_TABX_2026",
    rootPath: "/wp-content/uploads/",
  },
};

function getServer(serverId) {
  const id = serverId || "tabxle";
  const config = SERVERS[id];
  if (!config) throw new Error(`Unknown server: ${id}`);
  return { id, ...config };
}

function authMiddleware(req, res, next) {
  if (req.path === "/health" || req.path === "/servers") return next();
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}
app.use(authMiddleware);

// ── FTP helpers ────────────────────────────────────
async function getFtpClient(serverId) {
  const config = getServer(serverId);
  if (config.protocol !== "ftp") throw new Error("Not an FTP server");
  const client = new ftp.Client(15000);
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

// ── WordPress REST API helpers ────────────────────
let wpTokens = {}; // cache JWT tokens per server

async function getWpToken(serverId) {
  if (wpTokens[serverId]) return wpTokens[serverId];
  const config = getServer(serverId);
  if (config.protocol !== "wp") throw new Error("Not a WordPress server");
  
  const resp = await fetch(`${config.wpUrl}/wp-json/simple-jwt-login/v1/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: config.wpUser,
      password: config.wpPass,
      AUTH_KEY: config.wpAuthKey,
    }),
  });
  
  const data = await resp.json();
  const token = data?.data?.jwt;
  if (!token) throw new Error(`JWT auth failed for ${config.name}`);
  wpTokens[serverId] = token;
  return token;
}

async function wpRequest(serverId, path, options = {}) {
  const config = getServer(serverId);
  const token = await getWpToken(serverId);
  const url = `${config.wpUrl}/wp-json${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": options.body ? "application/json" : undefined,
      ...options.headers,
    },
  });
  return resp;
}

// ── Health (fast — no connection checks) ───────────
app.get("/health", (req, res) => {
  res.json({ ok: true, servers: Object.keys(SERVERS) });
});

// ── Debug ──────────────────────────────────────────
app.get("/debug", async (req, res) => {
  const serverId = req.query.server || "tabxle";
  const config = getServer(serverId);
  const result = {
    serverId,
    name: config.name,
    protocol: config.protocol,
    hasPass: !!config.pass,
    rootPath: config.rootPath,
  };
  
  if (config.protocol === "ftp") {
    result.host = config.host;
    result.port = config.port;
    result.secure = config.secure;
    try {
      const dns = await import("node:dns").then(m => m.promises);
      const addresses = await dns.resolve4(config.host);
      result.dns = { ok: true, addresses };
    } catch (err) {
      result.dns = { ok: false, error: err.message };
    }
    try {
      const net = await import("node:net");
      const socket = new net.default.Socket();
      socket.setTimeout(10000);
      result.tcp = await new Promise((resolve) => {
        socket.on("connect", () => { socket.destroy(); resolve({ ok: true }); });
        socket.on("timeout", () => { socket.destroy(); resolve({ ok: false, error: "TCP timeout" }); });
        socket.on("error", (err) => { socket.destroy(); resolve({ ok: false, error: err.message }); });
        socket.connect(config.port, config.host);
      });
    } catch (err) {
      result.tcp = { ok: false, error: err.message };
    }
  } else if (config.protocol === "wp") {
    result.wpUrl = config.wpUrl;
    result.wpUser = config.wpUser;
    try {
      const resp = await fetch(`${config.wpUrl}/wp-json/`);
      result.wpReachable = resp.ok;
      if (resp.ok) {
        const data = await resp.json();
        result.wpName = data.name;
        result.wpRoutes = Object.keys(data.routes || {}).length;
      }
    } catch (err) {
      result.wpReachable = false;
      result.error = err.message;
    }
  }
  
  res.json({ ok: true, debug: result });
});

// ── My IP ──────────────────────────────────────────
app.get("/my-ip", async (req, res) => {
  try {
    const resp = await fetch("https://api.ipify.org?format=json");
    const data = await resp.json();
    res.json({ ok: true, ip: data.ip });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── List servers ───────────────────────────────────
app.get("/servers", (req, res) => {
  const result = {};
  for (const [id, config] of Object.entries(SERVERS)) {
    result[id] = {
      name: config.name,
      protocol: config.protocol,
      rootPath: config.rootPath,
      ...(config.host ? { host: config.host } : {}),
      ...(config.wpUrl ? { wpUrl: config.wpUrl } : {}),
    };
  }
  res.json({ ok: true, servers: result });
});

// ── Check server health ─────────────────────────────
app.get("/check", async (req, res) => {
  const serverId = req.query.server;
  const results = {};
  const serversToCheck = serverId ? [serverId] : Object.keys(SERVERS);
  
  for (const id of serversToCheck) {
    const config = SERVERS[id];
    if (!config) { results[id] = { ok: false, error: "Unknown server" }; continue; }
    if (!config.pass && config.protocol === "ftp") {
      results[id] = { ok: false, error: "No password" };
      continue;
    }
    try {
      if (config.protocol === "ftp") {
        const { client } = await getFtpClient(id);
        const list = await client.list(config.rootPath);
        await client.close();
        results[id] = { ok: true, name: config.name, rootItems: list.length };
      } else if (config.protocol === "wp") {
        const token = await getWpToken(id);
        results[id] = { ok: true, name: config.name, auth: "JWT" };
      }
    } catch (err) {
      results[id] = { ok: false, error: err.message, name: config.name };
    }
  }
  res.json({ ok: true, servers: results });
});

// ── List directory ──────────────────────────────────
app.get("/list", async (req, res) => {
  const serverId = req.query.server || "tabxle";
  const dir = req.query.path;
  try {
    const config = getServer(serverId);
    
    if (config.protocol === "ftp") {
      const path = dir || config.rootPath;
      const { client } = await getFtpClient(serverId);
      const list = await client.list(path);
      await client.close();
      res.json({
        ok: true, server: serverId, path,
        items: list.map(i => ({
          name: i.name,
          type: i.type === 1 ? "file" : i.type === 2 ? "directory" : "other",
          size: i.size,
          modifiedDate: i.modifiedAt,
        })),
      });
    } else if (config.protocol === "wp") {
      // WordPress: list media library
      const page = parseInt(req.query.page || "1");
      const perPage = parseInt(req.query.perPage || "50");
      const resp = await wpRequest(serverId, `/wp/v2/media?per_page=${perPage}&page=${page}`);
      
      if (!resp.ok) {
        const text = await resp.text();
        return res.status(resp.status).json({ error: `WP API: ${resp.status}`, detail: text.substring(0, 200), ok: false });
      }
      
      const items = await resp.json();
      const total = resp.headers.get("x-wp-total") || items.length.toString();
      const totalPages = resp.headers.get("x-wp-totalpages") || "1";
      
      res.json({
        ok: true, server: serverId, path: dir || "media-library",
        total: parseInt(total),
        totalPages: parseInt(totalPages),
        page,
        items: items.map(i => ({
          id: i.id,
          name: i.title?.rendered || i.slug,
          type: "file",
          mime: i.mime_type,
          size: i.media_details?.filesize || 0,
          sourceUrl: i.source_url,
          modifiedDate: i.modified,
        })),
      });
    }
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
    const config = getServer(serverId);
    
    if (config.protocol === "ftp") {
      const { client } = await getFtpClient(serverId);
      const chunks = [];
      const writable = new Writable({
        write(chunk, enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
      });
      await client.downloadTo(writable, remotePath);
      await client.close();
      const content = Buffer.concat(chunks);
      res.json({ ok: true, server: serverId, path: remotePath, content: content.toString("utf-8"), size: content.length });
    } else if (config.protocol === "wp") {
      // WordPress: download by media ID
      const mediaId = parseInt(remotePath);
      if (isNaN(mediaId)) return res.status(400).json({ error: "WP download requires media ID as path" });
      
      const resp = await wpRequest(serverId, `/wp/v2/media/${mediaId}`);
      if (!resp.ok) return res.status(resp.status).json({ error: `WP API: ${resp.status}`, ok: false });
      
      const item = await resp.json();
      const fileResp = await fetch(item.source_url);
      const content = await fileResp.text();
      res.json({ ok: true, server: serverId, path: remotePath, content, size: content.length, sourceUrl: item.source_url, title: item.title?.rendered });
    }
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Upload file ─────────────────────────────────────
app.post("/upload", async (req, res) => {
  const serverId = req.body.server || "tabxle";
  const { path: remotePath, content, encoding } = req.body;
  if (!remotePath || content === undefined) return res.status(400).json({ error: "Missing 'path' or 'content'" });
  try {
    const config = getServer(serverId);
    
    if (config.protocol === "ftp") {
      const { client } = await getFtpClient(serverId);
      const buffer = Buffer.from(content, encoding || "utf-8");
      const stream = Readable.from([buffer]);
      await client.uploadFrom(stream, remotePath);
      await client.close();
      res.json({ ok: true, server: serverId, path: remotePath, size: buffer.length });
    } else if (config.protocol === "wp") {
      // WordPress: upload as media
      const filename = remotePath.split("/").pop();
      const buffer = Buffer.from(content, encoding || "utf-8");
      
      const resp = await wpRequest(serverId, "/wp/v2/media", {
        method: "POST",
        headers: {
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Type": "application/octet-stream",
        },
        body: buffer,
      });
      
      if (!resp.ok) {
        const text = await resp.text();
        return res.status(resp.status).json({ error: `WP upload: ${resp.status}`, detail: text.substring(0, 200), ok: false });
      }
      
      const item = await resp.json();
      res.json({ ok: true, server: serverId, path: remotePath, mediaId: item.id, sourceUrl: item.source_url, size: buffer.length });
    }
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Upload binary (base64) ──────────────────────────
app.post("/upload-binary", async (req, res) => {
  const serverId = req.body.server || "tabxle";
  const { path: remotePath, contentBase64 } = req.body;
  if (!remotePath || !contentBase64) return res.status(400).json({ error: "Missing 'path' or 'contentBase64'" });
  try {
    const config = getServer(serverId);
    const filename = remotePath.split("/").pop();
    
    if (config.protocol === "ftp") {
      const { client } = await getFtpClient(serverId);
      const buffer = Buffer.from(contentBase64, "base64");
      const stream = Readable.from([buffer]);
      await client.uploadFrom(stream, remotePath);
      await client.close();
      res.json({ ok: true, server: serverId, path: remotePath, size: buffer.length });
    } else if (config.protocol === "wp") {
      const buffer = Buffer.from(contentBase64, "base64");
      const resp = await wpRequest(serverId, "/wp/v2/media", {
        method: "POST",
        headers: {
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Type": "application/octet-stream",
        },
        body: buffer,
      });
      
      if (!resp.ok) {
        const text = await resp.text();
        return res.status(resp.status).json({ error: `WP upload: ${resp.status}`, detail: text.substring(0, 200), ok: false });
      }
      
      const item = await resp.json();
      res.json({ ok: true, server: serverId, path: remotePath, mediaId: item.id, sourceUrl: item.source_url, size: buffer.length });
    }
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
    const config = getServer(serverId);
    
    if (config.protocol === "ftp") {
      const { client } = await getFtpClient(serverId);
      await client.remove(remotePath);
      await client.close();
      res.json({ ok: true, server: serverId, deleted: remotePath });
    } else if (config.protocol === "wp") {
      const mediaId = parseInt(remotePath);
      if (isNaN(mediaId)) return res.status(400).json({ error: "WP delete requires media ID" });
      
      const resp = await wpRequest(serverId, `/wp/v2/media/${mediaId}?force=true`, { method: "DELETE" });
      if (!resp.ok) {
        const text = await resp.text();
        return res.status(resp.status).json({ error: `WP delete: ${resp.status}`, detail: text.substring(0, 200), ok: false });
      }
      const data = await resp.json();
      res.json({ ok: true, server: serverId, deleted: remotePath, wpDeleted: data.deleted });
    }
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Create directory (FTP only) ────────────────────
app.post("/mkdir", async (req, res) => {
  const serverId = req.body.server || "tabxle";
  const { path: remotePath } = req.body;
  if (!remotePath) return res.status(400).json({ error: "Missing 'path'" });
  try {
    const config = getServer(serverId);
    if (config.protocol !== "ftp") return res.status(400).json({ error: "mkdir not supported for WordPress servers" });
    const { client } = await getFtpClient(serverId);
    await client.ensureDir(remotePath);
    await client.close();
    res.json({ ok: true, server: serverId, created: remotePath });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Rename (FTP only) ───────────────────────────────
app.post("/rename", async (req, res) => {
  const serverId = req.body.server || "tabxle";
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: "Missing 'from' or 'to'" });
  try {
    const config = getServer(serverId);
    if (config.protocol !== "ftp") return res.status(400).json({ error: "rename not supported for WordPress servers" });
    const { client } = await getFtpClient(serverId);
    await client.rename(from, to);
    await client.close();
    res.json({ ok: true, server: serverId, renamed: { from, to } });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false });
  }
});

// ── Stat ────────────────────────────────────────────
app.get("/stat", async (req, res) => {
  const serverId = req.query.server || "tabxle";
  const remotePath = req.query.path;
  if (!remotePath) return res.status(400).json({ error: "Missing 'path'" });
  try {
    const config = getServer(serverId);
    
    if (config.protocol === "ftp") {
      const { client } = await getFtpClient(serverId);
      const dir = remotePath.includes("/") ? remotePath.substring(0, remotePath.lastIndexOf("/")) || "/" : "/";
      const fileName = remotePath.split("/").pop();
      const list = await client.list(dir);
      await client.close();
      const found = list.find(i => i.name === fileName);
      if (!found) return res.status(404).json({ error: "Not found" });
      res.json({ ok: true, server: serverId, path: remotePath, name: found.name, type: found.type === 1 ? "file" : "directory", size: found.size, modifiedDate: found.modifiedAt });
    } else if (config.protocol === "wp") {
      const mediaId = parseInt(remotePath);
      if (isNaN(mediaId)) return res.status(400).json({ error: "WP stat requires media ID" });
      const resp = await wpRequest(serverId, `/wp/v2/media/${mediaId}`);
      if (!resp.ok) return res.status(resp.status).json({ error: `WP API: ${resp.status}`, ok: false });
      const item = await resp.json();
      res.json({ ok: true, server: serverId, path: remotePath, name: item.title?.rendered, type: "file", size: item.media_details?.filesize || 0, mime: item.mime_type, sourceUrl: item.source_url });
    }
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
    const fromConfig = getServer(fromServer);
    let content;
    
    if (fromConfig.protocol === "ftp") {
      const { client } = await getFtpClient(fromServer);
      const chunks = [];
      const writable = new Writable({ write(chunk, enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
      await client.downloadTo(writable, fromPath);
      await client.close();
      content = Buffer.concat(chunks);
    } else if (fromConfig.protocol === "wp") {
      const mediaId = parseInt(fromPath);
      if (isNaN(mediaId)) throw new Error("WP transfer requires media ID as fromPath");
      const resp = await wpRequest(fromServer, `/wp/v2/media/${mediaId}`);
      if (!resp.ok) throw new Error(`WP download failed: ${resp.status}`);
      const item = await resp.json();
      const fileResp = await fetch(item.source_url);
      content = Buffer.from(await fileResp.arrayBuffer());
    }
    
    // Upload to destination
    const toConfig = getServer(toServer);
    const filename = toPath.split("/").pop();
    
    if (toConfig.protocol === "ftp") {
      const { client } = await getFtpClient(toServer);
      const stream = Readable.from([content]);
      await client.uploadFrom(stream, toPath);
      await client.close();
    } else if (toConfig.protocol === "wp") {
      const resp = await wpRequest(toServer, "/wp/v2/media", {
        method: "POST",
        headers: {
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Type": "application/octet-stream",
        },
        body: content,
      });
      if (!resp.ok) throw new Error(`WP upload failed: ${resp.status}`);
    }
    
    res.json({ ok: true, transferred: true, from: { server: fromServer, path: fromPath }, to: { server: toServer, path: toPath }, size: content.length });
  } catch (err) {
    res.status(500).json({ error: err.message, ok: false, transfer: false });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`FTP Bridge v3.0 (FTP + WP) running on port ${PORT}`);
  console.log(`Servers: ${Object.keys(SERVERS).join(", ")}`);
});
