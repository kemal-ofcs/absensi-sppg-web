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
  printCardsDirectly,
  renderIdCardSideToCanvas,
} from "@/lib/client/id-card-renderer";
import { formatBytes, optimizeImageFile } from "@/lib/client/image-optimizer";
import {
  buildDefaultFrontSlots,
  computeMirroredBackLayout,
  DEFAULT_PRINT_LAYOUT_PRESETS,
  deletePrintLayoutPreset,
  generatePresetId,
  getActivePrintLayout,
  getPaperDimensionsMm,
  loadPrintLayoutPresets,
  setActivePrintLayoutId,
  upsertPrintLayoutPreset,
} from "@/lib/client/print-layout-store";
import { BRANDING } from "@/lib/constants/branding";
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
  DuplexPositionMode,
  ElementType,
  FlipAxis,
  IdCardElement,
  IdCardPrintLayoutConfig,
  IdCardTemplateConfig,
  PrintDuplexMode,
  PrintPaperSize,
  PrintSlotAssignment,
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

type ActiveTab = "cards" | "builder" | "layout";

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
  const [template, setTemplate] = useState<IdCardTemplateConfig>({
    id: "default_template",
    name: BRANDING.defaultTemplateName,
    orientation: "landscape",
    frontBgUrl: "",
    backBgUrl: "",
    elements: DEFAULT_ID_CARD_ELEMENTS,
    isActive: true,
  });

  // Selection for Batch
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // UI / Feedback
  const [workingId, setWorkingId] = useState<string | null>(null);
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
    useState<string>("Teks Kustom");
  const builderCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Unified Print Modal State (Single or Batch)
  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [printTargetRows, setPrintTargetRows] = useState<
    Record<string, unknown>[]
  >([]);
  const [printBusy, setPrintBusy] = useState(false);

  // Filename customizer for Preview Modal
  const [customFilename, setCustomFilename] = useState("");

  // === TAB 3: SETTING LAYOUT & KERTAS ===
  const [printLayouts, setPrintLayouts] = useState<IdCardPrintLayoutConfig[]>(
    [],
  );
  const [activeLayout, setActiveLayout] = useState<IdCardPrintLayoutConfig>(
    DEFAULT_PRINT_LAYOUT_PRESETS[0],
  );
  // Untuk Position Matrix Editor
  const [matrixEditorPage, setMatrixEditorPage] = useState<"front" | "back">(
    "front",
  );
  const [layoutPreviewPage, setLayoutPreviewPage] = useState<
    "front" | "back" | "both"
  >("both");
  // Nama preset baru yang sedang dibuat
  const [newPresetName, setNewPresetName] = useState("");
  const [isSavingLayout, setIsSavingLayout] = useState(false);
  // Canvas Element Drag & Drop State
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{
    elementId: string;
    startClientX: number;
    startClientY: number;
    initialX: number;
    initialY: number;
  } | null>(null);

  // Load Data
  const loadData = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
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
          const safeElements =
            Array.isArray(templateRes.elements) &&
            templateRes.elements.length > 0
              ? templateRes.elements
              : DEFAULT_ID_CARD_ELEMENTS;
          const safeTemplate: IdCardTemplateConfig = {
            ...templateRes,
            elements: safeElements,
          };
          setTemplate(safeTemplate);
          if (safeElements.length > 0) {
            setSelectedElementId((prev) => prev || safeElements[0].id);
          }
        }
      } catch (cause) {
        if (!silent) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Gagal memuat data ID card.",
          );
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [search, statusFilter],
  );

  useEffect(() => {
    if (hydrated && isAuthenticated && canAccessArea(user, "idcards")) {
      void loadData();
    }
  }, [hydrated, isAuthenticated, user, loadData]);

  useEffect(() => {
    const onSyncCompleted = () => {
      void loadData(true);
    };
    window.addEventListener("sppg:sync-completed", onSyncCompleted);
    return () => {
      window.removeEventListener("sppg:sync-completed", onSyncCompleted);
    };
  }, [loadData]);

  // Load preset layout cetak dari localStorage saat hydration
  useEffect(() => {
    if (!hydrated) return;
    const presets = loadPrintLayoutPresets();
    const active = getActivePrintLayout();
    setPrintLayouts(presets);
    setActiveLayout(active);
  }, [hydrated]);

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

  // Set default filename when preview employee opens
  useEffect(() => {
    if (previewEmployee) {
      const nama = String(
        previewEmployee.nama || previewEmployee.id_unik || "karyawan",
      );
      const safeNama = nama.replace(/[/\\?%*:|"<>]/g, "-").trim();
      setCustomFilename(`id-card-${safeNama}`);
    }
  }, [previewEmployee]);

  // Preload template assets for instant 60fps canvas drawing
  useEffect(() => {
    if (!template) return;
    const sampleEmp = rows[0] || {
      id_unik: "EMP-2026-001",
      nama: "AHMAD FAUZI, S.Kom.",
      kode_karyawan: "EMP-001",
      divisi: "Divisi Operasional & IT",
      jabatan_status: "Koordinator Tim",
      token_absensi: "DEMO_TOKEN_2026",
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
      id_unik: "EMP-2026-001",
      nama: "AHMAD FAUZI, S.Kom.",
      kode_karyawan: "EMP-001",
      jenis_kelamin: "Laki-laki",
      divisi: "Divisi Operasional & IT",
      jabatan_status: "Koordinator Tim",
      token_absensi: "DEMO_TOKEN_2026",
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
    overrideFilename?: string,
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
      const defaultName = overrideFilename || `id-card-${safeNama}-${side}.png`;
      const finalFilename = defaultName.endsWith(".png")
        ? defaultName
        : `${defaultName}.png`;

      const res = await saveFileWithPicker(pngUrl, finalFilename, {
        description: `Gambar ID Card (${side.toUpperCase()})`,
        accept: { "image/png": [".png"] },
      });

      if (!res.cancelled) {
        await updateStatusIdCard({
          id_unik: id,
          idcard_status: "Berhasil",
          idcard_catatan: `PNG (${side}) disimpan`,
        });
        const destNote = res.path ? ` (${res.path})` : "";
        setMessage(
          `ID card ${nama} (${side}) berhasil diunduh & disimpan${destNote}.`,
        );
        await loadData();
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "ID card gagal diunduh.",
      );
    } finally {
      setWorkingId(null);
    }
  };

  // Download both front and back
  const handleSaveBothPng = async (
    row: Record<string, unknown>,
    baseName?: string,
  ) => {
    if (!template) return;
    const nama = String(row.nama || row.id_unik || "karyawan");
    const safeNama = nama.replace(/[/\\?%*:|"<>]/g, "-").trim();
    const prefix = baseName || `id-card-${safeNama}`;

    await handleSaveSinglePng(row, "front", `${prefix}-depan.png`);
    await handleSaveSinglePng(row, "back", `${prefix}-belakang.png`);
  };

  // Open Print Modal for a Single Employee
  const handleOpenPrintSingle = (row: Record<string, unknown>) => {
    setPrintTargetRows([row]);
    setPrintModalOpen(true);
  };

  // Open Print Modal for Multiple Selected Employees
  const handleOpenPrintBatch = () => {
    const targets = rows.filter((r) => selectedIds.has(String(r.id_unik)));
    if (targets.length === 0) return;
    setPrintTargetRows(targets);
    setPrintModalOpen(true);
  };

  // Execute Print using in-DOM high-res print engine
  const handleExecutePrint = async () => {
    if (!template || printTargetRows.length === 0) return;
    setPrintBusy(true);
    try {
      setMessage(
        `Sedang menyiapkan pencetakan untuk ${printTargetRows.length} ID card...`,
      );
      const renderedCards: {
        frontPng: string;
        backPng?: string;
        name: string;
      }[] = [];

      const needFront = activeLayout.duplexMode !== "back_only";
      const needBack =
        activeLayout.duplexMode === "duplex" ||
        activeLayout.duplexMode === "back_only" ||
        activeLayout.duplexMode === "side_by_side";

      for (const row of printTargetRows) {
        let frontPng = "";
        if (needFront) {
          frontPng = await renderIdCardSideToCanvas({
            template,
            side: "front",
            employee: row,
            company: companyProfile,
          });
        }

        let backPng: string | undefined;
        if (needBack) {
          backPng = await renderIdCardSideToCanvas({
            template,
            side: "back",
            employee: row,
            company: companyProfile,
          });
        }

        renderedCards.push({
          frontPng: frontPng || backPng || "",
          backPng,
          name: String(row.nama || row.id_unik),
        });

        await updateStatusIdCard({
          id_unik: String(row.id_unik),
          idcard_status: "Berhasil",
          idcard_catatan: `Dicetak (${activeLayout.presetName} - ${activeLayout.duplexMode})`,
        });
      }

      printCardsDirectly(renderedCards, {
        orientation: template.orientation,
        title:
          printTargetRows.length === 1
            ? `ID Card - ${String(printTargetRows[0]?.nama || "Karyawan")}`
            : "Cetak Lembar ID Card",
        customLayout: activeLayout,
      });

      setPrintModalOpen(false);
      setMessage(
        `Pencetakan ${printTargetRows.length} ID card berhasil disiapkan & dibuka ke printer.`,
      );
      await loadData();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Gagal memproses pencetakan ID card.",
      );
    } finally {
      setPrintBusy(false);
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

  // Canvas Element Hit Testing & Drag-and-Drop
  const getElementAtCoords = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = builderCanvasRef.current;
      if (!canvas || !template) return null;

      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;

      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const clickX = (clientX - rect.left) * scaleX;
      const clickY = (clientY - rect.top) * scaleY;

      const currentElements = (template.elements || []).filter(
        (el) => el.side === builderSide && el.visible !== false,
      );
      const fontMultiplier = canvas.width / 360;

      for (let i = currentElements.length - 1; i >= 0; i--) {
        const el = currentElements[i];
        const elX = (el.x / 100) * canvas.width;
        const elY = (el.y / 100) * canvas.height;
        const fontSizePx = Math.max(
          10,
          Math.round(el.fontSize * fontMultiplier),
        );

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

        if (
          clickX >= drawX - 10 &&
          clickX <= drawX + boxW + 10 &&
          clickY >= elY - 10 &&
          clickY <= elY + boxH + 10
        ) {
          return el;
        }
      }
      return null;
    },
    [template, builderSide],
  );

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const el = getElementAtCoords(e.clientX, e.clientY);
    if (el) {
      setSelectedElementId(el.id);
      dragStartRef.current = {
        elementId: el.id,
        startClientX: e.clientX,
        startClientY: e.clientY,
        initialX: el.x,
        initialY: el.y,
      };
      setIsDragging(true);
    } else {
      setSelectedElementId(null);
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = builderCanvasRef.current;
    if (!canvas || !template) return;

    if (isDragging && dragStartRef.current) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const deltaXPercent =
        ((e.clientX - dragStartRef.current.startClientX) / rect.width) * 100;
      const deltaYPercent =
        ((e.clientY - dragStartRef.current.startClientY) / rect.height) * 100;

      const newX = Math.max(
        0,
        Math.min(
          100,
          Math.round((dragStartRef.current.initialX + deltaXPercent) * 10) / 10,
        ),
      );
      const newY = Math.max(
        0,
        Math.min(
          100,
          Math.round((dragStartRef.current.initialY + deltaYPercent) * 10) / 10,
        ),
      );

      setTemplate((prev) => ({
        ...prev,
        elements: prev.elements.map((elem) =>
          elem.id === dragStartRef.current?.elementId
            ? { ...elem, x: newX, y: newY }
            : elem,
        ),
      }));
    } else {
      const el = getElementAtCoords(e.clientX, e.clientY);
      canvas.style.cursor = el ? "grab" : "default";
    }
  };

  const handleCanvasMouseUp = () => {
    setIsDragging(false);
    dragStartRef.current = null;
    const canvas = builderCanvasRef.current;
    if (canvas) canvas.style.cursor = "default";
  };

  const handleCanvasTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    const touch = e.touches[0];
    if (!touch) return;
    const el = getElementAtCoords(touch.clientX, touch.clientY);
    if (el) {
      setSelectedElementId(el.id);
      dragStartRef.current = {
        elementId: el.id,
        startClientX: touch.clientX,
        startClientY: touch.clientY,
        initialX: el.x,
        initialY: el.y,
      };
      setIsDragging(true);
    }
  };

  const handleCanvasTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    const touch = e.touches[0];
    const canvas = builderCanvasRef.current;
    if (!touch || !canvas || !template || !isDragging || !dragStartRef.current)
      return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const deltaXPercent =
      ((touch.clientX - dragStartRef.current.startClientX) / rect.width) * 100;
    const deltaYPercent =
      ((touch.clientY - dragStartRef.current.startClientY) / rect.height) * 100;

    const newX = Math.max(
      0,
      Math.min(
        100,
        Math.round((dragStartRef.current.initialX + deltaXPercent) * 10) / 10,
      ),
    );
    const newY = Math.max(
      0,
      Math.min(
        100,
        Math.round((dragStartRef.current.initialY + deltaYPercent) * 10) / 10,
      ),
    );

    setTemplate((prev) => ({
      ...prev,
      elements: prev.elements.map((elem) =>
        elem.id === dragStartRef.current?.elementId
          ? { ...elem, x: newX, y: newY }
          : elem,
      ),
    }));
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
    setMessage(
      "Tata letak elemen ID Card berhasil di-reset ke tata letak standar.",
    );
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
            <button
              type="button"
              onClick={() => setActiveTab("layout")}
              className={`rounded-xl px-4 py-2 text-xs font-bold transition ${
                activeTab === "layout"
                  ? "bg-violet-400 text-slate-950 shadow-md shadow-violet-950/20"
                  : "border border-white/10 bg-slate-900 text-slate-300 hover:bg-slate-800"
              }`}
            >
              <span className="flex items-center gap-2">
                <Icon name="settings" className="size-3.5" />
                Setting Layout
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
                  onClick={handleOpenPrintBatch}
                  disabled={printBusy}
                  className="rounded-xl bg-sky-400 px-4 py-2 text-xs font-black text-slate-950 shadow-md hover:bg-sky-300 disabled:opacity-50 inline-flex items-center gap-2"
                >
                  <Icon name="scanner" className="size-3.5" />
                  <span>Cetak Pilihan ({selectedIds.size})</span>
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
                        : "border-white/10 bg-slate-900/80 hover:border-white/20"
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
                        className="flex-1 rounded-xl border border-white/10 bg-slate-800 py-2 text-xs font-bold text-slate-200 hover:bg-slate-700 transition"
                      >
                        Pratinjau
                      </button>
                      <button
                        type="button"
                        disabled={isWorking}
                        onClick={() => handleOpenPrintSingle(row)}
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
                  onMouseDown={handleCanvasMouseDown}
                  onMouseMove={handleCanvasMouseMove}
                  onMouseUp={handleCanvasMouseUp}
                  onMouseLeave={handleCanvasMouseUp}
                  onTouchStart={handleCanvasTouchStart}
                  onTouchMove={handleCanvasTouchMove}
                  onTouchEnd={handleCanvasMouseUp}
                  className="size-full object-contain bg-slate-900 select-none cursor-pointer"
                  title="Klik & geser langsung elemen mana saja pada kartu untuk memindahkannya"
                />
              </div>
              <div className="mt-2 text-center text-[11px] text-slate-400">
                💡{" "}
                <span className="font-semibold text-slate-300">
                  Fitur Interaktif:
                </span>{" "}
                Klik dan geser (*drag & drop*) langsung teks, foto, logo, atau
                QR code di atas kartu untuk memindahkannya secara realtime.
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
                Reset ke Tata Letak Standar
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
                        className="rounded-lg border border-slate-700/50 bg-slate-800 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
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
                        className="rounded-lg border border-slate-700/50 bg-slate-800 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
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
                        className="rounded-lg border border-slate-700/50 bg-slate-800 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
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
                        className="rounded-lg border border-slate-700/50 bg-slate-800 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
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
                        className="rounded-lg border border-slate-700/50 bg-slate-800 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
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
                        className="rounded-lg border border-slate-700/50 bg-slate-800 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
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
                        className="rounded-lg border border-slate-700/50 bg-slate-800 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
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
                        className="rounded-lg border border-slate-700/50 bg-slate-800 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
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
                        className="rounded-lg border border-slate-700/50 bg-slate-800 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
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
                        className="rounded-lg border border-slate-700/50 bg-slate-800 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
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
                        className="rounded-lg border border-slate-700/50 bg-slate-800 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
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
                        className="rounded-lg border border-slate-700/50 bg-slate-800 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
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
                        className="rounded-lg border border-slate-700/50 bg-slate-800 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
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
                        className="rounded-lg border border-slate-700/50 bg-slate-800 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
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
                        className="rounded-lg border border-slate-700/50 bg-slate-800 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
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
                        className="rounded-lg border border-slate-700/50 bg-slate-800 py-1 text-center font-mono text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
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
          <div className="space-y-5">
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
                  previewSide === "front"
                    ? previewFrontUrl
                    : previewBackUrl
                ) ? (
                /* biome-ignore lint/performance/noImgElement: Data URL preview */
                <img
                  src={
                    (previewSide === "front"
                      ? previewFrontUrl
                      : previewBackUrl) as string
                  }
                  alt="Kartu Identitas"
                  className="max-h-[320px] max-w-full rounded-xl shadow-2xl border border-white/20"
                />
              ) : (
                <div className="text-xs text-slate-500 font-medium">
                  Pratinjau kartu sedang diproses...
                </div>
              )}
            </div>

            {/* Custom Filename Input */}
            <div className="space-y-1.5 rounded-2xl border border-white/10 bg-slate-950/80 p-3.5">
              <label
                htmlFor="id-card-filename"
                className="text-xs font-bold text-slate-300"
              >
                Nama File Unduhan:
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="id-card-filename"
                  type="text"
                  value={customFilename}
                  onChange={(e) => setCustomFilename(e.target.value)}
                  placeholder="Contoh: id-card-ahmad-fitrianto"
                  className="min-h-9 flex-1 rounded-xl border border-white/10 bg-slate-900 px-3 text-xs text-white outline-none focus:border-sky-400"
                />
                <span className="font-mono text-xs text-slate-400">
                  -{previewSide}.png
                </span>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 pt-1">
              <button
                type="button"
                onClick={() =>
                  handleSaveSinglePng(
                    previewEmployee,
                    "front",
                    customFilename ? `${customFilename}-depan.png` : undefined,
                  )
                }
                className="rounded-xl border border-sky-400/40 bg-sky-500/10 px-3 py-2.5 text-xs font-bold text-sky-300 hover:bg-sky-500/20 transition flex items-center justify-center gap-1.5"
              >
                <Icon name="download" className="size-3.5" />
                <span>Unduh PNG (Depan)</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  handleSaveSinglePng(
                    previewEmployee,
                    "back",
                    customFilename
                      ? `${customFilename}-belakang.png`
                      : undefined,
                  )
                }
                className="rounded-xl border border-sky-400/40 bg-sky-500/10 px-3 py-2.5 text-xs font-bold text-sky-300 hover:bg-sky-500/20 transition flex items-center justify-center gap-1.5"
              >
                <Icon name="download" className="size-3.5" />
                <span>Unduh PNG (Belakang)</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  handleSaveBothPng(
                    previewEmployee,
                    customFilename || undefined,
                  )
                }
                className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 px-3 py-2.5 text-xs font-bold text-emerald-300 hover:bg-emerald-500/20 transition flex items-center justify-center gap-1.5"
              >
                <Icon name="download" className="size-3.5" />
                <span>Unduh Keduanya (PNG)</span>
              </button>
              <button
                type="button"
                onClick={() => handleOpenPrintSingle(previewEmployee)}
                className="rounded-xl bg-sky-400 px-3 py-2.5 text-xs font-black text-slate-950 hover:bg-sky-300 transition flex items-center justify-center gap-1.5 shadow"
              >
                <Icon name="scanner" className="size-4" />
                <span>Cetak Kartu</span>
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* UNIFIED PRINT MODAL (SINGLE & BATCH) */}
      {printModalOpen ? (
        <Modal
          titleId="print-card-dialog"
          onClose={() => setPrintModalOpen(false)}
          title={
            printTargetRows.length === 1
              ? `Cetak ID Card - ${String(printTargetRows[0].nama || "Karyawan")}`
              : `Cetak Massal (${printTargetRows.length} Kartu Karyawan)`
          }
        >
          <div className="space-y-5">
            {/* Pilihan Preset Layout Cetak */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold text-slate-300">
                  1. Preset Layout Kertas (dari Setting Layout)
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setPrintModalOpen(false);
                    setActiveTab("layout");
                  }}
                  className="text-[11px] font-bold text-violet-400 hover:text-violet-200 underline"
                >
                  Buka Setting Layout →
                </button>
              </div>

              <select
                id="modal-layout-preset-select"
                value={activeLayout.presetId}
                onChange={(e) => {
                  const found = printLayouts.find(
                    (p) => p.presetId === e.target.value,
                  );
                  if (found) {
                    setActiveLayout(found);
                    setActivePrintLayoutId(found.presetId);
                  }
                }}
                className="min-h-11 w-full rounded-xl border border-violet-400/30 bg-slate-950 px-3 text-xs text-white shadow-sm font-medium"
              >
                {printLayouts.map((p) => (
                  <option key={p.presetId} value={p.presetId}>
                    {p.presetName} {p.isBuiltIn ? "(bawaan)" : "(kustom)"}
                  </option>
                ))}
              </select>

              {/* Detail Info Preset Aktif */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 rounded-xl border border-white/10 bg-slate-950/80 p-3 text-[11px]">
                <div className="space-y-0.5">
                  <span className="text-[10px] text-slate-500 uppercase font-bold">
                    Kertas
                  </span>
                  <div className="text-slate-200 font-bold">
                    {activeLayout.paperWidthMm}×{activeLayout.paperHeightMm} mm
                  </div>
                </div>
                <div className="space-y-0.5">
                  <span className="text-[10px] text-slate-500 uppercase font-bold">
                    Grid Kartu
                  </span>
                  <div className="text-slate-200 font-bold">
                    {activeLayout.gridCols}×{activeLayout.gridRows} (
                    {activeLayout.gridCols * activeLayout.gridRows} slot)
                  </div>
                </div>
                <div className="space-y-0.5">
                  <span className="text-[10px] text-slate-500 uppercase font-bold">
                    Tanda Potong
                  </span>
                  <div className="text-slate-200 font-bold">
                    {activeLayout.showCropMarks ? "Aktif" : "Nonaktif"}
                  </div>
                </div>
                <div className="space-y-0.5">
                  <span className="text-[10px] text-slate-500 uppercase font-bold">
                    Kalibrasi
                  </span>
                  <div className="text-slate-200 font-bold font-mono">
                    X:{activeLayout.printerOffsetXMm} Y:
                    {activeLayout.printerOffsetYMm}
                  </div>
                </div>
              </div>
            </div>

            {/* Sisi Kartu yang Dicetak */}
            <div className="space-y-2">
              <div className="text-xs font-bold text-slate-300">
                2. Sisi Kartu yang Dicetak (Mode Duplex)
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {(
                  [
                    ["front_only", "Depan Saja"],
                    ["back_only", "Belakang Saja"],
                    ["duplex", "Bolak-Balik (Duplex)"],
                    ["side_by_side", "Berdampingan (Lipat)"],
                  ] as [PrintDuplexMode, string][]
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() =>
                      setActiveLayout((prev) => ({
                        ...prev,
                        duplexMode: mode,
                      }))
                    }
                    className={`rounded-xl border p-2.5 text-center text-xs font-bold transition ${
                      activeLayout.duplexMode === mode
                        ? "border-violet-400 bg-violet-500/20 text-white shadow-sm"
                        : "border-white/10 bg-slate-950 text-slate-400 hover:bg-slate-900 hover:text-slate-200"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {activeLayout.duplexMode === "duplex" ? (
                <div className="text-[10px] text-orange-300/90 flex items-center gap-1.5 pt-0.5">
                  <span>
                    Arah balik printer:{" "}
                    <strong>
                      {activeLayout.flipAxis === "long_edge"
                        ? "Balik Sisi Panjang (Long Edge / Kiri-Kanan)"
                        : "Balik Sisi Pendek (Short Edge / Atas-Bawah)"}
                    </strong>
                  </span>
                </div>
              ) : null}
            </div>

            {/* Info Summary */}
            <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-3.5 text-xs text-slate-400 space-y-1.5">
              <div className="flex items-center justify-between">
                <span>Jumlah ID card:</span>
                <strong className="text-white font-mono">
                  {printTargetRows.length} orang
                </strong>
              </div>
              <div className="flex items-center justify-between">
                <span>Orientasi Desain:</span>
                <strong className="text-sky-300 font-medium capitalize">
                  {template?.orientation === "portrait"
                    ? "Portrait (54 × 85.6 mm)"
                    : "Landscape (85.6 × 54 mm)"}
                </strong>
              </div>
              <div className="flex items-center justify-between">
                <span>Estimasi Lembar Kertas:</span>
                <strong className="text-violet-300 font-bold font-mono">
                  {Math.ceil(
                    printTargetRows.length /
                      Math.max(
                        1,
                        activeLayout.gridCols * activeLayout.gridRows,
                      ),
                  )}{" "}
                  lembar
                  {activeLayout.duplexMode === "duplex"
                    ? " (2 halaman per lembar)"
                    : " (1 halaman per lembar)"}
                </strong>
              </div>
              <div className="text-[11px] text-slate-500 pt-1 border-t border-white/5">
                • Status ID card akan otomatis diperbarui menjadi &quot;Sudah
                Dicetak&quot; saat proses cetak dijalankan.
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPrintModalOpen(false)}
                className="flex-1 rounded-xl border border-white/10 bg-slate-800 py-2.5 text-xs font-bold text-slate-300 hover:bg-slate-700 transition"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={printBusy}
                onClick={handleExecutePrint}
                className="flex-1 rounded-xl bg-sky-400 py-2.5 text-xs font-black text-slate-950 hover:bg-sky-300 disabled:opacity-50 transition flex items-center justify-center gap-1.5 shadow"
              >
                <Icon name="scanner" className="size-4" />
                <span>
                  {printBusy
                    ? "Menyiapkan..."
                    : `Cetak Sekarang (${printTargetRows.length})`}
                </span>
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
                  Logo Instansi / Perusahaan
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
                <option value="text|company.name">
                  Nama Instansi / Perusahaan
                </option>
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

      {/* TAB 3: SETTING LAYOUT & KERTAS */}
      {activeTab === "layout" ? (
        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          {/* Kolom Kiri: Dual Sheet Preview */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">
                  Pratinjau Lembar Cetak
                </h2>
                <p className="text-[11px] text-slate-500">
                  Simulasi posisi kartu di atas kertas — depan dan belakang
                  secara berdampingan.
                </p>
              </div>
              {/* Toggle preview page */}
              <div className="flex gap-1 rounded-xl border border-white/10 bg-slate-900 p-1">
                {(["both", "front", "back"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setLayoutPreviewPage(p)}
                    className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${
                      layoutPreviewPage === p
                        ? "bg-violet-500 text-white"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    {p === "both"
                      ? "Keduanya"
                      : p === "front"
                        ? "Depan"
                        : "Belakang"}
                  </button>
                ))}
              </div>
            </div>

            {/* SVG Sheet Preview */}
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 overflow-auto">
              {(() => {
                const L = activeLayout;
                const pW = L.paperWidthMm;
                const pH = L.paperHeightMm;
                const isPortrait = template?.orientation === "portrait";
                const baseW = isPortrait ? 54 : 85.6;
                const baseH = isPortrait ? 85.6 : 54;
                const cardWMm = baseW + L.bleedMm * 2;
                const cardHMm = baseH + L.bleedMm * 2;
                const totalSlots = L.gridCols * L.gridRows;

                // Scale: fit preview ke max 320px lebar per halaman
                const scale = Math.min(320 / pW, 220 / pH);
                const svgW = pW * scale;
                const svgH = pH * scale;

                // Hitung posisi slot
                const frontSlots = buildDefaultFrontSlots(
                  L.gridCols,
                  L.gridRows,
                )
                  .slice(0, totalSlots)
                  .map((s) => ({ ...s, cardIndex: s.slotIndex }));
                const backSlots = computeMirroredBackLayout(
                  frontSlots,
                  L.gridCols,
                  L.gridRows,
                  L.flipAxis,
                );

                const renderSlots = (
                  slots: PrintSlotAssignment[],
                  page: "front" | "back",
                ) =>
                  slots.map((slot) => {
                    const row = Math.floor(slot.slotIndex / L.gridCols);
                    const col = slot.slotIndex % L.gridCols;
                    const x =
                      (L.marginLeftMm + col * (cardWMm + L.gapColMm)) * scale;
                    const y =
                      (L.marginTopMm + row * (cardHMm + L.gapRowMm)) * scale;
                    const w = cardWMm * scale;
                    const h = cardHMm * scale;
                    const label = `K${slot.cardIndex + 1}${page === "front" ? "D" : "B"}`;
                    const fillColor = page === "front" ? "#0ea5e9" : "#8b5cf6";
                    return (
                      <g key={`${page}-${slot.slotIndex}`}>
                        <rect
                          x={x}
                          y={y}
                          width={w}
                          height={h}
                          fill={fillColor}
                          fillOpacity={0.18}
                          stroke={fillColor}
                          strokeWidth={1}
                          rx={2}
                        />
                        <text
                          x={x + w / 2}
                          y={y + h / 2 + 4}
                          textAnchor="middle"
                          fontSize={Math.max(8, Math.min(13, w / 5))}
                          fontWeight="bold"
                          fill={fillColor}
                        >
                          {label}
                        </text>
                        {/* Crop marks di sudut jika aktif */}
                        {L.showCropMarks && (
                          <>
                            {/* Kiri-Atas */}
                            <line
                              x1={
                                x -
                                L.cropMarkOffsetMm * scale -
                                L.cropMarkLengthMm * scale
                              }
                              y1={y - L.cropMarkOffsetMm * scale}
                              x2={x - L.cropMarkOffsetMm * scale}
                              y2={y - L.cropMarkOffsetMm * scale}
                              stroke="#64748b"
                              strokeWidth={0.5}
                            />
                            <line
                              x1={x - L.cropMarkOffsetMm * scale}
                              y1={
                                y -
                                L.cropMarkOffsetMm * scale -
                                L.cropMarkLengthMm * scale
                              }
                              x2={x - L.cropMarkOffsetMm * scale}
                              y2={y - L.cropMarkOffsetMm * scale}
                              stroke="#64748b"
                              strokeWidth={0.5}
                            />
                            {/* Kanan-Atas */}
                            <line
                              x1={x + w + L.cropMarkOffsetMm * scale}
                              y1={y - L.cropMarkOffsetMm * scale}
                              x2={
                                x +
                                w +
                                L.cropMarkOffsetMm * scale +
                                L.cropMarkLengthMm * scale
                              }
                              y2={y - L.cropMarkOffsetMm * scale}
                              stroke="#64748b"
                              strokeWidth={0.5}
                            />
                            <line
                              x1={x + w + L.cropMarkOffsetMm * scale}
                              y1={
                                y -
                                L.cropMarkOffsetMm * scale -
                                L.cropMarkLengthMm * scale
                              }
                              x2={x + w + L.cropMarkOffsetMm * scale}
                              y2={y - L.cropMarkOffsetMm * scale}
                              stroke="#64748b"
                              strokeWidth={0.5}
                            />
                            {/* Kiri-Bawah */}
                            <line
                              x1={
                                x -
                                L.cropMarkOffsetMm * scale -
                                L.cropMarkLengthMm * scale
                              }
                              y1={y + h + L.cropMarkOffsetMm * scale}
                              x2={x - L.cropMarkOffsetMm * scale}
                              y2={y + h + L.cropMarkOffsetMm * scale}
                              stroke="#64748b"
                              strokeWidth={0.5}
                            />
                            <line
                              x1={x - L.cropMarkOffsetMm * scale}
                              y1={y + h + L.cropMarkOffsetMm * scale}
                              x2={x - L.cropMarkOffsetMm * scale}
                              y2={
                                y +
                                h +
                                L.cropMarkOffsetMm * scale +
                                L.cropMarkLengthMm * scale
                              }
                              stroke="#64748b"
                              strokeWidth={0.5}
                            />
                            {/* Kanan-Bawah */}
                            <line
                              x1={x + w + L.cropMarkOffsetMm * scale}
                              y1={y + h + L.cropMarkOffsetMm * scale}
                              x2={
                                x +
                                w +
                                L.cropMarkOffsetMm * scale +
                                L.cropMarkLengthMm * scale
                              }
                              y2={y + h + L.cropMarkOffsetMm * scale}
                              stroke="#64748b"
                              strokeWidth={0.5}
                            />
                            <line
                              x1={x + w + L.cropMarkOffsetMm * scale}
                              y1={y + h + L.cropMarkOffsetMm * scale}
                              x2={x + w + L.cropMarkOffsetMm * scale}
                              y2={
                                y +
                                h +
                                L.cropMarkOffsetMm * scale +
                                L.cropMarkLengthMm * scale
                              }
                              stroke="#64748b"
                              strokeWidth={0.5}
                            />
                          </>
                        )}
                      </g>
                    );
                  });

                const showFront =
                  layoutPreviewPage === "both" || layoutPreviewPage === "front";
                const showBack =
                  layoutPreviewPage === "both" || layoutPreviewPage === "back";
                const gap = layoutPreviewPage === "both" ? 20 : 0;
                const totalW =
                  (showFront ? svgW : 0) +
                  (showBack ? svgW : 0) +
                  (layoutPreviewPage === "both" ? gap : 0);

                return (
                  <div className="flex flex-col items-center gap-2">
                    <svg
                      role="img"
                      aria-label="Pratinjau lembar cetak ID Card — posisi kartu di atas kertas"
                      width={totalW}
                      height={svgH + 28}
                      style={{ maxWidth: "100%", height: "auto" }}
                    >
                      {/* Kertas Depan */}
                      {showFront ? (
                        <g transform="translate(0, 0)">
                          <rect
                            x={0}
                            y={0}
                            width={svgW}
                            height={svgH}
                            fill="#1e293b"
                            stroke="#334155"
                            strokeWidth={1}
                            rx={3}
                          />
                          <text
                            x={svgW / 2}
                            y={svgH + 16}
                            textAnchor="middle"
                            fontSize={10}
                            fill="#60a5fa"
                            fontWeight="bold"
                          >
                            Hal. 1 — Sisi Depan ({pW}×{pH}mm)
                          </text>
                          {renderSlots(frontSlots, "front")}
                        </g>
                      ) : null}

                      {/* Panah alignment (hanya saat mode both + duplex) */}
                      {layoutPreviewPage === "both" && L.duplexMode === "duplex"
                        ? frontSlots.map((fSlot) => {
                            const bSlot = backSlots.find(
                              (b) => b.cardIndex === fSlot.cardIndex,
                            );
                            if (!bSlot) return null;
                            const fRow = Math.floor(
                              fSlot.slotIndex / L.gridCols,
                            );
                            const fCol = fSlot.slotIndex % L.gridCols;
                            const bRow = Math.floor(
                              bSlot.slotIndex / L.gridCols,
                            );
                            const bCol = bSlot.slotIndex % L.gridCols;
                            const fx =
                              (L.marginLeftMm +
                                fCol * (cardWMm + L.gapColMm) +
                                cardWMm) *
                              scale;
                            const fy =
                              (L.marginTopMm +
                                fRow * (cardHMm + L.gapRowMm) +
                                cardHMm / 2) *
                              scale;
                            const bx =
                              svgW +
                              gap +
                              (L.marginLeftMm + bCol * (cardWMm + L.gapColMm)) *
                                scale;
                            const by =
                              (L.marginTopMm +
                                bRow * (cardHMm + L.gapRowMm) +
                                cardHMm / 2) *
                              scale;
                            return (
                              <line
                                key={`arrow-${fSlot.cardIndex}`}
                                x1={fx}
                                y1={fy}
                                x2={bx}
                                y2={by}
                                stroke="#f97316"
                                strokeWidth={1}
                                strokeDasharray="4 3"
                                markerEnd="url(#arrowhead)"
                                opacity={0.7}
                              />
                            );
                          })
                        : null}

                      {/* Definisi arrowhead */}
                      <defs>
                        <marker
                          id="arrowhead"
                          markerWidth="6"
                          markerHeight="4"
                          refX="6"
                          refY="2"
                          orient="auto"
                        >
                          <polygon points="0 0, 6 2, 0 4" fill="#f97316" />
                        </marker>
                      </defs>

                      {/* Kertas Belakang */}
                      {showBack ? (
                        <g
                          transform={`translate(${showFront ? svgW + gap : 0}, 0)`}
                        >
                          <rect
                            x={0}
                            y={0}
                            width={svgW}
                            height={svgH}
                            fill="#1e293b"
                            stroke="#334155"
                            strokeWidth={1}
                            rx={3}
                          />
                          <text
                            x={svgW / 2}
                            y={svgH + 16}
                            textAnchor="middle"
                            fontSize={10}
                            fill="#a78bfa"
                            fontWeight="bold"
                          >
                            Hal. 2 — Sisi Belakang (sebelum flip)
                          </text>
                          {renderSlots(backSlots, "back")}
                        </g>
                      ) : null}
                    </svg>

                    {/* Legenda */}
                    <div className="flex items-center gap-4 text-[10px] text-slate-400 mt-1">
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block w-3 h-3 rounded bg-sky-500/40 border border-sky-400" />
                        Sisi Depan (K=Karyawan, D=Depan)
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block w-3 h-3 rounded bg-violet-500/40 border border-violet-400" />
                        Sisi Belakang (B=Belakang)
                      </span>
                      {L.duplexMode === "duplex" ? (
                        <span className="flex items-center gap-1.5">
                          <span className="inline-block w-5 border-t-2 border-dashed border-orange-400" />
                          Pasangan duplex
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Info Overflow Warning */}
            {(() => {
              const L = activeLayout;
              const isPortrait = template?.orientation === "portrait";
              const baseW = isPortrait ? 54 : 85.6;
              const baseH = isPortrait ? 85.6 : 54;
              const cardWMm = baseW + L.bleedMm * 2;
              const cardHMm = baseH + L.bleedMm * 2;
              const usedW =
                L.marginLeftMm +
                L.marginRightMm +
                L.gridCols * cardWMm +
                (L.gridCols - 1) * L.gapColMm;
              const usedH =
                L.marginTopMm +
                L.marginBottomMm +
                L.gridRows * cardHMm +
                (L.gridRows - 1) * L.gapRowMm;
              const overflowW = usedW > L.paperWidthMm;
              const overflowH = usedH > L.paperHeightMm;
              if (!overflowW && !overflowH) return null;
              return (
                <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  <strong>Peringatan:</strong>{" "}
                  {overflowW
                    ? `Lebar grid (${usedW.toFixed(1)}mm) melebihi kertas (${L.paperWidthMm}mm). `
                    : ""}
                  {overflowH
                    ? `Tinggi grid (${usedH.toFixed(1)}mm) melebihi kertas (${L.paperHeightMm}mm).`
                    : ""}{" "}
                  Kurangi kolom/baris, margin, atau jarak antar kartu.
                </div>
              );
            })()}
          </div>

          {/* Kolom Kanan: Panel Konfigurasi */}
          <div className="space-y-4 overflow-y-auto max-h-[calc(100vh-200px)]">
            {/* Preset Selector */}
            <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-4 space-y-3">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Preset Layout
              </div>
              <select
                id="layout-preset-select"
                value={activeLayout.presetId}
                onChange={(e) => {
                  const found = printLayouts.find(
                    (p) => p.presetId === e.target.value,
                  );
                  if (found) {
                    setActiveLayout(found);
                    setActivePrintLayoutId(found.presetId);
                  }
                }}
                className="min-h-10 w-full rounded-xl border border-white/10 bg-slate-950 px-3 text-xs text-white"
              >
                {printLayouts.map((p) => (
                  <option key={p.presetId} value={p.presetId}>
                    {p.presetName}
                    {p.isBuiltIn ? " (bawaan)" : ""}
                  </option>
                ))}
              </select>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  placeholder="Nama preset baru..."
                  className="min-h-9 flex-1 rounded-xl border border-white/10 bg-slate-950 px-3 text-xs text-white"
                />
                <button
                  type="button"
                  disabled={!newPresetName.trim()}
                  onClick={() => {
                    const newPreset: IdCardPrintLayoutConfig = {
                      ...activeLayout,
                      presetId: generatePresetId(),
                      presetName: newPresetName.trim(),
                      isBuiltIn: false,
                    };
                    upsertPrintLayoutPreset(newPreset);
                    const updated = loadPrintLayoutPresets();
                    setPrintLayouts(updated);
                    setActiveLayout(newPreset);
                    setActivePrintLayoutId(newPreset.presetId);
                    setNewPresetName("");
                    setMessage(
                      "Preset layout berhasil disimpan ke perangkat ini.",
                    );
                  }}
                  className="rounded-xl bg-violet-500 px-3 py-1 text-xs font-bold text-white hover:bg-violet-400 disabled:opacity-40"
                >
                  Simpan
                </button>
                {!activeLayout.isBuiltIn ? (
                  <button
                    type="button"
                    onClick={() => {
                      deletePrintLayoutPreset(activeLayout.presetId);
                      const updated = loadPrintLayoutPresets();
                      setPrintLayouts(updated);
                      const first = updated[0];
                      if (first) {
                        setActiveLayout(first);
                        setActivePrintLayoutId(first.presetId);
                      }
                      setMessage("Preset dihapus.");
                    }}
                    className="rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-1 text-xs font-bold text-red-300 hover:bg-red-500/20"
                  >
                    Hapus
                  </button>
                ) : null}
              </div>
            </div>

            {/* Helper untuk update field di activeLayout */}
            {/* Ukuran Kertas */}
            <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-4 space-y-3">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Ukuran Kertas
              </div>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["cr80", "CR80 (85.6×54mm)"],
                    ["a4", "A4 (210×297mm)"],
                    ["f4", "F4 Folio (215×330mm)"],
                    ["letter", "Letter (216×279mm)"],
                    ["a3", "A3 (297×420mm)"],
                    ["custom", "Kustom (isi manual)"],
                  ] as [PrintPaperSize, string][]
                ).map(([size, label]) => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => {
                      const { widthMm, heightMm } = getPaperDimensionsMm(
                        size,
                        activeLayout.paperWidthMm,
                        activeLayout.paperHeightMm,
                      );
                      setActiveLayout((prev) => ({
                        ...prev,
                        paperSize: size,
                        paperWidthMm: widthMm,
                        paperHeightMm: heightMm,
                      }));
                    }}
                    className={`rounded-xl border p-2 text-left text-[11px] font-bold transition ${
                      activeLayout.paperSize === size
                        ? "border-violet-400 bg-violet-400/10 text-white"
                        : "border-white/10 bg-slate-950 text-slate-400 hover:bg-slate-900"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {activeLayout.paperSize === "custom" ? (
                <div className="grid grid-cols-2 gap-2">
                  <label className="block space-y-1 text-[11px] font-bold text-slate-400">
                    Lebar (mm)
                    <input
                      type="number"
                      min={50}
                      max={500}
                      step={0.1}
                      value={activeLayout.paperWidthMm}
                      onChange={(e) =>
                        setActiveLayout((prev) => ({
                          ...prev,
                          paperWidthMm: Number(e.target.value),
                        }))
                      }
                      className="min-h-9 w-full rounded-xl border border-white/10 bg-slate-950 px-2 text-xs text-white"
                    />
                  </label>
                  <label className="block space-y-1 text-[11px] font-bold text-slate-400">
                    Tinggi (mm)
                    <input
                      type="number"
                      min={50}
                      max={700}
                      step={0.1}
                      value={activeLayout.paperHeightMm}
                      onChange={(e) =>
                        setActiveLayout((prev) => ({
                          ...prev,
                          paperHeightMm: Number(e.target.value),
                        }))
                      }
                      className="min-h-9 w-full rounded-xl border border-white/10 bg-slate-950 px-2 text-xs text-white"
                    />
                  </label>
                </div>
              ) : null}
            </div>

            {/* Grid */}
            <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-4 space-y-3">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Grid Kartu
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1 text-[11px] font-bold text-slate-400">
                  Kolom (1–4)
                  <input
                    type="number"
                    min={1}
                    max={4}
                    value={activeLayout.gridCols}
                    onChange={(e) =>
                      setActiveLayout((prev) => ({
                        ...prev,
                        gridCols: Math.max(
                          1,
                          Math.min(4, Number(e.target.value)),
                        ),
                      }))
                    }
                    className="min-h-9 w-full rounded-xl border border-white/10 bg-slate-950 px-2 text-xs text-white"
                  />
                </label>
                <label className="block space-y-1 text-[11px] font-bold text-slate-400">
                  Baris (1–6)
                  <input
                    type="number"
                    min={1}
                    max={6}
                    value={activeLayout.gridRows}
                    onChange={(e) =>
                      setActiveLayout((prev) => ({
                        ...prev,
                        gridRows: Math.max(
                          1,
                          Math.min(6, Number(e.target.value)),
                        ),
                      }))
                    }
                    className="min-h-9 w-full rounded-xl border border-white/10 bg-slate-950 px-2 text-xs text-white"
                  />
                </label>
              </div>
              <div className="text-[10px] text-slate-500">
                {activeLayout.gridCols * activeLayout.gridRows} slot kartu per
                halaman
              </div>
            </div>

            {/* Margin & Jarak */}
            <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-4 space-y-3">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Margin Tepi & Jarak Antar Kartu (mm)
              </div>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["marginTopMm", "Margin Atas"],
                    ["marginBottomMm", "Margin Bawah"],
                    ["marginLeftMm", "Margin Kiri"],
                    ["marginRightMm", "Margin Kanan"],
                    ["gapColMm", "Jarak Horizontal"],
                    ["gapRowMm", "Jarak Vertikal"],
                  ] as [keyof IdCardPrintLayoutConfig, string][]
                ).map(([field, label]) => (
                  <label
                    key={field}
                    className="block space-y-1 text-[11px] font-bold text-slate-400"
                  >
                    {label}
                    <input
                      type="number"
                      min={0}
                      max={50}
                      step={0.5}
                      value={activeLayout[field] as number}
                      onChange={(e) =>
                        setActiveLayout((prev) => ({
                          ...prev,
                          [field]: Math.max(0, Number(e.target.value)),
                        }))
                      }
                      className="min-h-9 w-full rounded-xl border border-white/10 bg-slate-950 px-2 text-xs text-white"
                    />
                  </label>
                ))}
              </div>
            </div>

            {/* Tanda Potong & Finishing */}
            <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-4 space-y-3">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Tanda Potong & Finishing
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-300">
                  Tampilkan Garis Potong (Crop Marks)
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setActiveLayout((prev) => ({
                      ...prev,
                      showCropMarks: !prev.showCropMarks,
                    }))
                  }
                  className={`h-6 w-11 rounded-full transition-colors ${
                    activeLayout.showCropMarks
                      ? "bg-violet-500"
                      : "bg-slate-700"
                  }`}
                >
                  <span
                    className={`block h-4 w-4 rounded-full bg-white shadow transition-transform mx-1 ${
                      activeLayout.showCropMarks
                        ? "translate-x-5"
                        : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
              {activeLayout.showCropMarks ? (
                <div className="grid grid-cols-2 gap-2">
                  <label className="block space-y-1 text-[11px] font-bold text-slate-400">
                    Panjang Garis (mm)
                    <input
                      type="number"
                      min={1}
                      max={10}
                      step={0.5}
                      value={activeLayout.cropMarkLengthMm}
                      onChange={(e) =>
                        setActiveLayout((prev) => ({
                          ...prev,
                          cropMarkLengthMm: Number(e.target.value),
                        }))
                      }
                      className="min-h-9 w-full rounded-xl border border-white/10 bg-slate-950 px-2 text-xs text-white"
                    />
                  </label>
                  <label className="block space-y-1 text-[11px] font-bold text-slate-400">
                    Offset dari Kartu (mm)
                    <input
                      type="number"
                      min={0}
                      max={5}
                      step={0.5}
                      value={activeLayout.cropMarkOffsetMm}
                      onChange={(e) =>
                        setActiveLayout((prev) => ({
                          ...prev,
                          cropMarkOffsetMm: Number(e.target.value),
                        }))
                      }
                      className="min-h-9 w-full rounded-xl border border-white/10 bg-slate-950 px-2 text-xs text-white"
                    />
                  </label>
                </div>
              ) : null}
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1 text-[11px] font-bold text-slate-400">
                  Bleed (mm, 0–3)
                  <input
                    type="number"
                    min={0}
                    max={3}
                    step={0.5}
                    value={activeLayout.bleedMm}
                    onChange={(e) =>
                      setActiveLayout((prev) => ({
                        ...prev,
                        bleedMm: Math.max(
                          0,
                          Math.min(3, Number(e.target.value)),
                        ),
                      }))
                    }
                    className="min-h-9 w-full rounded-xl border border-white/10 bg-slate-950 px-2 text-xs text-white"
                  />
                </label>
                <div className="flex items-center gap-2 pt-5">
                  <button
                    type="button"
                    onClick={() =>
                      setActiveLayout((prev) => ({
                        ...prev,
                        showCardBorder: !prev.showCardBorder,
                      }))
                    }
                    className={`h-5 w-9 rounded-full transition-colors ${
                      activeLayout.showCardBorder
                        ? "bg-violet-500"
                        : "bg-slate-700"
                    }`}
                  >
                    <span
                      className={`block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform mx-0.5 ${
                        activeLayout.showCardBorder
                          ? "translate-x-4"
                          : "translate-x-0"
                      }`}
                    />
                  </button>
                  <span className="text-[11px] text-slate-400">
                    Garis Tepi Kartu
                  </span>
                </div>
              </div>
            </div>

            {/* Duplex & Position Matrix */}
            <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-4 space-y-3">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Sisi Cetak & Duplex Alignment
              </div>

              {/* Sisi yang dicetak */}
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["front_only", "Depan Saja"],
                    ["back_only", "Belakang Saja"],
                    ["duplex", "Bolak-Balik (Duplex)"],
                    ["side_by_side", "Berdampingan (Lipat)"],
                  ] as [PrintDuplexMode, string][]
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() =>
                      setActiveLayout((prev) => ({ ...prev, duplexMode: mode }))
                    }
                    className={`rounded-xl border p-2 text-[11px] font-bold transition ${
                      activeLayout.duplexMode === mode
                        ? "border-violet-400 bg-violet-400/10 text-white"
                        : "border-white/10 bg-slate-950 text-slate-400 hover:bg-slate-900"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Flip Axis (hanya saat duplex) */}
              {activeLayout.duplexMode === "duplex" ? (
                <div className="space-y-2">
                  <div className="text-[11px] font-bold text-slate-400">
                    Arah Balik Kertas Printer
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {(
                      [
                        ["long_edge", "Balik Kiri-Kanan (Long Edge)"],
                        ["short_edge", "Balik Atas-Bawah (Short Edge)"],
                      ] as [FlipAxis, string][]
                    ).map(([axis, label]) => (
                      <button
                        key={axis}
                        type="button"
                        onClick={() =>
                          setActiveLayout((prev) => ({
                            ...prev,
                            flipAxis: axis,
                          }))
                        }
                        className={`rounded-xl border p-2 text-[11px] font-bold transition ${
                          activeLayout.flipAxis === axis
                            ? "border-orange-400 bg-orange-400/10 text-orange-200"
                            : "border-white/10 bg-slate-950 text-slate-400 hover:bg-slate-900"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {/* Duplex Position Mode */}
                  <div className="text-[11px] font-bold text-slate-400 pt-1">
                    Mode Penempatan Slot
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {(
                      [
                        ["auto_mirror", "Auto Mirror (Otomatis)"],
                        ["manual_matrix", "Manual Matrix (Kustom)"],
                      ] as [DuplexPositionMode, string][]
                    ).map(([m, label]) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() =>
                          setActiveLayout((prev) => ({
                            ...prev,
                            duplexPositionMode: m,
                          }))
                        }
                        className={`rounded-xl border p-2 text-[11px] font-bold transition ${
                          activeLayout.duplexPositionMode === m
                            ? "border-violet-400 bg-violet-400/10 text-white"
                            : "border-white/10 bg-slate-950 text-slate-400 hover:bg-slate-900"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {/* Position Matrix Editor */}
                  {activeLayout.duplexPositionMode === "manual_matrix" ? (
                    <div className="space-y-3 rounded-xl border border-violet-400/20 bg-violet-950/20 p-3">
                      <div className="flex items-center justify-between">
                        <div className="text-[11px] font-bold text-violet-300">
                          Position Matrix Editor
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              // Reset ke auto mirror
                              const front = buildDefaultFrontSlots(
                                activeLayout.gridCols,
                                activeLayout.gridRows,
                              ).map((s) => ({ ...s, cardIndex: s.slotIndex }));
                              const back = computeMirroredBackLayout(
                                front,
                                activeLayout.gridCols,
                                activeLayout.gridRows,
                                activeLayout.flipAxis,
                              );
                              setActiveLayout((prev) => ({
                                ...prev,
                                frontPageSlots: front,
                                backPageSlots: back,
                              }));
                            }}
                            className="rounded-lg bg-violet-500/20 px-2 py-1 text-[10px] font-bold text-violet-300 hover:bg-violet-500/30"
                          >
                            Hitung Mirror Otomatis
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setActiveLayout((prev) => ({
                                ...prev,
                                frontPageSlots: undefined,
                                backPageSlots: undefined,
                              }));
                            }}
                            className="rounded-lg border border-white/10 px-2 py-1 text-[10px] font-bold text-slate-400 hover:text-white"
                          >
                            Reset
                          </button>
                        </div>
                      </div>

                      {/* Toggle halaman mana yang diedit */}
                      <div className="flex gap-1 rounded-lg border border-white/10 bg-slate-900 p-1 w-fit">
                        {(["front", "back"] as const).map((p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setMatrixEditorPage(p)}
                            className={`rounded-md px-2.5 py-1 text-[10px] font-bold transition ${
                              matrixEditorPage === p
                                ? p === "front"
                                  ? "bg-sky-500 text-white"
                                  : "bg-violet-500 text-white"
                                : "text-slate-400 hover:text-white"
                            }`}
                          >
                            {p === "front"
                              ? "Halaman Depan"
                              : "Halaman Belakang"}
                          </button>
                        ))}
                      </div>

                      {/* Grid matrix slot */}
                      <div
                        className="grid gap-1"
                        style={{
                          gridTemplateColumns: `repeat(${activeLayout.gridCols}, minmax(0, 1fr))`,
                        }}
                      >
                        {Array.from(
                          {
                            length:
                              activeLayout.gridCols * activeLayout.gridRows,
                          },
                          (_, i) => i,
                        ).map((slotNum) => {
                          const slotsKey =
                            matrixEditorPage === "front"
                              ? "frontPageSlots"
                              : "backPageSlots";
                          const currentSlots =
                            activeLayout[slotsKey] ??
                            (matrixEditorPage === "front"
                              ? buildDefaultFrontSlots(
                                  activeLayout.gridCols,
                                  activeLayout.gridRows,
                                ).map((s) => ({
                                  ...s,
                                  cardIndex: s.slotIndex,
                                }))
                              : computeMirroredBackLayout(
                                  buildDefaultFrontSlots(
                                    activeLayout.gridCols,
                                    activeLayout.gridRows,
                                  ).map((s) => ({
                                    ...s,
                                    cardIndex: s.slotIndex,
                                  })),
                                  activeLayout.gridCols,
                                  activeLayout.gridRows,
                                  activeLayout.flipAxis,
                                ));

                          const slot = currentSlots.find(
                            (s) => s.slotIndex === slotNum,
                          );

                          const cardOptions = Array.from(
                            {
                              length:
                                activeLayout.gridCols * activeLayout.gridRows,
                            },
                            (_, i) => i,
                          );

                          return (
                            <div
                              key={`matrix-slot-${matrixEditorPage}-${slotNum}`}
                              className="rounded-lg border border-white/10 bg-slate-950 p-1.5 text-center"
                            >
                              <div className="text-[9px] text-slate-500 mb-1">
                                Slot {slotNum + 1}
                              </div>
                              <select
                                value={
                                  slot
                                    ? `${slot.cardIndex}|${slot.side}`
                                    : "-1|front"
                                }
                                onChange={(e) => {
                                  const [ci, sd] = e.target.value.split("|");
                                  const updatedSlots = currentSlots.map((s) =>
                                    s.slotIndex === slotNum
                                      ? {
                                          ...s,
                                          cardIndex: Number(ci),
                                          side: sd as "front" | "back",
                                        }
                                      : s,
                                  );
                                  const existing = updatedSlots.find(
                                    (s) => s.slotIndex === slotNum,
                                  );
                                  const finalSlots = existing
                                    ? updatedSlots
                                    : [
                                        ...updatedSlots,
                                        {
                                          slotIndex: slotNum,
                                          cardIndex: Number(ci),
                                          side: sd as "front" | "back",
                                        },
                                      ];
                                  setActiveLayout((prev) => ({
                                    ...prev,
                                    [slotsKey]: finalSlots,
                                  }));
                                }}
                                className="w-full rounded bg-slate-900 text-[9px] text-white border border-white/10 px-1 py-0.5"
                              >
                                <option value="-1|front">Kosong</option>
                                {cardOptions.map((cardNum) => (
                                  <option
                                    key={`s${slotNum}-k${cardNum}-front`}
                                    value={`${cardNum}|front`}
                                  >
                                    K{cardNum + 1} Depan
                                  </option>
                                ))}
                                {cardOptions.map((cardNum) => (
                                  <option
                                    key={`s${slotNum}-k${cardNum}-back`}
                                    value={`${cardNum}|back`}
                                  >
                                    K{cardNum + 1} Belakang
                                  </option>
                                ))}
                              </select>
                            </div>
                          );
                        })}
                      </div>

                      <div className="text-[10px] text-slate-500">
                        Atur sendiri kartu mana di slot mana. Gunakan "Hitung
                        Mirror Otomatis" sebagai titik awal, lalu sesuaikan.
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-sky-400/20 bg-sky-950/20 p-3 text-[11px] text-sky-300">
                      Mode <strong>Auto Mirror</strong>: sistem akan menghitung
                      posisi halaman belakang secara otomatis berdasarkan arah
                      balik kertas yang dipilih di atas. Garis oranye
                      putus-putus di preview menunjukkan pasangan alignment
                      setiap kartu.
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            {/* Kalibrasi Printer */}
            <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-4 space-y-3">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Kalibrasi Offset Printer (mm)
              </div>
              <p className="text-[10px] text-slate-500">
                Geser seluruh tata letak kartu untuk kompensasi perbedaan
                mekanik printer. Positif = ke kanan/bawah, negatif = ke
                kiri/atas. Rentang: -5 s.d. +5 mm.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1 text-[11px] font-bold text-slate-400">
                  Offset Horizontal (X)
                  <input
                    type="number"
                    min={-5}
                    max={5}
                    step={0.1}
                    value={activeLayout.printerOffsetXMm}
                    onChange={(e) =>
                      setActiveLayout((prev) => ({
                        ...prev,
                        printerOffsetXMm: Math.max(
                          -5,
                          Math.min(5, Number(e.target.value)),
                        ),
                      }))
                    }
                    className="min-h-9 w-full rounded-xl border border-white/10 bg-slate-950 px-2 text-xs text-white"
                  />
                </label>
                <label className="block space-y-1 text-[11px] font-bold text-slate-400">
                  Offset Vertikal (Y)
                  <input
                    type="number"
                    min={-5}
                    max={5}
                    step={0.1}
                    value={activeLayout.printerOffsetYMm}
                    onChange={(e) =>
                      setActiveLayout((prev) => ({
                        ...prev,
                        printerOffsetYMm: Math.max(
                          -5,
                          Math.min(5, Number(e.target.value)),
                        ),
                      }))
                    }
                    className="min-h-9 w-full rounded-xl border border-white/10 bg-slate-950 px-2 text-xs text-white"
                  />
                </label>
              </div>
            </div>

            {/* Tombol Simpan */}
            <button
              id="save-layout-preset-btn"
              type="button"
              disabled={isSavingLayout}
              onClick={() => {
                setIsSavingLayout(true);
                try {
                  upsertPrintLayoutPreset(activeLayout);
                  setActivePrintLayoutId(activeLayout.presetId);
                  const updated = loadPrintLayoutPresets();
                  setPrintLayouts(updated);
                  setMessage(
                    `Layout "${activeLayout.presetName}" berhasil disimpan ke perangkat ini.`,
                  );
                } finally {
                  setIsSavingLayout(false);
                }
              }}
              className="w-full rounded-2xl bg-violet-500 py-3 text-sm font-black text-white hover:bg-violet-400 disabled:opacity-50 transition shadow-md shadow-violet-950/30"
            >
              {isSavingLayout
                ? "Menyimpan..."
                : "Terapkan & Simpan Preset ke Perangkat Ini"}
            </button>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
