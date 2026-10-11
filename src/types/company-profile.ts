export interface CompanyProfile {
  id: string;
  company_name: string;
  branch_name: string | null;
  logo_url: string | null;
  signature_url: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  leader_name: string | null;
  leader_title: string | null;
  leader_nip: string | null;
  card_terms: string | null;
  timezone: string;
  updated_at: string;
}

export interface CompanyProfileInput {
  company_name: string;
  branch_name?: string | null;
  logo_url?: string | null;
  signature_url?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  leader_name?: string | null;
  leader_title?: string | null;
  leader_nip?: string | null;
  card_terms?: string | null;
  timezone?: string;
}
