# 連結擷取器（link-extractor）

貼上 Telegram 頻道或論壇網址，列出頁面上所有「檔名 + 下載連結」（夸克/百度/阿里等網盤、magnet、.torrent、ed2k），點一下就開啟或下載。

- **Cloudflare Workers + D1**：前端與 API 放在同一個 Worker，免費方案即可使用
- **一次性帳密**：第一次開網站時建立，之後網站上無法修改
- **兩種擷取方式**
  - **貼網址**：伺服器直接抓（Telegram `t.me/s/頻道` 等公開頁面）
  - **書籤小工具**：伺服器抓不到的頁面（需要登入、有瀏覽器安全檢查，例如 EYNY），在自己瀏覽器打開該頁後按書籤，頁面內容送到網站解析
- **已讀標記**：每個來源各自記錄，NEW 標示新項目；可「自動往回翻到上次已讀處」
- **可擴充**：在設定頁加網域、用 CSS selector 描述結構即可支援新網站，不用改程式

---

## 部署步驟（Windows / macOS 都適用）

### 1. 準備

1. 安裝 [Node.js LTS](https://nodejs.org/)（20 以上）
2. 有一個 Cloudflare 帳號（免費即可）
3. 下載專案並安裝套件：

```bash
git clone https://github.com/jimmyeyes03160729/download.git
cd download
npm install
```

### 2. 登入 Cloudflare

```bash
npx wrangler login
```

瀏覽器會跳出授權頁，按「Allow」。

### 3. 建立 D1 資料庫

```bash
npx wrangler d1 create link-extractor-db
```

輸出裡會有一行 `database_id = "xxxxxxxx-...."`，把它貼到 `wrangler.toml` 的 `database_id`（取代那串 0）。

接著建立資料表：

```bash
npm run db:init:remote
```

### 4. 第一次部署

```bash
npm run deploy
```

完成後會顯示網址，例如 `https://link-extractor.<你的子網域>.workers.dev`。

### 5. 設定三個密鑰（Secrets）

先產生三組隨機字串（每執行一次產生一組）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

然後分別設定（每個指令執行後，貼上一組字串按 Enter）：

```bash
npx wrangler secret put SETUP_TOKEN
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ENC_KEY
```

| 名稱 | 用途 | 注意 |
|---|---|---|
| `SETUP_TOKEN` | 第一次建立帳密時要輸入的密語，防止別人搶先設定 | 自己記下來，下一步會用到 |
| `SESSION_SECRET` | 登入 session 簽章 | 之後更換 = 所有裝置被登出 |
| `ENC_KEY` | 加密保存網站 Cookie | 之後更換 = 已保存的 Cookie 都要重貼 |

> 也可以在 Cloudflare 後台設定：Workers & Pages → link-extractor → Settings → Variables and Secrets → Add → Type 選 **Secret**。

### 6. 建立帳密

打開步驟 4 的網址 → 輸入 `SETUP_TOKEN`、帳號、密碼（至少 10 字元）→「建立並鎖定」。

**設定完成後網站上無法修改帳密。**

---

## 使用方式

### 貼網址（Telegram 等）

1. 在「擷取」頁貼上 `https://t.me/s/頻道名`（也可以貼 `https://t.me/頻道名`，會自動轉換）
2. 按「擷取」；按「＋ 存為常用來源」之後就能一鍵擷取
3. 看完按「全部標為已讀」，下次只有新貼文會標 NEW
4. 勾「自動往回翻到上次已讀處」，會一直往前翻（最多 10 頁）直到碰到看過的貼文

### 書籤小工具（EYNY 等需要登入的論壇）

1. 到「設定」頁，把「📥 送到連結擷取器」按鈕**拖到瀏覽器書籤列**
2. 在瀏覽器正常登入 EYNY，打開要看的文章或版塊頁
3. 按書籤 → 會開新分頁顯示解析結果（第一次可能要允許彈出視窗）
4. 版塊列表頁會列出每篇文章，按「開啟」到該篇後再按一次書籤即可看附件

### 下載行為

| 類型 | 點擊後 |
|---|---|
| 夸克 / 百度 / 阿里等網盤 | 新分頁開啟分享頁（在網盤 App 或網頁存到自己的雲端）；有提取碼會一起顯示、一起複製 |
| magnet / ed2k | 交給電腦上預設的 BT / 下載軟體 |
| .torrent 附件 | 在新分頁開啟，使用你瀏覽器的登入狀態下載 |

勾選多筆後可「複製勾選連結」（一行一條）或「開啟勾選連結」。

---

## 新增其他網站

到「設定」→「新增 / 編輯網域」。白名單只影響「貼網址」模式；書籤小工具不受白名單限制，但會套用這裡的解析方式。

| 解析方式 | 適用 |
|---|---|
| `telegram` | Telegram 公開頻道預覽頁 |
| `discuz` | Discuz! 論壇（版塊列表 + 文章內頁）。未設定的網站若偵測到 Discuz! 也會自動使用 |
| `rules` | 用 CSS selector 描述結構（見下方） |
| `generic` | 掃全頁所有下載類連結（預設） |

### `rules` 範例

```json
{
  "item": "article.post",
  "title": "h2 a",
  "link": "a.download",
  "size": ".file-size",
  "date": "time",
  "next": "a.next-page"
}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `item` | ✔ | 每一筆項目的容器 |
| `title` | | 項目內的標題元素（省略時用第一個連結的文字） |
| `link` | | 只收這些連結（省略時收容器內所有下載類連結） |
| `size` / `date` | | 大小、日期文字 |
| `next` | | 「下一頁」連結，用來支援「載入更多」 |
| `includeOther` | | `true` 時連一般網址也列出 |

### 需要登入的網站

「登入 Cookie」欄位貼上瀏覽器的 Cookie（F12 → Network → 點任一請求 → Request Headers → `cookie:` 那一整行的值）。會以 AES-GCM 加密存在 D1，只會送到該網域。
若網站有瀏覽器安全檢查或驗證碼，伺服器抓取會失敗（網站會顯示「回傳了防爬或驗證頁面」），請改用書籤小工具。

### 寫專屬 adapter（結構特殊的網站）

1. 參考 `src/adapters/telegram.js` 新增一個檔案，實作：
   - `id`、`name`
   - `match(url)`：是否自動套用（通常回 `false`，由設定頁指定）
   - `sourceKey(url)`：已讀紀錄分組用的 key
   - `parse(document, url, { rules })` → `{ title, items, next }`
   - 選配 `normalize(url)`：把各種網址統一成要抓的頁面
2. 在 `src/adapters/index.js` 的 `ADAPTERS` 加入
3. `npm test` → `npm run deploy`

每個 item 的格式：

```js
{ key, title, size, tags: [], date, postUrl, links: [{ type, url, label, code }] }
```

---

## 忘記密碼 / 重設帳密

網站上沒有修改途徑。只能從 Cloudflare 刪掉帳密，網站就會回到「建立帳密」畫面（需要 `SETUP_TOKEN`）：

```bash
npx wrangler d1 execute link-extractor-db --remote --command "DELETE FROM auth; DELETE FROM login_attempts;"
```

也可以在 Cloudflare 後台：Storage & Databases → D1 → link-extractor-db → Console 執行同樣的 SQL。重設後所有舊的登入 session 自動失效。

---

## 安全設計

- 密碼：PBKDF2-SHA256（100,000 次）+ 隨機 salt，只存雜湊
- 帳密表 `id` 固定為 1，資料庫層級保證只能寫入一次
- 登入失敗：同 IP 15 分鐘內錯 5 次鎖 15 分鐘；全站 1 小時錯 20 次鎖 30 分鐘
- Session：HMAC 簽章的 HttpOnly / Secure / SameSite cookie，30 天有效
- 寫入類 API 檢查 `Origin`，只接受 JSON
- 伺服器只會連線到白名單網域（重新導向的每一站都會再檢查），不會變成開放代理
- 前端 CSP 禁止外部腳本，所有內容以 `textContent` 顯示，連結只允許 `http(s)` / `magnet` / `ed2k`
- `noindex` + `robots.txt`，不讓搜尋引擎收錄

## 開發

```bash
cp .dev.vars.example .dev.vars   # 本機用的密鑰
npm run db:init:local
npm run dev                      # http://127.0.0.1:8787
npm test                         # 解析器單元測試
```

## 已知限制

- Cloudflare 免費方案每次請求的 CPU 時間上限是 10ms。解析一頁約數 ms 到數十 ms（冷啟動較慢），偶爾超過時 Cloudflare 通常會放行；若常看到錯誤 1102，可把「自動往回翻」關掉，或升級 Workers Paid。
- 前端用 JavaScript 動態載入內容的網站，伺服器抓到的 HTML 是空的，請用書籤小工具。
- 「回覆後可見」等隱藏內容不會處理。
