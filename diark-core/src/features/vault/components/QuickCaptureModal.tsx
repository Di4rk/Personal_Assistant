import React, { useState, useEffect } from "react";
import {
  X,
  Zap,
  BookOpen,
  ExternalLink,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Code2,
} from "lucide-react";
import { createStructuredNote, openOnenoteLink } from "@/lib/tauri-client";
import type { CreateStructuredNoteDto, NoteType } from "../types";
import type { QuickNotePrefill } from "@/stores/useQuickCaptureStore";

interface QuickCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  vaultPath?: string;
  prefill?: QuickNotePrefill | null;
}

type TabType = "ALGO_TRICK" | "ONENOTE_LINK";

export const QuickCaptureModal: React.FC<QuickCaptureModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  vaultPath,
  prefill,
}) => {
  const [activeTab, setActiveTab] = useState<TabType>("ALGO_TRICK");

  // Common fields
  const [title, setTitle] = useState<string>("");
  const [tagsInput, setTagsInput] = useState<string>("");

  // Algo Trick fields
  const [platformLink, setPlatformLink] = useState<string>("");
  const [algoInsight, setAlgoInsight] = useState<string>("");
  const [algoCode, setAlgoCode] = useState<string>("");

  // OneNote fields
  const [subject, setSubject] = useState<string>("");
  const [onenoteUri, setOnenoteUri] = useState<string>("");
  const [onenoteDraft, setOnenoteDraft] = useState<string>("");
  const [isTestingLink, setIsTestingLink] = useState<boolean>(false);
  const [testLinkSuccess, setTestLinkSuccess] = useState<boolean | null>(null);
  const [testLinkError, setTestLinkError] = useState<string | null>(null);

  // Form submission state
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && prefill) {
      if (prefill.mode === "onenote") {
        setActiveTab("ONENOTE_LINK");
      } else {
        setActiveTab("ALGO_TRICK");
      }

      if (prefill.title) setTitle(prefill.title);
      if (prefill.platformLink) setPlatformLink(prefill.platformLink);
      if (prefill.tags && prefill.tags.length > 0) {
        setTagsInput(prefill.tags.map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" "));
      }
      if (prefill.codeSnippet) setAlgoCode(prefill.codeSnippet);
      if (prefill.prose) setAlgoInsight(prefill.prose);
    }
  }, [isOpen, prefill]);

  if (!isOpen) {
    return null;
  }

  const handleAutoGrow = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  const handleTestOneNoteLink = async () => {
    if (!onenoteUri.trim()) {
      setTestLinkError("Vui lòng nhập OneNote URI để kiểm tra");
      setTestLinkSuccess(false);
      return;
    }

    setIsTestingLink(true);
    setTestLinkError(null);
    setTestLinkSuccess(null);

    try {
      await openOnenoteLink(onenoteUri.trim());
      setTestLinkSuccess(true);
      setTimeout(() => setTestLinkSuccess(null), 3000);
    } catch (err) {
      setTestLinkSuccess(false);
      setTestLinkError(typeof err === "string" ? err : "Không thể mở OneNote URI");
    } finally {
      setIsTestingLink(false);
    }
  };

  const resetForm = () => {
    setTitle("");
    setTagsInput("");
    setPlatformLink("");
    setAlgoInsight("");
    setAlgoCode("");
    setSubject("");
    setOnenoteUri("");
    setOnenoteDraft("");
    setSubmitError(null);
    setTestLinkError(null);
    setTestLinkSuccess(null);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitError(null);

    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setSubmitError("Tiêu đề note không được để trống.");
      return;
    }

    // Parse common tags
    const rawTags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    let noteType: NoteType = "ALGO_TRICK";
    let prose = "";
    let codeSnippet: string | undefined = undefined;
    let externalUri: string | undefined = undefined;

    if (activeTab === "ALGO_TRICK") {
      noteType = "ALGO_TRICK";
      const cleanInsight = algoInsight.trim();
      if (!cleanInsight) {
        setSubmitError("Vui lòng nhập Key Insight cho thuật toán.");
        return;
      }
      prose = platformLink.trim()
        ? `**Nguồn / Bài toán:** ${platformLink.trim()}\n\n${cleanInsight}`
        : cleanInsight;
      codeSnippet = algoCode.trim() ? algoCode.trim() : undefined;
    } else if (activeTab === "ONENOTE_LINK") {
      noteType = "ONENOTE_LINK";
      const cleanUri = onenoteUri.trim();
      if (!cleanUri) {
        setSubmitError("Vui lòng nhập OneNote URI (onenote:...).");
        return;
      }
      externalUri = cleanUri;
      const cleanDraft = onenoteDraft.trim();
      prose = subject.trim()
        ? `**Môn học / Chủ đề:** ${subject.trim()}\n\n${cleanDraft || "Ghi chú liên kết từ OneNote."}`
        : cleanDraft || "Ghi chú liên kết từ OneNote.";
      if (subject.trim() && !rawTags.includes(subject.trim())) {
        rawTags.push(subject.trim());
      }
    }

    const payload: CreateStructuredNoteDto = {
      title: cleanTitle,
      noteType,
      tags: rawTags,
      prose,
      codeSnippet,
      externalUri,
      vaultPath: vaultPath?.trim() || undefined,
    };

    setIsSubmitting(true);
    try {
      await createStructuredNote(payload);
      resetForm();
      onSuccess?.();
      onClose();
    } catch (err) {
      setSubmitError(typeof err === "string" ? err : "Lỗi khi lưu note vào Vault.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75">
      <div className="w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 bg-zinc-900">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-emerald-950/60 border border-emerald-800/40 text-emerald-400">
              <Zap className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">Lưu nhanh ghi chú</h3>
              <p className="text-[11px] text-zinc-400">
                Tạo ghi chú có cấu trúc và đồng bộ ngay vào mục Ghi chú
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-zinc-800 bg-zinc-950/50 p-1.5 gap-1.5">
          <button
            type="button"
            onClick={() => {
              setActiveTab("ALGO_TRICK");
              setSubmitError(null);
            }}
            className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 text-xs font-medium rounded-lg transition-colors ${
              activeTab === "ALGO_TRICK"
                ? "bg-emerald-600/20 text-emerald-300 border border-emerald-500/30"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
            }`}
          >
            <Code2 className="w-3.5 h-3.5" />
            <span>Mẹo thuật toán</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setActiveTab("ONENOTE_LINK");
              setSubmitError(null);
            }}
            className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 text-xs font-medium rounded-lg transition-colors ${
              activeTab === "ONENOTE_LINK"
                ? "bg-emerald-600/20 text-emerald-300 border border-emerald-500/30"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>Liên kết OneNote</span>
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Error Banner */}
          {submitError && (
            <div className="flex items-center gap-2 text-xs text-rose-400 bg-rose-950/40 border border-rose-900/60 p-3 rounded-lg">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{submitError}</span>
            </div>
          )}

          {/* Common Title */}
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">
              Tiêu đề ghi chú <span className="text-emerald-400">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                activeTab === "ALGO_TRICK"
                  ? "Ví dụ: Two Pointers trên mảng đã sắp xếp"
                  : "Ví dụ: Kiến trúc máy tính — Chương 3 Pipelines"
              }
              className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
              required
            />
          </div>

          {/* TAB 1: ALGO TRICK */}
          {activeTab === "ALGO_TRICK" && (
            <>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Nguồn / Link bài tập
                </label>
                <input
                  type="text"
                  value={platformLink}
                  onChange={(e) => setPlatformLink(e.target.value)}
                  placeholder="https://codeforces.com/contest/... hoặc LeetCode 15"
                  className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Ý tưởng chính <span className="text-emerald-400">*</span>
                </label>
                <textarea
                  value={algoInsight}
                  onChange={(e) => setAlgoInsight(e.target.value)}
                  onInput={handleAutoGrow}
                  rows={3}
                  placeholder="Điểm mấu chốt, biến đổi trạng thái, mẹo xử lý biên..."
                  className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500 resize-none font-sans leading-relaxed"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Đoạn code mẫu (C++ / Rust / Python)
                </label>
                <textarea
                  value={algoCode}
                  onChange={(e) => setAlgoCode(e.target.value)}
                  onInput={handleAutoGrow}
                  rows={4}
                  placeholder="int l = 0, r = n - 1;&#10;while (l < r) { ... }"
                  className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500 resize-none font-mono text-[11px]"
                />
              </div>
            </>
          )}

          {/* TAB 2: ONENOTE BINDER */}
          {activeTab === "ONENOTE_LINK" && (
            <>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Môn học / Chủ đề
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Ví dụ: Giải tích 1, Mạng máy tính, CTDL..."
                  className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  OneNote URI <span className="text-emerald-400">*</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={onenoteUri}
                    onChange={(e) => setOnenoteUri(e.target.value)}
                    placeholder="onenote:https://d.docs.live.net/..."
                    className="flex-1 px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500 font-mono text-[11px]"
                    required
                  />
                  <button
                    type="button"
                    onClick={handleTestOneNoteLink}
                    disabled={isTestingLink || !onenoteUri.trim()}
                    className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-xs font-medium rounded-lg transition-colors border border-zinc-700 whitespace-nowrap"
                  >
                    {isTestingLink ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : testLinkSuccess ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <ExternalLink className="w-3.5 h-3.5 text-emerald-400" />
                    )}
                    <span>Kiểm tra mở thử</span>
                  </button>
                </div>
                {testLinkError && (
                  <p className="mt-1 text-[11px] text-rose-400">{testLinkError}</p>
                )}
                {testLinkSuccess && (
                  <p className="mt-1 text-[11px] text-emerald-400">Đã gửi lệnh mở OneNote URI thành công.</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Tóm tắt nội dung
                </label>
                <textarea
                  value={onenoteDraft}
                  onChange={(e) => setOnenoteDraft(e.target.value)}
                  onInput={handleAutoGrow}
                  rows={3}
                  placeholder="Ghi nhanh các ý chính, trang mục lục hoặc từ khóa để tìm lại sau..."
                  className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500 resize-none font-sans leading-relaxed"
                />
              </div>
            </>
          )}

          {/* Common Tags input */}
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">
              Thẻ gắn kèm (phân cách bằng dấu phẩy)
            </label>
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="dp, it004, giua-ky..."
              className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
            />
          </div>

          {/* Footer Controls */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-2 px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Đang lưu...</span>
                </>
              ) : (
                <span>Tạo ghi chú</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
