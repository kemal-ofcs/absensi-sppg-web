"use client";

import { useCallback, useEffect, useState } from "react";
import { getLicenseStatus, type LicenseStatus } from "@/lib/gateways/license";

/**
 * Status lisensi perangkat ini. Selalu `null` di Web, dan selama `enabled`
 * masih `false` (misalnya database belum dikonfigurasi).
 */
export function useLicenseStatus(enabled = true) {
  const [status, setStatus] = useState<LicenseStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getLicenseStatus();
      setStatus(next);
      return next;
    } catch {
      // Status lisensi yang gagal dibaca tidak boleh menutup layar login:
      // gerbang sebenarnya ada di `desktop_login`, yang akan menolak dengan
      // pesannya sendiri.
      setStatus(null);
      return null;
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  return { status, refresh, setStatus };
}
