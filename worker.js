// Botanical Research Database — Cloudflare Worker + D1
// Excel files are parsed in the admin's browser; the Worker only receives
// validated JSON rows in small chunks (keeps CPU/memory low and removes the
// need to run a spreadsheet parser on untrusted input server-side).

const ENC = new TextEncoder();
const COOKIE = "__Host-botany_session";
const SESSION_TTL = { member: 12 * 3600, admin: 4 * 3600 }; // seconds
const LOGIN_WINDOW = 15 * 60;
const LOGIN_MAX_FAILS = 8;
const LIMITS = {
  maxRows: 50000, maxCols: 200, maxHeader: 200, maxCell: 5000,
  maxChunkRows: 250, maxBody: 900_000, loginBody: 2_000,
  pageSize: 60, maxPage: 100, maxQuery: 200
};
const API_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer"
};

const now = () => Math.floor(Date.now() / 1000);
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...API_HEADERS, ...headers }
  });
const fail = (error, status) => json({ error }, status);

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function sha256(str) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", ENC.encode(str)));
}
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// Constant-time comparison (compares fixed-length digests, so length is not leaked).
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// Normalise text for indexing/search: Arabic→Persian letters, strip diacritics/tatweel,
// Persian/Arabic digits → ASCII, ZWNJ → space, lowercase.
function normalize(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[​-‏⁠﻿]/g, " ")
    .toLowerCase();
}
function ftsQuery(q) {
  const tokens = normalize(q).match(/[\p{L}\p{N}]+/gu) || [];
  return tokens.slice(0, 8).map((t) => `"${t}"*`).join(" ");
}

async function readJson(request, max) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > max) throw new HttpError("Request body too large.", 413);
  const text = await request.text();
  if (text.length > max) throw new HttpError("Request body too large.", 413);
  try { return JSON.parse(text); } catch { throw new HttpError("Invalid JSON.", 400); }
}
class HttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// ---------- sessions ----------
const cookieHeader = (value, maxAge) =>
  `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

async function getSession(request, env) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,64})`));
  if (!m) return null;
  const id = hex(await sha256(m[1]));
  const row = await env.DB.prepare("SELECT role, expires_at FROM sessions WHERE id = ?1").bind(id).first();
  if (!row || row.expires_at <= now()) return null;
  return { id, role: row.role };
}

async function login(request, env) {
  if (!env.MEMBER_PASSWORD || !env.ADMIN_PASSWORD || env.MEMBER_PASSWORD === env.ADMIN_PASSWORD) {
    return fail("Login is not configured. Set two different secrets: MEMBER_PASSWORD and ADMIN_PASSWORD.", 503);
  }
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const t = now();
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ?1 AND at > ?2").bind(ip, t - LOGIN_WINDOW).first();
  if (n >= LOGIN_MAX_FAILS) {
    return fail("Too many failed attempts. Try again later.", 429);
  }
  const body = await readJson(request, LIMITS.loginBody).catch((e) => { if (e instanceof HttpError) throw e; return {}; });
  const password = String(body?.password ?? "").slice(0, 256);
  // Evaluate both so timing does not reveal which password was closer.
  const isAdmin = await safeEqual(password, env.ADMIN_PASSWORD);
  const isMember = await safeEqual(password, env.MEMBER_PASSWORD);
  const role = isAdmin ? "admin" : isMember ? "member" : null;
  if (!role) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO login_attempts (ip, at) VALUES (?1, ?2)").bind(ip, t),
      env.DB.prepare("DELETE FROM login_attempts WHERE at < ?1").bind(t - LOGIN_WINDOW),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(t)
    ]);
    return fail("Incorrect password.", 401);
  }
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const ttl = SESSION_TTL[role];
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (id, role, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)").bind(hex(await sha256(token)), role, t, t + ttl),
    env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?1").bind(ip)
  ]);
  return json({ ok: true, role }, 200, { "set-cookie": cookieHeader(token, ttl) });
}

// ---------- data ----------
async function activeDataset(env) {
  const ds = await env.DB.prepare("SELECT id, file_name, sheet_name, columns, row_count, activated_at FROM datasets WHERE is_active = 1").first();
  return ds ? { ...ds, columns: JSON.parse(ds.columns) } : null;
}

async function listSpecies(url, env) {
  const ds = await activeDataset(env);
  if (!ds) return json({ columns: [], records: [], total: 0, datasetTotal: 0 });
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit")) || LIMITS.pageSize, 1), LIMITS.maxPage);
  const offset = Math.max(parseInt(url.searchParams.get("offset")) || 0, 0);
  const q = (url.searchParams.get("q") || "").slice(0, LIMITS.maxQuery).trim();
  let rows, total;
  if (!q) {
    rows = (await env.DB.prepare("SELECT id, data FROM records WHERE dataset_id = ?1 ORDER BY row_num LIMIT ?2 OFFSET ?3").bind(ds.id, limit, offset).all()).results;
    total = ds.row_count;
  } else {
    const match = ftsQuery(q);
    if (match) {
      const base = "FROM records_fts f JOIN records r ON r.id = f.rowid WHERE records_fts MATCH ?1 AND r.dataset_id = ?2";
      const [page, count] = await env.DB.batch([
        env.DB.prepare(`SELECT r.id, r.data ${base} ORDER BY f.rank, r.row_num LIMIT ?3 OFFSET ?4`).bind(match, ds.id, limit, offset),
        env.DB.prepare(`SELECT COUNT(*) AS n ${base}`).bind(match, ds.id)
      ]);
      rows = page.results; total = count.results[0].n;
    } else { rows = []; total = 0; }
    if (total === 0) { // fallback: substring match (e.g. text in the middle of a word)
      const like = "%" + normalize(q).trim().replace(/[\\%_]/g, "\\$&") + "%";
      const [page, count] = await env.DB.batch([
        env.DB.prepare("SELECT id, data FROM records WHERE dataset_id = ?1 AND search_text LIKE ?2 ESCAPE '\\' ORDER BY row_num LIMIT ?3 OFFSET ?4").bind(ds.id, like, limit, offset),
        env.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE dataset_id = ?1 AND search_text LIKE ?2 ESCAPE '\\'").bind(ds.id, like)
      ]);
      rows = page.results; total = count.results[0].n;
    }
  }
  return json({
    columns: ds.columns,
    total,
    datasetTotal: ds.row_count,
    records: rows.map((r) => ({ id: r.id, values: JSON.parse(r.data) }))
  });
}

// ---------- import (admin) ----------
function validName(s, max) { return typeof s === "string" && s.length > 0 && s.length <= max; }

async function importStart(request, env) {
  const b = await readJson(request, 100_000);
  const columns = b?.columns;
  if (!Array.isArray(columns) || columns.length < 1 || columns.length > LIMITS.maxCols || !columns.every((c) => validName(c, LIMITS.maxHeader)))
    return fail(`Columns must be 1–${LIMITS.maxCols} non-empty names.`, 400);
  if (new Set(columns).size !== columns.length) return fail("Column names must be unique.", 400);
  const rowCount = b.rowCount;
  if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > LIMITS.maxRows) return fail(`Row count must be 1–${LIMITS.maxRows}.`, 400);
  if (!validName(b.fileName, 255) || !validName(b.sheetName, 255)) return fail("Invalid file or sheet name.", 400);
  const t = now();
  // Drop abandoned staging imports older than a day.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM records_fts WHERE rowid IN (SELECT id FROM records WHERE dataset_id IN (SELECT id FROM datasets WHERE status = 'pending' AND created_at < ?1))").bind(t - 86400),
    env.DB.prepare("DELETE FROM records WHERE dataset_id IN (SELECT id FROM datasets WHERE status = 'pending' AND created_at < ?1)").bind(t - 86400),
    env.DB.prepare("DELETE FROM datasets WHERE status = 'pending' AND created_at < ?1").bind(t - 86400)
  ]);
  const r = await env.DB.prepare("INSERT INTO datasets (file_name, sheet_name, columns, row_count, status, is_active, created_at) VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5)")
    .bind(b.fileName, b.sheetName, JSON.stringify(columns), rowCount, t).run();
  return json({ ok: true, datasetId: r.meta.last_row_id });
}

async function importChunk(request, env) {
  const b = await readJson(request, LIMITS.maxBody);
  const ds = await env.DB.prepare("SELECT id, columns, row_count FROM datasets WHERE id = ?1 AND status = 'pending'").bind(b?.datasetId).first();
  if (!ds) return fail("Unknown or finished import.", 404);
  const ncols = JSON.parse(ds.columns).length;
  const start = b.start;
  const rows = b.rows;
  if (!Number.isInteger(start) || start < 0 || !Array.isArray(rows) || rows.length < 1 || rows.length > LIMITS.maxChunkRows)
    return fail("Invalid chunk.", 400);
  if (start + rows.length > ds.row_count) return fail("Chunk exceeds the declared row count.", 400);
  const payload = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== ncols) return fail("Every row must have exactly one value per column.", 400);
    const cells = row.map((c) => (typeof c === "string" ? c : String(c ?? "")));
    if (cells.some((c) => c.length > LIMITS.maxCell)) return fail(`A cell exceeds ${LIMITS.maxCell} characters.`, 400);
    payload.push({ d: cells, s: normalize(cells.join(" ")) });
  }
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO records (dataset_id, row_num, data, search_text) SELECT ?1, ?2 + CAST(j.key AS INTEGER) + 1, json_extract(j.value, '$.d'), json_extract(j.value, '$.s') FROM json_each(?3) AS j")
        .bind(ds.id, start, JSON.stringify(payload)),
      env.DB.prepare("INSERT INTO records_fts (rowid, search_text) SELECT id, search_text FROM records WHERE dataset_id = ?1 AND row_num BETWEEN ?2 AND ?3")
        .bind(ds.id, start + 1, start + rows.length)
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) return fail("This chunk was already uploaded. Restart the import.", 409);
    throw e;
  }
  return json({ ok: true, received: start + rows.length });
}

async function importFinish(request, env) {
  const b = await readJson(request, 1000);
  const ds = await env.DB.prepare("SELECT id, row_count FROM datasets WHERE id = ?1 AND status = 'pending'").bind(b?.datasetId).first();
  if (!ds) return fail("Unknown or finished import.", 404);
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE dataset_id = ?1").bind(ds.id).first();
  if (n !== ds.row_count) return fail(`Incomplete import: expected ${ds.row_count} rows, received ${n}.`, 400);
  // Atomic swap: the old dataset stays visible until this batch commits.
  await env.DB.batch([
    env.DB.prepare("UPDATE datasets SET is_active = 0, status = 'retired' WHERE is_active = 1"),
    env.DB.prepare("UPDATE datasets SET is_active = 1, status = 'ready', activated_at = ?2 WHERE id = ?1").bind(ds.id, now()),
    env.DB.prepare("DELETE FROM records_fts WHERE rowid IN (SELECT id FROM records WHERE dataset_id IN (SELECT id FROM datasets WHERE status = 'retired'))"),
    env.DB.prepare("DELETE FROM records WHERE dataset_id IN (SELECT id FROM datasets WHERE status = 'retired')"),
    env.DB.prepare("DELETE FROM datasets WHERE status = 'retired'")
  ]);
  return json({ ok: true, count: n });
}

// ---------- router ----------
async function api(request, env, url) {
  if (!env.DB) return fail("D1 binding DB is not configured.", 503);
  const method = request.method, path = url.pathname;

  // CSRF defence in depth (cookie is already SameSite=Strict): state-changing calls must come from our own origin.
  if (method !== "GET" && method !== "HEAD" && request.headers.get("Origin") !== url.origin) return fail("Cross-origin request blocked.", 403);

  if (method === "POST" && path === "/api/login") return login(request, env);

  const session = await getSession(request, env);
  if (!session) return fail("Authentication required", 401);

  if (method === "POST" && path === "/api/logout") {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(session.id).run();
    return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });
  }
  if (method === "GET" && path === "/api/me") return json({ role: session.role });
  if (method === "GET" && path === "/api/species") return listSpecies(url, env);

  if (path.startsWith("/api/import/") || path === "/api/meta") {
    if (session.role !== "admin") return fail("Administrator access required", 403);
    if (method === "GET" && path === "/api/meta") {
      const ds = await activeDataset(env);
      return json({ meta: ds && { fileName: ds.file_name, sheetName: ds.sheet_name, count: ds.row_count, columns: ds.columns, importedAt: new Date(ds.activated_at * 1000).toISOString() } });
    }
    if (method === "POST" && path === "/api/import/start") return importStart(request, env);
    if (method === "POST" && path === "/api/import/chunk") return importChunk(request, env);
    if (method === "POST" && path === "/api/import/finish") return importFinish(request, env);
  }
  return fail("Not found", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.message, e.status);
      console.error("Unhandled error:", e?.stack || e);
      return fail("Internal server error", 500); // no internal details leaked
    }
  }
};
