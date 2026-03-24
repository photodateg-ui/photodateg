# PhotoDateG 仕様書 v0.3.131（2026-03-24 確定）

---

## アプリのテーマ・思想

**家族で共有アルバムを一緒に見る**ためのアプリ。
個人のライブラリや個人写真を意識させない。主役は共有アルバム。

---

## 現在のバージョン

| 項目 | 値 |
|------|-----|
| OTAバージョン | **v0.3.131** |
| Runtime Version | 0.3.0 |
| EAS Branch | main（productionチャンネルが参照） |
| TestFlightビルド | build 42 |

---

## アプリ情報

| 項目 | 値 |
|------|-----|
| Bundle ID | com.photodateg.app |
| ASC App ID | 6760644685 |
| Apple Team ID | US3QET7HJR |
| アプリ名 | PhotoDate G |
| Expoアカウント | misettei |
| EAS Project ID | b6d12337-e2f5-4643-adad-5a9e4672922e |
| GitHubリポジトリ | photodateg-ui/photodateg（Public） |

---

## OTA配信手順（必読）

```bash
cd /home/riichi/works/photov
npx eas update --branch main --message "説明 vX.X.XXX"
```

### ⚠️ 絶対ルール
- **`--branch main` を使うこと**（`--branch preview` は絶対NG、アプリに届かない）
- productionチャンネル → main ブランチ を参照している
- OTA前に必ず `AlbumSelectWebScreen.js` の `BUILD_VERSION` を更新する
- バージョン表示は AlbumSelectWebScreen のヘッダー横＋デバッグメニュー **のみ**

---

## 関連ファイル一覧

| ファイル | 役割 |
|---------|------|
| `src/screens/AlbumSelectWebScreen.js` | アルバム一覧・BUILD_VERSION（唯一の真実） |
| `src/screens/HomeWebScreen.js` | アルバム内写真一覧・削除・アップロード・お気に入りトグル |
| `src/screens/PhotoDetailWebScreen.js` | 写真詳細・ダウンロード・☆/★お気に入りトグル |
| `src/screens/TrashWebScreen.js` | ゴミ箱一覧・復元・完全削除 |
| `src/screens/FavoritesWebScreen.js` | お気に入り一覧（ローカル）・★タップで削除 |
| `src/screens/AlbumSearchScreen.js` | 検索（保留中・コードは残存） |
| `src/services/googlePhotosWebApi.js` | 非公式API RPCまとめ・makeApiRequest |
| `src/services/googleAuthService.js` | OAuth・セッション・アップロード |
| `src/services/favoritesService.js` | お気に入りCRUD（AsyncStorage） |
| `App.js` | ナビゲーション定義 |

---

## 画面構成・ナビゲーション

```
Startup
└── WebAuth（ログイン）
    └── AlbumSelectWeb（アルバム一覧）
        ├── ☆ お気に入り → FavoritesWeb
        ├── 🗑️ ゴミ箱 → TrashWeb
        └── HomeWeb（アルバム内写真一覧）
            └── PhotoDetailWeb（写真詳細・モーダル）
```

---

## 機能仕様・実装詳細

---

### 1. ログイン・セッション取得

**概要**: GoogleフォトはOAuth公式APIだけでは機能が限られるため、Webブラウザと同じ非公式APIを使う。そのためにはブラウザのセッション情報（Cookie＋WIZ_global_data）が必要。

**実装方法**:
1. `WebAuthScreen` で `https://photos.google.com/` を **表示状態の WebView** で開く
2. ユーザーが実際にGoogleアカウントでログインする
3. ログイン完了後、WebViewのページに `window.WIZ_global_data` が存在する
4. JavaScriptを注入してこのオブジェクトを抽出し、React Native側に `postMessage` で送る
5. 抽出する値:
   - `SNlM0e` → `at`（XSRFトークン、APIリクエストに必須）
   - `FdrFJe` → `sid`（セッションID）
   - `cfb2h` → `bl`（バックエンドバージョン）
6. これらをAsyncStorageに保存（`@photov_session_data`）、24時間キャッシュ
7. 次回起動時はAsyncStorageから復元してWebAuthをスキップ

**注意**: セッションはCookieに紐づくため、`sharedCookiesEnabled={true}` が必須。WebViewとAPIリクエストが同じCookieを共有する。

---

### 2. アルバム一覧取得

**概要**: Googleフォトのアルバム一覧を取得する。公式APIとfallbackの2段構え。

**実装方法**:

#### メイン: 公式API（listAlbums）
```
googleAuthService.js の listAlbums()
OAuth accessTokenを使って公式Google Photos APIを叩く
GET https://photoslibrary.googleapis.com/v1/albums
```
- 共有アルバムも含めて取得できる
- ただし**0件を返すことがある**（APIの不安定さ）

#### Fallback: APP_CREATED_ALBUMS（AsyncStorage）
- アプリ内で作成したアルバムのmediaKeyとタイトルをAsyncStorageに保存
- listAlbumsが0件の場合にこちらを使用
- キー: `@photov_app_created_albums`

#### 削除済みアルバムの復活防止
- 削除したアルバムのmediaKeyを `@photov_deleted_albums` に保存
- fallback表示時にこのリストを除外する

---

### 3. アルバム内写真一覧表示

**概要**: 選択されたアルバムの写真をグリッド表示する。

**実装方法**:

#### メイン: 非公式API（snAcKc RPC）
```javascript
// googlePhotosWebApi.js の getAlbumPage()
RPC ID: snAcKc
requestData: [albumMediaKey, pageId, null, authKey]
```
- WebView経由で `batchexecute` エンドポイントを叩く
- レスポンスをパースして写真データ（mediaKey, thumb, timestamp等）を取得
- ページネーション対応（pageIdで次ページを取得）

#### WebView経由リクエストの仕組み
```
HomeWebScreen（非表示WebView） → photos.google.com
→ JavaScriptを注入してfetch()でbatchexecuteを呼ぶ
→ postMessageでReact Native側にレスポンスを返す
→ パースして写真stateに保存
```

- WebViewは `position: absolute, top: -9999` で完全に非表示
- ユーザーには見えないが、Cookieを共有しているので認証済みリクエストができる

#### サムネイルURL
- `getPhotoUrl(thumb, width, height, crop)` でGoogleusercontent.comのURLを生成
- `=w200-h200-c` パラメータで200x200クロップ
- expo-imageの `cachePolicy="memory-disk"` でキャッシュ

---

### 4. 写真削除（ライブラリ→ゴミ箱）

**概要**: 選択した写真をGoogleフォトのゴミ箱に移動する。

**実装方法**: `HomeWebScreen.js` の `performDelete()`

#### 写真の分類（3パターン）

**パターン1: dedupKeyあり**（通常の写真）
```javascript
moveItemsToTrash(dedupKeys)
// XwAOJf RPC: [null, 1, dedupKeys, 3]
```

**パターン2: dedupKeyなし・apiMediaItemIdあり**（楽観的更新で追加した写真）
```javascript
removePhotosFromAlbum(accessToken, apiAlbumId, mediaItemIds)
// 公式APIでアルバムから除外（ゴミ箱には移動しない）
```

**パターン3: dedupKeyなし・apiMediaItemIdもなし**
```javascript
// VrseUb APIでdedupKeyを自動取得してからパターン1に合流
const dedupKey = await getDedupKeyFromMediaKey(mediaKey)
```

#### 削除後のUX
- APIの完了を待たずに即座にstateから除去（楽観的UI更新）
- リフレッシュは行わない（リフレッシュすると楽観的更新と競合する）

---

### 5. ゴミ箱表示

**概要**: Googleフォトのゴミ箱に入った写真を一覧表示する。

**実装方法**: `TrashWebScreen.js`

#### なぜWebView解析か
- 非公式API（zy0lHe RPC）でゴミ箱一覧を取得できるが、dedupKeyが返らない
- WebViewで `https://photos.google.com/trash` を開くとページのHTMLにAF1Qipから始まるmediaKeyとサムネイルURLが埋め込まれている
- JavaScriptでこれを解析してアイテムを取得する

#### 抽出パターン（パターン1が最安定）
```javascript
// scriptタグ内のテキストを検索
const pattern1 = /\["(AF1Qip[A-Za-z0-9_-]+)",\s*\["(https:\/\/[^"]+)"/g
// mediaKey と サムネイルURL を同時に取得
```

#### WebView構成
```
WebView（非表示・position: absolute top: -9999）
  source: https://photos.google.com/trash
  onLoad → 500ms後にJavaScriptを注入
  → postMessageでアイテムリストをReact Native側に返す
```

#### リフレッシュ
- onRefreshは WebView の key を変えて再マウントするだけ
- API試行は行わない（セッションの状態によって失敗するため）

---

### 6. ゴミ箱操作（復元・完全削除）

**概要**: ゴミ箱内の写真を復元またはGoogleフォトから永久削除する。

**実装方法**:

#### dedupKey取得が必須な理由
- XwAOJf（ゴミ箱操作RPC）はdedupKeyを要求する
- zy0lHe（ゴミ箱一覧）はdedupKeyを返さない（null）
- **そのため、写真を選択するたびにVrseUb APIでdedupKeyを取得する**

#### VrseUb（dedupKey取得）
```javascript
// googlePhotosWebApi.js の getDedupKeyFromMediaKey()
RPC ID: VrseUb
source-path: /trash/{mediaKey}  ← makeApiRequestForTrashを使用
requestData: [mediaKey, null, null, 1]  ← 4要素
response[0][3]: dedupKey  ← ここにある
```

#### XwAOJf（ゴミ箱操作）
```javascript
// source-path: /u/0/photos（makeApiRequestを使用）
[null, 3, dedupKeys, 2] → 復元
[null, 2, dedupKeys, 2] → 完全削除
```

#### 復元後のアルバム自動リロード
- 復元完了 → `navigation.goBack()` でアルバム画面に戻る
- HomeWebScreenの `useFocusEffect` がフォーカスを検知して `onRefresh()` を自動実行
- `hasLoadedOnce.current`（初回ロード済みフラグ）がtrueの場合のみリロード
- `hasOptimisticUpdate.current`（アップロード中フラグ）がtrueの場合はスキップ

---

### 7. お気に入り

**概要**: 写真にスターをつけてアプリ内でブックマークする機能。

**なぜローカル保存か**:
- Googleフォトのお気に入りAPI（非公式）のRPC IDが未判明
- アプリ内だけのブックマークとして AsyncStorage に保存することにした
- Googleフォトのお気に入りとは完全に別物（同期しない）

**実装方法**: `favoritesService.js`

```javascript
// AsyncStorageキー: @photov_favorites
// 保存形式: [{ mediaKey, thumb, timestamp, dedupKey }, ...]
getFavorites()     // 全件取得
addFavorite(photo) // 追加（重複チェックあり）
removeFavorite(mediaKey) // 削除
isFavorite(mediaKey)     // 判定
```

#### お気に入りの追加・削除方法

| 場所 | 操作 |
|------|------|
| 写真詳細画面 | ヘッダーの ☆/★ ボタンをタップ（1枚ずつ） |
| アルバム内 | 長押しで選択モード → ☆/★ ボタン（複数まとめて） |
| お気に入り画面 | サムネイル右下の ★ を直接タップで削除 |

#### ★バッジの表示
- アルバム・ゴミ箱・お気に入り画面のサムネイル右下に金★を表示
- `useFocusEffect` で画面フォーカス時にfavoritesを再読み込み
- `favoriteKeys`（Set\<mediaKey\>）をstateで管理
- `PhotoItem` コンポーネントに `isFavorite` プロップを渡してバッジ表示

#### アルバム内の選択モード★ボタンのロジック
```javascript
// 選択中の全写真がお気に入り → ★（タップで全部外す）
// 1枚でも未お気に入り → ☆（タップで全部追加）
const allFavorited = selected.every(p => favoriteKeys.has(p.mediaKey))
```

---

### 8. アップロード

**概要**: 端末の写真をGoogleフォトのアルバムにアップロードする。

**実装方法**: `googleAuthService.js`

#### 4ステップの流れ

**Step1: blobを取得**
```javascript
// ローカルファイルURIからblobを生成
const response = await fetch(localUri)
const blob = await response.blob()
```

**Step2: uploadトークンを取得**
```javascript
// Google Photos Upload API
POST https://photoslibrary.googleapis.com/v1/uploads
Headers: X-Goog-Upload-Protocol: raw
Body: blob
→ uploadToken（文字列）を返す
```

**Step3: batchCreate（ライブラリに追加）**
```javascript
POST https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate
Body: { newMediaItems: [{ simpleMediaItem: { uploadToken } }] }
→ mediaItemId を返す
```

**Step4: batchAddMediaItems（アルバムに追加）**
```javascript
POST https://photoslibrary.googleapis.com/v1/albums/{albumId}:batchAddMediaItems
Body: { mediaItemIds: [mediaItemId] }
```

#### 楽観的更新
- Step1完了後、ローカルURIをthumbとして即座に写真stateに追加（ユーザーに即表示）
- `hasOptimisticUpdate.current = true` でリロードを防ぐ
- Step4完了後 `hasOptimisticUpdate.current = false`

---

### 9. 写真詳細・ダウンロード

**概要**: フルサイズ写真の表示・ダウンロード・動画再生。

**実装方法**: `PhotoDetailWebScreen.js`

#### フルサイズ表示
- `react-native-image-zoom-viewer` でピンチズーム・スワイプ対応
- URLは `getFullSizeUrl(thumb, 0, 0)` で `=d`（オリジナルサイズ）パラメータを付与
- 前後2枚をプリフェッチ（expo-imageのprefetch）

#### ダウンロード
1. `FileSystem.downloadAsync()` でローカルに一時保存
2. `Exify.write()` でEXIF撮影日時を書き込み（`DateTimeOriginal`）
3. `MediaLibrary.createAssetAsync()` でカメラロールに保存
4. 一時ファイルを削除

#### 動画再生
- `isVideoItem(photo)` で動画判定（thumbのURLパターンで判断）
- `thumb.split('=')[0] + '=dv'` で動画URLを生成
- Modalで全画面WebViewを開いて `<video>` タグで再生
- `allowsInlineMediaPlayback` + `mediaPlaybackRequiresUserAction={false}`

---

## 確定済みAPI仕様（PC DevTools検証済み 2026-03-23）

### batchexecuteエンドポイント
```
POST https://photos.google.com/_/PhotosUi/data/batchexecute
Params: rpcids, source-path, f.sid, bl, hl=ja, soc-app=165, soc-platform=1, soc-device=1, _reqid, rt=c
Body: f.req=[[[rpcId, JSON.stringify(requestData), null, wrapper]]]&at={at}&
```

### RPC ID 一覧

| RPC ID | 用途 | wrapper | source-path |
|--------|------|---------|-------------|
| `Z5xsfc` | アルバム一覧取得 | generic | /u/0/photos |
| `snAcKc` | アルバム内写真取得 | generic | /u/0/photos |
| `lcxiM` | タイムライン（日付順）取得 | generic | /u/0/photos |
| `EzkLib` | アップロード順取得 | generic | /u/0/photos |
| `F2A0H` | 共有リンク一覧 | generic | /u/0/photos |
| `XwAOJf` | ゴミ箱操作（移動・復元・完全削除） | generic | /u/0/photos |
| `nV6Qv` | アルバム削除 | generic | /u/0/photos |
| `zy0lHe` | ゴミ箱一覧取得 | **"1"（注意！）** | /trash |
| `VrseUb` | 写真詳細・dedupKey取得 | generic | /trash/{mediaKey} |

### XwAOJf リクエストデータ
```
[null, 1, dedupKeys, 3] → ライブラリ→ゴミ箱に移動
[null, 2, dedupKeys, 2] → ゴミ箱から完全削除
[null, 3, dedupKeys, 2] → ゴミ箱から復元
```

### VrseUb リクエスト・レスポンス
```
requestData: [mediaKey, null, null, 1]  ← 必ず4要素
response[0][3]: dedupKey
※ response[3] ではない（外側の配列の4番目はユーザー情報）
```

### zy0lHe の特殊性
```
wrapper: "1"（他のRPCは全て "generic"）
← これを間違えると空レスポンスになる
response[0][0][0]: mediaKey
response[0][0][3]: null（dedupKeyは返らない）
```

---

## ✅ 動作確認済み・絶対に触らない機能

| 機能 | 確認バージョン | 実装場所 |
|------|--------------|---------|
| 削除（ライブラリ→ゴミ箱） | build 6 | HomeWebScreen performDelete, XwAOJf [null,1,keys,3] |
| ゴミ箱復元 | v0.3.123 | restoreFromTrash, XwAOJf [null,3,keys,2] |
| ゴミ箱完全削除 | v0.3.123 | permanentlyDeleteFromTrash, XwAOJf [null,2,keys,2] |
| アップロード | build 6 | googleAuthService.js Step1〜4 |
| 楽観的更新 | build 7 | hasOptimisticUpdate ref |
| Fallback 2（アルバム選択） | build 7 | AlbumSelectWebScreen selectAlbum |
| ゴミ箱サムネイル表示 | v0.3.94 | TrashWebScreen パターン1抽出 |
| 復元後自動リロード | v0.3.129 | HomeWebScreen useFocusEffect + hasLoadedOnce ref |

---

## ⚠️ ハマりポイント集

### OTA
- `--branch preview` でデプロイしてもアプリに届かない（過去にやらかし済み）
- productionチャンネル → **main** ブランチ のみ

### zy0lHe の wrapper
- **"1"** を指定しないと空レスポンスになる
- 他のRPC全てが "generic" なので間違えやすい

### VrseUb のレスポンスパース
- `response[0][3]` が dedupKey（**response[3]** ではない）
- response[3] はユーザー情報配列（過去にここを間違えてdedupKey取得が壊れた）

### makeApiRequest vs makeApiRequestForTrash
- `makeApiRequestForTrash(rpcId, data, {}, mediaKey)`: source-path が `/trash/{mediaKey}`（VrseUb専用）
- `makeApiRequest(rpcId, data)`: source-path が `/u/0/photos`（それ以外全て）
- XwAOJf は makeApiRequest を使う

### HomeWebScreenの自動リロード
- `hasLoadedOnce.current`（初回ロード完了後trueになるref）でフォーカス時リロードを制御
- `onRefreshRef.current`（onRefreshの最新版を保持するref）でstale closureを回避
- `hasOptimisticUpdate.current`（アップロード中フラグ）がtrueのときはリロードしない

### お気に入りはGoogleフォトと無関係
- AsyncStorageのみ。アプリを削除すると消える
- Googleフォトのお気に入り（Likedフォルダ）とは同期しない

### アルバム削除後の復活防止
- 削除後に `@photov_deleted_albums` にmediaKeyを保存
- `@photov_app_created_albums` からも除去
- この2つをしないと、次回起動時にfallbackで削除済みアルバムが復活する

---

## 既知の課題

| 課題 | 状況 |
|------|------|
| listAlbums APIが0件を返すことがある | APP_CREATED_ALBUMSのfallbackで回避済み |
| アルバム内検索 | 共有アルバム限定の検索RPC未判明のため保留 |

---

## App Store提出チェックリスト

| 項目 | 状況 |
|------|------|
| プライバシーポリシーURL | ❌ 未作成（必須） |
| スクリーンショット | ❌ 未作成 |
| アプリ説明文 | ❌ 未作成 |
| 審査用Googleアカウント | ❌ 未作成（App Store Connectのレビュー情報欄に記入） |
| アイコン | ✅ build 42で反映済み |

---

## 開発ルール

- **JSのみ変更** → `npx eas update --branch main`
- **ネイティブ変更** → git push → GitHub Actions自動ビルド → TestFlight
- **GoogleフォトAPI関連の変更前** → Gemini CLI で仕様確認（`python3 gemini-cli.py "..."`)
- **EASビルドは有料**。動作未確認のままビルドしない
