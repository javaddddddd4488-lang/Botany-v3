const $ = (s) => document.querySelector(s);
const loginView = $("#loginView"), appView = $("#appView");
const MAX_FILE_BYTES = 15 * 1024 * 1024, MAX_ROWS = 50000, MAX_COLS = 200, MAX_CELL = 5000;
let records = [], columns = [], total = 0, datasetTotal = 0, role = null, toastTimer = null, searchTimer = null, requestSeq = 0;
let workbook = null;

function showToast(message) {
  const el = $("#toast"); el.textContent = message; el.classList.add("show"); Sfx.play("toast");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/login" && path !== "/api/me") { showLogin(); showToast("Session expired. Please sign in again."); }
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}
const postJson = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function showApp(nextRole) {
  role = nextRole;
  loginView.hidden = true; appView.hidden = false;
  $("#roleBadge").textContent = role === "admin" ? "ADMIN" : "MEMBER";
  $("#adminPanel").hidden = role !== "admin";
  loadRecords();
  if (role === "admin") loadMeta();
}
function showLogin() {
  role = null; records = []; workbook = null; appView.hidden = true; loginView.hidden = false;
  $("#password").value = ""; $("#loginError").textContent = "";
  $("#searchInput").value = ""; $("#resultsGrid").replaceChildren();
}
$("#togglePassword").addEventListener("click", () => {
  const input = $("#password"), show = input.type === "password";
  input.type = show ? "text" : "password"; $("#togglePassword").textContent = show ? "Hide" : "Show";
  $("#togglePassword").setAttribute("aria-label", show ? "Hide password" : "Show password");
});
$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true; $("#loginError").textContent = "";
  try {
    const data = await postJson("/api/login", { password: $("#password").value });
    showApp(data.role);
    Sfx.play("login");
  } catch (error) {
    $("#loginError").textContent = error.message; Sfx.play("error");
    const row = $(".password-row"); row.classList.remove("shake"); void row.offsetWidth; row.classList.add("shake");
  }
  finally { button.disabled = false; }
});
$("#logoutButton").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  Sfx.play("logout"); showLogin();
});
const backToList = () => { if (!$("#detailView").hidden) Sfx.play("back"); $(".page-wrap").classList.remove("is-detail"); $("#detailView").hidden = true; $("#resultsSection").hidden = false; };
$("#homeLink").addEventListener("click", (e) => { e.preventDefault(); backToList(); });
$("#backButton").addEventListener("click", backToList);
$("#clearSearch").addEventListener("click", () => { $("#searchInput").value = ""; loadRecords(); $("#searchInput").focus(); });
$("#searchInput").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadRecords(), 250); });
$("#loadMore").addEventListener("click", () => { Sfx.play("tap"); loadRecords({ append: true }); });

function val(record, key) { return record?.fields?.[key] == null || String(record.fields[key]).trim() === "" ? "No data" : String(record.fields[key]); }
function findKey(record, patterns) {
  const keys = Object.keys(record?.fields || {});
  return keys.find(k => patterns.some(p => p.test(k)));
}
function titleFor(record) {
  const key = findKey(record, [/scientific.*name/i, /latin.*name/i, /species.*name/i, /binomial/i, /taxon/i, /^name$/i, /نام علمی/]);
  return key ? val(record, key) : (Object.values(record.fields || {}).find(v => String(v).trim()) || "Untitled record");
}
function latinFor(record) {
  const key = findKey(record, [/scientific.*name/i, /latin.*name/i, /binomial/i, /species.*name/i, /نام علمی/]);
  return key ? val(record, key) : "";
}
function subtitleFor(record) {
  const key = findKey(record, [/family/i, /خانواده/]) || findKey(record, [/locality/i, /location/i, /province/i, /habitat/i, /پراکنش|مکان|استان/]);
  return key ? `${key}: ${val(record, key)}` : `${Object.keys(record.fields || {}).length} recorded fields`;
}
function auto(el) { el.dir = "auto"; return el; }

let shownCount = 0;
function countTo(el, to) {
  const from = shownCount; shownCount = to;
  if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = to.toLocaleString(); return; }
  const start = performance.now(), dur = 900;
  const step = (t) => { const k = Math.min((t - start) / dur, 1), e = 1 - Math.pow(1 - k, 3); el.textContent = Math.round(from + (to - from) * e).toLocaleString(); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function toRecords(data) {
  return data.records.map(r => {
    const fields = Object.create(null); // column names come from user data: avoid prototype keys
    data.columns.forEach((c, i) => { fields[c] = r.values[i] ?? ""; });
    return { id: r.id, fields };
  });
}
function renderRecords(fromIndex = 0) {
  const query = $("#searchInput").value.trim();
  countTo($("#recordCount"), datasetTotal);
  $("#resultSummary").textContent = query ? `${total.toLocaleString()} matching record${total === 1 ? "" : "s"}` : "All records";
  const grid = $("#resultsGrid");
  if (fromIndex === 0) grid.replaceChildren();
  records.slice(fromIndex).forEach((record, i) => {
    const index = fromIndex + i;
    const card = document.createElement("button"); card.type = "button"; card.className = "species-card"; card.style.animationDelay = `${Math.min(i, 8) * 35}ms`;
    const kicker = document.createElement("div"); kicker.className = "card-kicker"; kicker.textContent = `No. ${String(index + 1).padStart(3, "0")}`;
    const title = titleFor(record), lat = latinFor(record);
    const h = auto(document.createElement("h3")); h.textContent = title; if (lat && lat === title) h.className = "is-latin";
    const bottom = document.createElement("div"); bottom.className = "card-bottom";
    const sub = auto(document.createElement("span")); sub.textContent = subtitleFor(record);
    const arrow = document.createElement("span"); arrow.className = "arrow"; arrow.setAttribute("aria-hidden", "true");
    bottom.append(sub, arrow); card.append(kicker, h, bottom); card.addEventListener("click", () => openRecord(record)); card.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") Sfx.play("hover"); }); grid.append(card);
  });
  $("#emptyState").hidden = records.length !== 0;
  grid.hidden = records.length === 0;
  $("#loadMore").hidden = records.length >= total;
}
function openRecord(record) {
  Sfx.play("open");
  $(".page-wrap").classList.add("is-detail");
  $("#resultsSection").hidden = true; $("#detailView").hidden = false;
  const card = $("#detailCard"); card.replaceChildren();
  const head = document.createElement("header"); head.className = "detail-head";
    const title = titleFor(record), lat = latinFor(record);
  const h = auto(document.createElement("h1")); h.textContent = title; if (lat && lat === title) h.className = "is-latin";
  head.append(h); card.append(head);
  const dl = document.createElement("dl"); dl.className = "detail-fields";
  Object.entries(record.fields || {}).forEach(([key, value]) => {
    const wrapper = document.createElement("div"); wrapper.className = "detail-field";
    const dt = auto(document.createElement("dt")); dt.textContent = key;
    const dd = auto(document.createElement("dd")); const clean = value == null || String(value).trim() === "" ? "No data" : String(value); dd.textContent = clean;
    if (clean === "No data") dd.className = "no-data";
    wrapper.append(dt, dd); dl.append(wrapper);
  });
  card.append(dl); window.scrollTo({ top: 0, behavior: "smooth" });
}
async function loadRecords({ append = false } = {}) {
  const seq = ++requestSeq; // ignore out-of-order responses while typing
  const params = new URLSearchParams({ q: $("#searchInput").value.trim(), offset: append ? records.length : 0 });
  try {
    const data = await api(`/api/species?${params}`);
    if (seq !== requestSeq) return;
    const from = append ? records.length : 0;
    records = append ? records.concat(toRecords(data)) : toRecords(data);
    columns = data.columns; total = data.total; datasetTotal = data.datasetTotal;
    renderRecords(from); if (!append && $("#searchInput").value.trim()) Sfx.play("results");
  } catch (error) {
    if (seq !== requestSeq) return;
    showToast(error.message); records = []; total = 0; renderRecords();
  }
}
async function loadMeta() {
  try {
    const data = await api("/api/meta"), meta = data.meta;
    $("#metaLine").textContent = meta ? `Last import: ${meta.fileName} · ${meta.count} records · ${new Date(meta.importedAt).toLocaleString()}` : "No workbook has been imported yet.";
  } catch {}
}

// ---------- Excel import (parsed in the browser, uploaded as JSON chunks) ----------
let xlsxPromise = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve();
  xlsxPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script"); s.src = "/vendor/xlsx.full.min.js";
    s.onload = resolve; s.onerror = () => { xlsxPromise = null; reject(new Error("Could not load the Excel reader.")); };
    document.head.append(s);
  });
  return xlsxPromise;
}
function setStatus(text, isError = false) { const s = $("#importStatus"); s.className = "status-message" + (isError ? " error" : ""); s.textContent = text; }

$("#excelFile").addEventListener("change", async () => {
  const file = $("#excelFile").files[0], select = $("#sheetSelect");
  workbook = null; select.hidden = true; select.replaceChildren();
  $("#fileLabel").textContent = file?.name || "Choose Excel workbook";
  if (!file) return;
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error("File is larger than 15 MB.");
    setStatus("Reading workbook…");
    await loadXlsx();
    workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    workbook.SheetNames.forEach(n => { const o = document.createElement("option"); o.value = n; o.textContent = n; select.append(o); });
    select.hidden = workbook.SheetNames.length < 2;
    setStatus(`Ready: ${workbook.SheetNames.length} worksheet${workbook.SheetNames.length === 1 ? "" : "s"} found.`);
  } catch (error) { workbook = null; setStatus(error.message || "Could not read this file.", true); }
});

function sheetToTable(sheetName) {
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false, blankrows: false });
  if (rows.length < 2) throw new Error("The worksheet needs a header row and at least one data row.");
  const seen = new Map();
  const headers = rows[0].slice(0, MAX_COLS).map((h, i) => {
    const base = String(h ?? "").trim().slice(0, 200) || `Column ${i + 1}`;
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    return n > 1 ? `${base} (${n})` : base;
  });
  if (rows[0].length > MAX_COLS) throw new Error(`Too many columns (max ${MAX_COLS}).`);
  const data = rows.slice(1)
    .map(r => headers.map((_, i) => String(r[i] ?? "").slice(0, MAX_CELL)))
    .filter(r => r.some(v => v.trim() !== ""));
  if (!data.length) throw new Error("No data rows found.");
  if (data.length > MAX_ROWS) throw new Error(`Too many rows (max ${MAX_ROWS.toLocaleString()}).`);
  return { headers, data };
}

$("#importForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = $("#excelFile").files[0]; if (!file || !workbook) return setStatus("Choose a readable Excel file first.", true);
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const sheetName = $("#sheetSelect").value || workbook.SheetNames[0];
    const { headers, data } = sheetToTable(sheetName);
    if (!confirm(`Replace the current catalogue with ${data.length.toLocaleString()} records from “${sheetName}”?`)) { setStatus("Import cancelled."); return; }
    const { datasetId } = await postJson("/api/import/start", { fileName: file.name, sheetName, columns: headers, rowCount: data.length });
    let i = 0;
    while (i < data.length) {
      let end = i, size = 0;
      while (end < data.length && end - i < 250 && size < 400_000) { size += data[end].reduce((a, v) => a + v.length + 3, 0); end++; }
      await postJson("/api/import/chunk", { datasetId, start: i, rows: data.slice(i, end) });
      i = end; Sfx.play("tick"); setStatus(`Uploading… ${i.toLocaleString()} / ${data.length.toLocaleString()}`);
    }
    await postJson("/api/import/finish", { datasetId });
    setStatus(`Import complete: ${data.length.toLocaleString()} records saved from “${sheetName}”.`);
    $("#searchInput").value = ""; await loadRecords(); await loadMeta(); showToast("Research data imported successfully."); Sfx.play("done");
  } catch (error) { setStatus(error.message, true); Sfx.play("error"); }
  finally { button.disabled = false; }
});

(async function init() {
  try { const data = await api("/api/me"); showApp(data.role); }
  catch { showLogin(); }
})();
