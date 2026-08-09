export interface OperatorRecord {
  id: number;
  kodeOperator: string;
  name: string;
  username: string;
  roleId: number;
  roleKey: string;
  roleName: string;
  isSuperadmin: boolean;
  status: "Aktif" | "Nonaktif";
}

export interface OperatorDraft {
  kodeOperator: string;
  name: string;
  username: string;
  password?: string;
  roleId: number;
  status: "Aktif" | "Nonaktif";
}
