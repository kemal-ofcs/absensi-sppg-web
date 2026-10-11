import "server-only";

import { BRANDING } from "@/lib/constants/branding";
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

    await db.execute({
      sql: `
        INSERT OR IGNORE INTO company_profile (
          id, company_name, branch_name, logo_url, signature_url,
          address, phone, email, website,
          leader_name, leader_title, leader_nip,
          card_terms, timezone, updated_at
        ) VALUES (
          'default_company', ?, ?, NULL, NULL,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, 'Asia/Jakarta', ?
        );
      `,
      args: [
        BRANDING.defaultCompanyName,
        BRANDING.defaultBranchName,
        BRANDING.defaultAddress,
        BRANDING.defaultPhone,
        BRANDING.defaultEmail,
        BRANDING.defaultWebsite,
        BRANDING.defaultLeaderName,
        BRANDING.defaultLeaderTitle,
        BRANDING.defaultLeaderNip,
        BRANDING.defaultCardTerms,
        now,
      ],
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
      input.company_name || BRANDING.defaultCompanyName,
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
