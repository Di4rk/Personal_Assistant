export type PortalLinkCategory = "Học vụ" | "Thi cử" | "Tài chính & Giấy tờ" | "Hành chính & Khác";

export interface PortalQuickLink {
  id: string;
  label: string;
  category: PortalLinkCategory;
  url: string;
  keywords: string;
}

export const PORTAL_QUICK_LINKS: PortalQuickLink[] = [
  {
    id: "portal-tkb",
    label: "Thời khóa biểu Portal",
    category: "Học vụ",
    url: "https://portal.uit.edu.vn/sinh-vien/tkb",
    keywords: "tkb lich hoc thoi khoa bieu dang ky mon",
  },
  {
    id: "portal-bang-diem",
    label: "Bảng điểm chính thức",
    category: "Học vụ",
    url: "https://portal.uit.edu.vn/sinh-vien/bang-diem",
    keywords: "bang diem gpa cpa mon hoc",
  },
  {
    id: "portal-drl",
    label: "Điểm rèn luyện",
    category: "Học vụ",
    url: "https://portal.uit.edu.vn/sinh-vien/diem-ren-luyen",
    keywords: "drl diem ren luyen hoat dong",
  },
  {
    id: "portal-ctdt",
    label: "Chương trình đào tạo",
    category: "Học vụ",
    url: "https://portal.uit.edu.vn/chuong-trinh-dao-tao",
    keywords: "ctdt chuong trinh dao tao tin chi",
  },
  {
    id: "portal-tot-nghiep",
    label: "Đăng ký xét tốt nghiệp",
    category: "Học vụ",
    url: "https://portal.uit.edu.vn/sinh-vien/tot-nghiep",
    keywords: "xet tot nghiep ra truong",
  },
  {
    id: "portal-khoa-luan",
    label: "Khóa luận tốt nghiệp",
    category: "Học vụ",
    url: "https://portal.uit.edu.vn/sinh-vien/khoa-luan",
    keywords: "khoa luan kltn do an",
  },
  {
    id: "portal-lich-thi",
    label: "Lịch thi chính thức",
    category: "Thi cử",
    url: "https://portal.uit.edu.vn/sinh-vien/lich-thi",
    keywords: "lich thi giua ky cuoi ky phong thi",
  },
  {
    id: "portal-hoan-thi",
    label: "Hoãn thi & Thi lại",
    category: "Thi cử",
    url: "https://portal.uit.edu.vn/sinh-vien/hoan-thi",
    keywords: "hoan thi thi lai vang thi",
  },
  {
    id: "portal-phuc-khao",
    label: "Phúc khảo điểm",
    category: "Thi cử",
    url: "https://portal.uit.edu.vn/sinh-vien/phuc-khao",
    keywords: "phuc khao diem bai thi",
  },
  {
    id: "portal-hoc-phi",
    label: "Học phí & Biên lai",
    category: "Tài chính & Giấy tờ",
    url: "https://portal.uit.edu.vn/sinh-vien/hoc-phi",
    keywords: "hoc phi dong tien cong no",
  },
  {
    id: "portal-gia-han-hp",
    label: "Gia hạn học phí",
    category: "Tài chính & Giấy tờ",
    url: "https://portal.uit.edu.vn/sinh-vien/gia-han-hoc-phi",
    keywords: "gia han hoc phi tre han",
  },
  {
    id: "portal-giay-xn",
    label: "Xin giấy xác nhận SV",
    category: "Tài chính & Giấy tờ",
    url: "https://portal.uit.edu.vn/sinh-vien/giay-xac-nhan",
    keywords: "giay xac nhan sinh vien tam hoan nghia vu",
  },
  {
    id: "portal-chung-chi",
    label: "Xác nhận chứng chỉ",
    category: "Tài chính & Giấy tờ",
    url: "https://portal.uit.edu.vn/sinh-vien/xac-nhan-chung-chi",
    keywords: "chung chi ielts toeic ngoai ngu chuan dau ra",
  },
  {
    id: "portal-xin-bang-diem",
    label: "Đăng ký cấp bảng điểm",
    category: "Tài chính & Giấy tờ",
    url: "https://portal.uit.edu.vn/sinh-vien/xin-bang-diem",
    keywords: "xin bang diem giay",
  },
  {
    id: "portal-khao-sat",
    label: "Khảo sát giảng dạy",
    category: "Hành chính & Khác",
    url: "https://portal.uit.edu.vn/sinh-vien/khao-sat-giang-day",
    keywords: "khao sat mon hoc giang vien",
  },
  {
    id: "portal-gui-xe",
    label: "Đăng ký gửi xe",
    category: "Hành chính & Khác",
    url: "https://portal.uit.edu.vn/sinh-vien/gui-xe",
    keywords: "gui xe the xe bai xe",
  },
  {
    id: "portal-ngoai-tru",
    label: "Ngoại trú & Tạm trú",
    category: "Hành chính & Khác",
    url: "https://portal.uit.edu.vn/sinh-vien/ngoai-tru",
    keywords: "ngoai tru tam tru ky tuc xa",
  },
  {
    id: "portal-bhyt",
    label: "Thông tin Bảo hiểm Y tế",
    category: "Hành chính & Khác",
    url: "https://portal.uit.edu.vn/sinh-vien/bao-hiem",
    keywords: "bhyt bao hiem y te",
  },
  {
    id: "portal-kham-sk",
    label: "Đăng ký khám sức khỏe",
    category: "Hành chính & Khác",
    url: "https://portal.uit.edu.vn/sinh-vien/kham-suc-khoe",
    keywords: "kham suc khoe ho so",
  },
  {
    id: "portal-ho-tro",
    label: "Hỗ trợ Helpdesk UIT",
    category: "Hành chính & Khác",
    url: "https://portal.uit.edu.vn/sinh-vien/ho-tro",
    keywords: "ho tro helpdesk ticket",
  },
];

export const PORTAL_LINK_CATEGORIES: PortalLinkCategory[] = [
  "Học vụ",
  "Thi cử",
  "Tài chính & Giấy tờ",
  "Hành chính & Khác",
];
