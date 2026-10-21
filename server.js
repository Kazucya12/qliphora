"use strict";

const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const COOKIES_FILE = process.env.COOKIES_FILE || ""; // opsional, untuk YouTube yang minta login
const PROXY = process.env.PROXY || ""; // opsional, mis. http://user:pass@host:port
const TMP_DIR = path.join(os.tmpdir(), "unisave");
fs.mkdirSync(TMP_DIR, { recursive: true });

const app = express();
app.set("trust proxy", true);
app.use(cors({ exposedHeaders: ["Content-Disposition", "Content-Length"] }));
app.use(express.json({ limit: "20kb" }));

// ---------- util ----------
function platformOf(value) {
  let u;
  try { u = new URL(value); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.replace(/^www\./, "").toLowerCase();
  const is = d => h === d || h.endsWith("." + d);
  if (is("youtube.com") || is("youtu.be") || is("youtube-nocookie.com")) return "youtube";
  if (is("tiktok.com")) return "tiktok";
  return null;
}

function baseArgs() {
  const a = ["--no-playlist", "--no-warnings", "--no-progress"];
  if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) a.push("--cookies", COOKIES_FILE);
  if (PROXY) a.push("--proxy", PROXY);
  return a;
}

function run(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", args);
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("Waktu habis saat menghubungi sumber video.")); }, timeoutMs);
    p.stdout.on("data", d => (out += d));
    p.stderr.on("data", d => (err += d));
    p.on("error", e => { clearTimeout(t); reject(e); });
    p.on("close", code => {
      clearTimeout(t);
      code === 0 ? resolve(out) : reject(new Error(cleanError(err)));
    });
  });
}

function cleanError(err) {
  const line = (err.split("\n").filter(l => l.includes("ERROR")).pop() || err).trim();
  if (/sign in to confirm|not a bot/i.test(line)) return "YouTube meminta login/bot check. Pasang cookies atau pakai proxy.";
  if (/private|unavailable|not available/i.test(line)) return "Video privat atau tidak tersedia.";
  return line.replace(/^ERROR:\s*/, "").slice(0, 300) || "Gagal memproses video.";
}

function safeName(s) {
  return String(s || "media").replace(/[\\/:*?"<>|\r\n]+/g, "-").trim().slice(0, 100) || "media";
}

function formatSelector(quality) {
  const q = /^\d{3,4}$/.test(quality) ? Number(quality) : null;
  if (!q) return "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b";
  const h = `[height<=${q}]`;
  return `bv*${h}[ext=mp4]+ba[ext=m4a]/b${h}[ext=mp4]/bv*${h}+ba/b${h}/b`;
}

// ---------- routes ----------
app.get("/", (req, res) => res.json({ ok: true, service: "unisave-backend" }));

// Metadata: judul, uploader, thumbnail, durasi
app.post("/api/info", async (req, res) => {
  const url = req.body?.url;
  if (!platformOf(url)) return res.status(400).json({ error: "URL harus dari TikTok atau YouTube." });
  try {
    const out = await run([...baseArgs(), "--dump-single-json", "--skip-download", "--", url]);
    const j = JSON.parse(out);
    res.json({
      title: j.title,
      uploader: j.uploader || j.channel || "",
      thumbnail: j.thumbnail,
      duration: j.duration ?? null
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Endpoint kompatibel dengan frontend (gaya Cobalt): kembalikan link file
app.post("/", async (req, res) => {
  const { url, videoQuality = "best", downloadMode = "auto" } = req.body || {};
  if (!platformOf(url)) return res.status(400).json({ error: "URL harus dari TikTok atau YouTube." });
  try {
    const title = (await run([...baseArgs(), "--print", "%(title)s", "--skip-download", "--", url])).trim();
    const mode = downloadMode === "audio" ? "mp3" : "mp4";
    const base = `${req.protocol}://${req.get("host")}`;
    const link = `${base}/api/file?mode=${mode}&q=${encodeURIComponent(videoQuality)}&url=${encodeURIComponent(url)}`;
    res.json({ status: "tunnel", url: link, filename: `${safeName(title)}.${mode}` });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Unduh file (disimpan sementara di server, lalu dikirim dan dihapus)
let active = 0;
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE || 3);

app.get("/api/file", async (req, res) => {
  const { url, mode = "mp4", q = "best" } = req.query;
  if (!platformOf(url)) return res.status(400).json({ error: "URL tidak valid." });
  if (active >= MAX_ACTIVE) return res.status(429).json({ error: "Server sibuk, coba lagi sebentar." });

  active++;
  const id = crypto.randomBytes(8).toString("hex");
  const template = path.join(TMP_DIR, `${id}.%(ext)s`);
  const cleanup = () => {
    for (const f of fs.readdirSync(TMP_DIR)) if (f.startsWith(id)) fs.rmSync(path.join(TMP_DIR, f), { force: true });
  };

  try {
    const args = [...baseArgs(), "-o", template];
    if (mode === "mp3") args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    else args.push("-f", formatSelector(String(q)), "--merge-output-format", "mp4");
    args.push("--", url);

    await run(args, 10 * 60 * 1000);

    const file = fs.readdirSync(TMP_DIR).find(f => f.startsWith(id));
    if (!file) throw new Error("File hasil unduhan tidak ditemukan.");
    const full = path.join(TMP_DIR, file);
    const ext = path.extname(file).slice(1) || mode;

    res.setHeader("Content-Type", ext === "mp3" ? "audio/mpeg" : "video/mp4");
    res.setHeader("Content-Length", fs.statSync(full).size);
    res.setHeader("Content-Disposition", `attachment; filename="unisave-${id.slice(0, 6)}.${ext}"`);

    const stream = fs.createReadStream(full);
    stream.pipe(res);
    res.on("close", () => { stream.destroy(); cleanup(); active--; });
  } catch (e) {
    cleanup();
    active--;
    if (!res.headersSent) res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`UniSave backend jalan di port ${PORT}`));
