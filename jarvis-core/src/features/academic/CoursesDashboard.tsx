import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  BookOpen,
  User,
  Mail,
  Phone,
  FileText,
  Clock,
  Download,
  ExternalLink,
  Copy,
  Check,
  RefreshCw,
  Sparkles,
  AlertCircle,
  Layers,
  ChevronRight,
  Edit3,
  X,
  Folder,
  Loader2,
  CheckCircle2,
  ArrowDownToLine,
} from 'lucide-react';
import {
  getMoodleCourses,
  getMoodleTasks,
  getMoodleMaterials,
  openExternalUrl,
  updateMoodleCourseInstructor,
  openVaultCourseFolder,
  downloadCourseMaterials,
  openLocalMaterial,
  getVaultPath,
  MoodleCourse,
  MoodleTask,
  MoodleMaterial,
  MaterialDownloadProgress,
} from '../../lib/tauri-client';
import { useSyncOrchestratorStore } from './stores/syncOrchestratorStore';
import { SyncMoodleModal } from './components/SyncMoodleModal';
import { UnifiedQuestHub } from './components/UnifiedQuestHub';
import { useTauriEvent } from '../../hooks/useTauriEvent';

export const CoursesDashboard: React.FC = () => {
  const [courses, setCourses] = useState<MoodleCourse[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<number | null>(null);
  const [tasks, setTasks] = useState<MoodleTask[]>([]);
  const [materials, setMaterials] = useState<MoodleMaterial[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<'courses' | 'quests'>('courses');
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [editingCourse, setEditingCourse] = useState<MoodleCourse | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const { requestSync, serviceState } = useSyncOrchestratorStore();
  const moodleSync = serviceState.moodle;
  const isSyncing = moodleSync.isSyncing;
  const [vaultFolderError, setVaultFolderError] = useState<string | null>(null);

  // Material offline mirror state
  const [isDownloadingSlides, setIsDownloadingSlides] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = useState<MaterialDownloadProgress | null>(null);
  const [slideDownloadError, setSlideDownloadError] = useState<string | null>(null);
  const [slideSuccessMsg, setSlideSuccessMsg] = useState<string | null>(null);

  const handleOpenVaultFolder = async (courseCode: string) => {
    try {
      setVaultFolderError(null);
      await openVaultCourseFolder(courseCode);
    } catch (err) {
      console.error('[CoursesDashboard] Lỗi mở thư mục note:', err);
      setVaultFolderError(typeof err === 'string' ? err : 'Không thể mở thư mục ghi chú môn học');
      setTimeout(() => setVaultFolderError(null), 4000);
    }
  };

  const refreshCourseDetails = useCallback(async (courseId: number) => {
    try {
      const [taskList, materialList] = await Promise.all([
        getMoodleTasks(courseId).catch(() => []),
        getMoodleMaterials(courseId).catch(() => []),
      ]);
      setTasks(taskList);
      setMaterials(materialList);
    } catch (err) {
      console.error('[CoursesDashboard] Lỗi tải chi tiết môn học:', err);
    }
  }, []);

  const loadData = useCallback(async (showLoadingSpinner: boolean = true) => {
    if (showLoadingSpinner) setLoading(true);
    try {
      const courseList = await getMoodleCourses();
      setCourses(courseList);
      if (courseList.length > 0) {
        setSelectedCourseId((prev) => {
          const targetId = (prev && courseList.some((c) => c.course_id === prev))
            ? prev
            : courseList[0].course_id;
          refreshCourseDetails(targetId);
          return targetId;
        });
      }
    } catch (err) {
      console.error('[CoursesDashboard] Lỗi tải môn học Moodle:', err);
    } finally {
      if (showLoadingSpinner) setLoading(false);
    }
  }, [refreshCourseDetails]);

  useEffect(() => {
    loadData(true);
  }, [loadData]);

  useTauriEvent('moodle-data-synced', () => {
    loadData(false);
  });

  useTauriEvent<MaterialDownloadProgress>('moodle-material-download-progress', (payload) => {
    if (payload.course_id === selectedCourseId) {
      setDownloadProgress(payload);
    }
  });

  const handleDownloadAllSlides = async () => {
    if (!selectedCourseId) return;
    try {
      setSlideDownloadError(null);
      setSlideSuccessMsg(null);
      const vaultRoot = await getVaultPath();
      if (!vaultRoot || !vaultRoot.trim()) {
        setSlideDownloadError('Vui lòng chọn thư mục Obsidian Vault trong tab Vault trước khi tải tài liệu offline!');
        setTimeout(() => setSlideDownloadError(null), 6000);
        return;
      }
      setIsDownloadingSlides(true);
      const downloadedCount = await downloadCourseMaterials(selectedCourseId, vaultRoot);
      await refreshCourseDetails(selectedCourseId);
      setSlideSuccessMsg(`Đã tải và lưu thành công ${downloadedCount} tài liệu về thư mục môn học trong Vault.`);
      setTimeout(() => setSlideSuccessMsg(null), 6000);
    } catch (err) {
      console.error('[CoursesDashboard] Lỗi tải tài liệu offline:', err);
      setSlideDownloadError(typeof err === 'string' ? err : 'Lỗi khi tải slide tài liệu từ Moodle');
      setTimeout(() => setSlideDownloadError(null), 6000);
    } finally {
      setIsDownloadingSlides(false);
      setDownloadProgress(null);
    }
  };

  const handleOpenLocalMaterial = async (materialId: number) => {
    try {
      setSlideDownloadError(null);
      await openLocalMaterial(materialId);
    } catch (err) {
      console.error('[CoursesDashboard] Lỗi mở file offline:', err);
      setSlideDownloadError(typeof err === 'string' ? err : 'Không thể mở file offline bằng ứng dụng mặc định');
      setTimeout(() => setSlideDownloadError(null), 5000);
    }
  };

  const formatFileSize = (bytes?: number): string | null => {
    if (!bytes || bytes <= 0) return null;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Load tasks & materials for selected course
  useEffect(() => {
    if (!selectedCourseId) {
      setTasks([]);
      setMaterials([]);
      return;
    }

    let isMounted = true;
    Promise.all([
      getMoodleTasks(selectedCourseId).catch(() => []),
      getMoodleMaterials(selectedCourseId).catch(() => []),
    ]).then(([taskList, materialList]) => {
      if (isMounted) {
        setTasks(taskList);
        setMaterials(materialList);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [selectedCourseId]);

  const selectedCourse = useMemo(() => {
    return courses.find((c) => c.course_id === selectedCourseId) || null;
  }, [courses, selectedCourseId]);

  // Group materials by section_name
  const materialsBySection = useMemo(() => {
    const grouped: Record<string, MoodleMaterial[]> = {};
    for (const m of materials) {
      const sec = m.section_name || 'Chung';
      if (!grouped[sec]) grouped[sec] = [];
      grouped[sec].push(m);
    }
    return grouped;
  }, [materials]);

  const offlineMaterialsCount = useMemo(() => {
    return materials.filter(
      (m) =>
        m.download_status === 'synced' ||
        Boolean(m.local_file_path && m.local_file_path.trim().length > 0)
    ).length;
  }, [materials]);

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleSyncClick = async () => {
    if (courses.length === 0 || moodleSync.authStatus === 'expired') {
      setIsModalOpen(true);
    } else {
      await requestSync('moodle', { bypassTtl: true });
    }
  };

  const formatRemainingTime = (dueTs: number): string => {
    if (!dueTs) return 'Không thời hạn';
    const nowSec = Math.floor(Date.now() / 1000);
    const diff = dueTs - nowSec;
    if (diff <= 0) return 'Đã hết hạn';
    const hours = Math.floor(diff / 3600);
    const minutes = Math.floor((diff % 3600) / 60);
    if (hours < 1) return `còn ${minutes} phút`;
    if (hours < 24) return `còn ${hours} giờ ${minutes} phút`;
    const days = Math.floor(hours / 24);
    return `còn ${days} ngày`;
  };

  const formatDueDate = (dueTs: number): string => {
    if (!dueTs) return 'Chưa xác định';
    const d = new Date(dueTs * 1000);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  };

  const renderFileBadge = (fileType: string) => {
    const type = fileType.toLowerCase();
    if (type === 'pdf') {
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-500/15 text-rose-400 border border-rose-500/30">
          PDF
        </span>
      );
    }
    if (type === 'pptx' || type === 'powerpoint') {
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30">
          PPTX
        </span>
      );
    }
    if (type === 'docx' || type === 'word') {
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-sky-500/15 text-sky-400 border border-sky-500/30">
          DOCX
        </span>
      );
    }
    if (type === 'url' || type === 'link') {
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-500/15 text-indigo-400 border border-indigo-500/30">
          URL
        </span>
      );
    }
    return (
      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
        FILE
      </span>
    );
  };

  const handleSaveInstructor = async (
    courseId: number,
    name: string,
    mail: string,
    phone: string
  ) => {
    await updateMoodleCourseInstructor(courseId, name, mail, phone);
    setCourses((prev) =>
      prev.map((c) =>
        c.course_id === courseId
          ? {
              ...c,
              instructor_name: name,
              instructor_mail: mail,
              instructor_phone: phone,
            }
          : c
      )
    );
    setEditingCourse(null);
  };

  return (
    <div className="space-y-6">
      {/* Top Header & Sub-navigation */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-zinc-800 pb-5">
        <div>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-500/10 text-sky-400 border border-sky-500/20">
              <BookOpen className="h-5 w-5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-black tracking-tight text-white">Courses Engine</h1>
                <span className="rounded-full bg-sky-500/15 px-2.5 py-0.5 text-xs font-mono font-semibold text-sky-400 border border-sky-500/30">
                  Moodle UIT
                </span>
                <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-mono text-zinc-400">
                  HK2 2025-2026
                </span>
              </div>
              <p className="mt-0.5 text-xs text-zinc-400">
                Chuẩn hóa không gian lớp học phẳng: Giảng viên, Nhiệm vụ nộp bài và Danh mục slide bài giảng.
              </p>
            </div>
          </div>
        </div>

        {/* View Switcher & Sync Button */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 text-xs">
            <button
              onClick={() => setActiveTab('courses')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
                activeTab === 'courses'
                  ? 'bg-sky-600 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              <span>Lớp môn học ({courses.length})</span>
            </button>
            <button
              onClick={() => setActiveTab('quests')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
                activeTab === 'quests'
                  ? 'bg-amber-600 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>Unified Quest Hub</span>
            </button>
          </div>

          <button
            onClick={handleSyncClick}
            disabled={isSyncing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sky-600/30 bg-sky-600/10 hover:bg-sky-600/20 text-xs font-medium text-sky-300 transition-colors cursor-pointer disabled:opacity-50"
            title="Tự động đồng bộ môn học và tài liệu Moodle"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin text-sky-400' : ''}`} />
            <span>{isSyncing ? 'Đang đồng bộ...' : 'Đồng bộ Moodle'}</span>
          </button>

          <button
            onClick={() => setIsModalOpen(true)}
            className="px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 transition-colors cursor-pointer"
            title="Đăng nhập lại hoặc nạp JSON"
          >
            Tùy chọn
          </button>
        </div>
      </div>

      {/* Auth Expired Alert */}
      {moodleSync.authStatus === 'expired' && (
        <div className="flex items-center justify-between p-3.5 rounded-xl border border-rose-500/30 bg-rose-950/20 text-xs text-rose-300">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
            <span>Phiên đăng nhập Moodle UIT đã hết hạn. Vui lòng đăng nhập lại để cập nhật tài liệu mới.</span>
          </div>
          <button
            onClick={() => setIsModalOpen(true)}
            className="px-3 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white font-semibold transition-colors cursor-pointer"
          >
            Đăng nhập lại
          </button>
        </div>
      )}

      {/* Main Content Area */}
      {activeTab === 'quests' ? (
        <UnifiedQuestHub />
      ) : loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-zinc-500 gap-3">
          <RefreshCw className="h-6 w-6 animate-spin text-sky-400" />
          <span className="text-xs font-mono">Đang tải danh sách môn học...</span>
        </div>
      ) : courses.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-12 text-center space-y-4">
          <BookOpen className="mx-auto h-12 w-12 text-zinc-600" />
          <div className="space-y-1">
            <h3 className="text-base font-semibold text-zinc-200">Chưa có dữ liệu môn học Moodle</h3>
            <p className="text-xs text-zinc-400 max-w-md mx-auto">
              Nhấn nút &quot;Đồng bộ Moodle&quot; phía trên để tự động thu thập danh sách môn học, slide bài giảng và hạn chót nộp bài.
            </p>
          </div>
          <button
            onClick={() => setIsModalOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-500 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Đồng bộ ngay bây giờ</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: Course Selector (4 cols) */}
          <div className="lg:col-span-4 space-y-2.5">
            <div className="flex items-center justify-between text-xs font-semibold text-zinc-400 uppercase tracking-wider px-1">
              <span>Môn học kỳ này ({courses.length})</span>
            </div>

            <div className="space-y-2 max-h-[700px] overflow-y-auto pr-1">
              {courses.map((course) => {
                const isSelected = course.course_id === selectedCourseId;
                return (
                  <button
                    key={course.course_id}
                    onClick={() => setSelectedCourseId(course.course_id)}
                    className={`w-full text-left p-3.5 rounded-xl border transition-all cursor-pointer ${
                      isSelected
                        ? 'border-sky-500 bg-sky-950/20 shadow-sm'
                        : 'border-zinc-800/80 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-900'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="font-mono text-xs font-bold text-sky-400 bg-sky-500/10 px-2 py-0.5 rounded border border-sky-500/20">
                        {course.course_code}
                      </span>
                      {isSelected && <ChevronRight className="h-4 w-4 text-sky-400" />}
                    </div>

                    <div className="font-medium text-xs text-zinc-100 line-clamp-2 mb-2">
                      {course.fullname}
                    </div>

                    {course.instructor_name && (
                      <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 truncate">
                        <User className="h-3 w-3 text-zinc-500 shrink-0" />
                        <span className="truncate">{course.instructor_name}</span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right Column: 3 Clean Flat Zones (8 cols) */}
          <div className="lg:col-span-8 space-y-6">
            {selectedCourse ? (
              <>
                {/* ZONE 1: THÔNG TIN GIẢNG VIÊN */}
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-5 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800/60 pb-3.5">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-sky-400 bg-sky-500/10 px-2 py-0.5 rounded border border-sky-500/20">
                          {selectedCourse.course_code}
                        </span>
                        <span className="text-xs text-zinc-400">{selectedCourse.term}</span>
                      </div>
                      <h2 className="text-base font-bold text-white mt-1">{selectedCourse.fullname}</h2>
                    </div>

                    <div className="flex items-center gap-2 self-start sm:self-center">
                      <button
                        onClick={() => handleOpenVaultFolder(selectedCourse.course_code)}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-purple-800/60 bg-purple-950/40 hover:bg-purple-900/50 text-xs text-purple-300 transition-colors cursor-pointer"
                        title="Mở thư mục ghi chú của môn học ngoài File Explorer"
                      >
                        <Folder className="h-3.5 w-3.5 text-purple-400" />
                        <span>Mở thư mục Note</span>
                      </button>

                      <button
                        onClick={() => setEditingCourse(selectedCourse)}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 transition-colors cursor-pointer"
                        title="Tùy chỉnh thông tin liên hệ giảng viên"
                      >
                        <Edit3 className="h-3.5 w-3.5 text-sky-400" />
                        <span>Sửa thông tin</span>
                      </button>

                      <button
                        onClick={() => openExternalUrl(selectedCourse.course_url)}
                        className="flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300 transition-colors"
                        title="Mở trực tiếp trên Moodle UIT"
                      >
                        <span>Mở Moodle</span>
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {vaultFolderError && (
                    <div className="text-xs text-rose-400 bg-rose-950/40 border border-rose-900/60 px-3 py-2 rounded-lg">
                      {vaultFolderError}
                    </div>
                  )}

                  {/* Instructor Contacts Card */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-950/60 flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400 shrink-0">
                        <User className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-[11px] text-zinc-500">Giảng viên phụ trách</div>
                        <div className="text-xs font-semibold text-zinc-200 truncate">
                          {selectedCourse.instructor_name || 'Đang cập nhật'}
                        </div>
                      </div>
                    </div>

                    <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-950/60 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400 shrink-0">
                          <Mail className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[11px] text-zinc-500">Email liên hệ</div>
                          <div className="text-xs font-semibold text-zinc-200 truncate">
                            {selectedCourse.instructor_mail || 'Chưa có email'}
                          </div>
                        </div>
                      </div>
                      {selectedCourse.instructor_mail && (
                        <button
                          onClick={() => handleCopy(selectedCourse.instructor_mail, 'mail')}
                          className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
                          title="Copy email"
                        >
                          {copiedField === 'mail' ? (
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )}
                    </div>

                    <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-950/60 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400 shrink-0">
                          <Phone className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[11px] text-zinc-500">Điện thoại</div>
                          <div className="text-xs font-semibold text-zinc-200 truncate">
                            {selectedCourse.instructor_phone || 'Chưa có SĐT'}
                          </div>
                        </div>
                      </div>
                      {selectedCourse.instructor_phone && (
                        <button
                          onClick={() => handleCopy(selectedCourse.instructor_phone, 'phone')}
                          className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
                          title="Copy số điện thoại"
                        >
                          {copiedField === 'phone' ? (
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* ZONE 2: NHIỆM VỤ CẦN NỘP KÈM FILE TEMPLATE */}
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-zinc-800/60 pb-3">
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500/10 text-amber-400">
                        <Clock className="h-3.5 w-3.5" />
                      </span>
                      <h3 className="text-sm font-bold text-white">Nhiệm vụ & Bài tập cần nộp</h3>
                      <span className="rounded-full bg-zinc-800 px-2 py-0.2 text-[11px] font-mono text-zinc-400">
                        {tasks.length}
                      </span>
                    </div>
                  </div>

                  {tasks.length === 0 ? (
                    <div className="py-6 text-center text-xs text-zinc-500 font-mono">
                      Môn học này hiện chưa có bài tập hoặc nhiệm vụ cần nộp.
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {tasks.map((task) => (
                        <div
                          key={task.task_id}
                          className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-lg border border-zinc-800 bg-zinc-950/40 hover:border-zinc-700 transition-colors"
                        >
                          <div className="space-y-1 min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                                  task.task_type === 'quiz'
                                    ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                                    : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                }`}
                              >
                                {task.task_type === 'quiz' ? 'Quiz' : 'Assign'}
                              </span>
                              <span className="font-semibold text-xs text-zinc-200 truncate">
                                {task.title}
                              </span>
                            </div>

                            <div className="flex items-center gap-3 text-[11px] font-mono text-zinc-500">
                              <span className="text-amber-400 font-medium">
                                {formatRemainingTime(task.due_date)}
                              </span>
                              <span>•</span>
                              <span>Hạn nộp: {formatDueDate(task.due_date)}</span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            {task.template_file_url && (
                              <button
                                onClick={() => openExternalUrl(task.template_file_url)}
                                className="flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 transition-colors"
                                title="Tải mẫu đề đính kèm (.docx / .pdf)"
                              >
                                <Download className="h-3 w-3 text-sky-400" />
                                <span>Mẫu nộp</span>
                              </button>
                            )}

                            <button
                              onClick={() => openExternalUrl(task.task_url)}
                              className="flex items-center gap-1.5 px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white transition-colors"
                            >
                              <span>Nộp bài</span>
                              <ExternalLink className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ZONE 3: DANH MỤC SLIDE & TÀI LIỆU HỌC TẬP */}
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-5 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800/60 pb-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-400">
                        <FileText className="h-3.5 w-3.5" />
                      </span>
                      <h3 className="text-sm font-bold text-white">Slide bài giảng & Tài liệu môn học</h3>
                      <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] font-mono text-zinc-400">
                        {materials.length} files
                      </span>
                      {offlineMaterialsCount > 0 && (
                        <span className="rounded-full bg-emerald-950/60 border border-emerald-800/40 px-2 py-0.5 text-[10px] font-mono text-emerald-400">
                          {offlineMaterialsCount} offline
                        </span>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={handleDownloadAllSlides}
                      disabled={isDownloadingSlides || materials.length === 0}
                      className="flex items-center justify-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors shadow-sm cursor-pointer border border-emerald-500/30 whitespace-nowrap"
                      title="Tải toàn bộ tài liệu về thư mục Slides của môn trong Vault"
                    >
                      {isDownloadingSlides ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-200" />
                          <span>
                            {downloadProgress
                              ? `Đang tải ${downloadProgress.current}/${downloadProgress.total}... (${Math.round((downloadProgress.current / Math.max(downloadProgress.total, 1)) * 100)}%)`
                              : 'Đang tải Slide...'}
                          </span>
                        </>
                      ) : (
                        <>
                          <ArrowDownToLine className="h-3.5 w-3.5 text-emerald-200" />
                          <span>Tải toàn bộ Slide về máy</span>
                        </>
                      )}
                    </button>
                  </div>

                  {slideDownloadError && (
                    <div className="p-2.5 rounded-lg bg-rose-950/40 border border-rose-800/50 text-rose-300 text-xs flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                      <span>{slideDownloadError}</span>
                    </div>
                  )}

                  {slideSuccessMsg && (
                    <div className="p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-800/50 text-emerald-300 text-xs flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                      <span>{slideSuccessMsg}</span>
                    </div>
                  )}

                  {materials.length === 0 ? (
                    <div className="py-6 text-center text-xs text-zinc-500 font-mono">
                      Chưa có slide hoặc tài liệu học tập được đồng bộ cho môn này.
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {Object.entries(materialsBySection).map(([sectionName, sectionMaterials]) => (
                        <div key={sectionName} className="space-y-2">
                          <div className="text-xs font-mono font-semibold text-zinc-400 flex items-center gap-2">
                            <span className="h-1.5 w-1.5 rounded-full bg-sky-400"></span>
                            <span>{sectionName}</span>
                            <span className="text-[10px] text-zinc-600 font-normal">
                              ({sectionMaterials.length} tài liệu)
                            </span>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            {sectionMaterials.map((mat) => {
                              const isSynced =
                                mat.download_status === 'synced' ||
                                Boolean(mat.local_file_path && mat.local_file_path.trim().length > 0);
                              const isDownloadingThis =
                                isDownloadingSlides &&
                                (mat.download_status === 'downloading' ||
                                  downloadProgress?.filename === mat.title);
                              const sizeStr = formatFileSize(mat.file_size_bytes);

                              return (
                                <div
                                  key={mat.id || mat.file_url}
                                  className="group flex items-center justify-between p-2.5 rounded-lg border border-zinc-800/60 bg-zinc-950/40 hover:border-zinc-700 transition-colors text-xs gap-2"
                                >
                                  <div className="flex items-center gap-2 min-w-0 flex-1">
                                    {renderFileBadge(mat.file_type)}
                                    <span
                                      className="font-medium text-zinc-200 group-hover:text-sky-300 transition-colors truncate"
                                      title={mat.title}
                                    >
                                      {mat.title}
                                    </span>
                                    {sizeStr && (
                                      <span className="text-[10px] font-mono text-zinc-500 shrink-0">
                                        ({sizeStr})
                                      </span>
                                    )}
                                  </div>

                                  <div className="flex items-center gap-1.5 shrink-0">
                                    {isSynced ? (
                                      <>
                                        <span className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                                          <Check className="h-3 w-3" />
                                          <span>Đã lưu Offline</span>
                                        </span>
                                        <button
                                          type="button"
                                          onClick={() => handleOpenLocalMaterial(mat.id)}
                                          className="flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-950/60 hover:bg-emerald-900/80 text-emerald-300 hover:text-white transition-colors text-[11px] font-medium border border-emerald-700/50 shadow-sm cursor-pointer"
                                          title={mat.local_file_path ? `Mở: ${mat.local_file_path}` : 'Mở file offline'}
                                        >
                                          <FileText className="h-3.5 w-3.5 text-emerald-400" />
                                          <span>Mở File</span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => openExternalUrl(mat.file_url)}
                                          className="text-zinc-500 hover:text-sky-400 p-1 transition-colors"
                                          title="Mở link trực tuyến trên Moodle"
                                        >
                                          <ExternalLink className="h-3.5 w-3.5" />
                                        </button>
                                      </>
                                    ) : isDownloadingThis ? (
                                      <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono text-amber-300 bg-amber-500/10 border border-amber-500/30">
                                        <Loader2 className="h-3 w-3 animate-spin text-amber-400" />
                                        <span>Đang tải...</span>
                                      </span>
                                    ) : (
                                      <>
                                        {mat.download_status === 'failed' && (
                                          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono text-rose-400 bg-rose-500/10 border border-rose-500/20">
                                            Lỗi tải
                                          </span>
                                        )}
                                        <button
                                          type="button"
                                          onClick={() => openExternalUrl(mat.file_url)}
                                          className="flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-sky-400 transition-colors text-[11px] font-medium border border-zinc-800 cursor-pointer"
                                          title={mat.file_type === 'url' ? 'Mở liên kết web' : 'Mở hoặc tải trên Moodle'}
                                        >
                                          <span>{mat.file_type === 'url' ? 'Mở URL' : 'Mở Moodle'}</span>
                                          <ExternalLink className="h-3 w-3 text-zinc-500" />
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="py-20 text-center text-xs text-zinc-500 font-mono">
                Chọn một môn học từ danh sách bên trái để xem chi tiết.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Sync Moodle Modal */}
      <SyncMoodleModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSyncSuccess={() => {
          loadData();
        }}
      />

      {/* Edit Instructor Modal */}
      <EditInstructorModal
        course={editingCourse}
        isOpen={Boolean(editingCourse)}
        onClose={() => setEditingCourse(null)}
        onSave={handleSaveInstructor}
      />
    </div>
  );
};

interface EditInstructorModalProps {
  course: MoodleCourse | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (courseId: number, name: string, mail: string, phone: string) => Promise<void>;
}

const EditInstructorModal: React.FC<EditInstructorModalProps> = ({
  course,
  isOpen,
  onClose,
  onSave,
}) => {
  const [name, setName] = useState('');
  const [mail, setMail] = useState('');
  const [phone, setPhone] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (course) {
      setName(course.instructor_name || '');
      setMail(course.instructor_mail || '');
      setPhone(course.instructor_phone || '');
    }
  }, [course]);

  if (!isOpen || !course) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await onSave(course.course_id, name.trim(), mail.trim(), phone.trim());
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl space-y-5">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
              <User className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Tùy chỉnh thông tin giảng viên</h3>
              <p className="text-[11px] font-mono text-zinc-400">
                {course.course_code} - {course.fullname}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <div className="space-y-1.5">
            <label className="text-zinc-400 font-medium">Họ và tên giảng viên</label>
            <div className="relative">
              <User className="absolute left-3 top-2.5 h-3.5 w-3.5 text-zinc-500" />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="VD: TS. Nguyễn Văn A"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-3 text-xs text-zinc-200 placeholder-zinc-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-zinc-400 font-medium">Email liên hệ</label>
            <div className="relative">
              <Mail className="absolute left-3 top-2.5 h-3.5 w-3.5 text-zinc-500" />
              <input
                type="text"
                value={mail}
                onChange={(e) => setMail(e.target.value)}
                placeholder="VD: anguyen@uit.edu.vn"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-3 text-xs text-zinc-200 placeholder-zinc-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-zinc-400 font-medium">Số điện thoại / Zalo</label>
            <div className="relative">
              <Phone className="absolute left-3 top-2.5 h-3.5 w-3.5 text-zinc-500" />
              <input
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="VD: 0909 123 456"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-3 text-xs text-zinc-200 placeholder-zinc-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-zinc-800/60">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 font-medium transition-colors"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold transition-colors disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" />
              <span>{isSaving ? 'Đang lưu...' : 'Lưu thông tin'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CoursesDashboard;
