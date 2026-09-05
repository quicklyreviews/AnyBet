# AnyBet — hướng dẫn dùng

Đây là bản hướng dẫn cho người chơi. Muốn hiểu phần kỹ thuật thì đọc
[README.md](README.md).

AnyBet là thị trường dự đoán **không giới hạn chủ đề**: bạn đặt một câu hỏi bất
kỳ bằng tiếng Anh, nói rõ căn cứ nào quyết định đúng/sai và chỗ nào để tra, rồi
đến hạn thì **các validator của GenLayer tự đi tra và phán quyết**. Không có
admin nào bấm nút, cũng không có oracle nào phải tin.

---

## Mở ứng dụng

```bash
cd "F:\Work\Cryoto\Agent tank"
```

```bash
"C:\Users\1phut\AppData\Local\Programs\Python\Python313\python.exe" -m http.server 5174 --directory frontend
```

Để nguyên cửa sổ terminal đó (đóng là server tắt), rồi mở
<http://localhost:5174>.

Có hai trang: **trang chủ** (`/`) giới thiệu sản phẩm và hiện số liệu sống từ
contract — xem được mà không cần ví; bấm **Open the app** để sang **ứng dụng**
(`/app.html`) nơi đặt cược và mở thị trường. Bấm vào logo ở góc trái là quay về
trang chủ.

> `python` gõ trần trên máy này sẽ vướng bản stub của Microsoft Store và báo
> *"Python was not found"*, nên phải dùng đường dẫn đầy đủ như trên.

## Chuẩn bị ví

Cần một ví EVM (MetaMask hoặc tương đương). Trang **không giữ khoá của bạn** —
ví ký từng thao tác, ngắt kết nối là không còn gì sót lại.

1. Bấm **Connect wallet to play**
2. Ví sẽ hỏi thêm mạng **GenLayer StudioNet (chain 61999)** — đồng ý
3. Bấm **Get test GEN** để nhận 10 GEN test

GEN trên StudioNet **không có giá trị thật**, không mua bán được. Đây là mạng
thử nghiệm.

Khung tài khoản luôn hiện mạng ví đang đứng. Nếu ví nhảy sang mạng khác, dòng
Network chuyển màu vàng kèm nút **Switch** — và mọi giao dịch sẽ bị chặn cho tới
khi về đúng StudioNet, để bạn không mất một phút chờ rồi mới biết hỏng.

## Nạp tiền vào hợp đồng

Bấm **Deposit** rồi nhập số GEN. Tiền nằm trong hợp đồng dưới địa chỉ ví bạn,
và mọi lệnh cược trừ thẳng từ số dư đó — nên đặt cược **không cần chuyển tiền
lần nữa**. Lấy tiền ra bất cứ lúc nào bằng **Withdraw all**.

## Đặt cược

Mỗi thị trường có hai bên **YES** và **NO**. Nhập số tiền rồi bấm bên bạn tin.

Cách chia thưởng là **parimutuel** (giống PancakeSwap Prediction): toàn bộ hai
pool trừ phí được chia cho bên thắng theo tỷ lệ tiền góp. Nên hệ số nhân hiển
thị **chỉ là ước tính và sẽ đổi khi có người vào thêm** — chốt lại lúc đóng cửa.

Vài điều nên biết trước:

- **Mỗi ví chỉ cược một lần một bên trên mỗi thị trường.** Cược hai chiều chỉ
  tổ mất phí, nên hợp đồng từ chối luôn.
- **Ngừng nhận cược sớm 75 giây trước giờ đóng.** Một giao dịch cần khoảng một
  phút để đạt đồng thuận, đặt sát giờ thì gần như chắc chắn tới nơi thì đã muộn.
  Nút sẽ tự khoá và nhãn ghi *"too late to bet"*.
- **Nếu chỉ có một bên có tiền thì thị trường huỷ và hoàn đủ.** Không có ai bên
  kia thì lấy tiền của ai mà trả — thu phí lúc đó là lấy tiền của một cược không
  ai đối lại.

## Tự mở thị trường

Bấm một trong **11 mẫu có sẵn**, chia làm bốn nhóm theo tầm với:

| Nhóm | Mẫu |
|---|---|
| **Planet** | Động đất toàn cầu, ISS ở bắc bán cầu, số người đang ở ngoài vũ trụ |
| **Markets** | Giá Bitcoin, tổng vốn hoá toàn thị trường crypto |
| **Cities** | Mưa ở London, nắng nóng Tokyo, mưa Hà Nội, nắng nóng Hà Nội, PM2.5 Hà Nội |
| **Code** | Số sao GitHub |

Mẫu **tự đọc dữ liệu sống** rồi đặt ngưỡng sát mức hiện tại, nên câu hỏi thật sự
còn mở chứ không phải biết trước đáp án — ví dụ dự báo mưa đang 0.9mm thì ngưỡng
đặt 1mm, 24 giờ qua có 6 trận động đất thì hỏi "hơn 6 trận".

Muốn xem thử nhanh nhất thì chọn **ISS over the north**: đóng sau 6 phút, chỉ
đọc một con số vĩ độ, mà trạm bay hết vòng Trái Đất mỗi 90 phút nên gần như
50/50 thật.

Muốn tự viết thì cần ba thứ:

| Ô | Viết gì |
|---|---|
| **Question** | Câu hỏi có đáp án YES hoặc NO, không lấp lửng |
| **How should this be decided?** | **Chỉ đích danh trường dữ liệu và ngưỡng**, và nói rõ khi nào là UNKNOWN |
| **Sources to check** | Tối đa 3 URL công khai, cách nhau bằng dấu phẩy |

> Vì ngăn cách bằng dấu phẩy nên **URL có dấu phẩy bên trong sẽ bị cắt đôi**.
> Gặp trường hợp đó thì thay dấu phẩy bằng `%2C`. Form sẽ cảnh báo nếu phát hiện
> một mảnh không phải URL.

Bấm **Check sources now** để xem ngay nguồn đang trả về gì. Đây là bước đáng
làm: nguồn hỏng hoặc bị chặn thì thị trường sẽ ra UNKNOWN dù câu hỏi hay đến mấy.

**Quan trọng — đừng dùng Binance.** Binance chặn node validator của GenLayer
theo vùng địa lý, mà lại trả **HTTP 200 kèm nội dung lỗi**, nên nhìn thì tưởng
chạy. Các nguồn đã kiểm chứng là validator gọi được: CoinGecko, Coinbase, Kraken,
Open-Meteo (cả thời tiết lẫn chất lượng không khí), USGS, Open Notify, GitHub
API, Wikimedia. Muốn thêm nguồn mới thì chạy
`gltest tests/integration/probe_sources.py --network studionet -v -s` để kiểm
trước — mất khoảng 80 giây, rẻ hơn nhiều so với mở một thị trường rồi mới biết
hỏng.

## Chốt kết quả

Hết hạn, thị trường chuyển sang *Closed — awaiting resolution* và **bất kỳ ai**
cũng bấm được **Resolve now**, không cần quyền admin. Lúc đó mỗi validator tự đi
tải nguồn và chạy cùng một prompt.

Ba kết quả có thể xảy ra:

| Kết quả | Nghĩa là |
|---|---|
| **YES** / **NO** | Bằng chứng đủ rõ. Bên thắng chia pool sau khi trừ phí |
| **UNKNOWN** | Bằng chứng thiếu, mơ hồ, hoặc nguồn chết → **huỷ, hoàn đủ, không thu phí** |

UNKNOWN **không phải lỗi** — đó là điều được thiết kế có chủ đích: *sai UNKNOWN
chỉ làm chậm một thị trường, còn sai YES là trả tiền cho nhầm người.*

Lý do phán quyết được lưu luôn trên chain và hiện ngay trong thẻ thị trường, nên
bạn đọc được validator căn cứ vào đâu.

## Nhận tiền

Tiền thắng **được ghi nhận chứ không tự đẩy về ví**. Khi có tiền chờ, khu
**Ready to collect** hiện lên, bấm **Collect**.

Đây là lựa chọn có chủ ý: một khoản thắng mà bạn phải bấm nhận là khoản thắng
bạn có để ý. Đổi lại, tiền có thể bị bỏ quên — nên hợp đồng **không bao giờ xoá
một thị trường còn tiền chưa ai nhận**, dù cũ đến đâu.

Nhận xong tiền vào số dư trong hợp đồng, muốn rút về ví thì bấm **Withdraw all**.

---

## Vì sao mọi thứ chậm khoảng một phút

Đó là GenLayer đang **đạt đồng thuận thật**, không phải trang bị treo. Với các
thao tác thường thì là các validator xác nhận trạng thái; riêng bước **Resolve**
thì mỗi validator còn phải tự tải nguồn về và chạy mô hình ngôn ngữ, rồi kết quả
chuẩn hoá của họ phải **khớp nhau** thì giao dịch mới được chấp nhận.

Nút sẽ mờ đi trong lúc chờ và có thông báo ở cuối màn hình. Đừng bấm lại — hệ
thống đã chặn gửi trùng.

## Gặp lỗi thường gặp

| Hiện tượng | Xử lý |
|---|---|
| *"Sign in to place a bet"* | Chưa kết nối ví — bấm **Connect wallet** |
| Dòng Network màu vàng | Ví đang ở mạng khác, bấm **Switch** |
| *"Insufficient balance ... Deposit first"* | Chưa nạp vào hợp đồng, bấm **Deposit** |
| *"Betting has closed"* | Quá hạn, hoặc đã vào vùng 75 giây cuối |
| *"Already bet YES on this market"* | Mỗi ví một lần một thị trường |
| Thị trường ra UNKNOWN | Nguồn không đọc được. Kiểm bằng **Check sources now** trước khi mở lại |
| Số liệu không đổi sau khi giao dịch xong | Chờ vài giây rồi bấm **Refresh** — trang cũng tự đọc lại mỗi 20 giây |

Nếu vẫn hỏng, mở Console của trình duyệt (F12) và xem dòng lỗi — các lỗi liên
quan tới ví đều được ghi lại ở đó.
