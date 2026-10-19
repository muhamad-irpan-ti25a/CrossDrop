# CrossDrop

Aplikasi transfer data lintas platform untuk tugas Sistem Paralel dan Terdistribusi.

## Teknologi
- Python standard library (`socket`, `threading`, `http`, pemrosesan data)
- HTML
- CSS
- JavaScript

Server HTTP dibuat menggunakan Python socket TCP, bukan Flask atau Node.js.

## Menjalankan aplikasi
1. Pastikan Python 3.10 atau lebih baru sudah terpasang.
2. Buka CMD pada folder proyek.
3. Jalankan `python server.py`.
4. Jalankan `ipconfig` jika perlu, lalu cari **IPv4 Address** pada adaptor Wi-Fi/Ethernet yang aktif.
5. Buka `http://127.0.0.1:8765` di komputer server.
6. Untuk HP atau komputer lain pada Wi-Fi/LAN yang sama, buka `http://IP-LOKAL-KOMPUTER:8765` (ganti dengan IPv4 komputer server yang sebenarnya).
7. Jika tidak bisa diakses, izinkan Python pada Windows Defender Firewall untuk jaringan **Private** atau buat aturan inbound TCP port `8765`. Pastikan Wi-Fi tidak mengaktifkan fitur client/AP isolation.
8. Klik **Buat kode pairing** pada perangkat penerima.
9. Masukkan kode 6 digit di perangkat pengirim, lalu kirim teks atau file.
10. Pada perangkat penerima, klik **Setujui** lalu tekan **Unduh file**. Progres unduhan akan tampil di halaman.

## Catatan jaringan
- Izinkan Python melewati Windows Defender Firewall untuk jaringan Private jika diminta.
- Gunakan IP lokal komputer yang menjalankan server, bukan `localhost`, pada HP.
- Versi ini dirancang untuk pengujian pada jaringan lokal tepercaya. Jangan mengeksposnya langsung ke internet.
- HTTP lokal belum terenkripsi. Untuk penggunaan publik, implementasikan HTTPS, autentikasi yang lebih kuat, rate limiting, dan pengelolaan sesi yang aman.

## Batasan versi awal
- Kode pairing dan permintaan transfer disimpan di memori server; riwayat disimpan di `storage/history.json`.
- File maksimal 100 MiB dan ekstensi harus masuk daftar yang diizinkan di `config.py`.
- QR, TLS/HTTPS, dan pembersihan file otomatis belum diimplementasikan.
- Progres upload ditampilkan pada perangkat pengirim. Perangkat penerima juga menampilkan progres unduhan saat menekan **Unduh file**; unduhan dimulai melalui browser setelah data selesai diterima.
- Uji semua arah transfer di perangkat nyata sebelum menyatakan kompatibilitas berhasil.


## Fitur transfer lanjutan
- Pilih beberapa file sekaligus: maksimal 30 file, 100 MiB per file, dan 500 MiB total per kiriman.
- File ditransfer sebagai byte asli tanpa kompresi ulang, sehingga aplikasi tidak mengubah kualitas foto/video atau isi dokumen.
- QR Code membagikan URL lokal beserta kode pairing. Saat tombol **Buat kode baru** menghasilkan kode baru, QR yang sedang ditampilkan otomatis diperbarui. Tombol QR dapat digunakan untuk menampilkan atau menyembunyikannya. Pustaka QR dimuat dari CDN sehingga perlu internet untuk membuat QR; kode manual tetap tersedia.
- Pratinjau browser tersedia untuk gambar, video, PDF, dan teks setelah disetujui. Format lain perlu diunduh untuk dibuka.
- Browser web tidak dapat menyimpan diam-diam ke Photos/Files di iOS atau folder perangkat lain. Pengguna tetap perlu membuka/menyimpan melalui browser atau lembar berbagi. Ini bukan pengganti AirDrop native Apple.


## Pemindaian QR dari halaman web
- Pada bagian pengirim, tekan **Pindai QR dengan kamera** lalu izinkan akses kamera jika browser mendukungnya.
- Jika kamera tidak tersedia karena halaman dibuka melalui HTTP pada IP lokal, tekan **Pilih gambar QR** dan pilih screenshot/foto QR.
- Pemindai menggunakan pustaka JavaScript dari CDN, sehingga pemuatan pustaka membutuhkan internet.
- Browser modern umumnya hanya mengizinkan akses kamera pada konteks aman (HTTPS atau localhost). Untuk memindai kamera dari HP melalui IP lokal, siapkan HTTPS untuk server; opsi memilih gambar QR menjadi alternatif tanpa akses kamera.
