# Sumber ikon aplikasi

Disusun dari `logo-mark` Kemal Office Studio. Ketiga produk KOS memakai logo
yang sama dengan warna latar berbeda, supaya bisa dibedakan di taskbar dan
layar HP bila terpasang berdampingan.

- `app-icon.svg`: ikon Desktop, installer, dan favicon (kotak membulat).
- `android-bg.svg` + `android-fg.svg`: ikon adaptive Android. Latarnya penuh
  supaya launcher bebas memotong bentuknya, dan logonya di zona aman 66%.

Generate ulang (dari folder workspace masing-masing):

```bash
cd web-desktop
bunx tauri icon src-tauri/icons/sumber/icon-manifest.json -o src-tauri/icons
cp src-tauri/icons/icon.ico src/app/favicon.ico
cp src-tauri/icons/*.png src-tauri/icons/*.ico src-tauri/icons/*.icns ../mobile/src-tauri/icons/
rm -rf ../mobile/src-tauri/icons/android ../mobile/src-tauri/icons/ios
mv src-tauri/icons/android src-tauri/icons/ios ../mobile/src-tauri/icons/
```

Jalankan di `web-desktop`, bukan di `mobile`: bila `mobile/src-tauri/gen/android`
ada, `tauri icon` menulis ikon Android langsung ke sana dan `icons/android`
tidak terbentuk.

Ikon Android disalin ke `gen/android` oleh skrip patch Android di `mobile/scripts/`
pada setiap build, karena `tauri android init` memasang ulang ikon bawaan Tauri.
