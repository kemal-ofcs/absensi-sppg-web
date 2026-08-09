"use client";

import { redirect } from "next/navigation";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useAuth } from "@/lib/context/AuthContext";
import {
  createOperator,
  createRole,
  deleteMasterOperator,
  deleteRole,
  getMasterOperators,
  getRoleRecords,
  setRolePermissions,
  updateMasterOperator,
  updateRole,
} from "@/lib/gateways/master-operator";
import { useHydrated } from "@/lib/hooks/useHydrated";
import type { OperatorDraft, OperatorRecord } from "@/lib/operators/types";
import {
  PERMISSION_CATALOG,
  type PermissionKey,
  SUPERADMIN_ONLY_PERMISSIONS,
} from "@/lib/rbac/catalog";
import type { RoleRecord } from "@/lib/rbac/types";

type ActiveTab = "operators" | "roles";

const EMPTY_OPERATOR: OperatorDraft = {
  kodeOperator: "",
  name: "",
  username: "",
  password: "",
  roleId: 0,
  status: "Aktif",
};

const EDITABLE_PERMISSION_GROUPS = PERMISSION_CATALOG.filter(
  ({ key }) => !SUPERADMIN_ONLY_PERMISSIONS.has(key),
).reduce<Record<string, (typeof PERMISSION_CATALOG)[number][]>>(
  (groups, permission) => {
    groups[permission.group] = [
      ...(groups[permission.group] ?? []),
      permission,
    ];
    return groups;
  },
  {},
);

interface RoleFormState {
  name: string;
  description: string;
  status: "Aktif" | "Nonaktif";
}

function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return "Operasi tidak dapat diselesaikan.";
  if (error.message.includes("UNIQUE")) {
    return "Kode operator, username, atau nama role sudah digunakan.";
  }
  return error.message;
}

export default function MasterOperatorPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const [activeTab, setActiveTab] = useState<ActiveTab>("operators");
  const [operators, setOperators] = useState<OperatorRecord[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const [operatorModal, setOperatorModal] = useState(false);
  const [editingOperator, setEditingOperator] = useState<OperatorRecord | null>(
    null,
  );
  const [operatorDraft, setOperatorDraft] =
    useState<OperatorDraft>(EMPTY_OPERATOR);
  const [roleModal, setRoleModal] = useState(false);
  const [editingRole, setEditingRole] = useState<RoleRecord | null>(null);
  const [roleDraft, setRoleDraft] = useState<RoleFormState>({
    name: "",
    description: "",
    status: "Aktif",
  });
  const [selectedPermissions, setSelectedPermissions] = useState<
    Set<PermissionKey>
  >(new Set());
  const [deleteTarget, setDeleteTarget] = useState<
    | { type: "operator"; item: OperatorRecord }
    | { type: "role"; item: RoleRecord }
    | null
  >(null);

  const loadData = useCallback(async () => {
    if (!user?.isSuperadmin) return;
    setLoading(true);
    try {
      const [operatorData, roleData] = await Promise.all([
        getMasterOperators(user.id),
        getRoleRecords(user.id),
      ]);
      setOperators(operatorData);
      setRoles(roleData);
    } catch (error) {
      setFeedback({ tone: "error", message: errorMessage(error) });
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const openNewOperator = () => {
    const firstRole = roles.find((role) => role.status === "Aktif");
    setEditingOperator(null);
    setOperatorDraft({ ...EMPTY_OPERATOR, roleId: firstRole?.id ?? 0 });
    setOperatorModal(true);
  };

  const openEditOperator = (operator: OperatorRecord) => {
    setEditingOperator(operator);
    setOperatorDraft({
      kodeOperator: operator.kodeOperator,
      name: operator.name,
      username: operator.username,
      password: "",
      roleId: operator.roleId,
      status: operator.status,
    });
    setOperatorModal(true);
  };

  const submitOperator = async (event: FormEvent) => {
    event.preventDefault();
    if (!user) return;
    setSaving(true);
    setFeedback(null);
    try {
      if (editingOperator) {
        await updateMasterOperator(user.id, editingOperator.id, operatorDraft);
      } else {
        await createOperator(user.id, operatorDraft);
      }
      setOperatorModal(false);
      await loadData();
      setFeedback({
        tone: "success",
        message: editingOperator
          ? "Operator berhasil diperbarui."
          : "Operator berhasil ditambahkan.",
      });
    } catch (error) {
      setFeedback({ tone: "error", message: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const openNewRole = () => {
    setEditingRole(null);
    setRoleDraft({ name: "", description: "", status: "Aktif" });
    setSelectedPermissions(new Set());
    setRoleModal(true);
  };

  const openEditRole = (role: RoleRecord) => {
    setEditingRole(role);
    setRoleDraft({
      name: role.name,
      description: role.description,
      status: role.status,
    });
    setSelectedPermissions(new Set(role.permissions));
    setRoleModal(true);
  };

  const submitRole = async (event: FormEvent) => {
    event.preventDefault();
    if (!user) return;
    setSaving(true);
    setFeedback(null);
    try {
      if (editingRole) {
        await updateRole(user.id, editingRole.id, roleDraft);
        await setRolePermissions(user.id, editingRole.id, [
          ...selectedPermissions,
        ]);
      } else {
        await createRole(user.id, roleDraft, [...selectedPermissions]);
      }
      setRoleModal(false);
      await loadData();
      setFeedback({
        tone: "success",
        message: editingRole
          ? "Role dan permission berhasil diperbarui."
          : "Role baru berhasil dibuat.",
      });
    } catch (error) {
      setFeedback({ tone: "error", message: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!user || !deleteTarget) return;
    setSaving(true);
    setFeedback(null);
    try {
      if (deleteTarget.type === "operator") {
        await deleteMasterOperator(user.id, deleteTarget.item.id);
      } else {
        await deleteRole(user.id, deleteTarget.item.id);
      }
      setDeleteTarget(null);
      await loadData();
      setFeedback({ tone: "success", message: "Data berhasil dihapus." });
    } catch (error) {
      setDeleteTarget(null);
      setFeedback({ tone: "error", message: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  if (!isHydrated || authLoading)
    return <div className="min-h-dvh bg-slate-950" />;
  if (!isAuthenticated) redirect("/login");
  if (!user?.isSuperadmin) redirect("/forbidden");

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-9">
      <PageHeader
        eyebrow="Administrasi akses"
        title="Master Operator"
        description="Kelola akun, role dinamis, dan permission. Perubahan keamanan hanya dapat dilakukan Superadmin saat online."
        actions={
          <StatusBadge tone="warning">
            <Icon name="lock" className="size-3.5" />
            Superadmin saja
          </StatusBadge>
        }
      />

      {feedback ? (
        <FeedbackBanner
          tone={feedback.tone}
          onDismiss={() => setFeedback(null)}
        >
          {feedback.message}
        </FeedbackBanner>
      ) : null}

      <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-950/70 p-1">
          {(["operators", "roles"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`min-h-11 rounded-lg px-4 text-xs font-black transition ${
                activeTab === tab
                  ? "bg-sky-400 text-slate-950"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              {tab === "operators"
                ? `Pengguna (${operators.length})`
                : `Role & Akses (${roles.length})`}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={activeTab === "operators" ? openNewOperator : openNewRole}
          disabled={loading}
          className="min-h-11 rounded-xl bg-amber-300 px-4 text-xs font-black text-slate-950 transition hover:bg-amber-200 disabled:opacity-50"
        >
          {activeTab === "operators" ? "Tambah operator" : "Buat role baru"}
        </button>
      </div>

      {loading ? (
        <div className="app-panel grid min-h-72 place-items-center rounded-3xl text-sm text-slate-400">
          Memuat Master Operator...
        </div>
      ) : activeTab === "operators" ? (
        <OperatorTable
          operators={operators}
          currentUserId={user.id}
          onEdit={openEditOperator}
          onDelete={(item) => setDeleteTarget({ type: "operator", item })}
        />
      ) : (
        <RoleGrid
          roles={roles}
          onEdit={openEditRole}
          onDelete={(item) => setDeleteTarget({ type: "role", item })}
        />
      )}

      {operatorModal ? (
        <OperatorFormModal
          editingOperator={editingOperator}
          draft={operatorDraft}
          roles={roles}
          saving={saving}
          onChange={setOperatorDraft}
          onClose={() => setOperatorModal(false)}
          onSubmit={submitOperator}
        />
      ) : null}

      {roleModal ? (
        <RoleFormModal
          editingRole={editingRole}
          draft={roleDraft}
          permissions={selectedPermissions}
          saving={saving}
          onDraftChange={setRoleDraft}
          onPermissionsChange={setSelectedPermissions}
          onClose={() => setRoleModal(false)}
          onSubmit={submitRole}
        />
      ) : null}

      {deleteTarget ? (
        <Modal
          title="Konfirmasi penghapusan"
          titleId="delete-modal-title"
          onClose={() => setDeleteTarget(null)}
        >
          <p className="text-sm leading-6 text-slate-300">
            Hapus {deleteTarget.type === "operator" ? "operator" : "role"}{" "}
            <strong className="text-white">{deleteTarget.item.name}</strong>?
            Data dengan histori transaksi akan ditolak dan harus dinonaktifkan.
          </p>
          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => setDeleteTarget(null)}
              className="min-h-11 rounded-xl border border-white/10 px-4 text-sm font-bold text-slate-300"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={confirmDelete}
              disabled={saving}
              className="min-h-11 rounded-xl bg-rose-500 px-4 text-sm font-black text-white disabled:opacity-50"
            >
              {saving ? "Menghapus..." : "Hapus"}
            </button>
          </div>
        </Modal>
      ) : null}
    </AppShell>
  );
}

function OperatorFormModal({
  editingOperator,
  draft,
  roles,
  saving,
  onChange,
  onClose,
  onSubmit,
}: {
  editingOperator: OperatorRecord | null;
  draft: OperatorDraft;
  roles: RoleRecord[];
  saving: boolean;
  onChange: (draft: OperatorDraft) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <Modal
      title={editingOperator ? "Edit operator" : "Tambah operator"}
      titleId="operator-modal-title"
      onClose={onClose}
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Kode operator" htmlFor="operator-code">
            <input
              id="operator-code"
              required
              value={draft.kodeOperator}
              onChange={(event) =>
                onChange({ ...draft, kodeOperator: event.target.value })
              }
              className="app-input"
            />
          </FormField>
          <FormField label="Username" htmlFor="operator-username">
            <input
              id="operator-username"
              required
              autoComplete="username"
              value={draft.username}
              onChange={(event) =>
                onChange({ ...draft, username: event.target.value })
              }
              className="app-input"
            />
          </FormField>
        </div>
        <FormField label="Nama operator" htmlFor="operator-name">
          <input
            id="operator-name"
            required
            value={draft.name}
            onChange={(event) =>
              onChange({ ...draft, name: event.target.value })
            }
            className="app-input"
          />
        </FormField>
        <FormField
          label={editingOperator ? "Password baru (opsional)" : "Password"}
          htmlFor="operator-password"
        >
          <input
            id="operator-password"
            type="password"
            required={!editingOperator}
            minLength={12}
            autoComplete="new-password"
            value={draft.password}
            onChange={(event) =>
              onChange({ ...draft, password: event.target.value })
            }
            className="app-input"
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Role" htmlFor="operator-role">
            <select
              id="operator-role"
              value={draft.roleId}
              onChange={(event) =>
                onChange({ ...draft, roleId: Number(event.target.value) })
              }
              className="app-input"
            >
              {roles
                .filter(
                  (role) => role.status === "Aktif" || role.id === draft.roleId,
                )
                .map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
            </select>
          </FormField>
          <FormField label="Status" htmlFor="operator-status">
            <select
              id="operator-status"
              value={draft.status}
              onChange={(event) =>
                onChange({
                  ...draft,
                  status: event.target.value as "Aktif" | "Nonaktif",
                })
              }
              className="app-input"
            >
              <option value="Aktif">Aktif</option>
              <option value="Nonaktif">Nonaktif</option>
            </select>
          </FormField>
        </div>
        <ModalActions saving={saving} onCancel={onClose} />
      </form>
    </Modal>
  );
}

function RoleFormModal({
  editingRole,
  draft,
  permissions,
  saving,
  onDraftChange,
  onPermissionsChange,
  onClose,
  onSubmit,
}: {
  editingRole: RoleRecord | null;
  draft: RoleFormState;
  permissions: Set<PermissionKey>;
  saving: boolean;
  onDraftChange: (draft: RoleFormState) => void;
  onPermissionsChange: (permissions: Set<PermissionKey>) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <Modal
      title={editingRole ? "Edit role & akses" : "Buat role baru"}
      titleId="role-modal-title"
      onClose={onClose}
    >
      <form className="space-y-5" onSubmit={onSubmit}>
        <FormField label="Nama role" htmlFor="role-name">
          <input
            id="role-name"
            required
            minLength={3}
            disabled={editingRole?.isSuperadmin}
            value={draft.name}
            onChange={(event) =>
              onDraftChange({ ...draft, name: event.target.value })
            }
            className="app-input"
          />
        </FormField>
        <FormField label="Deskripsi" htmlFor="role-description">
          <textarea
            id="role-description"
            rows={3}
            disabled={editingRole?.isSuperadmin}
            value={draft.description}
            onChange={(event) =>
              onDraftChange({ ...draft, description: event.target.value })
            }
            className="app-input py-3"
          />
        </FormField>
        {!editingRole?.isSuperadmin ? (
          <fieldset>
            <legend className="text-xs font-black uppercase tracking-wider text-slate-300">
              Permission role
            </legend>
            <div className="mt-3 max-h-72 space-y-4 overflow-y-auto rounded-2xl border border-white/10 bg-slate-950/60 p-4">
              {Object.entries(EDITABLE_PERMISSION_GROUPS).map(
                ([group, groupPermissions]) => (
                  <div key={group}>
                    <p className="mb-2 text-[10px] font-black uppercase tracking-[0.2em] text-sky-300">
                      {group}
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {groupPermissions.map((permission) => (
                        <label
                          key={permission.key}
                          className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-xs text-slate-200"
                        >
                          <input
                            type="checkbox"
                            checked={permissions.has(permission.key)}
                            onChange={(event) => {
                              const next = new Set(permissions);
                              if (event.target.checked)
                                next.add(permission.key);
                              else next.delete(permission.key);
                              onPermissionsChange(next);
                            }}
                            className="size-4 accent-sky-400"
                          />
                          {permission.name}
                        </label>
                      ))}
                    </div>
                  </div>
                ),
              )}
            </div>
          </fieldset>
        ) : (
          <FeedbackBanner tone="success">
            Superadmin selalu memiliki seluruh permission.
          </FeedbackBanner>
        )}
        {editingRole && !editingRole.isSuperadmin ? (
          <FormField label="Status role" htmlFor="role-status">
            <select
              id="role-status"
              value={draft.status}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  status: event.target.value as "Aktif" | "Nonaktif",
                })
              }
              className="app-input"
            >
              <option value="Aktif">Aktif</option>
              <option value="Nonaktif">Nonaktif</option>
            </select>
          </FormField>
        ) : null}
        {!editingRole?.isSuperadmin ? (
          <ModalActions saving={saving} onCancel={onClose} />
        ) : null}
      </form>
    </Modal>
  );
}

function OperatorTable({
  operators,
  currentUserId,
  onEdit,
  onDelete,
}: {
  operators: OperatorRecord[];
  currentUserId: number;
  onEdit: (operator: OperatorRecord) => void;
  onDelete: (operator: OperatorRecord) => void;
}) {
  return (
    <div className="overflow-hidden rounded-3xl border border-white/10 bg-slate-900/80">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="border-b border-white/10 bg-slate-950/70 text-slate-400">
            <tr>
              <th className="p-4">Operator</th>
              <th className="p-4">Kode / Username</th>
              <th className="p-4">Role</th>
              <th className="p-4">Status</th>
              <th className="p-4 text-right">Aksi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {operators.map((operator) => (
              <tr key={operator.id} className="text-slate-300">
                <td className="p-4">
                  <p className="font-bold text-white">{operator.name}</p>
                  {operator.id === currentUserId ? (
                    <span className="text-[10px] text-sky-300">Akun aktif</span>
                  ) : null}
                </td>
                <td className="p-4 font-mono">
                  <p>{operator.kodeOperator}</p>
                  <p className="text-slate-500">@{operator.username}</p>
                </td>
                <td className="p-4">
                  <StatusBadge
                    tone={operator.isSuperadmin ? "warning" : "info"}
                  >
                    {operator.roleName}
                  </StatusBadge>
                </td>
                <td className="p-4">
                  <StatusBadge
                    tone={operator.status === "Aktif" ? "success" : "neutral"}
                  >
                    {operator.status}
                  </StatusBadge>
                </td>
                <td className="p-4">
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => onEdit(operator)}
                      className="min-h-10 rounded-lg border border-sky-300/20 bg-sky-300/10 px-3 font-bold text-sky-200"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(operator)}
                      disabled={operator.id === currentUserId}
                      className="min-h-10 rounded-lg border border-rose-300/20 bg-rose-300/10 px-3 font-bold text-rose-200 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Hapus
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RoleGrid({
  roles,
  onEdit,
  onDelete,
}: {
  roles: RoleRecord[];
  onEdit: (role: RoleRecord) => void;
  onDelete: (role: RoleRecord) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {roles.map((role) => (
        <article key={role.id} className="app-panel rounded-3xl p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-black text-white">{role.name}</h2>
                {role.isSystem ? (
                  <StatusBadge tone="neutral">Sistem</StatusBadge>
                ) : null}
              </div>
              <p className="mt-1 font-mono text-[10px] text-slate-500">
                {role.roleKey}
              </p>
            </div>
            <StatusBadge tone={role.status === "Aktif" ? "success" : "neutral"}>
              {role.status}
            </StatusBadge>
          </div>
          <p className="mt-4 min-h-10 text-xs leading-5 text-slate-400">
            {role.description || "Belum ada deskripsi role."}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-slate-950/50 p-3 text-center">
            <div>
              <p className="text-lg font-black text-white">
                {role.operatorCount}
              </p>
              <p className="text-[10px] text-slate-500">Operator</p>
            </div>
            <div>
              <p className="text-lg font-black text-sky-200">
                {role.isSuperadmin ? "Semua" : role.permissions.length}
              </p>
              <p className="text-[10px] text-slate-500">Permission</p>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => onEdit(role)}
              className="min-h-10 flex-1 rounded-xl bg-sky-400/10 px-3 text-xs font-black text-sky-200"
            >
              {role.isSuperadmin ? "Lihat" : "Atur akses"}
            </button>
            {!role.isSystem ? (
              <button
                type="button"
                onClick={() => onDelete(role)}
                className="min-h-10 rounded-xl bg-rose-400/10 px-3 text-xs font-black text-rose-200"
              >
                Hapus
              </button>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function FormField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-2 block text-xs font-bold text-slate-300"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function ModalActions({
  saving,
  onCancel,
}: {
  saving: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col-reverse gap-3 border-t border-white/10 pt-5 sm:flex-row sm:justify-end">
      <button
        type="button"
        onClick={onCancel}
        className="min-h-11 rounded-xl border border-white/10 px-4 text-sm font-bold text-slate-300"
      >
        Batal
      </button>
      <button
        type="submit"
        disabled={saving}
        className="min-h-11 rounded-xl bg-sky-400 px-5 text-sm font-black text-slate-950 disabled:opacity-50"
      >
        {saving ? "Menyimpan..." : "Simpan"}
      </button>
    </div>
  );
}
