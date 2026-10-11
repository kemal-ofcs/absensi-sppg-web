"use client";

import { useEffect, useState } from "react";

/**
 * Mengembalikan nilai yang telah di-debounce — hanya diperbarui setelah
 * `delay` milidetik tanpa perubahan nilai baru masuk.
 *
 * @param value  Nilai reaktif yang ingin di-debounce (biasanya string search)
 * @param delay  Waktu tunggu dalam milidetik (default: 300ms)
 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delay);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);

  return debounced;
}
