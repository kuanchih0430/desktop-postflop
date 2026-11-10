# 匯入範圍資料夾

在 Solver 的 OOP／IP 範圍編輯器，按 **Import Folder**，選擇包含範圍的整個資料夾，例如 `PioRanges_nlhe_100bb_3x_NL200`。

- 根資料夾與子資料夾會成為可展開的群組，支援超過原本四層的目錄，保留空群組。
- `.txt` 檔案成為範圍項目，保留檔名；選取後按 **Load** 或雙擊即可套用。
- 支援逗號分隔的手牌文字，例如 `AA,KK,AK,AQs,AQo:0.75,77:0.5`，以及分行、UTF-8 BOM。`:0.75` 表示 75% 權重，未寫權重則是 100%；`AK` 包含同花與非同花。
- 選取群組時，資料夾會匯入該群組內；選取範圍時，匯入同一層；未選取時匯入最上層。
- 重複匯入會建立 `名稱 (2)` 等新群組，不覆蓋舊範圍。同名檔案位於不同子資料夾時會分別保留。
- 所有檔案驗證成功後才一次儲存；解析失敗會顯示問題檔案的相對路徑，不寫入部分資料。非 `.txt` 檔案、隱藏項目與符號連結會略過。

既有範圍與樹設定資料會自動遷移到多層路徑儲存格式。**Import JSON** 繼續接受舊的 version 2 備份，也接受新版 version 3；匯出超過四層的資料使用 version 3，其餘使用 version 2。

檢查方式：

```sh
npm run test:range-folders
npm run test:result-files
npm run build
npm run lint
cargo test --manifest-path src-tauri/Cargo.toml --locked --offline
```

範圍測試使用實際解析引擎，包含提供的 Pio 範圍範例與完整權重對照。資料庫測試使用 IndexedDB 模擬環境執行實際 Dexie 升級、交易與查詢，驗證舊資料、多層路徑、重複項目及失敗時不寫入；遞迴元件另驗證十二層的渲染。原生資料夾對話框與桌面點擊仍需在 App 中驗收。
