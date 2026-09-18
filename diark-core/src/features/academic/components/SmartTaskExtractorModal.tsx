import React, { useState, useEffect } from 'react';
import {
  Sparkles,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Trash2,
  Plus,
  RefreshCw,
  X,
  FileText,
  Key,
} from 'lucide-react';
import {
  getGeminiConfig,
  extractMoodleTasks,
  saveExtractedMoodleTasks,
  ExtractedTask,
  MoodleCourse,
} from '../../../lib/tauri-client';
import { useSettingsStore } from '../../../stores/useSettingsStore';

interface SmartTaskExtractorModalProps {
  isOpen: boolean;
  onClose: () => void;
  courses: MoodleCourse[];
  defaultCourseId?: number | null;
  onTasksSaved?: () => void;
}

export const SmartTaskExtractorModal: React.FC<SmartTaskExtractorModalProps> = ({
  isOpen,
  onClose,
  courses,
  defaultCourseId,
  onTasksSaved,
}) => {
  const [proseText, setProseText] = useState<string>('');
  const [courseHint, setCourseHint] = useState<string>('');
  const [isExtracting, setIsExtracting] = useState<boolean>(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean>(true);
  const [extractedTasks, setExtractedTasks] = useState<ExtractedTask[]>([]);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);

  // Khởi tạo course hint nếu có defaultCourseId
  useEffect(() => {
    if (defaultCourseId && courses.length > 0) {
      const found = courses.find((c) => c.course_id === defaultCourseId);
      if (found) {
        setCourseHint(found.course_code || found.fullname);
      }
    }
  }, [defaultCourseId, courses]);

  // Kiểm tra API Key khi mở Modal
  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    getGeminiConfig()
      .then((cfg) => {
        if (!isMounted) return;
        if (!cfg.api_key || cfg.api_key.trim() === '') {
          setHasApiKey(false);
          setExtractError('Chưa cấu hình Gemini API Key. Vui lòng thêm API Key để sử dụng tính năng bóc tách.');
        } else {
          setHasApiKey(true);
          setExtractError(null);
        }
      })
      .catch((err) => {
        if (!isMounted) return;
        console.error('[SmartTaskExtractor] Lỗi config:', err);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  const handleExtract = async () => {
    if (!proseText.trim() || isExtracting) return;
    setIsExtracting(true);
    setExtractError(null);
    setSaveSuccessMsg(null);

    try {
      const results = await extractMoodleTasks({
        prose_text: proseText,
        course_hint: courseHint.trim() ? courseHint : null,
      });

      if (results.length === 0) {
        setExtractError('Gemini không tìm thấy nhiệm vụ học thuật nào trong đoạn văn bản trên.');
      } else {
        setExtractedTasks(results);
      }
    } catch (err) {
      console.error('[SmartTaskExtractor] Bóc tách lỗi:', err);
      setExtractError(typeof err === 'string' ? err : 'Không thể bóc tách nhiệm vụ với Gemini API.');
    } finally {
      setIsExtracting(false);
    }
  };

  const handleTaskChange = (index: number, field: keyof ExtractedTask, value: string | number) => {
    setExtractedTasks((prev) =>
      prev.map((t, i) => (i === index ? { ...t, [field]: value } : t))
    );
  };

  const handleRemoveTask = (index: number) => {
    setExtractedTasks((prev) => prev.filter((_, i) => i !== index));
  };

  const handleAddTask = () => {
    const newTask: ExtractedTask = {
      title: 'Nhiệm vụ mới',
      course_code: courseHint || 'CHUNG',
      course_name: 'Môn học',
      due_date_str: '23:59 31/12/2026',
      due_timestamp: Math.floor(Date.now() / 1000) + 86400 * 7,
      priority: 'normal',
      description: '',
      task_type: 'assignment',
    };
    setExtractedTasks((prev) => [...prev, newTask]);
  };

  const handleSaveAllTasks = async () => {
    if (extractedTasks.length === 0 || isSaving) return;
    setIsSaving(true);
    setSaveSuccessMsg(null);
    setExtractError(null);

    try {
      const savedCount = await saveExtractedMoodleTasks(extractedTasks);
      setSaveSuccessMsg(`Đã lưu thành công ${savedCount} nhiệm vụ vào danh mục Nhiệm vụ Moodle!`);
      if (onTasksSaved) {
        onTasksSaved();
      }
      setTimeout(() => {
        setExtractedTasks([]);
        setProseText('');
      }, 2000);
    } catch (err) {
      console.error('[SmartTaskExtractor] Lỗi lưu tasks:', err);
      setExtractError(typeof err === 'string' ? err : 'Lỗi khi lưu danh sách nhiệm vụ vào cơ sở dữ liệu.');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-4xl rounded-xl border border-zinc-800 bg-zinc-950 p-5 sm:p-6 shadow-2xl flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/25">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white">Smart Task Extractor</h2>
                <span className="rounded-md bg-indigo-950/80 px-2 py-0.5 text-[11px] font-mono text-indigo-400 border border-indigo-800/60">
                  Gemini Structured Output
                </span>
              </div>
              <p className="text-xs text-zinc-400 mt-0.5">
                Bóc tách bài viết văn xuôi của giảng viên (diễn đàn Moodle, Zalo, Email) thành nhiệm vụ có deadline cụ thể.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors cursor-pointer"
            aria-label="Đóng modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Missing API Key Alert */}
        {!hasApiKey && (
          <div className="mt-4 rounded-lg border border-amber-600/30 bg-amber-950/30 p-3 text-xs text-amber-200 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Key className="w-4 h-4 text-amber-400 shrink-0" />
              <span>Chưa cấu hình Gemini API Key cá nhân. Bạn cần nhập API Key để bóc tách thông báo.</span>
            </div>
            <button
              type="button"
              onClick={() => useSettingsStore.getState().openSettings('copilot')}
              className="px-3 py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold text-xs whitespace-nowrap cursor-pointer transition-colors"
            >
              Cấu hình BYOK
            </button>
          </div>
        )}

        {/* Form Input Section */}
        <div className="mt-4 space-y-3">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
            <label className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5 text-indigo-400" />
              <span>Đoạn văn xuôi thông báo của giảng viên:</span>
            </label>

            {courses.length > 0 && (
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-zinc-400">Gợi ý môn học:</span>
                <select
                  value={courseHint}
                  onChange={(e) => setCourseHint(e.target.value)}
                  className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="">Tự động nhận diện môn học</option>
                  {courses.map((c) => (
                    <option key={c.course_id} value={c.course_code || c.fullname}>
                      {c.course_code ? `${c.course_code} - ${c.fullname}` : c.fullname}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <textarea
            value={proseText}
            onChange={(e) => setProseText(e.target.value)}
            rows={4}
            placeholder="Ví dụ: 'Chào các bạn, thầy gửi bài tập lớn môn CSDL. Các nhóm nộp báo cáo qua link Moodle trước 23h59 ngày 30/10/2026. Tuần sau ngày 05/11 sẽ có bài kiểm tra trắc nghiệm 15 phút tại lớp...'"
            disabled={isExtracting || !hasApiKey}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/80 p-3 text-xs font-mono text-zinc-200 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none disabled:opacity-50 resize-y"
          />

          <div className="flex items-center justify-between">
            <span className="text-[11px] text-zinc-500">
              * Gemini sẽ chuẩn hóa thời hạn thành Unix timestamp và phân loại độ khẩn cấp.
            </span>
            <button
              type="button"
              onClick={handleExtract}
              disabled={isExtracting || !hasApiKey || !proseText.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-xs font-semibold text-white transition-colors cursor-pointer disabled:opacity-50"
            >
              {isExtracting ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              <span>{isExtracting ? 'Đang bóc tách...' : 'Bóc tách bằng Gemini'}</span>
            </button>
          </div>
        </div>

        {/* Error Alert */}
        {extractError && (
          <div className="mt-3 rounded-lg border border-rose-800/60 bg-rose-950/40 p-3 text-xs text-rose-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{extractError}</span>
          </div>
        )}

        {/* Success Alert */}
        {saveSuccessMsg && (
          <div className="mt-3 rounded-lg border border-emerald-800/60 bg-emerald-950/40 p-3 text-xs text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{saveSuccessMsg}</span>
          </div>
        )}

        {/* Extracted Tasks Review Table */}
        {extractedTasks.length > 0 && (
          <div className="mt-4 flex-1 flex flex-col min-h-0 border-t border-zinc-800 pt-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-zinc-200">
                  Kết quả bóc tách ({extractedTasks.length} nhiệm vụ):
                </span>
                <span className="text-[11px] text-zinc-400">
                  Bạn có thể chỉnh sửa trực tiếp trước khi lưu vào SQLite.
                </span>
              </div>
              <button
                type="button"
                onClick={handleAddTask}
                className="flex items-center gap-1 text-[11px] font-semibold text-indigo-400 hover:text-indigo-300 cursor-pointer"
              >
                <Plus className="w-3 h-3" />
                <span>Thêm thủ công</span>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/40 p-1">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-400 text-[11px]">
                    <th className="py-2 px-2.5">Tiêu đề nhiệm vụ</th>
                    <th className="py-2 px-2">Mã môn</th>
                    <th className="py-2 px-2">Loại</th>
                    <th className="py-2 px-2">Mức độ</th>
                    <th className="py-2 px-2">Hạn nộp</th>
                    <th className="py-2 px-1 text-center">Xóa</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60 text-zinc-200">
                  {extractedTasks.map((task, idx) => (
                    <tr key={idx} className="hover:bg-zinc-900/60">
                      <td className="py-2 px-2.5 font-medium">
                        <input
                          type="text"
                          value={task.title}
                          onChange={(e) => handleTaskChange(idx, 'title', e.target.value)}
                          className="w-full bg-transparent border-b border-transparent hover:border-zinc-700 focus:border-indigo-500 focus:outline-none text-zinc-200 font-semibold"
                        />
                        <input
                          type="text"
                          value={task.description}
                          placeholder="Mô tả bổ sung..."
                          onChange={(e) => handleTaskChange(idx, 'description', e.target.value)}
                          className="w-full bg-transparent text-[11px] text-zinc-400 placeholder-zinc-600 focus:outline-none"
                        />
                      </td>
                      <td className="py-2 px-2 whitespace-nowrap">
                        <input
                          type="text"
                          value={task.course_code}
                          onChange={(e) => handleTaskChange(idx, 'course_code', e.target.value)}
                          className="w-20 rounded bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 text-[11px] font-mono text-zinc-300 focus:border-indigo-500 focus:outline-none"
                        />
                      </td>
                      <td className="py-2 px-2 whitespace-nowrap">
                        <select
                          value={task.task_type}
                          onChange={(e) => handleTaskChange(idx, 'task_type', e.target.value)}
                          className="rounded bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300 focus:border-indigo-500 focus:outline-none"
                        >
                          <option value="assignment">Assignment</option>
                          <option value="quiz">Quiz / Trắc nghiệm</option>
                          <option value="lab">Lab / Thực hành</option>
                          <option value="report">Report / Báo cáo</option>
                          <option value="exam">Exam / Thi</option>
                          <option value="general">Khác</option>
                        </select>
                      </td>
                      <td className="py-2 px-2 whitespace-nowrap">
                        <select
                          value={task.priority}
                          onChange={(e) => handleTaskChange(idx, 'priority', e.target.value)}
                          className={`rounded border border-zinc-800 px-1.5 py-0.5 text-[11px] font-semibold focus:outline-none ${
                            task.priority === 'urgent'
                              ? 'bg-rose-950/80 text-rose-400'
                              : task.priority === 'high'
                              ? 'bg-amber-950/80 text-amber-400'
                              : 'bg-zinc-800 text-zinc-300'
                          }`}
                        >
                          <option value="urgent">Khẩn cấp</option>
                          <option value="high">Ưu tiên cao</option>
                          <option value="normal">Bình thường</option>
                        </select>
                      </td>
                      <td className="py-2 px-2 whitespace-nowrap">
                        <div className="flex items-center gap-1 font-mono text-[11px] text-zinc-300">
                          <Clock className="w-3 h-3 text-zinc-500" />
                          <input
                            type="text"
                            value={task.due_date_str}
                            onChange={(e) => handleTaskChange(idx, 'due_date_str', e.target.value)}
                            className="w-36 rounded bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 text-[11px] font-mono text-zinc-300 focus:border-indigo-500 focus:outline-none"
                          />
                        </div>
                      </td>
                      <td className="py-2 px-1 text-center">
                        <button
                          type="button"
                          onClick={() => handleRemoveTask(idx)}
                          className="p-1 rounded text-zinc-500 hover:text-rose-400 hover:bg-rose-950/40 transition-colors cursor-pointer"
                          title="Xóa nhiệm vụ này"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="mt-4 flex items-center justify-between border-t border-zinc-800 pt-3">
          <div className="text-[11px] text-zinc-500">
            Nhiệm vụ được lưu vào SQLite và đồng bộ cùng Unified Quest Hub.
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 transition-colors cursor-pointer"
            >
              Đóng
            </button>

            {extractedTasks.length > 0 && (
              <button
                type="button"
                onClick={handleSaveAllTasks}
                disabled={isSaving}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-white transition-colors cursor-pointer disabled:opacity-50"
              >
                {isSaving ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                )}
                <span>Lưu vào Nhiệm vụ Moodle</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
