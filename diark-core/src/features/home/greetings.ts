import { extractVietnameseGivenName } from "../../utils/masking.ts";

export type TimeBucket =
  | "early_morning"
  | "morning"
  | "noon"
  | "afternoon"
  | "evening"
  | "late_night";

type GreetingBuilder = (name: string) => string;

export function getTimeBucket(hour: number): TimeBucket {
  if (hour >= 5 && hour < 8) return "early_morning";
  if (hour >= 8 && hour < 11) return "morning";
  if (hour >= 11 && hour < 14) return "noon";
  if (hour >= 14 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "late_night";
}

const GREETING_POOLS: Record<TimeBucket, readonly GreetingBuilder[]> = {
  early_morning: [
    (n) => (n ? `Chào buổi sáng, ${n}` : "Chào buổi sáng"),
    (n) => (n ? `Sáng nay dậy sớm dữ ha, ${n}` : "Sáng nay dậy sớm dữ ha"),
    (n) => (n ? `Ngày mới tốt lành nhé, ${n}` : "Ngày mới tốt lành nhé"),
    (n) => (n ? `Dậy sớm đi học hay chạy deadline vậy ${n}?` : "Dậy sớm đi học hay chạy deadline vậy?"),
    (n) => (n ? `Bình minh rồi đó ${n}, kiểm tra lịch hôm nay thôi` : "Bình minh rồi đó, kiểm tra lịch hôm nay thôi"),
    (n) => (n ? `Sáng sớm tỉnh táo chưa ${n}? Nhớ ăn sáng nha` : "Sáng sớm tỉnh táo chưa? Nhớ ăn sáng nha"),
    (n) => (n ? `Mở màn ngày mới nhẹ nhàng nào, ${n}` : "Mở màn ngày mới nhẹ nhàng nào"),
    (n) => (n ? `Chào ngày mới, ${n}. Nay có tiết sớm không?` : "Chào ngày mới. Nay có tiết sớm không?"),
    (n) => (n ? `Không khí buổi sáng mát mẻ quá ha, ${n}` : "Không khí buổi sáng mát mẻ quá ha"),
    (n) => (n ? `Chuẩn bị cặp sách lên giảng đường thôi, ${n}` : "Chuẩn bị cặp sách lên giảng đường thôi"),
  ],
  morning: [
    (n) => (n ? `Chào buổi sáng, ${n}` : "Chào buổi sáng"),
    (n) => (n ? `Ngày mới tốt lành nhé, ${n}` : "Ngày mới tốt lành nhé"),
    (n) => (n ? `Cà phê chưa ${n}? Vào việc thôi` : "Cà phê chưa? Vào việc thôi"),
    (n) => (n ? `Sáng nay học ổn chứ, ${n}?` : "Sáng nay học ổn chứ?"),
    (n) => (n ? `Đừng để deadline dí nha, ${n}` : "Đừng để deadline dí nha"),
    (n) => (n ? `Chúc ${n} một buổi sáng làm việc hiệu quả` : "Chúc bạn một buổi sáng làm việc hiệu quả"),
    (n) => (n ? `Sáng nay lịch có căng lắm không, ${n}?` : "Sáng nay lịch có căng lắm không?"),
    (n) => (n ? `Giữ nhịp tập trung từ sáng nào, ${n}` : "Giữ nhịp tập trung từ sáng nào"),
    (n) => (n ? `Hôm nay thử xử lý gọn việc khó trước nha, ${n}` : "Hôm nay thử xử lý gọn việc khó trước nha"),
    (n) => (n ? `Chào ${n}, xem hôm nay có gì mới nào` : "Chào bạn, xem hôm nay có gì mới nào"),
  ],
  noon: [
    (n) => (n ? `Chào buổi trưa, ${n}` : "Chào buổi trưa"),
    (n) => (n ? `Trưa rồi, nhớ ăn uống đầy đủ nhé ${n}` : "Trưa rồi, nhớ ăn uống đầy đủ nhé"),
    (n) => (n ? `Nghỉ trưa một chút lấy sức chiều học tiếp, ${n}` : "Nghỉ trưa một chút lấy sức chiều học tiếp"),
    (n) => (n ? `Nắng trưa gắt lắm, nhớ uống đủ nước nha ${n}` : "Nắng trưa gắt lắm, nhớ uống đủ nước nha"),
    (n) => (n ? `Sáng nay chạy ổn hết chứ ${n}?` : "Sáng nay chạy ổn hết chứ?"),
    (n) => (n ? `Giờ trưa rồi ${n}, chợp mắt 15 phút cho đỡ oải` : "Giờ trưa rồi, chợp mắt 15 phút cho đỡ oải"),
    (n) => (n ? `Cơm trưa xong chưa ${n}? Chuẩn bị cho ca chiều nha` : "Cơm trưa xong chưa? Chuẩn bị cho ca chiều nha"),
    (n) => (n ? `Giữa ngày rồi đó ${n}, kiểm tra lại các mốc chiều nay` : "Giữa ngày rồi đó, kiểm tra lại các mốc chiều nay"),
    (n) => (n ? `Tạm gác bàn phím ăn trưa đi ${n} ơi` : "Tạm gác bàn phím ăn trưa thôi"),
    (n) => (n ? `Chiều nay còn kèo nào nữa không, ${n}?` : "Chiều nay còn kèo nào nữa không?"),
  ],
  afternoon: [
    (n) => (n ? `Chào buổi chiều, ${n}` : "Chào buổi chiều"),
    (n) => (n ? `Chiều nay cố nốt mấy việc còn lại nhé, ${n}` : "Chiều nay cố nốt mấy việc còn lại nhé"),
    (n) => (n ? `Đừng để buồn ngủ đánh gục chiều nay nhé, ${n}` : "Đừng để buồn ngủ đánh gục chiều nay nhé"),
    (n) => (n ? `Nạp lại năng lượng cho ca chiều nào, ${n}` : "Nạp lại năng lượng cho ca chiều nào"),
    (n) => (n ? `Chiều nay học thực hành hay tự học vậy ${n}?` : "Chiều nay học thực hành hay tự học vậy?"),
    (n) => (n ? `Sắp hết buổi chiều rồi, ráng thêm chút nữa nha ${n}` : "Sắp hết buổi chiều rồi, ráng thêm chút nữa nha"),
    (n) => (n ? `Chiều nay có deadline nào cận giờ không đó, ${n}?` : "Chiều nay có deadline nào cận giờ không đó?"),
    (n) => (n ? `Làm một ngụm nước mát rồi chạy tiếp nhé, ${n}` : "Làm một ngụm nước mát rồi chạy tiếp nhé"),
    (n) => (n ? `Tiến độ hôm nay tới đâu rồi, ${n}?` : "Tiến độ hôm nay tới đâu rồi?"),
    (n) => (n ? `Còn nửa ngày thôi, xử lý gọn gàng nha ${n}` : "Còn nửa ngày thôi, xử lý gọn gàng nha"),
  ],
  evening: [
    (n) => (n ? `Chào buổi tối, ${n}` : "Chào buổi tối"),
    (n) => (n ? `Tối nay nghỉ ngơi hay cày bài tiếp đây, ${n}?` : "Tối nay nghỉ ngơi hay cày bài tiếp đây?"),
    (n) => (n ? `Ăn tối chưa ${n}? Xong rồi hẵng mở bài` : "Ăn tối chưa? Xong rồi hẵng mở bài"),
    (n) => (n ? `Tối nay dành chút thời gian xả hơi nhé, ${n}` : "Tối nay dành chút thời gian xả hơi nhé"),
    (n) => (n ? `Hôm nay đi học vất vả rồi, nghỉ một nhịp nha ${n}` : "Hôm nay đi học vất vả rồi, nghỉ một nhịp nha"),
    (n) => (n ? `Ngó qua lịch ngày mai trước khi tắt máy nhé, ${n}` : "Ngó qua lịch ngày mai trước khi tắt máy nhé"),
    (n) => (n ? `Buổi tối yên tĩnh rất hợp để ôn lại bài đó, ${n}` : "Buổi tối yên tĩnh rất hợp để ôn lại bài đó"),
    (n) => (n ? `Còn bài Moodle nào chưa nộp không đó, ${n}?` : "Còn bài Moodle nào chưa nộp không đó?"),
    (n) => (n ? `Chậm lại một nhịp cho đỡ căng đầu nhé, ${n}` : "Chậm lại một nhịp cho đỡ căng đầu nhé"),
    (n) => (n ? `Tối nay định xong việc lúc mấy giờ đây, ${n}?` : "Tối nay định xong việc lúc mấy giờ đây?"),
  ],
  late_night: [
    (n) => (n ? `Tối nay lại thức khuya nữa à, ${n}?` : "Tối nay lại thức khuya nữa à?"),
    (n) => (n ? `Khuya rồi đó ${n}, nhớ giữ sức mai còn đi học` : "Khuya rồi đó, nhớ giữ sức mai còn đi học"),
    (n) => (n ? `Chạy deadline xuyên đêm hả ${n}?` : "Chạy deadline xuyên đêm hả?"),
    (n) => (n ? `Cú đêm UIT lại hoạt động rồi hả, ${n}?` : "Cú đêm UIT lại hoạt động rồi hả?"),
    (n) => (n ? `Ngủ sớm đi ${n}, bài để mai tính tiếp` : "Ngủ sớm đi, bài để mai tính tiếp"),
    (n) => (n ? `Lại thức khuya nữa hả ${n}? Cố nốt rồi nghỉ nhé` : "Lại thức khuya nữa hả? Cố nốt rồi nghỉ nhé"),
    (n) => (n ? `Mắt díu chưa ${n}? Nhớ bật đèn vừa đủ kẻo mỏi mắt` : "Mắt díu chưa? Nhớ bật đèn vừa đủ kẻo mỏi mắt"),
    (n) => (n ? `Đêm muộn rồi ${n}, đừng quên uống ngụm nước rồi đi ngủ` : "Đêm muộn rồi, đừng quên uống ngụm nước rồi đi ngủ"),
    (n) => (n ? `Còn mỗi một chút nữa thôi hả ${n}? Xong là ngủ liền nha` : "Còn mỗi một chút nữa thôi hả? Xong là ngủ liền nha"),
    (n) => (n ? `Đêm khuya thanh vắng, giữ nhịp vừa sức thôi nhé ${n}` : "Đêm khuya thanh vắng, giữ nhịp vừa sức thôi nhé"),
  ],
};

export function pickRandomGreeting(
  hour: number,
  rawFullName: string,
  randomFloat?: number
): string {
  const givenName = extractVietnameseGivenName(rawFullName);
  const pool = GREETING_POOLS[getTimeBucket(hour)];
  const r =
    randomFloat !== undefined
      ? Math.min(0.999999, Math.max(0, randomFloat))
      : Math.random();
  const idx = Math.floor(r * pool.length);
  return pool[idx](givenName);
}
