import React, { useState } from "react";
import { SyncPortalModal } from "./SyncPortalModal";
import type { AcademicOverviewDto } from "../types";

export interface SyncPortalButtonProps {
  onSyncSuccess?: (overview?: AcademicOverviewDto) => void;
  className?: string;
}

export const SyncPortalButton: React.FC<SyncPortalButtonProps> = ({
  onSyncSuccess,
  className = "",
}) => {
  const [isOpen, setIsOpen] = useState<boolean>(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 active:bg-sky-700 text-white text-xs font-semibold shadow-sm transition-all cursor-pointer ${className}`}
      >
        <span className="text-white">⚡</span>
        <span>Đồng bộ Cổng UIT</span>
      </button>

      <SyncPortalModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        onSyncSuccess={onSyncSuccess}
      />
    </>
  );
};

export default SyncPortalButton;
