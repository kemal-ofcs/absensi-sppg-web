import "server-only";

import { db, ensureDbInitialized } from "@/lib/db";
import type {
  CompanyProfile,
  CompanyProfileInput,
} from "@/types/company-profile";

export async function getCompanyProfile(): Promise<CompanyProfile> {
  await ensureDbInitialized();

  const res = await db.execute(
    "SELECT * FROM company_profile WHERE id = 'default_company' LIMIT 1;",
  );

  if (res.rows.length === 0) {
    const now = new Date().toISOString();
    const defaultTerms = `1. Kartu ini adalah tanda pengenal resmi karyawan/personil SPPG.
2. Wajib dibawa dan dipindai (scan QR) setiap hadir dan pulang kerja.
3. Dilarang memindahtangankan atau meminjamkan kartu ini kepada pihak lain.
4. Apabila kartu hilang atau menemukan kartu ini, harap segera melapor ke Bagian SDM/Operasional SPPG.`;

    await db.execute({
      sql: `
        INSERT OR IGNORE INTO company_profile (
          id, company_name, branch_name, logo_url, signature_url,
          address, phone, email, website,
          leader_name, leader_title, leader_nip,
          card_terms, timezone, updated_at
        ) VALUES (
          'default_company', 'SPPG', 'Pusat Operasional', NULL, NULL,
          'Jl. Sudirman No. 123, Jakarta', '021-5550123', 'info@sppg.id', 'https://sppg.id',
          'Dr. H. Ahmad Fauzi, M.M.', 'Kepala SPPG', '19750815 200003 1 002',
          ?, 'Asia/Jakarta', ?
        );
      `,
      args: [defaultTerms, now],
    });

    const fallbackRes = await db.execute(
      "SELECT * FROM company_profile WHERE id = 'default_company' LIMIT 1;",
    );
    return fallbackRes.rows[0] as unknown as CompanyProfile;
  }

  return res.rows[0] as unknown as CompanyProfile;
}

export async function updateCompanyProfile(
  input: CompanyProfileInput,
): Promise<CompanyProfile> {
  await ensureDbInitialized();

  const now = new Date().toISOString();

  await db.execute({
    sql: `
      INSERT INTO company_profile (
        id, company_name, branch_name, logo_url, signature_url,
        address, phone, email, website,
        leader_name, leader_title, leader_nip,
        card_terms, timezone, updated_at
      ) VALUES (
        'default_company', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        company_name = excluded.company_name,
        branch_name = excluded.branch_name,
        logo_url = excluded.logo_url,
        signature_url = excluded.signature_url,
        address = excluded.address,
        phone = excluded.phone,
        email = excluded.email,
        website = excluded.website,
        leader_name = excluded.leader_name,
        leader_title = excluded.leader_title,
        leader_nip = excluded.leader_nip,
        card_terms = excluded.card_terms,
        timezone = excluded.timezone,
        updated_at = excluded.updated_at;
    `,
    args: [
      input.company_name || "SPPG",
      input.branch_name ?? null,
      input.logo_url ?? null,
      input.signature_url ?? null,
      input.address ?? null,
      input.phone ?? null,
      input.email ?? null,
      input.website ?? null,
      input.leader_name ?? null,
      input.leader_title ?? null,
      input.leader_nip ?? null,
      input.card_terms ?? null,
      input.timezone || "Asia/Jakarta",
      now,
    ],
  });

  return getCompanyProfile();
}
