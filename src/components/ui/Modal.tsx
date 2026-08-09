import type { KeyboardEvent, ReactNode } from "react";

interface ModalProps {
  children: ReactNode;
  descriptionId?: string;
  onClose: () => void;
  title: string;
  titleId: string;
}

function focusDialog(node: HTMLDivElement | null) {
  node?.focus();
}

export function Modal({
  children,
  descriptionId,
  onClose,
  title,
  titleId,
}: ModalProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") onClose();
  };

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center overflow-y-auto bg-slate-950/85 p-4 backdrop-blur-md">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        ref={focusDialog}
        onKeyDown={handleKeyDown}
        className="my-auto max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-3xl border border-slate-800 bg-slate-900 p-5 shadow-2xl sm:p-6"
      >
        <div className="mb-5 flex items-center justify-between gap-4 border-b border-slate-800 pb-3">
          <h2 id={titleId} className="text-base font-bold text-white">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup dialog"
            className="grid size-11 shrink-0 place-items-center rounded-xl text-xl text-slate-400 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
          >
            &times;
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
