from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
HOST = "0.0.0.0"
PORT = 8765

STORAGE_DIR = BASE_DIR / "storage"
UPLOAD_DIR = STORAGE_DIR / "uploads"
HISTORY_FILE = STORAGE_DIR / "history.json"

# Batas ukuran satu file: 100 MiB
MAX_FILE_SIZE = 100 * 1024 * 1024

# Ekstensi yang diperbolehkan. Tambahkan sesuai kebutuhan.
ALLOWED_EXTENSIONS = {
    ".txt", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp",
    ".mp4", ".mov", ".webm", ".zip", ".doc", ".docx",
    ".xls", ".xlsx", ".ppt", ".pptx", ".csv"
}

for folder in (STORAGE_DIR, UPLOAD_DIR):
    folder.mkdir(parents=True, exist_ok=True)

if not HISTORY_FILE.exists():
    HISTORY_FILE.write_text("[]", encoding="utf-8")
