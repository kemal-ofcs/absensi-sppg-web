"use client";

import QRCode from "qrcode";
import type { CompanyProfile } from "@/types/company-profile";
import type {
  CardSide,
  IdCardElement,
  IdCardTemplateConfig,
} from "@/types/id-card";

// Memory caches to eliminate async lag & re-render latency
const imageCache = new Map<string, HTMLImageElement>();
const qrCache = new Map<string, HTMLImageElement>();

export function getCachedImage(src: string): HTMLImageElement | null {
  return imageCache.get(src) || null;
}

export function preloadImage(src: string): Promise<HTMLImageElement> {
  if (!src) return Promise.reject(new Error("URL gambar kosong"));
  const existing = imageCache.get(src);
  if (existing?.complete && existing.naturalWidth > 0) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imageCache.set(src, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error("Gagal memuat gambar"));
    img.src = src;
  });
}

export async function preloadCardAssets(params: {
  template: IdCardTemplateConfig;
  company?: CompanyProfile | null;
  employee?: Record<string, unknown>;
}): Promise<void> {
  const promises: Promise<unknown>[] = [];
  if (params.template.frontBgUrl) {
    promises.push(preloadImage(params.template.frontBgUrl).catch(() => null));
  }
  if (params.template.backBgUrl) {
    promises.push(preloadImage(params.template.backBgUrl).catch(() => null));
  }
  if (params.company?.logo_url) {
    promises.push(preloadImage(params.company.logo_url).catch(() => null));
  }
  if (params.company?.signature_url) {
    promises.push(preloadImage(params.company.signature_url).catch(() => null));
  }
  if (params.employee?.avatar_url) {
    promises.push(
      preloadImage(params.employee.avatar_url as string).catch(() => null),
    );
  }

  const token = params.employee?.token_absensi
    ? `${String(params.employee.id_unik)}|${String(params.employee.token_absensi)}`
    : "";
  if (token) {
    promises.push(getOrGenerateQrImage(token, "#000000").catch(() => null));
  }

  await Promise.all(promises);
}

export async function getOrGenerateQrImage(
  token: string,
  color = "#000000",
): Promise<HTMLImageElement> {
  const cacheKey = `${token}_${color}`;
  const existing = qrCache.get(cacheKey);
  if (existing) return existing;

  const dataUrl = await QRCode.toDataURL(token, {
    margin: 1,
    width: 256,
    color: {
      dark: color || "#000000",
      light: "#ffffff",
    },
  });

  const img = await preloadImage(dataUrl);
  qrCache.set(cacheKey, img);
  return img;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): void {
  const lines = text.split("\n");
  let currentY = y;

  for (const paragraph of lines) {
    const words = paragraph.split(" ");
    let line = "";

    for (let n = 0; n < words.length; n++) {
      const testLine = `${line + words[n]} `;
      const metrics = ctx.measureText(testLine);
      const testWidth = metrics.width;
      if (testWidth > maxWidth && n > 0) {
        ctx.fillText(line, x, currentY);
        line = `${words[n]} `;
        currentY += lineHeight;
      } else {
        line = testLine;
      }
    }
    ctx.fillText(line, x, currentY);
    currentY += lineHeight;
  }
}

export interface RenderCardParams {
  template: IdCardTemplateConfig;
  side: CardSide;
  employee?: Record<string, unknown>;
  company?: CompanyProfile | null;
  qrPngOverride?: string;
  dpiScale?: number; // default 1 (300 DPI = 1011x638)
  selectedElementId?: string | null;
  showBoundingBoxes?: boolean;
}

export async function drawIdCardToCanvas(
  canvas: HTMLCanvasElement,
  params: RenderCardParams,
): Promise<void> {
  const {
    template,
    side,
    employee = {},
    company,
    qrPngOverride,
    dpiScale = 1,
    selectedElementId,
    showBoundingBoxes,
  } = params;

  const isPortrait = template.orientation === "portrait";
  // Standard CR80 base resolution (300 DPI approx)
  const baseWidth = isPortrait ? 638 : 1011;
  const baseHeight = isPortrait ? 1011 : 638;

  const width = Math.round(baseWidth * dpiScale);
  const height = Math.round(baseHeight * dpiScale);

  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, width, height);

  const bgUrl = side === "front" ? template.frontBgUrl : template.backBgUrl;

  // 1. Draw Background
  if (bgUrl) {
    const cachedBg = imageCache.get(bgUrl);
    if (cachedBg?.complete && cachedBg.naturalWidth > 0) {
      ctx.drawImage(cachedBg, 0, 0, width, height);
    } else {
      try {
        const bgImg = await preloadImage(bgUrl);
        ctx.drawImage(bgImg, 0, 0, width, height);
      } catch {
        drawFallbackBackground(ctx, width, height, side);
      }
    }
  } else {
    drawFallbackBackground(ctx, width, height, side);
  }

  // 2. Filter elements for this side (only if visible !== false)
  const elements = (template.elements || []).filter(
    (el) => el.side === side && el.visible !== false,
  );

  // 3. Render each element
  for (const el of elements) {
    await renderSingleElement(
      ctx,
      el,
      width,
      height,
      employee,
      company,
      qrPngOverride,
    );
  }

  // 4. Render Bounding Box Guidelines (when editing in builder)
  if (showBoundingBoxes || selectedElementId) {
    drawBoundingBoxGuides(
      ctx,
      elements,
      width,
      height,
      selectedElementId,
      showBoundingBoxes,
    );
  }
}

function drawBoundingBoxGuides(
  ctx: CanvasRenderingContext2D,
  elements: IdCardElement[],
  canvasWidth: number,
  canvasHeight: number,
  selectedElementId?: string | null,
  showAllGuides?: boolean,
) {
  ctx.save();

  const fontMultiplier = canvasWidth / 360;

  for (const el of elements) {
    const isSelected = el.id === selectedElementId;
    if (!isSelected && !showAllGuides) continue;

    const x = (el.x / 100) * canvasWidth;
    const y = (el.y / 100) * canvasHeight;
    const fontSizePx = Math.max(10, Math.round(el.fontSize * fontMultiplier));

    let boxW = el.width ? (el.width / 100) * canvasWidth : 0;
    let boxH = el.height ? (el.height / 100) * canvasHeight : 0;

    if (el.type === "qr_code") {
      boxW = boxW > 0 ? boxW : 180;
      boxH = boxH > 0 ? boxH : 180;
    } else if (el.type === "company_logo" || el.type === "photo") {
      boxW = boxW > 0 ? boxW : 100;
      boxH = boxH > 0 ? boxH : 100;
    } else {
      if (boxW === 0) {
        boxW = Math.min(canvasWidth - x - 10, fontSizePx * 10);
      }
      if (boxH === 0) {
        boxH = fontSizePx * 1.5;
      }
    }

    let drawX = x;
    if (el.textAlign === "center") {
      drawX = x - boxW / 2;
    } else if (el.textAlign === "right") {
      drawX = x - boxW;
    }

    if (isSelected) {
      // Highlighted Selected Element Guide
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(drawX, y, boxW, boxH);

      // Corner handles
      ctx.fillStyle = "#38bdf8";
      const handleSize = 6;
      ctx.fillRect(
        drawX - handleSize / 2,
        y - handleSize / 2,
        handleSize,
        handleSize,
      );
      ctx.fillRect(
        drawX + boxW - handleSize / 2,
        y - handleSize / 2,
        handleSize,
        handleSize,
      );
      ctx.fillRect(
        drawX - handleSize / 2,
        y + boxH - handleSize / 2,
        handleSize,
        handleSize,
      );
      ctx.fillRect(
        drawX + boxW - handleSize / 2,
        y + boxH - handleSize / 2,
        handleSize,
        handleSize,
      );

      // Label badge at top
      ctx.setLineDash([]);
      ctx.fillStyle = "#0284c7";
      ctx.font = "bold 11px Inter, sans-serif";
      const tagText = ` ${el.label} (${el.x.toFixed(1)}%, ${el.y.toFixed(1)}%) `;
      const tagWidth = ctx.measureText(tagText).width;
      const tagY = Math.max(14, y - 4);
      ctx.fillRect(drawX, tagY - 12, tagWidth, 14);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(tagText, drawX, tagY);
    } else if (showAllGuides) {
      // Subtle guide for non-selected active elements
      ctx.strokeStyle = "rgba(56, 189, 248, 0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(drawX, y, boxW, boxH);
    }
  }

  ctx.restore();
}

export async function renderIdCardSideToCanvas(
  params: RenderCardParams,
): Promise<string> {
  const isPortrait = params.template.orientation === "portrait";
  const baseWidth = isPortrait ? 638 : 1011;
  const baseHeight = isPortrait ? 1011 : 638;
  const dpiScale = params.dpiScale || 1;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(baseWidth * dpiScale);
  canvas.height = Math.round(baseHeight * dpiScale);

  await drawIdCardToCanvas(canvas, params);
  return canvas.toDataURL("image/png");
}

function drawFallbackBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  side: CardSide,
) {
  const grad = ctx.createLinearGradient(0, 0, width, height);
  if (side === "front") {
    grad.addColorStop(0, "#020617"); // slate-950
    grad.addColorStop(0.5, "#0f172a"); // slate-900
    grad.addColorStop(1, "#0369a1"); // sky-700
  } else {
    grad.addColorStop(0, "#0f172a"); // slate-900
    grad.addColorStop(1, "#020617"); // slate-950
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Subtle border accent
  ctx.strokeStyle = "rgba(56, 189, 248, 0.4)";
  ctx.lineWidth = 4;
  ctx.strokeRect(10, 10, width - 20, height - 20);
}

async function renderSingleElement(
  ctx: CanvasRenderingContext2D,
  el: IdCardElement,
  canvasWidth: number,
  canvasHeight: number,
  employee: Record<string, unknown>,
  company?: CompanyProfile | null,
  qrPngOverride?: string,
) {
  if (el.visible === false) return;

  const x = (el.x / 100) * canvasWidth;
  const y = (el.y / 100) * canvasHeight;
  const w = el.width ? (el.width / 100) * canvasWidth : 0;
  const h = el.height ? (el.height / 100) * canvasHeight : 0;

  // Font scale calculation (base font 14px -> scale for 1011px width)
  const fontMultiplier = canvasWidth / 360;
  const fontSizePx = Math.max(10, Math.round(el.fontSize * fontMultiplier));
  const fontWeight =
    el.fontWeight === "bold"
      ? "bold"
      : el.fontWeight === "600"
        ? "600"
        : "normal";

  ctx.save();

  if (el.type === "qr_code") {
    const qrToken =
      qrPngOverride ||
      (employee.token_absensi
        ? `${String(employee.id_unik)}|${String(employee.token_absensi)}`
        : "");
    const boxW = w > 0 ? w : 180;
    const boxH = h > 0 ? h : 180;

    if (qrToken) {
      try {
        const qrImg = qrToken.startsWith("data:image")
          ? await preloadImage(qrToken)
          : await getOrGenerateQrImage(qrToken, el.color || "#000000");

        // White background for QR code scan reliability
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x - 4, y - 4, boxW + 8, boxH + 8);
        ctx.drawImage(qrImg, x, y, boxW, boxH);
      } catch {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x, y, boxW, boxH);
        ctx.fillStyle = "#000000";
        ctx.font = "12px sans-serif";
        ctx.fillText("QR Code", x + 10, y + boxH / 2);
      }
    }
  } else if (el.type === "company_logo" || el.type === "photo") {
    let imgUrl: string | null = null;
    if (el.sourceKey === "company.logo") {
      imgUrl = company?.logo_url || null;
    } else if (el.sourceKey === "company.signature") {
      imgUrl = company?.signature_url || null;
    } else if (el.sourceKey === "employee.avatar") {
      imgUrl = (employee.avatar_url as string) || null;
    }

    const boxW = w > 0 ? w : 100;
    const boxH = h > 0 ? h : 100;

    if (imgUrl) {
      try {
        const img = await preloadImage(imgUrl);
        ctx.drawImage(img, x, y, boxW, boxH);
      } catch {
        // Fallback placeholder
        ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
        ctx.fillRect(x, y, boxW, boxH);
      }
    } else {
      // Empty box / placeholder preview
      ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
      ctx.fillRect(x, y, boxW, boxH);
    }
  } else {
    // Text rendering
    let val = "";
    switch (el.sourceKey) {
      case "employee.name":
        val = String(employee.nama || "NAMA KARYAWAN");
        break;
      case "employee.nik":
        val = String(employee.kode_karyawan || employee.id_unik || "SPPG-001");
        break;
      case "employee.gender":
        val = String(employee.jenis_kelamin || employee.gender || "Laki-laki");
        break;
      case "employee.position":
        val = String(employee.jabatan_status || "Staff");
        break;
      case "employee.department":
        val = String(employee.divisi || "Operasional");
        break;
      case "company.name":
        val = String(company?.company_name || "SPPG");
        break;
      case "company.terms":
        val = String(
          company?.card_terms ||
            "1. Kartu ini milik instansi SPPG.\n2. Wajib dibawa setiap hari kerja.",
        );
        break;
      case "static_text":
        val = el.staticValue || el.label || "";
        break;
      default:
        val = el.label || "";
        break;
    }

    if (el.isUppercase) {
      val = val.toUpperCase();
    }

    ctx.fillStyle = el.color || "#ffffff";
    ctx.font = `${fontWeight} ${fontSizePx}px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = el.textAlign || "left";
    ctx.textBaseline = "top";

    if (w > 0 && val.includes("\n")) {
      const lineHeight = fontSizePx * 1.35;
      wrapText(ctx, val, x, y, w, lineHeight);
    } else if (w > 0 && ctx.measureText(val).width > w) {
      const lineHeight = fontSizePx * 1.35;
      wrapText(ctx, val, x, y, w, lineHeight);
    } else {
      ctx.fillText(val, x, y);
    }
  }

  ctx.restore();
}

export function printSingleCard(frontPng: string, title = "ID Card") {
  let iframe = document.getElementById(
    "id-card-print-frame",
  ) as HTMLIFrameElement | null;
  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.id = "id-card-print-frame";
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);
  }

  const frameDoc = iframe.contentWindow?.document || iframe.contentDocument;
  if (!frameDoc) throw new Error("Gagal menginisialisasi modul pencetakan.");

  frameDoc.open();
  frameDoc.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>${title}</title>
      <style>
        @page { size: 85.6mm 54mm; margin: 0; }
        @media print {
          body, html { margin: 0; padding: 0; width: 85.6mm; height: 54mm; }
        }
        body { margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; background: white; }
        img { width: 85.6mm; height: 54mm; object-fit: cover; display: block; }
      </style>
    </head>
    <body>
      <img src="${frontPng}" onload="window.focus(); window.print();" />
    </body>
    </html>
  `);
  frameDoc.close();
}

export function printA4GridSheet(
  cards: { frontPng: string; backPng?: string; name: string }[],
  mode: "front_only" | "back_only" | "duplex" = "front_only",
) {
  let iframe = document.getElementById(
    "id-card-print-frame",
  ) as HTMLIFrameElement | null;
  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.id = "id-card-print-frame";
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);
  }

  const frameDoc = iframe.contentWindow?.document || iframe.contentDocument;
  if (!frameDoc) throw new Error("Gagal menginisialisasi modul pencetakan.");

  let pagesHtml = "";

  if (mode === "front_only") {
    pagesHtml = `
      <div class="a4-page">
        <div class="card-grid">
          ${cards
            .map(
              (c) => `
            <div class="card-wrapper">
              <div class="crop-mark top-left"></div>
              <div class="crop-mark top-right"></div>
              <div class="crop-mark bottom-left"></div>
              <div class="crop-mark bottom-right"></div>
              <img src="${c.frontPng}" alt="${c.name}" class="card-img" />
            </div>
          `,
            )
            .join("")}
        </div>
      </div>
    `;
  } else if (mode === "back_only") {
    pagesHtml = `
      <div class="a4-page">
        <div class="card-grid">
          ${cards
            .map(
              (c) => `
            <div class="card-wrapper">
              <div class="crop-mark top-left"></div>
              <div class="crop-mark top-right"></div>
              <div class="crop-mark bottom-left"></div>
              <div class="crop-mark bottom-right"></div>
              <img src="${c.backPng || c.frontPng}" alt="${c.name}" class="card-img" />
            </div>
          `,
            )
            .join("")}
        </div>
      </div>
    `;
  } else {
    pagesHtml = `
      <div class="a4-page page-front">
        <div class="card-grid">
          ${cards
            .map(
              (c) => `
            <div class="card-wrapper">
              <div class="crop-mark top-left"></div>
              <div class="crop-mark top-right"></div>
              <div class="crop-mark bottom-left"></div>
              <div class="crop-mark bottom-right"></div>
              <img src="${c.frontPng}" alt="${c.name}" class="card-img" />
            </div>
          `,
            )
            .join("")}
        </div>
      </div>
      <div class="a4-page page-back">
        <div class="card-grid">
          ${cards
            .map(
              (c) => `
            <div class="card-wrapper">
              <div class="crop-mark top-left"></div>
              <div class="crop-mark top-right"></div>
              <div class="crop-mark bottom-left"></div>
              <div class="crop-mark bottom-right"></div>
              <img src="${c.backPng || c.frontPng}" alt="${c.name}" class="card-img" />
            </div>
          `,
            )
            .join("")}
        </div>
      </div>
    `;
  }

  frameDoc.open();
  frameDoc.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Cetak Lembar ID Card A4 SPPG</title>
      <style>
        @page {
          size: A4 portrait;
          margin: 10mm;
        }
        @media print {
          body, html { margin: 0; padding: 0; background: white; }
          .a4-page { page-break-after: always; }
          .a4-page:last-child { page-break-after: auto; }
        }
        body {
          margin: 0;
          padding: 0;
          font-family: sans-serif;
          background: #ffffff;
        }
        .a4-page {
          width: 190mm;
          min-height: 277mm;
          margin: 0 auto;
          box-sizing: border-box;
          padding-top: 5mm;
        }
        .card-grid {
          display: grid;
          grid-template-columns: repeat(2, 85.6mm);
          gap: 6mm 10mm;
          justify-content: center;
        }
        .card-wrapper {
          position: relative;
          width: 85.6mm;
          height: 54mm;
          box-sizing: border-box;
        }
        .card-img {
          width: 85.6mm;
          height: 54mm;
          object-fit: cover;
          display: block;
          border-radius: 2mm;
        }
        .crop-mark {
          position: absolute;
          width: 4mm;
          height: 4mm;
          border-color: #64748b;
          border-style: solid;
          pointer-events: none;
        }
        .top-left { top: -2mm; left: -2mm; border-width: 1px 0 0 1px; }
        .top-right { top: -2mm; right: -2mm; border-width: 1px 1px 0 0; }
        .bottom-left { bottom: -2mm; left: -2mm; border-width: 0 0 1px 1px; }
        .bottom-right { bottom: -2mm; right: -2mm; border-width: 0 1px 1px 0; }
      </style>
    </head>
    <body>
      ${pagesHtml}
      <script>
        window.onload = function() {
          setTimeout(function() {
            window.focus();
            window.print();
          }, 300);
        };
      </script>
    </body>
    </html>
  `);
  frameDoc.close();
}
