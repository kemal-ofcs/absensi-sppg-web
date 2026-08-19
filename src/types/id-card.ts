export type CardOrientation = "portrait" | "landscape";
export type CardSide = "front" | "back";
export type ElementType =
  | "text"
  | "qr_code"
  | "photo"
  | "company_logo"
  | "static_text";

export interface IdCardElement {
  id: string;
  type: ElementType;
  side: CardSide;
  sourceKey:
    | "employee.name"
    | "employee.nik"
    | "employee.gender"
    | "employee.position"
    | "employee.department"
    | "employee.qr_token"
    | "employee.avatar"
    | "company.name"
    | "company.logo"
    | "company.terms"
    | "company.signature"
    | "static_text";
  staticValue?: string;
  label: string;
  x: number; // Persentase dari kiri (0 - 100%)
  y: number; // Persentase dari atas (0 - 100%)
  width?: number; // Persentase lebar (0 - 100%)
  height?: number; // Persentase tinggi (0 - 100%)
  fontSize: number; // Ukuran font dalam pt/px
  fontWeight?: "normal" | "600" | "bold";
  color: string; // Hex color
  textAlign?: "left" | "center" | "right";
  isUppercase?: boolean;
  visible?: boolean; // Default true, jika false maka elemen tidak dirender di kartu
}

export interface IdCardTemplateConfig {
  id: string;
  name: string;
  orientation: CardOrientation;
  frontBgUrl?: string; // Base64 atau URL asset
  backBgUrl?: string;
  elements: IdCardElement[];
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}
