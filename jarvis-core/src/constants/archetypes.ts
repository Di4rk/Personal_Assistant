export interface ArchetypePreset {
  id: string;
  name: string;
  description: string;
  badge: string;
  defaultPlugins: string[]; // plugin_ids to enable
}

export const ARCHETYPE_PRESETS: ArchetypePreset[] = [
  {
    id: "uit_standard",
    name: "UIT Standard",
    description: "Tập trung học vụ trường UIT, tự động đồng bộ Wecode & đồ án môn học.",
    badge: "UIT // CORE",
    defaultPlugins: ["uit-wecode", "cp-codeforces"],
  },
  {
    id: "competitive_programming",
    name: "Competitive Programmer",
    description: "Tối ưu hóa luyện thuật toán ICPC, Codeforces rating radar & LeetCode tracker.",
    badge: "ALGO // ICPC",
    defaultPlugins: ["cp-codeforces", "cp-leetcode"],
  },
  {
    id: "ai_datascience",
    name: "AI & Data Science",
    description: "Nghiên cứu mô hình học máy, theo dõi Kaggle notebook và xử lý dữ liệu lớn.",
    badge: "NEURAL // LAB",
    defaultPlugins: ["ai-lab", "uit-wecode"],
  },
  {
    id: "cyber_security",
    name: "Cyber Security",
    description: "Ghi chép writeup CTF, theo dõi bài tập an toàn thông tin & reverse engineering.",
    badge: "SEC // REDTEAM",
    defaultPlugins: ["sec-ctf", "cp-codeforces"],
  },
];
