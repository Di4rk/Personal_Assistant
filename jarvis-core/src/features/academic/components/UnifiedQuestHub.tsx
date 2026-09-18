import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Clock,
  AlertTriangle,
  CheckCircle2,
  Calendar,
  Download,
  ExternalLink,
  Search,
  BookOpen,
  Code2,
  Sparkles,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
import {
  getMoodleTasks,
  getWecodeAssignments,
  getWecodeProblems,
  openExternalUrl,
  MoodleTask,
} from '../../../lib/tauri-client';
import type { WecodeAssignmentMeta, WecodeProblemRecord } from '../../../types/wecode';
import { useSyncOrchestratorStore } from '../stores/syncOrchestratorStore';
import { useTauriEvent } from '../../../hooks/useTauriEvent';

export type QuestUrgency = 'critical' | 'upcoming' | 'completed';
export type QuestPlatform = 'all' | 'moodle' | 'wecode';

export interface UnifiedQuestItem {
  id: string;
  source: 'moodle' | 'wecode';
  title: string;
  courseCode: string;
  courseName: string;
  dueTimestamp: number; // Unix epoch seconds
  dueDateStr: string;
  isSubmitted: boolean;
  statusLabel: string;
  actionUrl: string;
  templateUrl?: string;
  taskType?: string; // assign, quiz, wecode
  solvedCount?: number;
  totalCount?: number;
}

function formatRemainingTime(secondsRemaining: number): string {
  if (secondsRemaining < -30 * 86400) return 'Đã đóng (Lưu trữ)';
  if (secondsRemaining <= 0) {
    const overdueDays = Math.floor(Math.abs(secondsRemaining) / 86400);
    return overdueDays > 0 ? `Quá hạn ${overdueDays} ngày` : 'Quá hạn hôm nay';
  }
  const hours = Math.floor(secondsRemaining / 3600);
  const minutes = Math.floor((secondsRemaining % 3600) / 60);

  if (hours < 1) {
    return `còn ${minutes} phút`;
  }
  if (hours < 24) {
    return `còn ${hours} giờ ${minutes} phút`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `còn ${days} ngày ${remHours} giờ`;
}

function formatTimestamp(ts: number): string {
  if (!ts) return 'Không thời hạn';
  const d = new Date(ts * 1000);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

function parseWecodeDate(dateStr?: string): number {
  if (!dateStr) return 0;
  // Format: 'YYYY-MM-DD HH:MM:SS'
  const parsed = Date.parse(dateStr.replace(' ', 'T') + '+07:00');
  return isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

export const UnifiedQuestHub: React.FC = () => {
  const [moodleTasks, setMoodleTasks] = useState<MoodleTask[]>([]);
  const [wecodeAssignments, setWecodeAssignments] = useState<WecodeAssignmentMeta[]>([]);
  const [wecodeProblems, setWecodeProblems] = useState<WecodeProblemRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [platformFilter, setPlatformFilter] = useState<QuestPlatform>('all');
  const [nowSec, setNowSec] = useState<number>(Math.floor(Date.now() / 1000));

  const { requestSync, serviceState } = useSyncOrchestratorStore();
  const isSyncing = serviceState.moodle.isSyncing || serviceState.wecode.isSyncing;

  // Real-time ticking clock every 30s
  useEffect(() => {
    const timer = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 30000);
    return () => clearInterval(timer);
  }, []);

  const loadAllData = useCallback(async (showLoadingSpinner: boolean = true) => {
    if (showLoadingSpinner) setLoading(true);
    try {
      const [mTasks, wAssigns, wProbs] = await Promise.all([
        getMoodleTasks().catch(() => []),
        getWecodeAssignments().catch(() => []),
        getWecodeProblems().catch(() => []),
      ]);
      setMoodleTasks(mTasks);
      setWecodeAssignments(wAssigns);
      setWecodeProblems(wProbs);
    } catch (err) {
      console.error('[UnifiedQuestHub] Lỗi nạp dữ liệu nhiệm vụ:', err);
    } finally {
      if (showLoadingSpinner) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAllData(true);
  }, [loadAllData]);

  useTauriEvent('moodle-data-synced', () => {
    loadAllData(false);
  });

  // Compute Unified Quests
  const allQuests = useMemo<UnifiedQuestItem[]>(() => {
    const list: UnifiedQuestItem[] = [];

    // 1. Map Moodle Tasks
    for (const t of moodleTasks) {
      list.push({
        id: `moodle-${t.task_id}`,
        source: 'moodle',
        title: t.title,
        courseCode: t.course_code || 'MOODLE',
        courseName: t.course_name || 'Môn học Moodle',
        dueTimestamp: t.due_date,
        dueDateStr: formatTimestamp(t.due_date),
        isSubmitted: t.is_submitted,
        statusLabel: t.submission_status || (t.is_submitted ? 'Đã nộp' : 'Chưa nộp'),
        actionUrl: t.task_url,
        templateUrl: t.template_file_url || undefined,
        taskType: t.task_type,
      });
    }

    // 2. Map Wecode Assignments
    for (const a of wecodeAssignments) {
      const finishTs = parseWecodeDate(a.finish_time);
      const assignProbs = wecodeProblems.filter((p) => p.assignment_id === a.id);
      const solved = assignProbs.filter((p) => p.is_ac).length;
      const total = a.total_problems || assignProbs.length;
      const isCompleted = total > 0 && solved === total;

      // Chuẩn hóa base_url thành link chi tiết bài tập hợp lệ của Wecode: ${base}/assignment/${id}/0
      const rawBase = a.base_url?.trim().replace(/\/+$/, '') || 'https://khmt.uit.edu.vn/wecode25/it00x';
      const base = rawBase.includes('/assignment') ? rawBase.split('/assignment')[0] : rawBase;
      const actionUrl = `${base}/assignment/${a.id}/0`;

      list.push({
        id: `wecode-${a.id}`,
        source: 'wecode',
        title: a.name,
        courseCode: a.classes ? a.classes.split(/[\s,]+/)[0] : 'WECODE',
        courseName: a.classes || 'Bài tập thực hành Wecode',
        dueTimestamp: finishTs,
        dueDateStr: finishTs > 0 ? formatTimestamp(finishTs) : 'Không giới hạn',
        isSubmitted: isCompleted,
        statusLabel: isCompleted ? `Đã AC (${solved}/${total})` : `Đang làm (${solved}/${total})`,
        actionUrl,
        taskType: 'wecode',
        solvedCount: solved,
        totalCount: total,
      });
    }

    return list;
  }, [moodleTasks, wecodeAssignments, wecodeProblems]);

  // Filtered by search & platform
  const filteredQuests = useMemo(() => {
    return allQuests.filter((q) => {
      if (platformFilter !== 'all' && q.source !== platformFilter) return false;
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchTitle = q.title.toLowerCase().includes(query);
        const matchCode = q.courseCode.toLowerCase().includes(query);
        const matchCourse = q.courseName.toLowerCase().includes(query);
        return matchTitle || matchCode || matchCourse;
      }
      return true;
    });
  }, [allQuests, platformFilter, searchQuery]);

  // Categorize by Urgency
  const { criticalQuests, upcomingQuests, futureQuests, openEndedQuests, completedQuests } = useMemo(() => {
    const critical: UnifiedQuestItem[] = [];
    const upcoming: UnifiedQuestItem[] = [];
    const future: UnifiedQuestItem[] = [];
    const openEnded: UnifiedQuestItem[] = [];
    const completed: UnifiedQuestItem[] = [];

    for (const q of filteredQuests) {
      if (q.isSubmitted) {
        completed.push(q);
        continue;
      }

      if (q.dueTimestamp <= 0) {
        // Bài tập không giới hạn thời gian / Luyện tập tự do
        openEnded.push(q);
        continue;
      }

      const diff = q.dueTimestamp - nowSec;
      // Active Horizon Filter:
      // 1. Quá hạn > 30 ngày: Bài tập xác sống (Zombie Deadline từ các năm cũ như 2021, 2023)
      //    -> Chuyển sang Luyện tập tự do / Đã đóng, tuyệt đối KHÔNG làm tăng counter đỏ.
      if (diff < -30 * 86400) {
        openEnded.push({
          ...q,
          statusLabel: 'Đã đóng (Lưu trữ)',
        });
      } else if (diff < 0 || diff <= 86400) {
        // Quá hạn gần đây (< 30 ngày) HOẶC Còn dưới 24h
        critical.push(q);
      } else if (diff <= 86400 * 7) {
        // Trong 7 ngày tới
        upcoming.push(q);
      } else {
        // Tương lai (> 7 ngày)
        future.push(q);
      }
    }

    // Sort: earliest deadline first
    critical.sort((a, b) => a.dueTimestamp - b.dueTimestamp);
    upcoming.sort((a, b) => a.dueTimestamp - b.dueTimestamp);
    future.sort((a, b) => a.dueTimestamp - b.dueTimestamp);
    completed.sort((a, b) => b.dueTimestamp - a.dueTimestamp);

    return {
      criticalQuests: critical,
      upcomingQuests: upcoming,
      futureQuests: future,
      openEndedQuests: openEnded,
      completedQuests: completed,
    };
  }, [filteredQuests, nowSec]);

  const handleOpenLink = (url?: string) => {
    if (url) {
      openExternalUrl(url);
    }
  };

  const handleRefresh = async () => {
    await Promise.all([
      requestSync('moodle', { bypassTtl: true }),
      requestSync('wecode', { bypassTtl: true }),
    ]);
    await loadAllData();
  };

  return (
    <div className="space-y-6">
      {/* Top Hub Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-zinc-800/80 pb-5">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <Sparkles className="h-4 w-4" />
            </span>
            <h2 className="text-lg font-bold tracking-tight text-white">Unified Quest Hub</h2>
            <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-mono font-medium text-zinc-400">
              {allQuests.length} Nhiệm vụ
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-400">
            Hợp nhất thời hạn bài tập Courses Moodle UIT và thực hành lập trình Wecode theo độ khẩn cấp.
          </p>
        </div>

        {/* Action Controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Search bar */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
            <input
              type="text"
              placeholder="Tìm bài tập, môn học..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 w-44 md:w-56 rounded-md border border-zinc-800 bg-zinc-900/90 pl-8 pr-3 text-xs text-zinc-200 placeholder-zinc-500 focus:border-amber-500 focus:outline-none"
            />
          </div>

          {/* Platform Filter Buttons */}
          <div className="flex rounded-md border border-zinc-800 bg-zinc-900 p-0.5 text-xs">
            <button
              onClick={() => setPlatformFilter('all')}
              className={`px-2.5 py-1 rounded transition-colors ${
                platformFilter === 'all'
                  ? 'bg-zinc-700 font-semibold text-white'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Tất cả
            </button>
            <button
              onClick={() => setPlatformFilter('moodle')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded transition-colors ${
                platformFilter === 'moodle'
                  ? 'bg-sky-600 font-semibold text-white'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <BookOpen className="h-3 w-3" />
              Moodle
            </button>
            <button
              onClick={() => setPlatformFilter('wecode')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded transition-colors ${
                platformFilter === 'wecode'
                  ? 'bg-emerald-600 font-semibold text-white'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Code2 className="h-3 w-3" />
              Wecode
            </button>
          </div>

          {/* Refresh Button */}
          <button
            onClick={handleRefresh}
            disabled={isSyncing}
            className="flex items-center gap-1.5 h-8 px-3 rounded-md border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 transition-colors disabled:opacity-50"
            title="Đồng bộ lại toàn bộ bài tập"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin text-amber-400' : ''}`} />
            <span className="hidden sm:inline">Làm mới</span>
          </button>
        </div>
      </div>

      {/* Overview Stat Badges */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="flex items-center justify-between p-3.5 rounded-xl border border-rose-500/20 bg-rose-950/10 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-500/20 text-rose-400">
              <AlertTriangle className="h-5 w-5 animate-pulse" />
            </div>
            <div>
              <div className="text-xs text-rose-300 font-medium">Khẩn cấp (&lt; 24h / Quá hạn)</div>
              <div className="text-lg font-black text-rose-400 font-mono">{criticalQuests.length}</div>
            </div>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">
            CẦN NỘP GẤP
          </span>
        </div>

        <div className="flex items-center justify-between p-3.5 rounded-xl border border-amber-500/20 bg-amber-950/10 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/20 text-amber-400">
              <Calendar className="h-5 w-5" />
            </div>
            <div>
              <div className="text-xs text-amber-300 font-medium">Trong 7 ngày tới</div>
              <div className="text-lg font-black text-amber-400 font-mono">{upcomingQuests.length}</div>
            </div>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
            KẾ HOẠCH
          </span>
        </div>

        <div className="flex items-center justify-between p-3.5 rounded-xl border border-indigo-500/20 bg-indigo-950/10 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400">
              <Code2 className="h-5 w-5" />
            </div>
            <div>
              <div className="text-xs text-indigo-300 font-medium">Luyện tập tự do</div>
              <div className="text-lg font-black text-indigo-400 font-mono">{openEndedQuests.length}</div>
            </div>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
            KHÔNG HẠN
          </span>
        </div>

        <div className="flex items-center justify-between p-3.5 rounded-xl border border-emerald-500/20 bg-emerald-950/10 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div>
              <div className="text-xs text-emerald-300 font-medium">Đã nộp / Hoàn thành</div>
              <div className="text-lg font-black text-emerald-400 font-mono">{completedQuests.length}</div>
            </div>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
            HOÀN THÀNH
          </span>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center py-16 text-zinc-500 gap-3">
          <RefreshCw className="h-6 w-6 animate-spin text-amber-400" />
          <span className="text-xs font-mono">Đang hợp nhất nhiệm vụ Moodle & Wecode...</span>
        </div>
      ) : (
        <div className="space-y-6">
          {/* SECTION 1: KHẨN CẤP (< 24H) */}
          {criticalQuests.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-rose-400 uppercase tracking-wider">
                <AlertTriangle className="h-4 w-4" />
                <span>Nhiệm vụ khẩn cấp (&lt; 24 giờ / Quá hạn)</span>
                <span className="ml-1 rounded-full bg-rose-500/20 px-2 py-0.2 text-[11px] font-mono">
                  {criticalQuests.length}
                </span>
              </div>

              <div className="grid grid-cols-1 gap-2.5">
                {criticalQuests.map((quest) => {
                  const remSec = quest.dueTimestamp - nowSec;
                  const isOverdue = remSec <= 0 && quest.dueTimestamp > 0;
                  return (
                    <div
                      key={quest.id}
                      className="group flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-rose-500/30 bg-zinc-900/90 hover:border-rose-500/60 transition-all shadow-sm"
                    >
                      <div className="space-y-1.5 flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold uppercase ${
                              quest.source === 'moodle'
                                ? 'bg-sky-500/15 text-sky-400 border border-sky-500/30'
                                : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                            }`}
                          >
                            {quest.source === 'moodle' ? 'Moodle' : 'Wecode'}
                          </span>
                          <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-mono text-zinc-300 font-semibold">
                            {quest.courseCode}
                          </span>
                          <span className="text-xs text-zinc-400 truncate max-w-[200px]">
                            {quest.courseName}
                          </span>
                        </div>

                        <div className="font-semibold text-sm text-zinc-100 group-hover:text-amber-300 transition-colors">
                          {quest.title}
                        </div>

                        <div className="flex items-center gap-4 text-xs font-mono text-zinc-400">
                          <span className="flex items-center gap-1 text-rose-400 font-semibold">
                            <Clock className="h-3.5 w-3.5" />
                            {isOverdue ? 'Đã quá hạn' : formatRemainingTime(remSec)}
                          </span>
                          <span className="text-zinc-500">•</span>
                          <span>Hạn nộp: {quest.dueDateStr}</span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2 self-end sm:self-center">
                        {quest.templateUrl && (
                          <button
                            onClick={() => handleOpenLink(quest.templateUrl)}
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 transition-colors"
                            title="Tải file đề bài / template mẫu"
                          >
                            <Download className="h-3.5 w-3.5 text-sky-400" />
                            <span>Mẫu đề</span>
                          </button>
                        )}
                        <button
                          onClick={() => handleOpenLink(quest.actionUrl)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 font-semibold text-xs text-white shadow-sm transition-colors cursor-pointer"
                        >
                          <span>Nộp bài ngay</span>
                          <ExternalLink className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* SECTION 2: SẮP TỚI (7 NGÀY TỚI) */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-400 uppercase tracking-wider">
              <Calendar className="h-4 w-4" />
              <span>Nhiệm vụ trong 7 ngày tới</span>
              <span className="ml-1 rounded-full bg-amber-500/20 px-2 py-0.2 text-[11px] font-mono">
                {upcomingQuests.length}
              </span>
            </div>

            {upcomingQuests.length === 0 ? (
              <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-6 text-center text-xs text-zinc-500 font-mono">
                Không có bài tập nào cần nộp trong 7 ngày tới. Tuyệt vời!
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {upcomingQuests.map((quest) => {
                  const remSec = quest.dueTimestamp - nowSec;
                  return (
                    <div
                      key={quest.id}
                      className="group flex flex-col justify-between p-3.5 rounded-xl border border-zinc-800 bg-zinc-900/80 hover:border-zinc-700 transition-all space-y-3"
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                                quest.source === 'moodle'
                                  ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
                                  : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                              }`}
                            >
                              {quest.source === 'moodle' ? 'Moodle' : 'Wecode'}
                            </span>
                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-300">
                              {quest.courseCode}
                            </span>
                          </div>

                          {quest.dueTimestamp > 0 && (
                            <span className="text-[11px] font-mono text-amber-400 font-medium">
                              {formatRemainingTime(remSec)}
                            </span>
                          )}
                        </div>

                        <div className="font-semibold text-xs text-zinc-200 group-hover:text-amber-300 transition-colors line-clamp-2">
                          {quest.title}
                        </div>

                        <div className="text-[11px] text-zinc-500 font-mono">
                          Hạn chót: {quest.dueDateStr}
                        </div>
                      </div>

                      <div className="flex items-center justify-between border-t border-zinc-800/60 pt-2.5 text-xs">
                        <span className="text-zinc-500 text-[11px] font-mono">{quest.statusLabel}</span>

                        <div className="flex items-center gap-2">
                          {quest.templateUrl && (
                            <button
                              onClick={() => handleOpenLink(quest.templateUrl)}
                              className="text-zinc-400 hover:text-sky-400 p-1 rounded transition-colors"
                              title="Tải template mẫu"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            onClick={() => handleOpenLink(quest.actionUrl)}
                            className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 font-medium transition-colors"
                          >
                            <span>Chi tiết</span>
                            <ChevronRight className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* SECTION 3: KẾ HOẠCH XA HƠN (> 7 NGÀY) */}
          {futureQuests.length > 0 && (
            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-sky-400 uppercase tracking-wider">
                <Clock className="h-4 w-4" />
                <span>Kế hoạch xa hơn (&gt; 7 ngày)</span>
                <span className="ml-1 rounded-full bg-sky-500/20 px-2 py-0.2 text-[11px] font-mono">
                  {futureQuests.length}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {futureQuests.map((quest) => {
                  const remSec = quest.dueTimestamp - nowSec;
                  return (
                    <div
                      key={quest.id}
                      className="group flex flex-col justify-between p-3.5 rounded-xl border border-zinc-800 bg-zinc-900/80 hover:border-zinc-700 transition-all space-y-3"
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                                quest.source === 'moodle'
                                  ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
                                  : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                              }`}
                            >
                              {quest.source === 'moodle' ? 'Moodle' : 'Wecode'}
                            </span>
                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-300">
                              {quest.courseCode}
                            </span>
                          </div>

                          <span className="text-[11px] font-mono text-zinc-400 font-medium">
                            {formatRemainingTime(remSec)}
                          </span>
                        </div>

                        <div className="font-semibold text-xs text-zinc-200 group-hover:text-sky-300 transition-colors line-clamp-2">
                          {quest.title}
                        </div>

                        <div className="text-[11px] text-zinc-500 font-mono">
                          Hạn chót: {quest.dueDateStr}
                        </div>
                      </div>

                      <div className="flex items-center justify-between border-t border-zinc-800/60 pt-2.5 text-xs">
                        <span className="text-zinc-500 text-[11px] font-mono">{quest.statusLabel}</span>

                        <div className="flex items-center gap-2">
                          {quest.templateUrl && (
                            <button
                              onClick={() => handleOpenLink(quest.templateUrl)}
                              className="text-zinc-400 hover:text-sky-400 p-1 rounded transition-colors"
                              title="Tải template mẫu"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            onClick={() => handleOpenLink(quest.actionUrl)}
                            className="flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300 font-medium transition-colors"
                          >
                            <span>Chi tiết</span>
                            <ChevronRight className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* SECTION 4: LUYỆN TẬP TỰ DO & KHÔNG GIỚI HẠN THỜI GIAN */}
          {openEndedQuests.length > 0 && (
            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-indigo-400 uppercase tracking-wider">
                <Code2 className="h-4 w-4" />
                <span>Luyện tập tự do & Không giới hạn thời gian</span>
                <span className="ml-1 rounded-full bg-indigo-500/20 px-2 py-0.2 text-[11px] font-mono">
                  {openEndedQuests.length}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {openEndedQuests.map((quest) => {
                  const solved = quest.solvedCount ?? 0;
                  const total = quest.totalCount ?? 0;
                  const percent = total > 0 ? Math.round((solved / total) * 100) : 0;

                  return (
                    <div
                      key={quest.id}
                      className="group flex flex-col justify-between p-3.5 rounded-xl border border-zinc-800 bg-zinc-900/80 hover:border-indigo-500/40 transition-all space-y-3"
                    >
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                                quest.source === 'moodle'
                                  ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
                                  : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                              }`}
                            >
                              {quest.source === 'moodle' ? 'Moodle' : 'Wecode'}
                            </span>
                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-300">
                              {quest.courseCode}
                            </span>
                          </div>

                          <span className="text-[10px] font-mono text-zinc-400 bg-zinc-800/80 px-2 py-0.5 rounded border border-zinc-700/60">
                            Không giới hạn
                          </span>
                        </div>

                        <div className="font-semibold text-xs text-zinc-200 group-hover:text-indigo-300 transition-colors line-clamp-2">
                          {quest.title}
                        </div>

                        {/* Progress bar for Wecode / practice assignments */}
                        {total > 0 && (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                              <span>Tiến độ: {solved}/{total} bài</span>
                              <span className="text-indigo-400 font-bold">{percent}%</span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
                              <div
                                className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                                style={{ width: `${percent}%` }}
                              />
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="flex items-center justify-between border-t border-zinc-800/60 pt-2.5 text-xs">
                        <span className="text-zinc-500 text-[11px] font-mono">
                          {quest.statusLabel}
                        </span>

                        <div className="flex items-center gap-2">
                          {quest.templateUrl && (
                            <button
                              onClick={() => handleOpenLink(quest.templateUrl)}
                              className="text-zinc-400 hover:text-sky-400 p-1 rounded transition-colors"
                              title="Tải template mẫu"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            onClick={() => handleOpenLink(quest.actionUrl)}
                            className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
                          >
                            <span>Chi tiết</span>
                            <ChevronRight className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* SECTION 3: ĐÃ HOÀN THÀNH / ĐÃ NỘP */}
          {completedQuests.length > 0 && (
            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400 uppercase tracking-wider">
                <CheckCircle2 className="h-4 w-4" />
                <span>Nhiệm vụ đã hoàn thành / Đã nộp</span>
                <span className="ml-1 rounded-full bg-emerald-500/20 px-2 py-0.2 text-[11px] font-mono">
                  {completedQuests.length}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {completedQuests.slice(0, 10).map((quest) => (
                  <div
                    key={quest.id}
                    className="flex items-center justify-between p-3 rounded-lg border border-zinc-800/60 bg-zinc-900/40 text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <CheckCircle2 className="h-4 w-4 text-emerald-400 flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="text-zinc-300 font-medium truncate">{quest.title}</div>
                        <div className="text-[11px] text-zinc-500 font-mono">{quest.courseCode}</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-[11px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                        {quest.statusLabel}
                      </span>
                      <button
                        onClick={() => handleOpenLink(quest.actionUrl)}
                        className="text-zinc-400 hover:text-zinc-200 p-1"
                        title="Xem lại bài nộp"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default UnifiedQuestHub;
