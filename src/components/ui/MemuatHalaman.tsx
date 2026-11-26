/** Layar penuh saat menunggu sesi/otorisasi. Gaya di `.memuat-halaman*` globals.css. */
export function MemuatHalaman({
  pesan = "Memuat otorisasi…",
}: {
  pesan?: string;
}) {
  return (
    <div className="memuat-halaman grid min-h-dvh place-items-center p-6">
      <output className="flex flex-col items-center gap-3">
        <span
          aria-hidden="true"
          className="memuat-halaman-putar size-10 animate-spin rounded-full motion-reduce:animate-none"
        />
        <p className="font-medium text-xs">{pesan}</p>
      </output>
    </div>
  );
}
