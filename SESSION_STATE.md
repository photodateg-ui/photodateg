# PhotoDateG - セッション状態管理（2026-03-23 更新）

## 現在のバージョン

| 項目 | 内容 |
|------|------|
| OTAバージョン | **v0.3.127** |
| EAS Branch | main |
| TestFlightビルド | build 42 |

---

## ★ アプリ情報

| 項目 | 値 |
|------|-----|
| Bundle ID | com.photodateg.app |
| ASC App ID | 6760644685 |
| Apple Team ID | US3QET7HJR |
| Expoアカウント | misettei |
| EAS Project ID | b6d12337-e2f5-4643-adad-5a9e4672922e |
| GitHubリポジトリ | photodateg-ui/photodateg（Public） |

---

## ★ OTA配信コマンド（毎回これ）

```bash
cd /home/riichi/works/photov
npx eas update --branch main --message "説明 vX.X.XXX"
```

**必須**: `--branch main`（`--branch preview` は絶対NG）
**必須**: 事前に `AlbumSelectWebScreen.js` の `BUILD_VERSION` を更新

---

## ★ 今日の作業まとめ（2026-03-23）

### 配信済み
| バージョン | 内容 |
|-----------|------|
| v0.3.123 | ゴミ箱復元・完全削除 動作確認済み |
| v0.3.124 | 復元後goBack、バージョン表示をAlbumSelectWebScreenに統一 |
| v0.3.125 | アルバム選択画面2×2グリッドボタン、AlbumSearchScreen新規作成 |
| v0.3.126 | お気に入り機能（PhotoDetail ☆/★、FavoritesWebScreen刷新）、検索WebView化、ゴミ箱リロード高速化、削除時dedupKey自動取得 |
| v0.3.127 | お気に入り★バッジをアルバム・ゴミ箱サムネイルに表示 |
| v0.3.128 | アルバム内検索ボタンを非表示（お気に入り・ゴミ箱の2ボタンに整理） |

---

## ★ 確定済み状態（v0.3.127）

| 機能 | 状態 |
|------|------|
| アルバム一覧 | ✅ |
| 写真一覧（★バッジ表示） | ✅ |
| 写真詳細（☆/★トグル、ダウンロード） | ✅ |
| 削除（dedupKey自動取得対応） | ✅ |
| ゴミ箱（表示・復元・完全削除・★バッジ） | ✅ |
| お気に入り（ローカル、一覧画面） | ✅ |
| 検索（Google Photos WebView直接表示） | ✅ |
| アップロード | ✅ |

---

## ★ 残タスク・未解決

| 課題 | 優先度 |
|------|--------|
| ゴミ箱復元後の自動リロード | 中 |

## ★ 保留機能（コードはキープ、UIから非表示）

| 機能 | ファイル | 保留理由 |
|------|---------|---------|
| アルバム内検索（`AlbumSearchScreen.js`） | `src/screens/AlbumSearchScreen.js` | Google Photos WebViewと同等で差別化なし。共有アルバムも検索できないため。ネイティブ検索RPCが使えるようになれば復活候補 |

---

## ★ 重要ファイル

| ファイル | 役割 |
|---------|------|
| `HANDOVER.md` | **完全仕様書（これが正）** |
| `src/screens/AlbumSelectWebScreen.js` | BUILD_VERSION（唯一の真実） |
| `src/services/googlePhotosWebApi.js` | 全RPC定義・API呼び出し |
| `src/services/favoritesService.js` | お気に入りCRUD |

---

## トリガーワード

- **「続き」「pj」「photov」「再開」** → SESSION_STATE.mdを読んで即作業再開
- **「終了」「やめる」「離れる」** → SESSION_STATE.mdを更新
