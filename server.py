import json
import mimetypes
import os
import secrets
import socket
import threading
import time
import uuid
from email.parser import BytesParser
from email.policy import default
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

from config import HOST, PORT, STORAGE_DIR, UPLOAD_DIR, HISTORY_FILE, MAX_FILE_SIZE, MAX_REQUEST_SIZE, ALLOWED_EXTENSIONS

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
}

sessions = {}  # code -> {"created": timestamp}
pending = {}   # transfer_id -> transfer object
lock = threading.RLock()


def load_history():
    try:
        data = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


history = load_history()


def save_history():
    temp = HISTORY_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps(history[-500:], ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(HISTORY_FILE)


def add_history(item):
    with lock:
        history.append(item)
        save_history()


def json_bytes(data):
    return json.dumps(data, ensure_ascii=False).encode("utf-8")


def response(client, status, body=b"", content_type="text/plain; charset=utf-8", headers=None):
    reasons = {
        200: "OK", 201: "Created", 400: "Bad Request", 403: "Forbidden",
        404: "Not Found", 405: "Method Not Allowed", 413: "Payload Too Large",
        415: "Unsupported Media Type", 500: "Internal Server Error"
    }
    if isinstance(body, str):
        body = body.encode("utf-8")
    head = [
        f"HTTP/1.1 {status} {reasons.get(status, 'OK')}",
        f"Content-Type: {content_type}",
        f"Content-Length: {len(body)}",
        "Connection: close",
        "X-Content-Type-Options: nosniff",
        "Cache-Control: no-store",
    ]
    if headers:
        head.extend(f"{k}: {v}" for k, v in headers.items())
    client.sendall(("\r\n".join(head) + "\r\n\r\n").encode("ascii") + body)


def send_json(client, status, data):
    response(client, status, json_bytes(data), "application/json; charset=utf-8")


def read_request(client):
    client.settimeout(20)
    buffer = b""
    while b"\r\n\r\n" not in buffer:
        chunk = client.recv(4096)
        if not chunk:
            raise ValueError("Koneksi ditutup sebelum header selesai.")
        buffer += chunk
        if len(buffer) > 65536:
            raise ValueError("Header terlalu besar.")
    header_bytes, body = buffer.split(b"\r\n\r\n", 1)
    lines = header_bytes.decode("iso-8859-1").split("\r\n")
    method, target, _ = lines[0].split(" ", 2)
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            key, value = line.split(":", 1)
            headers[key.strip().lower()] = value.strip()
    length = int(headers.get("content-length", "0") or "0")
    if length > 500 * 1024 * 1024 + 4 * 1024 * 1024:
        raise OverflowError("Ukuran permintaan melebihi batas.")
    while len(body) < length:
        chunk = client.recv(min(65536, length - len(body)))
        if not chunk:
            raise ValueError("Body permintaan tidak lengkap.")
        body += chunk
    return method.upper(), target, headers, body[:length]


def safe_filename(name):
    name = Path(unquote(name or "file")).name
    name = "".join(ch for ch in name if ch.isalnum() or ch in " ._-()")
    name = name.strip(" .")
    return (name or "file")[:150]


def require_code(code):
    code = (code or "").strip().upper()
    with lock:
        if code not in sessions:
            return None
        # Kode sesi berlaku 12 jam
        if time.time() - sessions[code]["created"] > 12 * 60 * 60:
            sessions.pop(code, None)
            return None
        return code


def parse_multipart(content_type, body):
    # Parser standar library untuk multipart/form-data dari browser.
    message = BytesParser(policy=default).parsebytes(
        b"Content-Type: " + content_type.encode("ascii", "replace") + b"\r\n"
        b"MIME-Version: 1.0\r\n\r\n" + body
    )
    fields = {}
    uploaded = []
    if not message.is_multipart():
        raise ValueError("Format upload tidak valid.")
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        filename = part.get_filename()
        payload = part.get_payload(decode=True) or b""
        if filename is not None:
            uploaded.append((safe_filename(filename), payload, part.get_content_type()))
        elif name:
            charset = part.get_content_charset() or "utf-8"
            fields[name] = payload.decode(charset, "replace")
    return fields, uploaded


def route(client, method, target, headers, body):
    parsed = urlparse(target)
    path = parsed.path
    query = parse_qs(parsed.query)

    if method == "GET" and path == "/":
        html = (Path(__file__).parent / "templates" / "index.html").read_bytes()
        return response(client, 200, html, "text/html; charset=utf-8")

    if method == "GET" and path.startswith("/static/"):
        relative = path[len("/static/"):]
        base = (Path(__file__).parent / "static").resolve()
        file_path = (base / relative).resolve()
        if base not in file_path.parents or not file_path.is_file():
            return response(client, 404, "File tidak ditemukan.")
        mime = MIME_TYPES.get(file_path.suffix.lower(), mimetypes.guess_type(str(file_path))[0] or "application/octet-stream")
        return response(client, 200, file_path.read_bytes(), mime)

    if method == "GET" and path == "/api/health":
        return send_json(client, 200, {"ok": True, "service": "CrossDrop TCP server"})

    if method == "POST" and path == "/api/pair":
        code = f"{secrets.randbelow(900000) + 100000}"
        with lock:
            while code in sessions:
                code = f"{secrets.randbelow(900000) + 100000}"
            sessions[code] = {"created": time.time()}
        return send_json(client, 201, {"ok": True, "code": code, "expiresIn": 43200})

    if method == "POST" and path == "/api/send-text":
        try:
            data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return send_json(client, 400, {"ok": False, "error": "Data teks tidak valid."})
        code = require_code(data.get("code"))
        text = str(data.get("text", "")).strip()
        sender = str(data.get("sender", "Perangkat pengirim"))[:80]
        if not code:
            return send_json(client, 403, {"ok": False, "error": "Kode pairing tidak valid atau kedaluwarsa."})
        if not text:
            return send_json(client, 400, {"ok": False, "error": "Teks tidak boleh kosong."})
        if len(text) > 20000:
            return send_json(client, 413, {"ok": False, "error": "Teks maksimal 20.000 karakter."})
        item_id = uuid.uuid4().hex
        item = {
            "id": item_id, "code": code, "type": "text", "sender": sender,
            "text": text, "name": "Pesan teks", "size": len(text.encode("utf-8")),
            "status": "Menunggu persetujuan", "created": time.time(), "path": None
        }
        with lock:
            pending[item_id] = item
        return send_json(client, 201, {"ok": True, "id": item_id, "status": item["status"]})

    if method == "POST" and path == "/api/upload":
        try:
            fields, uploads = parse_multipart(headers.get("content-type", ""), body)
        except Exception:
            return send_json(client, 400, {"ok": False, "error": "Form upload tidak valid."})
        if not uploads:
            return send_json(client, 400, {"ok": False, "error": "Pilih minimal satu file."})
        code = require_code(fields.get("code"))
        sender = str(fields.get("sender", "Perangkat pengirim"))[:80]
        if not code:
            return send_json(client, 403, {"ok": False, "error": "Kode pairing tidak valid atau kedaluwarsa."})
        if len(uploads) > 30:
            return send_json(client, 413, {"ok": False, "error": "Maksimal 30 file sekali kirim."})
        total_size = sum(len(payload) for _, payload, _ in uploads)
        if total_size > 100 * 1024 * 1024:
            return send_json(client, 413, {"ok": False, "error": "Total ukuran sekali kirim maksimal 100 MiB pada konfigurasi hosting gratis."})
        for filename, payload, mime in uploads:
            if len(payload) > MAX_FILE_SIZE:
                return send_json(client, 413, {"ok": False, "error": f"File {filename} melebihi batas 100 MiB."})
            if Path(filename).suffix.lower() not in ALLOWED_EXTENSIONS:
                return send_json(client, 415, {"ok": False, "error": f"Jenis file {filename} belum diizinkan."})
            if not payload:
                return send_json(client, 400, {"ok": False, "error": f"File {filename} kosong."})
        created_items = []
        for filename, payload, mime in uploads:
            item_id = uuid.uuid4().hex
            stored_path = UPLOAD_DIR / f"{item_id}{Path(filename).suffix.lower()}"
            stored_path.write_bytes(payload)
            item = {"id": item_id, "code": code, "type": "file", "sender": sender, "text": None,
                    "name": filename, "size": len(payload), "mime": mime,
                    "status": "Menunggu persetujuan", "created": time.time(), "path": str(stored_path)}
            with lock:
                pending[item_id] = item
            created_items.append({"id": item_id, "name": filename, "size": len(payload), "status": item["status"]})
        return send_json(client, 201, {"ok": True, "items": created_items, "count": len(created_items), "totalSize": total_size})

    if method == "GET" and path == "/api/inbox":
        code = require_code((query.get("code") or [""])[0])
        if not code:
            return send_json(client, 403, {"ok": False, "error": "Kode pairing tidak valid atau kedaluwarsa."})
        with lock:
            items = [
                {k: v for k, v in item.items() if k not in ("path", "code")}
                for item in pending.values() if item["code"] == code
            ]
        items.sort(key=lambda x: x["created"], reverse=True)
        return send_json(client, 200, {"ok": True, "items": items})

    if method == "POST" and path.startswith("/api/decision/"):
        item_id = path.rsplit("/", 1)[-1]
        try:
            data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return send_json(client, 400, {"ok": False, "error": "Permintaan tidak valid."})
        code = require_code(data.get("code"))
        decision = data.get("decision")
        with lock:
            item = pending.get(item_id)
            if not code or not item or item["code"] != code:
                return send_json(client, 403, {"ok": False, "error": "Transfer tidak ditemukan atau kode salah."})
            if item["status"] != "Menunggu persetujuan":
                return send_json(client, 400, {"ok": False, "error": "Transfer sudah diproses."})
            if decision == "accept":
                item["status"] = "Disetujui"
            elif decision == "reject":
                item["status"] = "Ditolak"
            else:
                return send_json(client, 400, {"ok": False, "error": "Pilihan keputusan tidak valid."})
            record = {
                "id": item["id"], "type": item["type"], "name": item["name"],
                "sender": item["sender"], "size": item["size"],
                "status": item["status"], "time": time.strftime("%Y-%m-%d %H:%M:%S")
            }
            history.append(record)
            save_history()
        return send_json(client, 200, {"ok": True, "status": item["status"]})

    if method == "GET" and path.startswith("/api/preview/"):
        item_id = path.rsplit("/", 1)[-1]
        code = require_code((query.get("code") or [""])[0])
        with lock:
            item = pending.get(item_id)
            if not code or not item or item["code"] != code:
                return response(client, 403, "Akses ditolak.")
            if item["status"] != "Disetujui":
                return response(client, 403, "Penerima belum menyetujui transfer.")
            if item["type"] != "file":
                return response(client, 415, "Pratinjau tidak tersedia untuk item ini.")
            file_path = Path(item["path"])
            if not file_path.is_file():
                return response(client, 404, "File sudah tidak tersedia.")
            data = file_path.read_bytes()
            mime = item.get("mime", "application/octet-stream")
            if not (mime.startswith("image/") or mime.startswith("video/") or mime == "application/pdf" or mime.startswith("text/")):
                return response(client, 415, "Format ini tidak mendukung pratinjau browser. Gunakan tombol unduh.")
        return response(client, 200, data, mime, {"Content-Disposition": "inline", "Content-Security-Policy": "default-src 'none'; sandbox"})

    if method == "GET" and path.startswith("/api/download/"):
        item_id = path.rsplit("/", 1)[-1]
        code = require_code((query.get("code") or [""])[0])
        with lock:
            item = pending.get(item_id)
            if not code or not item or item["code"] != code:
                return response(client, 403, "Akses ditolak.")
            if item["status"] != "Disetujui":
                return response(client, 403, "Penerima belum menyetujui transfer.")
            if item["type"] == "text":
                data = item["text"].encode("utf-8")
                filename = "pesan.txt"
                mime = "text/plain; charset=utf-8"
            else:
                file_path = Path(item["path"])
                if not file_path.is_file():
                    return response(client, 404, "File sudah tidak tersedia.")
                data = file_path.read_bytes()
                filename = item["name"].replace('"', "")
                mime = item.get("mime", "application/octet-stream")
        return response(client, 200, data, mime, {
            "Content-Disposition": f'attachment; filename="{filename}"'
        })

    if method == "GET" and path == "/api/history":
        code = require_code((query.get("code") or [""])[0])
        if not code:
            return send_json(client, 403, {"ok": False, "error": "Kode pairing tidak valid atau kedaluwarsa."})
        with lock:
            records = [r for r in history[-100:] if r.get("id") in pending and pending[r["id"]]["code"] == code]
        records.reverse()
        return send_json(client, 200, {"ok": True, "items": records})

    return response(client, 404, "Endpoint tidak ditemukan.")


def handle_client(client, address):
    try:
        method, target, headers, body = read_request(client)
        route(client, method, target, headers, body)
    except OverflowError as exc:
        try:
            send_json(client, 413, {"ok": False, "error": str(exc)})
        except OSError:
            pass
    except (ValueError, OSError) as exc:
        try:
            send_json(client, 400, {"ok": False, "error": str(exc)})
        except OSError:
            pass
    except Exception as exc:
        print(f"[ERROR] {address}: {exc}")
        try:
            send_json(client, 500, {"ok": False, "error": "Terjadi kesalahan pada server."})
        except OSError:
            pass
    finally:
        try:
            client.close()
        except OSError:
            pass


def get_local_ip():
    """Mendeteksi alamat IPv4 lokal yang digunakan untuk jaringan aktif."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # connect UDP ini hanya menentukan rute/interface; tidak mengirim data aplikasi.
        probe.connect(("192.0.2.1", 80))
        ip_address = probe.getsockname()[0]
        if ip_address and not ip_address.startswith("127."):
            return ip_address
    except OSError:
        pass
    finally:
        probe.close()

    try:
        for result in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip_address = result[4][0]
            if not ip_address.startswith("127."):
                return ip_address
    except OSError:
        pass
    return "IP-LOKAL-KOMPUTER"


def main():
    local_ip = get_local_ip()
    print("=" * 60)
    print(" CrossDrop - Aplikasi Transfer Data")
    print(f" Server lokal : http://127.0.0.1:{PORT}")
    if "RENDER" not in os.environ:
        print(f" Akses Wi-Fi  : http://{local_ip}:{PORT}")
    else:
        print(" Mode hosting Render aktif; gunakan URL HTTPS dari dashboard Render.")
    print(" Pastikan perangkat lain terhubung ke Wi-Fi/LAN yang sama.")
    print(" Jika diminta, izinkan Python di Windows Defender Firewall (Private network).")
    print(" Tekan Ctrl+C untuk menghentikan server.")
    print("=" * 60)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((HOST, PORT))
        server.listen(50)
        while True:
            client, address = server.accept()
            threading.Thread(target=handle_client, args=(client, address), daemon=True).start()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nServer CrossDrop dihentikan.")
