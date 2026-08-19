"use client";

import { redirect } from "next/navigation";
import type { ChangeEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { canAccessArea } from "@/lib/auth/access";
import { saveFileWithPicker } from "@/lib/client/download";
import {
  drawIdCardToCanvas,
  preloadCardAssets,
  printA4GridSheet,
  printSingleCard,
  renderIdCardSideToCanvas,
} from "@/lib/client/id-card-renderer";
import { formatBytes, optimizeImageFile } from "@/lib/client/image-optimizer";
import { useAuth } from "@/lib/context/AuthContext";
import {
  type CompanyProfile,
  getCompanyProfile,
} from "@/lib/gateways/company-profile";
import { getDaftarIdCard, updateStatusIdCard } from "@/lib/gateways/id-card";
import {
  getIdCardTemplate,
  saveIdCardTemplate,
} from "@/lib/gateways/id-card-template";
import { useHydrated } from "@/lib/hooks/useHydrated";
import type {
  CardSide,
  ElementType,
  IdCardElement,
  IdCardTemplateConfig,
} from "@/types/id-card";

const DEFAULT_ID_CARD_ELEMENTS: IdCardElement[] = [
  {
    id: "el-company-logo",
    type: "company_logo",
    side: "front",
    sourceKey: "company.logo",
    label: "Logo Instansi",
    x: 6,
    y: 8,
    width: 14,
    height: 20,
    fontSize: 14,
    color: "#ffffff",
    visible: true,
  },
  {
    id: "el-header-company",
    type: "text",
    side: "front",
    sourceKey: "company.name",
    label: "Nama Instansi",
    x: 22,
    y: 11,
    fontSize: 16,
    fontWeight: "bold",
    color: "#ffffff",
    textAlign: "left",
    isUppercase: true,
    visible: true,
  },
  {
    id: "el-header-title",
    type: "static_text",
    side: "front",
    sourceKey: "static_text",
    staticValue: "KARTU IDENTITAS KARYAWAN",
    label: "Judul Kartu",
    x: 22,
    y: 22,
    fontSize: 9,
    fontWeight: "600",
    color: "#38bdf8",
    textAlign: "left",
    isUppercase: true,
    visible: true,
  },
  {
    id: "el-emp-name",
    type: "text",
    side: "front",
    sourceKey: "employee.name",
    label: "Nama Karyawan",
    x: 6,
    y: 44,
    fontSize: 18,
    fontWeight: "bold",
    color: "#ffffff",
    textAlign: "left",
    isUppercase: true,
    visible: true,
  },
  {
    id: "el-emp-pos",
    type: "text",
    side: "front",
    sourceKey: "employee.position",
    label: "Jabatan / Posisi",
    x: 6,
    y: 56,
    fontSize: 12,
    fontWeight: "600",
    color: "#7dd3fc",
    textAlign: "left",
    visible: true,
  },
  {
    id: "el-emp-dept",
    type: "text",
    side: "front",
    sourceKey: "employee.department",
    label: "Divisi / Unit",
    x: 6,
    y: 66,
    fontSize: 11,
    color: "#94a3b8",
    textAlign: "left",
    visible: true,
  },
  {
    id: "el-emp-nik",
    type: "text",
    side: "front",
    sourceKey: "employee.nik",
    label: "NIK / ID Karyawan",
    x: 6,
    y: 77,
    fontSize: 11,
    color: "#cbd5e1",
    textAlign: "left",
    visible: true,
  },
  {
    id: "el-qr-code",
    type: "qr_code",
    side: "front",
    sourceKey: "employee.qr_token",
    label: "QR Code Token",
    x: 74,
    y: 42,
    width: 20,
    height: 38,
    fontSize: 12,
    color: "#000000",
    visible: true,
  },
  {
    id: "el-back-terms",
    type: "text",
    side: "back",
    sourceKey: "company.terms",
    label: "Ketentuan Penggunaan",
    x: 8,
    y: 12,
    width: 84,
    height: 48,
    fontSize: 10,
    color: "#e2e8f0",
    textAlign: "left",
    visible: true,
  },
  {
    id: "el-back-signature",
    type: "photo",
    side: "back",
    sourceKey: "company.signature",
    label: "Tanda Tangan Pimpinan",
    x: 66,
    y: 64,
    width: 26,
    height: 24,
    fontSize: 10,
    color: "#ffffff",
    visible: true,
  },
];

type ActiveTab = "cards" | "builder";

export default function IdCardsPage() {
  const hydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  // Tab State
  const [activeTab, setActiveTab] = useState<ActiveTab>("cards");

  // Data States
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile | null>(
    null,
  );
  const [template, setTemplate] = useState<IdCardTemplateConfig | null>(null);

  // Selection for Batch
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // UI / Feedback
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Preview Modal State
  const [previewEmployee, setPreviewEmployee] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [previewSide, setPreviewSide] = useState<CardSide>("front");
  const [previewFrontUrl, setPreviewFrontUrl] = useState<string | null>(null);
  const [previewBackUrl, setPreviewBackUrl] = useState<string | null>(null);
  const [previewRendering, setPreviewRendering] = useState(false);

  // Builder State
  const [builderSide, setBuilderSide] = useState<CardSide>("front");
  const [selectedElementId, setSelectedElementId] = useState<string | null>(
    null,
  );
  const [showBoundingBoxes, setShowBoundingBoxes] = useState(true);
  const [builderBusy, setBuilderBusy] = useState(false);
  const [addElementModalOpen, setAddElementModalOpen] = useState(false);
  const [newElementType, setNewElementType] =
    useState<ElementType>("static_text");
  const [newElementSourceKey, setNewElementSourceKey] =
    useState<IdCardElement["sourceKey"]>("static_text");
  const [newElementLabel, setNewElementLabel] =
    useState<string>("Teks Kustom Baru");
  const [newElementStaticVal, setNewElementStaticVal] =
    useState<string>("Teks Kustom SPPG");
  const builderCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Batch Print Modal
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchPrintMode, setBatchPrintMode] = useState<
    "front_only" | "back_only" | "duplex"
  >("front_only");
  const [batchPrintType, setBatchPrintType] = useState<"cr80" | "a4_sheet">(
    "a4_sheet",
  );

  // Load Data
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cardsRes, companyRes, templateRes] = await Promise.all([
        getDaftarIdCard({
          search: search.trim() || undefined,
          status: statusFilter === "all" ? undefined : statusFilter,
        }),
        getCompanyProfile().catch(() => null),
        getIdCardTemplate().catch(() => null),
      ]);
      setRows(cardsRes);
      if (companyRes) setCompanyProfile(companyRes);
      if (templateRes) {
        setTemplate((prev) => prev || templateRes);
        if (templateRes.elements.length > 0) {
          setSelectedElementId((prev) => prev || templateRes.elements[0].id);
        }
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Gagal memuat data ID card.",
      );
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => {
    if (hydrated && isAuthenticated && canAccessArea(user, "idcards")) {
      void loadData();
    }
  }, [hydrated, isAuthenticated, user, loadData]);

  // Filtered rows
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (statusFilter !== "all") {
        const s = String(r.idcard_status || "Belum");
        if (s !== statusFilter) return false;
      }
      return true;
    });
  }, [rows, statusFilter]);

  // Selection helpers
  const isAllSelected = useMemo(() => {
    if (filteredRows.length === 0) return false;
    return filteredRows.every((r) => selectedIds.has(String(r.id_unik)));
  }, [filteredRows, selectedIds]);

  const toggleSelectAll = () => {
    if (isAllSelected) {
      setSelectedIds(new Set());
    } else {
      const next = new Set<string>();
      for (const r of filteredRows) {
        next.add(String(r.id_unik));
      }
      setSelectedIds(next);
    }
  };

  const toggleSelectRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Render preview when modal opens
  useEffect(() => {
    if (!previewEmployee || !template) return;
    let cancelled = false;
    setPreviewRendering(true);

    Promise.all([
      renderIdCardSideToCanvas({
        template,
        side: "front",
        employee: previewEmployee,
        company: companyProfile,
      }),
      renderIdCardSideToCanvas({
        template,
        side: "back",
        employee: previewEmployee,
        company: companyProfile,
      }),
    ])
      .then(([front, back]) => {
        if (!cancelled) {
          setPreviewFrontUrl(front);
          setPreviewBackUrl(back);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Gagal me-render kartu.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewRendering(false);
      });

    return () => {
      cancelled = true;
    };
  }, [previewEmployee, template, companyProfile]);

  // Preload template assets for instant 60fps canvas drawing
  useEffect(() => {
    if (!template) return;
    const sampleEmp = rows[0] || {
      id_unik: "SPPG-2026-001",
      nama: "AHMAD FAUZI, S.Kom.",
      kode_karyawan: "SPPG-001",
      divisi: "Divisi Operasional & IT",
      jabatan_status: "Koordinator Tim",
      token_absensi: "DEMO_TOKEN_SPPG_2026",
    };
    void preloadCardAssets({
      template,
      company: companyProfile,
      employee: sampleEmp,
    });
  }, [template, companyProfile, rows]);

  // Render builder canvas synchronously / instant animation frame without flashing img tag
  useEffect(() => {
    const canvas = builderCanvasRef.current;
    if (!canvas || !template) return;

    const sampleEmp = rows[0] || {
      id_unik: "SPPG-2026-001",
      nama: "AHMAD FAUZI, S.Kom.",
      kode_karyawan: "SPPG-001",
      jenis_kelamin: "Laki-laki",
      divisi: "Divisi Operasional & IT",
      jabatan_status: "Koordinator Tim",
      token_absensi: "DEMO_TOKEN_SPPG_2026",
    };

    let animId: number;
    animId = requestAnimationFrame(() => {
      void drawIdCardToCanvas(canvas, {
        template,
        side: builderSide,
        employee: sampleEmp,
        company: companyProfile,
        selectedElementId,
        showBoundingBoxes,
      });
    });

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [
    template,
    builderSide,
    rows,
    companyProfile,
    selectedElementId,
    showBoundingBoxes,
  ]);

  // Single card action: Save PNG
  const handleSaveSinglePng = async (
    row: Record<string, unknown>,
    side: CardSide = "front",
  ) => {
    if (!template) return;
    const id = String(row.id_unik);
    const nama = String(row.nama || id);
    setWorkingId(id);
    try {
      const pngUrl = await renderIdCardSideToCanvas({
        template,
        side,
        employee: row,
        company: companyProfile,
      });

      const safeNama = nama.replace(/[/\\?%*:|"<>]/g, "-").trim();
      const res = await saveFileWithPicker(
        pngUrl,
        `id-card-${safeNama}-${side}.png`,
        {
          description: `Gambar ID Card (${side.toUpperCase()})`,
          accept: { "image/png": [".png"] },
        },
      );

      if (!res.cancelled) {
        await updateStatusIdCard({
          id_unik: id,
          idcard_status: "Berhasil",
          idcard_catatan: `PNG (${side}) disimpan`,
        });
        setMessage(`ID card ${nama} (${side}) berhasil disimpan.`);
        await loadData();
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "ID card gagal dibuat.",
      );
    } finally {
      setWorkingId(null);
    }
  };

  // Single card action: Direct Print CR80
  const handlePrintSingleDirect = async (row: Record<string, unknown>) => {
    if (!template) return;
    const id = String(row.id_unik);
    const nama = String(row.nama || id);
    setWorkingId(id);
    try {
      const frontPng = await renderIdCardSideToCanvas({
        template,
        side: "front",
        employee: row,
        company: companyProfile,
      });
      printSingleCard(frontPng, `ID Card - ${nama}`);
      await updateStatusIdCard({
        id_unik: id,
        idcard_status: "Berhasil",
        idcard_catatan: "Dicetak langsung dari aplikasi",
      });
      setMessage(`ID card ${nama} dikirim ke pencetakan.`);
      await loadData();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "ID card gagal dicetak.",
      );
    } finally {
      setWorkingId(null);
    }
  };

  // Batch Print Execution
  const handleExecuteBatchPrint = async () => {
    if (!template) return;
    const targetRows = rows.filter((r) => selectedIds.has(String(r.id_unik)));
    if (targetRows.length === 0) return;

    setBatchBusy(true);
    setBatchModalOpen(false);
    setMessage(
      `Sedang menyiapkan pencetakan untuk ${targetRows.length} kartu...`,
    );

    try {
      const renderedCards: {
        frontPng: string;
        backPng?: string;
        name: string;
      }[] = [];

      for (const row of targetRows) {
        const frontPng = await renderIdCardSideToCanvas({
          template,
          side: "front",
          employee: row,
          company: companyProfile,
        });

        let backPng: string | undefined;
        if (batchPrintMode === "back_only" || batchPrintMode === "duplex") {
          backPng = await renderIdCardSideToCanvas({
            template,
            side: "back",
            employee: row,
            company: companyProfile,
          });
        }

        renderedCards.push({
          frontPng,
          backPng,
          name: String(row.nama || row.id_unik),
        });

        // Update status
        await updateStatusIdCard({
          id_unik: String(row.id_unik),
          idcard_status: "Berhasil",
          idcard_catatan: `Batch Print (${batchPrintMode})`,
        });
      }

      if (batchPrintType === "a4_sheet") {
        printA4GridSheet(renderedCards, batchPrintMode);
      } else {
        // Direct print first one or loop
        if (renderedCards[0]) {
          printSingleCard(renderedCards[0].frontPng, "Batch ID Cards");
        }
      }

      setMessage(`Pencetakan ${targetRows.length} ID card berhasil disiapkan!`);
      await loadData();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Gagal mencetak batch ID card.",
      );
    } finally {
      setBatchBusy(false);
    }
  };

  // Builder actions
  const handleSaveTemplate = async () => {
    if (!template) return;
    setBuilderBusy(true);
    try {
      const saved = await saveIdCardTemplate(template);
      setTemplate(saved);
      setMessage(
        "Konfigurasi Template ID Card berhasil disimpan & disinkronkan.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Gagal menyimpan template ID card.",
      );
    } finally {
      setBuilderBusy(false);
    }
  };

  const handleCustomBgUpload = async (
    event: ChangeEvent<HTMLInputElement>,
    side: CardSide,
  ) => {
    const file = event.target.files?.[0];
    if (!file || !template) return;

    try {
      setBuilderBusy(true);
      const isPortrait = template.orientation === "portrait";
      const targetWidth = isPortrait ? 638 : 1011;
      const targetHeight = isPortrait ? 1011 : 638;

      const optimized = await optimizeImageFile(file, {
        maxWidth: targetWidth,
        maxHeight: targetHeight,
        quality: 0.92,
        mimeType: "image/jpeg",
        fit: "exact",
      });

      setTemplate({
        ...template,
        [side === "front" ? "frontBgUrl" : "backBgUrl"]: optimized.dataUrl,
      });

      setMessage(
        `Background sisi ${side === "front" ? "depan" : "belakang"} berhasil dioptimasi dari ${formatBytes(optimized.originalSizeBytes)} menjadi ${formatBytes(optimized.optimizedSizeBytes)} (${optimized.width}×${optimized.height} px HD 300 DPI).`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Gagal mengoptimasi gambar background.",
      );
    } finally {
      setBuilderBusy(false);
      event.target.value = "";
    }
  };

  const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = builderCanvasRef.current;
    if (!canvas || !template) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clickX = (event.clientX - rect.left) * scaleX;
    const clickY = (event.clientY - rect.top) * scaleY;

    // Filter elemen aktif pada sisi builder saat ini
    const currentElements = (template.elements || []).filter(
      (el) => el.side === builderSide && el.visible !== false,
    );

    const fontMultiplier = canvas.width / 360;

    // Loop terbalik (elemen yang berada di layer paling atas dicek terlebih dahulu)
    for (let i = currentElements.length - 1; i >= 0; i--) {
      const el = currentElements[i];
      const elX = (el.x / 100) * canvas.width;
      const elY = (el.y / 100) * canvas.height;
      const fontSizePx = Math.max(10, Math.round(el.fontSize * fontMultiplier));

      let boxW = el.width ? (el.width / 100) * canvas.width : 0;
      let boxH = el.height ? (el.height / 100) * canvas.height : 0;

      if (el.type === "qr_code") {
        boxW = boxW > 0 ? boxW : 180;
        boxH = boxH > 0 ? boxH : 180;
      } else if (el.type === "company_logo" || el.type === "photo") {
        boxW = boxW > 0 ? boxW : 100;
        boxH = boxH > 0 ? boxH : 100;
      } else {
        if (boxW === 0) {
          boxW = Math.min(canvas.width - elX - 10, fontSizePx * 10);
        }
        if (boxH === 0) {
          boxH = fontSizePx * 1.5;
        }
      }

      let drawX = elX;
      if (el.textAlign === "center") {
        drawX = elX - boxW / 2;
      } else if (el.textAlign === "right") {
        drawX = elX - boxW;
      }

      // Hit-test dengan toleransi klik 6px
      if (
        clickX >= drawX - 6 &&
        clickX <= drawX + boxW + 6 &&
        clickY >= elY - 6 &&
        clickY <= elY + boxH + 6
      ) {
        setSelectedElementId(el.id);
        return;
      }
    }
  };

  const handleUpdateSelectedElement = (updates: Partial<IdCardElement>) => {
    if (!template || !selectedElementId) return;
    setTemplate({
      ...template,
      elements: template.elements.map((el) =>
        el.id === selectedElementId ? { ...el, ...updates } : el,
      ),
    });
  };

  const handleToggleElementVisible = (elementId: string) => {
    if (!template) return;
    setTemplate({
      ...template,
      elements: template.elements.map((el) => {
        if (el.id === elementId) {
          return { ...el, visible: el.visible === false };
        }
        return el;
      }),
    });
  };

  const handleSwitchElementSide = (elementId: string, targetSide: CardSide) => {
    if (!template) return;
    setTemplate({
      ...template,
      elements: template.elements.map((el) => {
        if (el.id === elementId) {
          return { ...el, side: targetSide };
        }
        return el;
      }),
    });
    setBuilderSide(targetSide);
    setSelectedElementId(elementId);
  };

  const handleAddNewElement = (
    type: ElementType,
    sourceKey: IdCardElement["sourceKey"],
    label: string,
    staticValue?: string,
  ) => {
    if (!template) return;
    const newId = `el-custom-${Date.now()}`;
    const newEl: IdCardElement = {
      id: newId,
      type,
      side: builderSide,
      sourceKey,
      staticValue:
        staticValue || (type === "static_text" ? "Teks Baru" : undefined),
      label,
      x: 10,
      y: 50,
      width:
        type === "qr_code" || type === "company_logo" || type === "photo"
          ? 20
          : undefined,
      height:
        type === "qr_code" || type === "company_logo" || type === "photo"
          ? 20
          : undefined,
      fontSize: 12,
      fontWeight: "normal",
      color: type === "qr_code" ? "#000000" : "#ffffff",
      textAlign: "left",
      isUppercase: false,
      visible: true,
    };
    setTemplate({
      ...template,
      elements: [...template.elements, newEl],
    });
    setSelectedElementId(newId);
    setAddElementModalOpen(false);
    setMessage(
      `Elemen "${label}" berhasil ditambahkan ke sisi ${builderSide === "front" ? "Depan" : "Belakang"}.`,
    );
  };

  const handleDeleteElement = (elementId: string) => {
    if (!template) return;
    const remaining = template.elements.filter((el) => el.id !== elementId);
    setTemplate({
      ...template,
      elements: remaining,
    });
    if (selectedElementId === elementId) {
      const nextEl = remaining.find((el) => el.side === builderSide);
      setSelectedElementId(nextEl ? nextEl.id : null);
    }
    setMessage("Elemen kustom berhasil dihapus.");
  };

  const handleResetToDefault = () => {
    if (!template) return;
    setTemplate({
      ...template,
      elements: DEFAULT_ID_CARD_ELEMENTS,
    });
    setSelectedElementId("el-emp-name");
    setMessage("Tata letak elemen ID Card berhasil di-reset ke standar SPPG.");
  };

  const selectedElement = useMemo(() => {
    return template?.elements.find((el) => el.id === selectedElementId) || null;
  }, [template, selectedElementId]);

  if (!hydrated || authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 p-10 text-slate-300">
        Memuat data ID Card...
      </div>
    );
  }
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "idcards")) redirect("/forbidden");

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Header */}
      <PageHeader
        eyebrow="Identitas & Kartu Personil"
        title="Dynamic ID Card Builder & Batch Print"
        description="Sistem generator ID Card beresolusi tinggi (CR80 300 DPI) dengan visual template builder, barcode QR otomatis, dan cetak lembar A4 dengan tanda potong."
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveTab("cards")}
              className={`rounded-xl px-4 py-2 text-xs font-bold transition ${
                activeTab === "cards"
                  ? "bg-sky-400 text-slate-950 shadow-md shadow-sky-950/20"
                  : "border border-white/10 bg-slate-900 text-slate-300 hover:bg-slate-800"
              }`}
            >
              <span className="flex items-center gap-2">
                <Icon name="users" className="size-3.5" />
                Daftar & Cetak Kartu
              </span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("builder")}
              className={`rounded-xl px-4 py-2 text-xs font-bold transition ${
                activeTab === "builder"
                  ? "bg-sky-400 text-slate-950 shadow-md shadow-sky-950/20"
                  : "border border-white/10 bg-slate-900 text-slate-300 hover:bg-slate-800"
              }`}
            >
              <span className="flex items-center gap-2">
                <Icon name="palette" className="size-3.5" />
                Desain Template
              </span>
            </button>
          </div>
        }
      />

      {/* Notifications */}
      {message ? (
        <FeedbackBanner tone="success" onDismiss={() => setMessage(null)}>
          {message}
        </FeedbackBanner>
      ) : null}
      {error ? (
        <FeedbackBanner tone="error" onDismiss={() => setError(null)}>
          {error}
        </FeedbackBanner>
      ) : null}

      {/* TAB 1: DAFTAR & CETAK KARTU */}
      {activeTab === "cards" ? (
        <div className="space-y-5">
          {/* Filter & Batch Actions Bar */}
          <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-slate-900/80 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari nama karyawan, NIK, atau divisi..."
                className="min-h-10 flex-1 min-w-[200px] rounded-xl border border-white/10 bg-slate-950 px-3 text-xs text-white outline-none focus:border-sky-400"
              />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="min-h-10 rounded-xl border border-white/10 bg-slate-950 px-3 text-xs text-white outline-none focus:border-sky-400"
              >
                <option value="all">Semua Status</option>
                <option value="Belum">Belum Dicetak</option>
                <option value="Berhasil">Sudah Dicetak</option>
              </select>
            </div>

            {selectedIds.size > 0 ? (
              <div className="flex items-center gap-2 animate-in fade-in">
                <span className="text-xs font-bold text-sky-300">
                  {selectedIds.size} dipilih
                </span>
                <button
                  type="button"
                  onClick={() => setBatchModalOpen(true)}
                  disabled={batchBusy}
                  className="rounded-xl bg-sky-400 px-4 py-2 text-xs font-black text-slate-950 shadow-md hover:bg-sky-300 disabled:opacity-50 inline-flex items-center gap-2"
                >
                  <Icon name="scanner" className="size-3.5" />
                  <span>Cetak Pilihan (Batch)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="rounded-xl border border-white/10 bg-slate-800 px-3 py-2 text-xs font-bold text-slate-300 hover:bg-slate-700"
                >
                  Batal
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={toggleSelectAll}
                className="rounded-xl border border-white/10 bg-slate-800 px-3 py-2 text-xs font-bold text-slate-300 hover:bg-slate-700 inline-flex items-center gap-2"
              >
                <Icon name="check" className="size-3.5" />
                <span>Pilih Semua ({filteredRows.length})</span>
              </button>
            )}
          </div>

          {/* Cards Grid */}
          {loading ? (
            <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-12 text-center text-slate-400">
              Memuat data karyawan...
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-12 text-center text-slate-400">
              Tidak ada data ID Card yang cocok dengan pencarian.
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredRows.map((row) => {
                const id = String(row.id_unik);
                const isSelected = selectedIds.has(id);
                const isWorking = workingId === id;
                const status = String(row.idcard_status || "Belum");

                return (
                  <div
                    key={id}
                    className={`group relative flex flex-col justify-between rounded-2xl border transition-all p-5 ${
                      isSelected
                        ? "border-sky-400/80 bg-sky-950/20 shadow-lg shadow-sky-950/30"
                        : "border-white/10 bg-gradient-to-br from-slate-900/90 to-slate-950 hover:border-white/20"
                    }`}
                  >
                    {/* Checkbox Header */}
                    <div className="flex items-start justify-between gap-2">
                      <label className="flex items-center gap-2.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelectRow(id)}
                          className="size-4 rounded border-slate-700 bg-slate-900 text-sky-400 focus:ring-sky-400"
                        />
                        <span className="font-mono text-xs font-bold text-sky-400">
                          {String(row.kode_karyawan || id)}
                        </span>
                      </label>
                      <StatusBadge
                        tone={status === "Berhasil" ? "info" : "neutral"}
                      >
                        {status === "Berhasil" ? "Tercetak" : "Belum Cetak"}
                      </StatusBadge>
                    </div>

                    {/* Employee Info */}
                    <div className="mt-3 space-y-1">
                      <h3 className="text-base font-black text-white group-hover:text-sky-200 transition">
                        {String(row.nama)}
                      </h3>
                      <p className="text-xs font-semibold text-sky-300">
                        {String(row.jabatan_status || "-")}
                      </p>
                      <p className="text-xs text-slate-400">
                        {String(row.divisi || "-")}
                      </p>
                    </div>

                    {/* QR Code Status */}
                    <div className="mt-4 flex items-center justify-between rounded-xl border border-white/5 bg-slate-950/60 px-3 py-2 text-[11px]">
                      <span className="text-slate-400">Token QR Absensi</span>
                      <span
                        className={`font-mono font-bold ${
                          row.token_absensi
                            ? "text-emerald-400"
                            : "text-amber-400"
                        }`}
                      >
                        {row.token_absensi ? "Siap" : "Belum Terbit"}
                      </span>
                    </div>

                    {/* Action Buttons */}
                    <div className="mt-5 flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setPreviewEmployee(row);
                          setPreviewSide("front");
                        }}
                        className="flex-1 rounded-xl border border-white/10 bg-white/5 py-2 text-xs font-bold text-white hover:bg-white/10 transition"
                      >
                        Pratinjau
                      </button>
                      <button
                        type="button"
                        disabled={isWorking}
                        onClick={() => handlePrintSingleDirect(row)}
                        className="rounded-xl bg-sky-400 px-3.5 py-2 text-xs font-black text-slate-950 hover:bg-sky-300 disabled:opacity-50 transition"
                      >
                        {isWorking ? "..." : "Cetak"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {/* TAB 2: VISUAL TEMPLATE BUILDER */}
      {activeTab === "builder" && template ? (
        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          {/* Left: Live Preview Canvas */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">
                  Live Realtime Canvas Preview
                </h2>
                <p className="text-[11px] text-slate-500">
                  Perubahan posisi, teks, dan ukuran langsung terlihat tanpa
                  jeda.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowBoundingBoxes(!showBoundingBoxes)}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-bold transition flex items-center gap-1.5 border ${
                    showBoundingBoxes
                      ? "border-sky-400 bg-sky-500/15 text-sky-300"
                      : "border-white/10 bg-slate-800 text-slate-400 hover:text-white"
                  }`}
                  title="Tampilkan / Sembunyikan garis pembatas kotak elemen di preview"
                >
                  <Icon name="palette" className="size-3.5" />
                  <span>
                    {showBoundingBoxes ? "Garis Box: ON" : "Garis Box: OFF"}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setBuilderSide("front")}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                    builderSide === "front"
                      ? "bg-sky-400 text-slate-950"
                      : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  Sisi Depan
                </button>
                <button
                  type="button"
                  onClick={() => setBuilderSide("back")}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                    builderSide === "back"
                      ? "bg-sky-400 text-slate-950"
                      : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  Sisi Belakang
                </button>
              </div>
            </div>

            <div className="grid min-h-[380px] place-items-center rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-inner">
              <div
                className={`relative rounded-2xl overflow-hidden shadow-2xl shadow-black/80 border border-white/20 transition-all ${
                  template.orientation === "portrait"
                    ? "w-[240px] h-[380px]"
                    : "w-[380px] h-[240px]"
                }`}
              >
                <canvas
                  ref={builderCanvasRef}
                  onClick={handleCanvasClick}
                  className="size-full object-contain bg-slate-900 cursor-pointer"
                  title="Klik elemen mana saja pada kartu untuk langsung memilih & mengeditnya"
                />
              </div>
              <div className="mt-2 text-center text-[11px] text-slate-400">
                💡 <span className="font-semibold text-slate-300">Tips:</span>{" "}
                Klik langsung teks, foto, atau QR code di kartu untuk
                memilihnya.
              </div>
            </div>

            {/* Template Orientasi & Dimensi */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() =>
                  setTemplate({ ...template, orientation: "landscape" })
                }
                className={`rounded-2xl border p-3 text-xs font-bold transition text-left ${
                  template.orientation === "landscape"
                    ? "border-sky-400 bg-sky-400/10 text-white"
                    : "border-white/10 bg-slate-950 text-slate-400 hover:bg-slate-800"
                }`}
              >
                <div className="font-bold">Landscape (Mendatar)</div>
                <div className="text-[10px] text-slate-500">
                  Standar CR80 85.6 × 54 mm
                </div>
              </button>
              <button
                type="button"
                onClick={() =>
                  setTemplate({ ...template, orientation: "portrait" })
                }
                className={`rounded-2xl border p-3 text-xs font-bold transition text-left ${
                  template.orientation === "portrait"
                    ? "border-sky-400 bg-sky-400/10 text-white"
                    : "border-white/10 bg-slate-950 text-slate-400 hover:bg-slate-800"
                }`}
              >
                <div className="font-bold">Portrait (Tegak)</div>
                <div className="text-[10px] text-slate-500">
                  Standar CR80 54 × 85.6 mm
                </div>
              </button>
            </div>

            {/* Background Image Upload for active side */}
            <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white">
                  Background Desain (Sisi{" "}
                  {builderSide === "front" ? "Depan" : "Belakang"})
                </span>
                {(
                  builderSide === "front"
                    ? template.frontBgUrl
                    : template.backBgUrl
                ) ? (
                  <button
                    type="button"
                    onClick={() =>
                      setTemplate({
                        ...template,
                        [builderSide === "front" ? "frontBgUrl" : "backBgUrl"]:
                          undefined,
                      })
                    }
                    className="text-[11px] text-rose-400 hover:underline"
                  >
                    Hapus Custom Background
                  </button>
                ) : null}
              </div>
              <label className="inline-flex min-h-9 cursor-pointer items-center justify-center gap-2 rounded-xl bg-slate-800 px-3 text-xs font-bold text-white border border-white/10 hover:bg-slate-700 w-full">
                <Icon name="upload" className="size-3.5" />
                Upload Background Desain Baru (300 DPI)
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => handleCustomBgUpload(e, builderSide)}
                  className="sr-only"
                />
              </label>
              <p className="text-[11px] text-slate-500">
                Disarankan rasio 85.6:54 (1011×638 px) PNG/JPEG tanpa teks agar
                dapat diisi dinamis.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-900 p-4">
              <button
                type="button"
                onClick={handleResetToDefault}
                className="rounded-xl border border-white/10 bg-slate-800 px-3.5 py-2 text-xs font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
              >
                Reset ke Standar SPPG
              </button>
              <button
                type="button"
                disabled={builderBusy}
                onClick={handleSaveTemplate}
                className="rounded-xl bg-emerald-400 px-5 py-2 text-xs font-black text-slate-950 shadow-md hover:bg-emerald-300 disabled:opacity-50 inline-flex items-center gap-2"
              >
                <Icon name="check" className="size-4" />
                <span>
                  {builderBusy ? "Menyimpan..." : "Simpan Pengaturan Template"}
                </span>
              </button>
            </div>
          </div>

          {/* Right: Controls & Element Toolbar */}
          <div className="space-y-5 rounded-3xl border border-white/10 bg-slate-900/90 p-5 sm:p-6 transition-all">
            {/* Header Toolbar (Selalu Muncul) */}
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-black text-white">
                  Tata Letak Elemen Kartu
                </h3>
                <p className="text-xs text-slate-400">
                  Sisi Aktif:{" "}
                  <strong className="text-sky-300">
                    {builderSide === "front" ? "Sisi Depan" : "Sisi Belakang"}
                  </strong>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAddElementModalOpen(true)}
                className="rounded-xl bg-sky-400 px-3.5 py-1.5 text-xs font-black text-slate-950 hover:bg-sky-300 inline-flex items-center gap-1.5 shadow"
              >
                <Icon name="add" className="size-3.5" />
                <span>Tambah Elemen</span>
              </button>
            </div>

            {/* FOCUSED ELEMENT INSPECTOR (Tampil langsung di paling atas saat ada elemen yang dipilih) */}
            {selectedElement ? (
              <div className="space-y-4 rounded-3xl border border-sky-400/40 bg-slate-950 p-5 shadow-2xl shadow-sky-950/40">
                <div className="flex items-center justify-between border-b border-white/10 pb-3">
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-7 items-center justify-center rounded-xl bg-sky-400/20 text-sky-300">
                      <Icon name="palette" className="size-4" />
                    </span>
                    <div>
                      <div className="text-[10px] font-black uppercase tracking-wider text-sky-400">
                        Pengaturan Elemen Terpilih
                      </div>
                      <div className="text-sm font-black text-white">
                        {selectedElement.label}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedElement.id.startsWith("el-custom-") ? (
                      <button
                        type="button"
                        onClick={() => handleDeleteElement(selectedElement.id)}
                        className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-bold text-rose-300 hover:bg-rose-500/20"
                      >
                        Hapus Elemen
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setSelectedElementId(null)}
                      className="rounded-xl border border-white/10 bg-slate-800 px-3 py-1 text-xs font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition flex items-center gap-1"
                      title="Selesai mengedit elemen ini"
                    >
                      <span>✕ Selesai</span>
                    </button>
                  </div>
                </div>

                {/* Status Visibilitas & Sisi Penempatan */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-400">
                      Status di Kartu
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        handleToggleElementVisible(selectedElement.id)
                      }
                      className={`w-full rounded-xl p-2 text-xs font-bold transition text-center border ${
                        selectedElement.visible !== false
                          ? "border-emerald-400 bg-emerald-500/10 text-emerald-300"
                          : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                      }`}
                    >
                      {selectedElement.visible !== false
                        ? "✓ Ditampilkan di Kartu"
                        : "✗ Disembunyikan / Nonaktif"}
                    </button>
                  </div>

                  <label className="space-y-1 text-xs font-medium text-slate-400">
                    Sisi Penempatan
                    <select
                      value={selectedElement.side}
                      onChange={(e) => {
                        const newSide = e.target.value as CardSide;
                        handleSwitchElementSide(selectedElement.id, newSide);
                      }}
                      className="min-h-9 w-full rounded-xl border border-white/10 bg-slate-900 px-2 text-xs text-white"
                    >
                      <option value="front">Sisi Depan</option>
                      <option value="back">Sisi Belakang</option>
                    </select>
                  </label>
                </div>

                {/* Custom Label & Static text */}
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1 text-xs font-medium text-slate-400">
                    Nama Label Elemen
                    <input
                      type="text"
                      value={selectedElement.label}
                      onChange={(e) =>
                        handleUpdateSelectedElement({ label: e.target.value })
                      }
                      className="min-h-9 w-full rounded-xl border border-white/10 bg-slate-900 px-3 text-xs text-white"
                    />
                  </label>
                  {selectedElement.type === "static_text" ? (
                    <label className="space-y-1 text-xs font-medium text-slate-400">
                      Isi Teks Statis
                      <input
                        type="text"
                        value={selectedElement.staticValue || ""}
                        onChange={(e) =>
                          handleUpdateSelectedElement({
                            staticValue: e.target.value,
                          })
                        }
                        className="min-h-9 w-full rounded-xl border border-white/10 bg-slate-900 px-3 text-xs text-white"
                      />
                    </label>
                  ) : null}
                </div>

                {/* Posisi X & Posisi Y Sliders + Precision Steppers */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Posisi X */}
                  <div className="space-y-2 rounded-2xl border border-white/5 bg-slate-900/60 p-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-300">
                        Posisi X (Mendatar)
                      </span>
                      <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-slate-950 px-2 py-0.5">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.1}
                          value={selectedElement.x}
                          onChange={(e) =>
                            handleUpdateSelectedElement({
                              x: Math.round(Number(e.target.value) * 10) / 10,
                            })
                          }
                          className="w-12 bg-transparent text-right font-mono text-xs font-bold text-sky-400 focus:outline-none"
                        />
                        <span className="text-[10px] font-bold text-slate-400">
                          %
                        </span>
                      </div>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={0.1}
                      value={selectedElement.x}
                      onChange={(e) =>
                        handleUpdateSelectedElement({
                          x: Math.round(Number(e.target.value) * 10) / 10,
                        })
                      }
                      className="w-full accent-sky-400 cursor-pointer"
                    />
                    <div className="grid grid-cols-4 gap-1 pt-0.5">
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedElement({
                            x: Math.max(
                              0,
                              Math.round((selectedElement.x - 1) * 10) / 10,
                            ),
                          })
                        }
                        className="rounded-lg bg-slate-800/90 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                      >
                        -1%
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedElement({
                            x: Math.max(
                              0,
                              Math.round((selectedElement.x - 0.1) * 10) / 10,
                            ),
                          })
                        }
                        className="rounded-lg bg-slate-800/90 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                      >
                        -0.1%
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedElement({
                            x: Math.min(
                              100,
                              Math.round((selectedElement.x + 0.1) * 10) / 10,
                            ),
                          })
                        }
                        className="rounded-lg bg-slate-800/90 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                      >
                        +0.1%
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedElement({
                            x: Math.min(
                              100,
                              Math.round((selectedElement.x + 1) * 10) / 10,
                            ),
                          })
                        }
                        className="rounded-lg bg-slate-800/90 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                      >
                        +1%
                      </button>
                    </div>
                  </div>

                  {/* Posisi Y */}
                  <div className="space-y-2 rounded-2xl border border-white/5 bg-slate-900/60 p-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-300">
                        Posisi Y (Tegak)
                      </span>
                      <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-slate-950 px-2 py-0.5">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.1}
                          value={selectedElement.y}
                          onChange={(e) =>
                            handleUpdateSelectedElement({
                              y: Math.round(Number(e.target.value) * 10) / 10,
                            })
                          }
                          className="w-12 bg-transparent text-right font-mono text-xs font-bold text-sky-400 focus:outline-none"
                        />
                        <span className="text-[10px] font-bold text-slate-400">
                          %
                        </span>
                      </div>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={0.1}
                      value={selectedElement.y}
                      onChange={(e) =>
                        handleUpdateSelectedElement({
                          y: Math.round(Number(e.target.value) * 10) / 10,
                        })
                      }
                      className="w-full accent-sky-400 cursor-pointer"
                    />
                    <div className="grid grid-cols-4 gap-1 pt-0.5">
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedElement({
                            y: Math.max(
                              0,
                              Math.round((selectedElement.y - 1) * 10) / 10,
                            ),
                          })
                        }
                        className="rounded-lg bg-slate-800/90 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                      >
                        -1%
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedElement({
                            y: Math.max(
                              0,
                              Math.round((selectedElement.y - 0.1) * 10) / 10,
                            ),
                          })
                        }
                        className="rounded-lg bg-slate-800/90 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                      >
                        -0.1%
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedElement({
                            y: Math.min(
                              100,
                              Math.round((selectedElement.y + 0.1) * 10) / 10,
                            ),
                          })
                        }
                        className="rounded-lg bg-slate-800/90 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                      >
                        +0.1%
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedElement({
                            y: Math.min(
                              100,
                              Math.round((selectedElement.y + 1) * 10) / 10,
                            ),
                          })
                        }
                        className="rounded-lg bg-slate-800/90 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                      >
                        +1%
                      </button>
                    </div>
                  </div>
                </div>

                {/* Width & Height (for QR / Image / bounded boxes) */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Lebar Box */}
                  <div className="space-y-2 rounded-2xl border border-white/5 bg-slate-900/60 p-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-300">
                        Lebar Box
                      </span>
                      <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-slate-950 px-2 py-0.5">
                        <input
                          type="number"
                          min={2}
                          max={100}
                          step={0.5}
                          value={selectedElement.width || 20}
                          onChange={(e) =>
                            handleUpdateSelectedElement({
                              width:
                                Math.round(Number(e.target.value) * 10) / 10,
                            })
                          }
                          className="w-12 bg-transparent text-right font-mono text-xs font-bold text-sky-400 focus:outline-none"
                        />
                        <span className="text-[10px] font-bold text-slate-400">
                          %
                        </span>
                      </div>
                    </div>
                    <input
                      type="range"
                      min={2}
                      max={100}
                      step={0.5}
                      value={selectedElement.width || 20}
                      onChange={(e) =>
                        handleUpdateSelectedElement({
                          width: Math.round(Number(e.target.value) * 10) / 10,
                        })
                      }
                      className="w-full accent-sky-400 cursor-pointer"
                    />
                    <div className="grid grid-cols-4 gap-1 pt-0.5">
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedElement({
                            width: Math.max(
                              2,
                              Math.round(
                                ((selectedElement.width || 20) - 5) * 10,
                              ) / 10,
                            ),
                          })
                        }
                        className="rounded-lg bg-slate-800/90 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                      >
                        -5%
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedElement({
                            width: Math.max(
                              2,
                              Math.round(
                                ((selectedElement.width || 20) - 1) * 10,
                              ) / 10,
                            ),
                          })
                        }
                        className="rounded-lg bg-slate-800/90 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                      >
                        -1%
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedElement({
                            width: Math.min(
                              100,
                              Math.round(
                                ((selectedElement.width || 20) + 1) * 10,
                              ) / 10,
                            ),
                          })
                        }
                        className="rounded-lg bg-slate-800/90 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                      >
                        +1%
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedElement({
                            width: Math.min(
                              100,
                              Math.round(
                                ((selectedElement.width || 20) + 5) * 10,
                              ) / 10,
                            ),
                          })
                        }
                        className="rounded-lg bg-slate-800/90 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                      >
                        +5%
                      </button>
                    </div>
                  </div>

                  {/* Tinggi Box */}
                  <div className="space-y-2 rounded-2xl border border-white/5 bg-slate-900/60 p-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-300">
                        Tinggi Box
                      </span>
                      <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-slate-950 px-2 py-0.5">
                        <input
                          type="number"
                          min={2}
                          max={100}
                          step={0.5}
                          value={selectedElement.height || 20}
                          onChange={(e) =>
                            handleUpdateSelectedElement({
                              height:
                                Math.round(Number(e.target.value) * 10) / 10,
                            })
                          }
                          className="w-12 bg-transparent text-right font-mono text-xs font-bold text-sky-400 focus:outline-none"
                        />
                        <span className="text-[10px] font-bold text-slate-400">
                          %
                        </span>
                      </div>
                    </div>
                    <input
                      type="range"
                      min={2}
                      max={100}
                      step={0.5}
                      value={selectedElement.height || 20}
                      onChange={(e) =>
                        handleUpdateSelectedElement({
                          height: Math.round(Number(e.target.value) * 10) / 10,
                        })
                      }
                      className="w-full accent-sky-400 cursor-pointer"
                    />
                    <div className="grid grid-cols-4 gap-1 pt-0.5">
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedElement({
                            height: Math.max(
                              2,
                              Math.round(
                                ((selectedElement.height || 20) - 5) * 10,
                              ) / 10,
                            ),
                          })
                        }
                        className="rounded-lg bg-slate-800/90 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                      >
                        -5%
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedElement({
                            height: Math.max(
                              2,
                              Math.round(
                                ((selectedElement.height || 20) - 1) * 10,
                              ) / 10,
                            ),
                          })
                        }
                        className="rounded-lg bg-slate-800/90 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                      >
                        -1%
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedElement({
                            height: Math.min(
                              100,
                              Math.round(
                                ((selectedElement.height || 20) + 1) * 10,
                              ) / 10,
                            ),
                          })
                        }
                        className="rounded-lg bg-slate-800/90 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                      >
                        +1%
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedElement({
                            height: Math.min(
                              100,
                              Math.round(
                                ((selectedElement.height || 20) + 5) * 10,
                              ) / 10,
                            ),
                          })
                        }
                        className="rounded-lg bg-slate-800/90 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                      >
                        +5%
                      </button>
                    </div>
                  </div>
                </div>

                {/* Typography & Styling */}
                <div className="grid grid-cols-3 gap-3">
                  <label className="space-y-1 text-xs font-medium text-slate-400">
                    Ukuran Font (pt)
                    <input
                      type="number"
                      min={6}
                      max={48}
                      value={selectedElement.fontSize}
                      onChange={(e) =>
                        handleUpdateSelectedElement({
                          fontSize: Number(e.target.value),
                        })
                      }
                      className="min-h-9 w-full rounded-xl border border-white/10 bg-slate-900 px-2 text-xs text-white"
                    />
                  </label>
                  <label className="space-y-1 text-xs font-medium text-slate-400">
                    Warna Teks / QR
                    <input
                      type="color"
                      value={selectedElement.color || "#ffffff"}
                      onChange={(e) =>
                        handleUpdateSelectedElement({ color: e.target.value })
                      }
                      className="h-9 w-full cursor-pointer rounded-xl border border-white/10 bg-slate-900 p-1"
                    />
                  </label>
                  <label className="space-y-1 text-xs font-medium text-slate-400">
                    Huruf Kapital
                    <select
                      value={selectedElement.isUppercase ? "yes" : "no"}
                      onChange={(e) =>
                        handleUpdateSelectedElement({
                          isUppercase: e.target.value === "yes",
                        })
                      }
                      className="min-h-9 w-full rounded-xl border border-white/10 bg-slate-900 px-2 text-xs text-white"
                    >
                      <option value="yes">KAPITAL</option>
                      <option value="no">Normal</option>
                    </select>
                  </label>
                </div>

                {/* Perataan Teks (Alignment) */}
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-400">
                    Perataan Teks
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {(["left", "center", "right"] as const).map((align) => (
                      <button
                        key={align}
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedElement({ textAlign: align })
                        }
                        className={`rounded-xl py-1.5 text-xs font-bold capitalize transition border ${
                          (selectedElement.textAlign || "left") === align
                            ? "border-sky-400 bg-sky-400/10 text-sky-300"
                            : "border-white/5 bg-slate-900 text-slate-400 hover:bg-slate-800"
                        }`}
                      >
                        {align === "left"
                          ? "Kiri"
                          : align === "center"
                            ? "Tengah"
                            : "Kanan"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {/* Element Selector List for active side (Selalu Muncul) */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>
                  Daftar Elemen (Sisi{" "}
                  {builderSide === "front" ? "Depan" : "Belakang"}):
                </span>
                <span className="text-[11px] text-slate-500">
                  Klik elemen untuk memilih & mengedit posisinya
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto rounded-2xl border border-white/10 bg-slate-950 p-2.5">
                {template.elements
                  .filter((el) => el.side === builderSide)
                  .map((el) => {
                    const isSelected = selectedElementId === el.id;
                    const isVisible = el.visible !== false;
                    return (
                      <div
                        key={el.id}
                        className={`flex items-center justify-between rounded-xl border p-2 text-xs transition ${
                          isSelected
                            ? "border-sky-400 bg-sky-500/10 text-white"
                            : "border-white/5 bg-slate-900 text-slate-300 hover:bg-slate-800"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedElementId(el.id)}
                          className="flex-1 text-left font-bold truncate pr-2"
                        >
                          <div className="truncate">{el.label}</div>
                          <div className="text-[10px] font-normal text-slate-500">
                            Pos ({el.x}%, {el.y}%)
                          </div>
                        </button>

                        {/* Visibility Toggle Button */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleElementVisible(el.id);
                          }}
                          title={
                            isVisible
                              ? "Elemen aktif (klik untuk menyembunyikan)"
                              : "Elemen disembunyikan (klik untuk mengaktifkan)"
                          }
                          className={`rounded-lg px-2 py-1 text-[10px] font-bold transition flex items-center gap-1 ${
                            isVisible
                              ? "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30"
                              : "bg-slate-800 text-slate-500 hover:bg-slate-700"
                          }`}
                        >
                          <Icon
                            name={isVisible ? "eye" : "eye-off"}
                            className="size-3"
                          />
                          <span>{isVisible ? "Aktif" : "Mati"}</span>
                        </button>
                      </div>
                    );
                  })}
              </div>
            </div>

            {/* Elements on opposite side helper (Selalu Muncul) */}
            {template.elements.some((el) => el.side !== builderSide) ? (
              <div className="rounded-2xl border border-white/5 bg-slate-950/40 p-3 space-y-2">
                <div className="text-[11px] font-bold text-slate-400">
                  Elemen di Sisi Sebaliknya (
                  {builderSide === "front" ? "Sisi Belakang" : "Sisi Depan"}):
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {template.elements
                    .filter((el) => el.side !== builderSide)
                    .map((el) => (
                      <button
                        key={el.id}
                        type="button"
                        onClick={() =>
                          handleSwitchElementSide(el.id, builderSide)
                        }
                        title={`Klik untuk memindahkan "${el.label}" ke Sisi ${builderSide === "front" ? "Depan" : "Belakang"}`}
                        className="rounded-lg border border-white/10 bg-slate-900 px-2.5 py-1 text-[11px] text-slate-300 hover:border-sky-400 hover:text-white transition inline-flex items-center gap-1"
                      >
                        <span>{el.label}</span>
                        <span className="text-[9px] text-sky-400">
                          (Pindahkan ke Sisi Ini)
                        </span>
                      </button>
                    ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* SINGLE CARD PREVIEW MODAL */}
      {previewEmployee ? (
        <Modal
          titleId="preview-card-dialog"
          onClose={() => setPreviewEmployee(null)}
          title={`Kartu Identitas - ${String(previewEmployee.nama)}`}
        >
          <div className="space-y-6">
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => setPreviewSide("front")}
                className={`rounded-xl px-4 py-2 text-xs font-bold transition ${
                  previewSide === "front"
                    ? "bg-sky-400 text-slate-950"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                Sisi Depan
              </button>
              <button
                type="button"
                onClick={() => setPreviewSide("back")}
                className={`rounded-xl px-4 py-2 text-xs font-bold transition ${
                  previewSide === "back"
                    ? "bg-sky-400 text-slate-950"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                Sisi Belakang
              </button>
            </div>

            <div className="grid min-h-[300px] place-items-center rounded-2xl border border-white/10 bg-slate-950 p-4">
              {previewRendering ? (
                <div className="text-xs text-sky-300 animate-pulse">
                  Me-render kartu resolusi tinggi...
                </div>
              ) : (
                /* biome-ignore lint/performance/noImgElement: Data URL preview */
                <img
                  src={
                    (previewSide === "front"
                      ? previewFrontUrl
                      : previewBackUrl) || ""
                  }
                  alt="Kartu Identitas"
                  className="max-h-[320px] max-w-full rounded-xl shadow-2xl border border-white/20"
                />
              )}
            </div>

            <div className="flex flex-wrap gap-2 pt-2">
              <button
                type="button"
                onClick={() => handlePrintSingleDirect(previewEmployee)}
                className="flex-1 rounded-xl bg-sky-400 py-2.5 text-xs font-black text-slate-950 hover:bg-sky-300 inline-flex items-center justify-center gap-2"
              >
                <Icon name="scanner" className="size-4" />
                <span>Cetak Kartu CR80</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  handleSaveSinglePng(previewEmployee, previewSide)
                }
                className="rounded-xl border border-white/10 bg-slate-800 px-4 py-2.5 text-xs font-bold text-white hover:bg-slate-700"
              >
                Unduh PNG ({previewSide.toUpperCase()})
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* BATCH PRINT MODAL */}
      {batchModalOpen ? (
        <Modal
          titleId="batch-print-dialog"
          onClose={() => setBatchModalOpen(false)}
          title={`Cetak Massal (${selectedIds.size} Kartu Karyawan)`}
        >
          <div className="space-y-5">
            <div className="space-y-2">
              <div className="text-xs font-bold text-slate-300">
                1. Format Lembar Cetak
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setBatchPrintType("a4_sheet")}
                  className={`rounded-2xl border p-4 text-left transition ${
                    batchPrintType === "a4_sheet"
                      ? "border-sky-400 bg-sky-400/10 text-white"
                      : "border-white/10 bg-slate-950 text-slate-400 hover:bg-slate-900"
                  }`}
                >
                  <div className="text-xs font-black">Lembar Grid A4</div>
                  <div className="mt-1 text-[11px] text-slate-400">
                    Grid kartu dengan tanda potong (crop marks) untuk laminating
                    mudah.
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setBatchPrintType("cr80")}
                  className={`rounded-2xl border p-4 text-left transition ${
                    batchPrintType === "cr80"
                      ? "border-sky-400 bg-sky-400/10 text-white"
                      : "border-white/10 bg-slate-950 text-slate-400 hover:bg-slate-900"
                  }`}
                >
                  <div className="text-xs font-black">Printer ID Card CR80</div>
                  <div className="mt-1 text-[11px] text-slate-400">
                    Kirim langsung per kartu standar (Evolis/Fargo/Zebra/HiTi).
                  </div>
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-bold text-slate-300">
                2. Sisi Kartu yang Dicetak
              </div>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setBatchPrintMode("front_only")}
                  className={`rounded-xl border p-2.5 text-center text-xs font-bold transition ${
                    batchPrintMode === "front_only"
                      ? "border-sky-400 bg-sky-400/10 text-sky-200"
                      : "border-white/10 bg-slate-950 text-slate-400 hover:bg-slate-900"
                  }`}
                >
                  Depan Saja
                </button>
                <button
                  type="button"
                  onClick={() => setBatchPrintMode("back_only")}
                  className={`rounded-xl border p-2.5 text-center text-xs font-bold transition ${
                    batchPrintMode === "back_only"
                      ? "border-sky-400 bg-sky-400/10 text-sky-200"
                      : "border-white/10 bg-slate-950 text-slate-400 hover:bg-slate-900"
                  }`}
                >
                  Belakang Saja
                </button>
                <button
                  type="button"
                  onClick={() => setBatchPrintMode("duplex")}
                  className={`rounded-xl border p-2.5 text-center text-xs font-bold transition ${
                    batchPrintMode === "duplex"
                      ? "border-sky-400 bg-sky-400/10 text-sky-200"
                      : "border-white/10 bg-slate-950 text-slate-400 hover:bg-slate-900"
                  }`}
                >
                  Bolak-Balik
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-3 text-xs text-slate-400 space-y-1">
              <p>
                • Total karyawan terpilih:{" "}
                <strong className="text-white">{selectedIds.size} orang</strong>
              </p>
              <p>
                • Status ID card karyawan terpilih akan otomatis diperbarui
                menjadi &quot;Sudah Dicetak&quot;.
              </p>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setBatchModalOpen(false)}
                className="flex-1 rounded-xl border border-white/10 bg-slate-800 py-2.5 text-xs font-bold text-slate-300 hover:bg-slate-700"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleExecuteBatchPrint}
                className="flex-1 rounded-xl bg-sky-400 py-2.5 text-xs font-black text-slate-950 hover:bg-sky-300"
              >
                Mulai Cetak ({selectedIds.size})
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* ADD ELEMENT MODAL */}
      {addElementModalOpen ? (
        <Modal
          titleId="add-element-dialog"
          onClose={() => setAddElementModalOpen(false)}
          title={`Tambah Elemen Baru (Sisi ${builderSide === "front" ? "Depan" : "Belakang"})`}
        >
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="el-type-select"
                className="text-xs font-bold text-slate-300"
              >
                Pilih Jenis Elemen:
              </label>
              <select
                id="el-type-select"
                value={`${newElementType}|${newElementSourceKey}`}
                onChange={(e) => {
                  const [t, s] = e.target.value.split("|") as [
                    ElementType,
                    IdCardElement["sourceKey"],
                  ];
                  setNewElementType(t);
                  setNewElementSourceKey(s);
                  if (s === "static_text") {
                    setNewElementLabel("Teks Kustom Baru");
                  } else if (s === "employee.qr_token") {
                    setNewElementLabel("QR Code Token");
                  } else if (s === "employee.avatar") {
                    setNewElementLabel("Foto Karyawan");
                  } else if (s === "company.logo") {
                    setNewElementLabel("Logo Instansi");
                  } else if (s === "company.signature") {
                    setNewElementLabel("Tanda Tangan Pimpinan");
                  } else if (s === "employee.name") {
                    setNewElementLabel("Nama Karyawan");
                  } else if (s === "employee.nik") {
                    setNewElementLabel("NIK / ID Karyawan");
                  } else if (s === "employee.gender") {
                    setNewElementLabel("Jenis Kelamin");
                  } else if (s === "employee.position") {
                    setNewElementLabel("Jabatan / Posisi");
                  } else if (s === "employee.department") {
                    setNewElementLabel("Divisi / Unit");
                  } else if (s === "company.name") {
                    setNewElementLabel("Nama Instansi");
                  } else if (s === "company.terms") {
                    setNewElementLabel("Syarat & Ketentuan");
                  }
                }}
                className="min-h-10 w-full rounded-xl border border-white/10 bg-slate-900 px-3 text-xs text-white"
              >
                <option value="static_text|static_text">
                  Teks Kustom / Judul Tambahan Bebas
                </option>
                <option value="qr_code|employee.qr_token">
                  QR Code Token Absensi Karyawan
                </option>
                <option value="photo|employee.avatar">
                  Foto / Avatar Karyawan
                </option>
                <option value="company_logo|company.logo">
                  Logo Instansi SPPG
                </option>
                <option value="photo|company.signature">
                  Tanda Tangan & Stempel Pimpinan
                </option>
                <option value="text|employee.name">
                  Nama Lengkap Karyawan
                </option>
                <option value="text|employee.nik">
                  NIK / Kode Identitas Karyawan
                </option>
                <option value="text|employee.gender">
                  Jenis Kelamin (Laki-laki / Perempuan)
                </option>
                <option value="text|employee.position">
                  Jabatan / Posisi Kerja
                </option>
                <option value="text|employee.department">
                  Divisi / Unit Departemen
                </option>
                <option value="text|company.name">Nama Instansi SPPG</option>
                <option value="text|company.terms">
                  Syarat & Ketentuan Penggunaan
                </option>
              </select>
            </div>

            <label className="block space-y-1.5 text-xs font-bold text-slate-300">
              Label Nama Elemen:
              <input
                type="text"
                value={newElementLabel}
                onChange={(e) => setNewElementLabel(e.target.value)}
                placeholder="Contoh: Nomor Kontak Darurat"
                className="min-h-10 w-full rounded-xl border border-white/10 bg-slate-900 px-3 text-xs text-white"
              />
            </label>

            {newElementType === "static_text" ? (
              <label className="block space-y-1.5 text-xs font-bold text-slate-300">
                Isi Teks Statis:
                <textarea
                  rows={2}
                  value={newElementStaticVal}
                  onChange={(e) => setNewElementStaticVal(e.target.value)}
                  placeholder="Masukkan teks yang akan ditampilkan di kartu..."
                  className="w-full rounded-xl border border-white/10 bg-slate-900 p-3 text-xs text-white"
                />
              </label>
            ) : null}

            <div className="flex gap-2 pt-3">
              <button
                type="button"
                onClick={() => setAddElementModalOpen(false)}
                className="flex-1 rounded-xl border border-white/10 bg-slate-800 py-2.5 text-xs font-bold text-slate-300 hover:bg-slate-700"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() =>
                  handleAddNewElement(
                    newElementType,
                    newElementSourceKey,
                    newElementLabel.trim() || "Elemen Baru",
                    newElementStaticVal,
                  )
                }
                className="flex-1 rounded-xl bg-sky-400 py-2.5 text-xs font-black text-slate-950 hover:bg-sky-300"
              >
                Tambahkan ke Sisi{" "}
                {builderSide === "front" ? "Depan" : "Belakang"}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </AppShell>
  );
}
