const $ = (id) => document.getElementById(id);
let activeCode = "";
let pollTimer = null;
let seenItems = new Set();
let previewTextItem = null;

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 3200);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  let data;
  try { data = await response.json(); }
  catch { throw new Error("Respons server tidak dapat dibaca."); }
  if (!response.ok || data.ok === false) throw new Error(data.error || `Kesalahan ${response.status}`);
  return data;
}


let qrScanner = null;
let scannerRunning = false;

function extractPairCode(decodedText) {
  const value = String(decodedText || "").trim();
  if (/^\d{6}$/.test(value)) return value;
  try {
    const parsed = new URL(value, location.href);
    const code = parsed.searchParams.get("code");
    if (code && /^\d{6}$/.test(code)) return code;
  } catch (_) {}
  return null;
}

async function acceptScannedQr(decodedText) {
  const code = extractPairCode(decodedText);
  if (!code) {
    toast("QR tidak berisi kode pairing CrossDrop yang valid.");
    return false;
  }
  $("pairCode").value = code;
  await stopQrScanner();
  toast("QR berhasil dipindai. Kode pairing sudah diisi.");
  return true;
}

async function stopQrScanner() {
  if (qrScanner && scannerRunning) {
    try { await qrScanner.stop(); } catch (_) {}
  }
  if (qrScanner) {
    try { await qrScanner.clear(); } catch (_) {}
  }
  qrScanner = null;
  scannerRunning = false;
  $("scannerPanel").classList.add("hidden");
}

async function startQrScanner() {
  if (typeof Html5Qrcode === "undefined") {
    toast("Pemindai QR belum termuat. Periksa koneksi internet, atau pilih gambar QR.");
    return;
  }
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $("scannerPanel").classList.remove("hidden");
    $("scannerHint").textContent = "Browser memblokir kamera pada alamat HTTP lokal. Buka CrossDrop melalui HTTPS atau localhost, atau gunakan tombol Pilih gambar QR.";
    toast("Kamera memerlukan HTTPS atau localhost pada browser ini.");
    return;
  }
  await stopQrScanner();
  $("scannerPanel").classList.remove("hidden");
  $("scannerHint").textContent = "Izinkan akses kamera, lalu arahkan ke QR Code CrossDrop.";
  try {
    qrScanner = new Html5Qrcode("qrScannerRegion");
    await qrScanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 230, height: 230 }, aspectRatio: 1 },
      async (decodedText) => { await acceptScannedQr(decodedText); },
      () => {}
    );
    scannerRunning = true;
  } catch (err) {
    await stopQrScanner();
    toast("Kamera tidak dapat dibuka. Izinkan akses kamera atau gunakan gambar QR.");
  }
}

async function scanQrImage(file) {
  if (!file) return;
  if (typeof Html5Qrcode === "undefined") {
    toast("Pemindai QR belum termuat. Periksa koneksi internet.");
    return;
  }
  try {
    await stopQrScanner();
    $("scannerPanel").classList.remove("hidden");
    $("scannerHint").textContent = "Membaca gambar QR...";
    qrScanner = new Html5Qrcode("qrScannerRegion");
    const decodedText = await qrScanner.scanFile(file, true);
    await acceptScannedQr(decodedText);
  } catch (_) {
    await stopQrScanner();
    toast("QR tidak terbaca. Pilih gambar yang menampilkan QR dengan jelas.");
  }
}

function deviceName() {
  const typed = $("senderName").value.trim();
  if (typed) return typed;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "iPhone / iPad";
  if (/Android/i.test(ua)) return "Perangkat Android";
  return "Perangkat Windows / Browser";
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
function formatTime(seconds) {
  return new Date(seconds * 1000).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" });
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
  }[ch]));
}
function statusClass(status) {
  if (status === "Disetujui" || status === "Berhasil") return "ok";
  if (status === "Ditolak" || status === "Gagal") return "bad";
  return "pending";
}

async function createSession() {
  try {
    const data = await api("/api/pair", { method: "POST" });
    activeCode = data.code;
    $("receiverCode").textContent = activeCode;
    $("receiverCodeWrap").classList.remove("hidden");
    // Bila QR sedang ditampilkan, buat ulang agar selalu memuat kode terbaru.
    if (!$("qrWrap").classList.contains("hidden")) renderQr();
    $("createSessionBtn").textContent = "Buat kode baru";
    $("pairCode").value = activeCode;
    startPolling();
    toast("Kode pairing berhasil dibuat.");
    await refreshInbox();
  } catch (err) { toast(err.message); }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshInbox, 2500);
}

async function refreshInbox() {
  const code = activeCode || $("pairCode").value.trim();
  if (!code) return;
  try {
    const data = await api(`/api/inbox?code=${encodeURIComponent(code)}`);
    renderInbox(data.items);
    await refreshHistory(code);
  } catch (err) {
    if (activeCode) $("inboxList").innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

function renderInbox(items) {
  const list = $("inboxList");
  if (!items.length) {
    list.className = "empty-state";
    list.textContent = "Belum ada transfer masuk. Biarkan halaman ini terbuka.";
    return;
  }
  list.className = "";
  list.innerHTML = items.map(item => {
    const status = escapeHtml(item.status);
    const detail = item.type === "text"
      ? `<div class="item-meta message-preview">${escapeHtml(item.text)}</div>`
      : `<div class="item-meta">${formatSize(item.size)} · ${escapeHtml(item.mime || "File")}</div>`;
    const actions = item.status === "Menunggu persetujuan"
      ? `<div class="item-actions"><button class="btn btn-primary btn-small" data-action="accept" data-id="${item.id}">Setujui</button><button class="btn btn-quiet btn-small" data-action="reject" data-id="${item.id}">Tolak</button></div>`
      : item.status === "Disetujui"
        ? `<div class="item-actions">${item.type === "text" ? `<button class="btn btn-quiet btn-small" data-action="preview-text" data-id="${item.id}">Pratinjau teks</button>` : (String(item.mime || "").startsWith("image/") || String(item.mime || "").startsWith("video/") || item.mime === "application/pdf" || String(item.mime || "").startsWith("text/")) ? `<button class="btn btn-quiet btn-small" data-action="preview" data-id="${item.id}">Pratinjau</button>` : ""}<button class="btn btn-primary btn-small" data-action="download" data-id="${item.id}" data-type="${item.type}" data-name="${item.type === "text" ? "pesan.txt" : escapeHtml(item.name)}">${item.type === "text" ? "Unduh TXT" : "Unduh file"}</button></div>`
        : "";
    return `<div class="transfer-item">
      <div class="item-main"><div class="item-name">${item.type === "text" ? "✉ " : "▧ "}${escapeHtml(item.name)}</div>
      <div class="item-meta">Dari ${escapeHtml(item.sender)} · ${formatSize(item.size)} · ${formatTime(item.created)}</div>
      ${detail}<span class="status ${statusClass(item.status)}">${status}</span></div>${actions}</div>`;
  }).join("");
}

function openTextPreview(item) {
  previewTextItem = item;
  $("textPreviewTitle").textContent = item.name || "Pratinjau pesan teks";
  $("textPreviewMeta").textContent = `Dari ${item.sender || "Perangkat pengirim"} · ${formatSize(item.size || 0)} · ${formatTime(item.created || Date.now() / 1000)}`;
  $("textPreviewContent").textContent = item.text || "";
  $("textPreviewModal").classList.remove("hidden");
  document.body.classList.add("modal-open");
  $("closeTextPreviewBtn").focus();
}

function closeTextPreview() {
  $("textPreviewModal").classList.add("hidden");
  document.body.classList.remove("modal-open");
  previewTextItem = null;
}

function downloadTextPreview() {
  if (!previewTextItem) return;
  const blob = new Blob([previewTextItem.text || ""], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "pesan.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function decide(itemId, decision) {
  const code = activeCode || $("pairCode").value.trim();
  try {
    await api(`/api/decision/${encodeURIComponent(itemId)}`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ code, decision })
    });
    toast(decision === "accept" ? "Transfer disetujui." : "Transfer ditolak.");
    await refreshInbox();
  } catch (err) { toast(err.message); }
}

function downloadItem(itemId, filename = "file-unduhan") {
  const code = activeCode || $("pairCode").value.trim();
  if (!/^\d{6}$/.test(code)) return toast("Kode pairing tidak valid.");
  const xhr = new XMLHttpRequest();
  const progressWrap = $("uploadProgressWrap");
  progressWrap.classList.remove("hidden");
  $("progressLabel").textContent = "Menyiapkan unduhan...";
  $("progressPercent").textContent = "0%";
  $("progressDetail").textContent = "File sedang diterima dari server. Jangan tutup halaman ini.";
  $("uploadProgress").value = 0;
  xhr.open("GET", `/api/download/${encodeURIComponent(itemId)}?code=${encodeURIComponent(code)}`);
  xhr.responseType = "blob";
  xhr.onprogress = event => {
    if (event.lengthComputable) {
      const percent = Math.round(event.loaded / event.total * 100);
      $("progressLabel").textContent = "Mengunduh file...";
      $("progressPercent").textContent = `${percent}%`;
      $("uploadProgress").value = percent;
      $("progressDetail").textContent = `${formatSize(event.loaded)} dari ${formatSize(event.total)} diterima.`;
    } else {
      $("progressLabel").textContent = "Mengunduh file...";
      $("progressDetail").textContent = `${formatSize(event.loaded)} diterima.`;
    }
  };
  xhr.onload = () => {
    if (xhr.status < 200 || xhr.status >= 300) {
      xhr.response.text().then(text => {
        let message = "Unduhan gagal.";
        try { message = JSON.parse(text).error || message; } catch (_) { if (text) message = text; }
        $("progressLabel").textContent = "Unduhan gagal";
        toast(message);
      });
      return;
    }
    const blobUrl = URL.createObjectURL(xhr.response);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename || "file-unduhan";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    $("progressLabel").textContent = "Unduhan selesai";
    $("progressPercent").textContent = "100%";
    $("uploadProgress").value = 100;
    $("progressDetail").textContent = `${formatSize(xhr.response.size)} siap disimpan oleh browser.`;
    toast("File diterima. Browser akan menyimpan atau meminta lokasi penyimpanan.");
  };
  xhr.onerror = () => {
    $("progressLabel").textContent = "Koneksi unduhan gagal";
    $("progressDetail").textContent = "Periksa koneksi Wi-Fi dan coba lagi.";
    toast("Tidak dapat mengunduh file dari server.");
  };
  xhr.send();
}

async function refreshHistory(code) {
  try {
    const data = await api(`/api/history?code=${encodeURIComponent(code)}`);
    const list = $("historyList");
    if (!data.items.length) {
      list.className = "empty-state";
      list.textContent = "Belum ada transfer yang selesai diproses.";
      return;
    }
    list.className = "";
    list.innerHTML = data.items.map(item => `<div class="history-item">
      <div class="item-main"><div class="item-name">${escapeHtml(item.name)}</div>
      <div class="item-meta">${escapeHtml(item.sender)} · ${formatSize(item.size)} · ${escapeHtml(item.time)}</div>
      <span class="status ${statusClass(item.status)}">${escapeHtml(item.status)}</span></div>
    </div>`).join("");
  } catch (_) {}
}

async function sendText() {
  const code = $("pairCode").value.trim();
  const text = $("messageText").value.trim();
  if (!/^\d{6}$/.test(code)) return toast("Masukkan kode pairing 6 digit.");
  if (!text) return toast("Tulis pesan terlebih dahulu.");
  $("sendTextBtn").disabled = true;
  try {
    await api("/api/send-text", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ code, text, sender: deviceName() })
    });
    $("messageText").value = "";
    toast("Pesan dikirim dan menunggu persetujuan penerima.");
    if (activeCode === code) await refreshInbox();
  } catch (err) { toast(err.message); }
  finally { $("sendTextBtn").disabled = false; }
}

function sendFile() {
  const code = $("pairCode").value.trim();
  const files = Array.from($("fileInput").files || []);
  if (!/^\d{6}$/.test(code)) return toast("Masukkan kode pairing 6 digit.");
  if (!files.length) return toast("Pilih minimal satu file terlebih dahulu.");
  if (files.length > 30) return toast("Maksimal 30 file sekali kirim.");
  if (files.some(file => file.size > 100 * 1024 * 1024)) return toast("Setiap file maksimal 100 MiB.");
  if (files.reduce((sum, file) => sum + file.size, 0) > 500 * 1024 * 1024) return toast("Total file maksimal 500 MiB sekali kirim.");
  const form = new FormData();
  form.append("code", code); form.append("sender", deviceName());
  files.forEach(file => form.append("file", file, file.name));
  const xhr = new XMLHttpRequest();
  $("uploadProgressWrap").classList.remove("hidden"); $("sendFileBtn").disabled = true;
  $("progressLabel").textContent = `Mengirim ${files.length} file...`;
  $("progressDetail").textContent = "Progres ini menunjukkan pengiriman dari perangkat pengirim ke server.";
  $("progressPercent").textContent = "0%"; $("uploadProgress").value = 0;
  xhr.open("POST", "/api/upload");
  xhr.upload.onprogress = event => { if (event.lengthComputable) { const percent = Math.round(event.loaded / event.total * 100); $("progressPercent").textContent = `${percent}%`; $("uploadProgress").value = percent; } };
  xhr.onload = async () => {
    $("sendFileBtn").disabled = false;
    try {
      const data = JSON.parse(xhr.responseText);
      if (xhr.status < 200 || xhr.status >= 300 || !data.ok) throw new Error(data.error || "Upload gagal.");
      $("progressLabel").textContent = `${data.count} file terunggah · menunggu persetujuan`;
      $("progressDetail").textContent = "Upload ke server selesai. Penerima masih perlu menyetujui transfer.";
      $("fileInput").value = ""; $("selectedFiles").textContent = "File dikirim tanpa kompresi atau perubahan kualitas.";
      toast(`${data.count} file berhasil dikirim. Menunggu persetujuan penerima.`);
      if (activeCode === code) await refreshInbox();
    } catch (err) { $("progressLabel").textContent = "Transfer gagal"; toast(err.message || "Transfer gagal."); }
  };
  xhr.onerror = () => { $("sendFileBtn").disabled = false; $("progressLabel").textContent = "Koneksi gagal"; toast("Tidak dapat terhubung ke server."); };
  xhr.send(form);
}

document.querySelectorAll(".tab").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab === button));
    document.querySelectorAll(".tab-panel").forEach(panel => panel.classList.toggle("hidden", panel.id !== button.dataset.tab));
  });
});

$("scanQrBtn").addEventListener("click", startQrScanner);
$("stopScannerBtn").addEventListener("click", stopQrScanner);
$("scanQrImageBtn").addEventListener("click", () => $("qrImageInput").click());
$("qrImageInput").addEventListener("change", async () => {
  const file = $("qrImageInput").files && $("qrImageInput").files[0];
  await scanQrImage(file);
  $("qrImageInput").value = "";
});
$("createSessionBtn").addEventListener("click", createSession);
$("sendTextBtn").addEventListener("click", sendText);
$("sendFileBtn").addEventListener("click", sendFile);
$("refreshBtn").addEventListener("click", refreshInbox);
function renderQr() {
  if (!activeCode) return toast("Buat kode pairing terlebih dahulu.");
  if (typeof QRCode === "undefined") return toast("QR Code perlu koneksi internet untuk memuat pustaka QR.");
  const box = $("qrCode");
  box.innerHTML = "";
  new QRCode(box, { text: `${location.origin}/?code=${encodeURIComponent(activeCode)}`, width: 190, height: 190, correctLevel: QRCode.CorrectLevel.M });
  $("qrWrap").classList.remove("hidden");
  $("showQrBtn").textContent = "Sembunyikan QR Code";
  $("showQrBtn").setAttribute("aria-expanded", "true");
}

$("showQrBtn").addEventListener("click", () => {
  if (!activeCode) return toast("Buat kode pairing terlebih dahulu.");
  const wrap = $("qrWrap");
  if (!wrap.classList.contains("hidden")) {
    wrap.classList.add("hidden");
    $("showQrBtn").textContent = "Tampilkan QR Code";
    $("showQrBtn").setAttribute("aria-expanded", "false");
    return;
  }
  renderQr();
});
$("fileInput").addEventListener("change", () => {
  const files = Array.from($("fileInput").files || []);
  if (!files.length) { $("selectedFiles").textContent = "Pilih beberapa file sekaligus jika diperlukan."; return; }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  $("selectedFiles").textContent = `${files.length} file dipilih · total ${formatSize(total)} · ${files.map(file => file.name).join(", ")}`;
});

$("copyCodeBtn").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(activeCode); toast("Kode berhasil disalin."); }
  catch { toast("Salin kode secara manual."); }
});
$("inboxList").addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "accept" || action === "reject") decide(button.dataset.id, action);
  if (action === "download") downloadItem(button.dataset.id, button.dataset.name || "pesan.txt");
  if (action === "preview-text") {
    const code = activeCode || $("pairCode").value.trim();
    api(`/api/inbox?code=${encodeURIComponent(code)}`).then(data => {
      const item = data.items.find(entry => entry.id === button.dataset.id && entry.type === "text" && entry.status === "Disetujui");
      if (item) openTextPreview(item); else toast("Pesan tidak ditemukan atau belum disetujui.");
    }).catch(err => toast(err.message));
  }
  if (action === "preview") { const code = activeCode || $("pairCode").value.trim(); window.open(`/api/preview/${encodeURIComponent(button.dataset.id)}?code=${encodeURIComponent(code)}`, "_blank", "noopener"); }
});
$("closeTextPreviewBtn").addEventListener("click", closeTextPreview);
$("downloadPreviewTextBtn").addEventListener("click", downloadTextPreview);
$("textPreviewModal").addEventListener("click", event => {
  if (event.target.dataset.closePreview === "true") closeTextPreview();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("textPreviewModal").classList.contains("hidden")) closeTextPreview();
});

$("pairCode").addEventListener("input", () => {
  $("pairCode").value = $("pairCode").value.replace(/\D/g, "").slice(0, 6);
});

const params = new URLSearchParams(location.search);
const scannedCode = params.get("code");
if (scannedCode && /^\d{6}$/.test(scannedCode)) { $("pairCode").value = scannedCode; toast("Kode pairing diisi dari QR Code."); }
