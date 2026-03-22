# PhotoDateG - セッション状態管理（2026-03-23 更新）

## 現在のバージョン

| 項目 | 内容 |
|------|------|
| バージョン | v0.3.98 |
| ビルドナンバー | GitHub Actions run番号（自動） |
| TestFlight | ビルド進行中（2026-03-18） |

---

## ★ 現在の状態（2026-03-18）

### アプリ情報
| 項目 | 値 |
|------|-----|
| Bundle ID | com.photodateg.app |
| ASC App ID | 6760644685 |
| Apple Team ID | US3QET7HJR |
| アプリ名 | PhotoDate G |
| Expoアカウント | misettei |
| EAS Project ID | b6d12337-e2f5-4643-adad-5a9e4672922e |

### GitHubリポジトリ
- アカウント: `photodateg-ui`
- リポジトリ: `photodateg-ui/photodateg`（Public）
- PAT: ※ローカルのみ保管（`※ローカルのみ保管`）

### Google OAuth
| 項目 | 値 |
|------|-----|
| iOS Client ID | `483467707926-haidkv7t2d0vg3pgk7ushjkovvqukdn5.apps.googleusercontent.com` |
| Web Client ID | `483467707926-c5hljat3427q2cn7ip8u7c7lrf39f6df.apps.googleusercontent.com` |
| Google Cloud Project | PhotoDateG（新アカウント） |

---

## ★ 完了済み作業

### GitHub Actions + Fastlane（EASビルド廃止）
- [x] GitHub Actions ワークフロー作成（`.github/workflows/ios-build.yml`）
- [x] Fastlane設定（Fastfile, Appfile, Gemfile）
- [x] iOS Distribution証明書 + Provisioning Profile設定
- [x] p12をmacOS互換レガシー形式（PBE-SHA1-3DES）で再作成（AES-256-CBCだとmacOSで失敗）
- [x] GitHub Secrets全6つ登録（ASC_KEY_*, CERTIFICATE_*, PROVISIONING_PROFILE_BASE64）
- [x] ビルド成功・TestFlight送信成功

### Google OAuth再設定
- [x] 新Google Cloudプロジェクト「PhotoDateG」作成
- [x] Photos Library API有効化
- [x] OAuthスコープ設定（readonly, appendonly, sharing, edit.appcreateddata）
- [x] iOS OAuthクライアント作成（Bundle ID: com.photodateg.app）
- [x] Web OAuthクライアント作成
- [x] アプリコードのクライアントID更新（googleAuthService.js, googleAuth.js）
- [x] CFBundleURLSchemesを新クライアントIDに更新

### EAS Update設定
- [x] expo-updatesインストール
- [x] EASプロジェクト作成（misetteiアカウント、ID: b6d12337-...）
- [x] productionチャンネル作成
- [x] app.jsonにupdates/runtimeVersion設定
- [x] EXPO_TOKEN GitHub Secretsに登録
- [x] OTAワークフロー作成（`.github/workflows/ota-update.yml`）

### UI修正
- [x] アルバム選択画面をSafeAreaViewに変更（ヘッダーが上に固定）
- [x] アルバム選択画面レイアウト修正（v0.3.39）- メインreturnからWebView削除で解決
- [x] 新アイコン反映（白背景・1024x1024）
- [x] .gitignore整理（.venv等を除外）

### TestFlight設定
- [x] 内部テスター登録済み（r.sato.jp@gmail.com 他2名）

### ゴミ箱機能修正（v0.3.94 確定）
- [x] 黒い画像の誤検出問題解消（AF1Qip雑抽出→正確なパターンマッチに変更）
- [x] ゴミ箱アイテム取得改善（WebViewページデータからパターン1で抽出）
- [x] サムネイルURL正常取得（レスポンスから直接URLを使用）
- [x] バージョン一括更新スクリプト作成（`./scripts/bump-version.sh`）

---

## ★ OTAビルドの使い方（重要）

### JS修正の場合（30秒）
```bash
# GitHub Actionsでワークフロー手動実行
# Actions → "OTA Update (EAS Update)" → Run workflow
```
またはCLI:
```bash
cd /home/riichi/works/photov
EXPO_TOKEN=lCnYEIhWs0D11Bj9QOU2xFPfcBRL_9uOcgeTpkNh eas update --channel production --message "修正内容"
```

### ネイティブ変更の場合（30〜40分）
git push → GitHub Actions自動実行 → TestFlight

---

## ★ 既知の問題・やること

### 確認待ち
- [ ] 新ビルドでGoogleログインが動くか確認（新OAuthクライアントID）
- [ ] アルバム選択画面のレイアウト確認（SafeAreaView修正）
- [ ] 新アイコンの確認

### 残タスク
- [ ] アルバム画面などのUI細かい修正（OTAで対応可）
- [ ] EAS Updateが実際に動くか初回テスト

---

## ★ 重要ファイルとコード位置

| ファイル | 関連箇所 |
|---------|---------|
| `src/services/googleAuthService.js` | `uploadToGooglePhotos` 137行、IOS_CLIENT_ID 9行 |
| `src/services/googlePhotosWebApi.js` | `moveItemsToTrash` 449行、`deleteAlbum` 508行 |
| `src/screens/AlbumSelectWebScreen.js` | `selectAlbum` 721行、SafeAreaView修正済み |
| `src/screens/HomeWebScreen.js` | `performUpload` 1239行、`performDelete` 1411行 |
| `src/screens/TrashWebScreen.js` | `generateGetTrashScript` 127行、ゴミ箱アイテム抽出 |
| `src/config/googleAuth.js` | OAuthクライアントID設定 |
| `scripts/bump-version.sh` | 全画面のBUILD_VERSION一括更新スクリプト |

---

## ★ 確定した成功事例（変更禁止）

### ✅ 削除機能（build 6で確認済み）
- `performDelete` in HomeWebScreen.js
- `moveItemsToTrash(dedupKeys)` → 非公式APIで削除
- **PROTECTED_FEATURES.mdに仕様固定済み**

### ✅ アップロード処理（googleAuthService.js 137行〜）
- Step1: blob取得 → Step2: uploadトークン → Step3: batchCreate → Step4: batchAddMediaItems

### ✅ ゴミ箱表示（v0.3.94で確定）
- `TrashWebScreen.js` - WebViewでphotos.google.com/trashを開く
- ページ埋め込みデータからパターン1 `["AF1Qip...",["https://...` で抽出
- サムネイルURLはレスポンスに含まれる実際のURLを使用
- **詳細はARCHITECTURE.mdの「ゴミ箱表示の仕組み」参照**

---

## ★ 開発ルール

- JSのみの修正 → OTA（`eas update`）
- ネイティブ変更 → git push → GitHub Actions自動ビルド
- p12は必ずPBE-SHA1-3DES形式で作成（AES-256-CBCはmacOSで動かない）

---

## トリガーワード

- **「続き」「pj」「photov」「再開」** → このファイルを読んで作業再開
- **「終了」「やめる」「離れる」** → このファイルを更新
