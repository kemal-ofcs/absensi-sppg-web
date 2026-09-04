"use client";

import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface ModalProps {
  children: ReactNode;
  className?: string;
  descriptionId?: string;
  footer?: ReactNode;
  hideFooter?: boolean;
  isOpen?: boolean;
  maxWidth?: string;
  onClose: () => void;
  subtitle?: string;
  title: string;
  titleId?: string;
}

export function Modal({
  children,
  className = "",
  descriptionId,
  footer,
  hideFooter = true,
  isOpen = true,
  maxWidth = "max-w-lg",
  onClose,
  subtitle,
  title,
  titleId = "modal-title",
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    dialogRef.current?.focus({ preventScroll: true });
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  if (!isOpen || !mounted) return null;

  const handleContainerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };

  return createPortal(
    <div
      data-no-pull-refresh
      className="visual-modal-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 md:p-8 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-150"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleContainerKeyDown}
        className={`app-modal-panel visual-modal-panel relative flex w-full ${maxWidth} flex-col overflow-hidden rounded-3xl border border-white/15 bg-slate-900 shadow-2xl shadow-black/80 backdrop-blur-2xl transition-all animate-in zoom-in-95 duration-150 focus:outline-none ${className}`}
        style={{ maxHeight: "calc(100vh - 4rem)" }}
      >
        {/* Sticky Modal Header */}
        <div className="app-modal-header flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-slate-900/95 px-5 py-3.5 sm:px-6 sm:py-4 backdrop-blur-sm">
          <div className="min-w-0 flex-1">
            <h3
              id={titleId}
              className="app-modal-title truncate text-sm sm:text-base font-bold text-white tracking-wide"
              title={title}
            >
              {title}
            </h3>
            {subtitle ? (
              <p className="app-modal-subtitle mt-0.5 truncate text-[11px] text-slate-400">
                {subtitle}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup dialog"
            className="app-modal-close grid size-9 shrink-0 place-items-center rounded-xl bg-white/10 text-sm font-bold text-slate-300 transition hover:bg-white/20 hover:text-white active:scale-95"
          >
            ✕
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="app-modal-body flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 text-slate-100 touch-pan-y overscroll-contain">
          {children}
        </div>

        {/* Optional Sticky Footer */}
        {footer ? (
          <div className="app-modal-footer flex shrink-0 items-center justify-end border-t border-white/10 bg-slate-950/80 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        ) : !hideFooter ? (
          <div className="app-modal-footer flex shrink-0 items-center justify-end border-t border-white/10 bg-slate-950/80 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <button
              type="button"
              onClick={onClose}
              className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 active:scale-95 text-slate-950 font-black text-xs transition shadow-md shadow-sky-500/20"
            >
              Tutup
            </button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
