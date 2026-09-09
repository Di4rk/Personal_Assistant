import { useEffect, useState } from "react";
import { getPostMortem, savePostMortem } from "../lib/tauri-client";
import {
  ROOT_CAUSE_LABELS,
  type PostMortemInput,
  type RootCauseType,
} from "../types/post_mortem";

export interface SelectedSubmission {
  problemId: string;
  problemName: string;
  verdict: string;
}

interface PostMortemModalProps {
  isOpen: boolean;
  onClose: () => void;
  submission: SelectedSubmission | null;
}

const ROOT_CAUSES: RootCauseType[] = [
  "LOGIC_BUG",
  "CORNER_CASE",
  "TIME_COMPLEXITY",
  "IMPLEMENTATION",
  "MISREAD",
];

function createInitialForm(submission: SelectedSubmission): PostMortemInput {
  return {
    problem_id: submission.problemId,
    problem_name: submission.problemName,
    platform: "codeforces",
    root_cause: "LOGIC_BUG",
    key_insight: "",
    tags: "",
  };
}

export default function PostMortemModal({
  isOpen,
  onClose,
  submission,
}: PostMortemModalProps) {
  const [form, setForm] = useState<PostMortemInput | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isOpen || !submission) return;

    let cancelled = false;
    const initialForm = createInitialForm(submission);
    setForm(initialForm);
    setError("");
    setIsLoading(true);

    getPostMortem(submission.problemId)
      .then((record) => {
        if (!record || cancelled) return;

        setForm({
          problem_id: record.problem_id,
          problem_name: record.problem_name,
          platform: record.platform,
          root_cause: record.root_cause,
          key_insight: record.key_insight,
          tags: record.tags,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setError("Không thể tải post-mortem hiện có. Bạn vẫn có thể tạo bản mới.");
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, submission]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSaving) onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isSaving, onClose]);

  if (!isOpen || !submission || !form) return null;

  const updateField = <K extends keyof PostMortemInput>(
    field: K,
    value: PostMortemInput[K],
  ) => {
    setForm((current) => (current ? { ...current, [field]: value } : current));
  };

  const handleSave = async () => {
    if (!form.key_insight.trim()) {
      setError("Hãy ghi lại ít nhất một bài học rút ra trước khi lưu.");
      return;
    }

    setIsSaving(true);
    setError("");

    try {
      await savePostMortem(form);
      onClose();
    } catch (saveError) {
      console.error("[post-mortem] save failed:", saveError);
      setError("Không thể lưu post-mortem. Hãy kiểm tra lại dữ liệu và thử lại.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-950/80 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSaving) onClose();
      }}
    >
      <section
        aria-labelledby="post-mortem-title"
        aria-modal="true"
        className="w-full max-w-2xl rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl"
        role="dialog"
      >
        <header className="flex items-start justify-between gap-4 border-b border-zinc-800 p-4">
          <div>
            <h2 id="post-mortem-title" className="text-base font-semibold text-zinc-100">
              Post-mortem
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              {submission.problemName} · {submission.problemId} · {submission.verdict}
            </p>
          </div>
          <button
            aria-label="Đóng post-mortem"
            className="rounded-md border border-zinc-700 px-2 py-1 text-sm text-zinc-400 transition-colors duration-150 ease-out hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
            disabled={isSaving}
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </header>

        <div className="space-y-4 p-4">
          {isLoading ? (
            <div className="h-40 animate-pulse rounded-md bg-zinc-900" />
          ) : (
            <>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                  Root cause
                </span>
                <select
                  className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors duration-150 ease-out focus:border-violet-500"
                  onChange={(event) => updateField("root_cause", event.target.value as RootCauseType)}
                  value={form.root_cause}
                >
                  {ROOT_CAUSES.map((rootCause) => (
                    <option key={rootCause} value={rootCause}>
                      {ROOT_CAUSE_LABELS[rootCause]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                  Key insight
                </span>
                <textarea
                  className="mt-2 min-h-32 w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm leading-6 text-zinc-100 outline-none transition-colors duration-150 ease-out placeholder:text-zinc-500 focus:border-violet-500"
                  onChange={(event) => updateField("key_insight", event.target.value)}
                  placeholder="What failed, why it failed, and the invariant you will check next time."
                  value={form.key_insight}
                />
              </label>

              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                  Tags
                </span>
                <input
                  className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors duration-150 ease-out placeholder:text-zinc-500 focus:border-violet-500"
                  onChange={(event) => updateField("tags", event.target.value)}
                  placeholder="dp, graph, invariant"
                  value={form.tags}
                />
              </label>
            </>
          )}

          {error && (
            <p className="rounded-md border border-rose-800 bg-rose-950/40 px-3 py-2 text-sm text-rose-300" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-zinc-800 p-4">
          <button
            className="rounded-md px-3 py-2 text-sm font-medium text-zinc-400 transition-colors duration-150 ease-out hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
            disabled={isSaving}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="rounded-md bg-violet-500 px-3 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-violet-600 focus:outline-none focus:ring-2 focus:ring-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isLoading || isSaving}
            onClick={handleSave}
            type="button"
          >
            {isSaving ? "Saving…" : "Save post-mortem"}
          </button>
        </footer>
      </section>
    </div>
  );
}
