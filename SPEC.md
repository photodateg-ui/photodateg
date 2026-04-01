# PhotoV / PhotodateG 仕様書

**最終更新: 2026-04-01**
**バージョン: v0.3.159 (build 42)**

---

## 目次

1. [アプリ概要](#1-アプリ概要)
2. [技術スタック・アーキテクチャ](#2-技術スタックアーキテクチャ)
3. [認証システム](#3-認証システム)
4. [Google Photos 非公式API](#4-google-photos-非公式api)
5. [機能別仕様](#5-機能別仕様)
6. [データ管理（AsyncStorage）](#6-データ管理asyncstorage)
7. [既知の制限と回避策](#7-既知の制限と回避策)
8. [実装の注意事項（やってはいけないこと）](#8-実装の注意事項やってはいけないこと)
9. [RPC一覧（ペイロード・レスポンス構造）](#9-rpc一覧ペイロードレスポンス構造)
10. [仕様候補（未実装の改善案）](#10-仕様候補未実装の改善案)

---

## 1. アプリ概要

**アプリ名**: PhotoDate G（旧: PhotoV）

**目的**: Googleフォトのコンテンツを高品質ビューで閲覧・管理するiPhoneアプリ。
公式のGoogle Photos APIには写真削除・ゴミ箱・お気に入り機能がないため、
非公式Web APIを利用してこれらを実現する。

**対象プラットフォーム**: iOS（iPhone）、Expo Go / EAS Build (TestFlight)

**主な機能**:
- アルバム一覧表示・選択
- アルバム内写真の日付グループ表示
- 写真削除（ゴミ箱）・ゴミ箱復元・完全削除
- お気に入り管理
- アルバム作成・リネーム・削除
- 写真アップロード（公式API）
- 共有リンク作成・コピー
- 写真検索（WebView）

---

## 2. 技術スタック・アーキテクチャ

### フレームワーク
- **React Native** + **Expo** (SDK 52以降)
- **expo-router** ではなく `@react-navigation/stack` を使用
- **expo-updates** によるOTA（Over-The-Air）更新

### 主要ライブラリ
- `react-native-webview` — Google Photosセッション管理・API実行の核心
- `expo-image` — 高速キャッシュ付き画像表示
- `@react-native-async-storage/async-storage` — ローカルデータ永続化
- `expo-auth-session` — Google OAuth認証
- `expo-image-picker` / `expo-media-library` — 写真ピッカー・メディアアクセス
- `expo-clipboard` — クリップボードコピー

### アーキテクチャ概要

```
App.js
├── WebAuthScreen        — WebViewでGoogleログイン + セッション抽出
├── AlbumSelectWebScreen — アルバム一覧（WebView経由で取得）
├── HomeWebScreen        — アルバム内写真一覧（非表示WebView使用）
├── PhotoDetailWebScreen — 写真詳細表示
├── TrashWebScreen       — ゴミ箱
├── FavoritesWebScreen   — お気に入り
├── AlbumSearchScreen    — 検索（WebView表示）
└── WebManageScreen      — WebView管理画面

src/services/
├── googlePhotosWebApi.js  — 非公式API（batchexecute）クライアント
├── webViewApiClient.js    — WebView injectJavaScript スクリプト生成
├── googleAuthService.js   — OAuth認証・公式API呼び出し
└── favoritesService.js    — お気に入りローカル管理
```

### 2つの認証方式が共存する理由

| 操作 | 方式 | 理由 |
|------|------|------|
| 写真閲覧・削除・お気に入り | 非公式Web API (WebView経由) | 公式APIにこれらの機能がない |
| アルバム作成・リネーム・アップロード | 公式 Photos Library API (OAuth) | 信頼性が高く、アルバムIDを正確に取得できる |
| 共有リンク作成 | 非公式Web API (WebView経由) | WebViewのCookieが必須 |
| アルバム削除 | 非公式Web API (native fetch) | Cookieが sessionManager に渡せるため動作する |

---

## 3. 認証システム

### 3.1 WebViewセッション（WIZ_global_data）

Google PhotosはWebアクセス時に `WIZ_global_data` というグローバル変数をページに埋め込む。
この変数から以下の3つの値を抽出してセッションを確立する。

| フィールド | 変数名 | 用途 |
|-----------|--------|------|
| `at` | `WIZ_global_data.SNlM0e` | XSRFトークン（全リクエストに必須） |
| `sid` | `WIZ_global_data.FdrFJe` | セッションID（URLパラメータ `f.sid`） |
| `bl` | `WIZ_global_data.cfb2h` | バックエンドバージョン（URLパラメータ `bl`） |

**抽出方法** (WebAuthScreen.js):

```javascript
// WebViewがphotos.google.comをロードした後にinjectJavaScript
const extractionScript = `
  (function() {
    if (typeof WIZ_global_data !== 'undefined') {
      const data = {
        SNlM0e: WIZ_global_data.SNlM0e,  // at (XSRFトークン)
        FdrFJe: WIZ_global_data.FdrFJe,  // sid
        cfb2h:  WIZ_global_data.cfb2h,   // bl
      };
      if (data.SNlM0e && data.FdrFJe && data.cfb2h) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'SESSION_DATA',
          data: data,
        }));
        return;
      }
    }
    // フォールバック: script タグを直接パース
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      const atMatch  = text.match(/SNlM0e['"\\s]*:['"\\s]*["']([^"']+)["']/);
      const sidMatch = text.match(/FdrFJe['"\\s]*:['"\\s]*["'](-?\\d+)["']/);
      const blMatch  = text.match(/cfb2h['"\\s]*:['"\\s]*["']([^"']+)["']/);
      if (atMatch && sidMatch && blMatch) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'SESSION_DATA',
          data: { SNlM0e: atMatch[1], FdrFJe: sidMatch[1], cfb2h: blMatch[1] },
        }));
        return;
      }
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'EXTRACTION_FAILED' }));
  })();
  true;
`;
```

**セッション保存**: `@photov_session_data` に `{ wizData, savedAt }` 形式で保存。
有効期間は30日。1時間経過後はバックグラウンドWebViewで自動更新。

**SessionManagerクラス** (`googlePhotosWebApi.js`):

```javascript
class SessionManager {
  setFromWizData(wizData) {
    this.at  = wizData.SNlM0e;
    this.sid = wizData.FdrFJe;
    this.bl  = wizData.cfb2h;
    this.isValid = !!(this.at && this.sid && this.bl);
    return this.isValid;
  }
}
export const sessionManager = new SessionManager();
```

### 3.2 OAuth（Google Photos Library API）

**用途**: アルバム作成・リネーム・アップロード・共有設定

**スコープ**:
```javascript
const SCOPES = [
  'https://www.googleapis.com/auth/photoslibrary.readonly',
  'https://www.googleapis.com/auth/photoslibrary.appendonly',
  'https://www.googleapis.com/auth/photoslibrary.sharing',
  'https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata',
];
```

**クライアントID**: `483467707926-haidkv7t2d0vg3pgk7ushjkovvqukdn5.apps.googleusercontent.com`

**実装**: `expo-auth-session/providers/google` の `useAuthRequest` hook。
リダイレクトURI: `{reverseClientId}:/oauth2redirect/google`

**トークン管理**: `@photov_google_auth` に `{ accessToken, expiresAt }` で保存。
期限切れ時は `getStoredAuth()` が null を返す → アプリがOAuthフローを再起動。

**重要な制約**: OAuthトークンの自動更新（リフレッシュトークン）は未実装。
期限切れ時はユーザーが手動で再認証する必要がある。

### 3.3 なぜ2つの認証が必要か

公式 Google Photos Library API (OAuth) は以下の操作に**対応していない**:
- 写真の削除・ゴミ箱移動・復元
- お気に入り設定
- アルバムの削除
- アルバム一覧の未共有アルバム取得（共有済みのみ返す場合がある）

これらは Google Photos の Web UI が使う **非公式 batchexecute API** でのみ実現可能。

### 3.4 ❌ やってはいけない: native fetch で /u/0/ エンドポイントを叩く

**現象**: `HTTP 403 INVALID_ARGUMENT` が返る。

**理由**: `/u/0/_/PhotosUi/data/batchexecute` エンドポイントは、
Google Photos Web UI のCookieセッション（`__Secure-1PSID` 等）を要求する。
React Native の `fetch()` はWebViewのCookieを持たないため認証が失敗する。

**正解**: WebView の `injectJavaScript` でスクリプトを実行し、
WebView内部のCookieを使って `fetch()` を呼ぶ。
結果は `window.ReactNativeWebView.postMessage()` でRN側に返す。

---

## 4. Google Photos 非公式API

### 4.1 batchexecute の仕組み

Google Photos WebアプリはすべてのAPI操作を `batchexecute` エンドポイントに送信する。

**エンドポイント（パス別の違い）**:
- `https://photos.google.com/_/PhotosUi/data/batchexecute` — 通常API（削除・一覧取得等）
- `https://photos.google.com/u/0/_/PhotosUi/data/batchexecute` — ユーザーコンテキストAPI（共有リンク作成等）

**リクエスト形式**:

```
POST /batchexecute?rpcids={RPC_ID}&source-path={path}&f.sid={sid}&bl={bl}&rt=c
Content-Type: application/x-www-form-urlencoded;charset=UTF-8

f.req=[[["RPC_ID","JSON_ENCODED_PAYLOAD",null,"generic"]]]&at={at}&
```

**URLパラメータ一覧**:
| パラメータ | 値 | 説明 |
|-----------|-----|------|
| `rpcids` | RPC IDの文字列 | 例: `Z5xsfc` |
| `source-path` | `/u/0/photos` 等 | コンテキストパス（操作によって異なる） |
| `f.sid` | セッションID (FdrFJe) | セッション識別子 |
| `bl` | バージョン (cfb2h) | バックエンドバージョン |
| `rt` | `c` | レスポンス形式（常に `c`） |
| `pageId` | `none` | （省略可） |
| `soc-app` | `165` | 共有系RPCで必要 |
| `soc-platform` | `1` | 共有系RPCで必要 |
| `soc-device` | `1` | 共有系RPCで必要 |

**ペイロードのラッピング**:

```javascript
// requestData を JSON 文字列化してラッピング
const wrappedData = [[[rpcid, JSON.stringify(requestData), null, 'generic']]];
const requestBody = `f.req=${encodeURIComponent(JSON.stringify(wrappedData))}&at=${encodeURIComponent(at)}&`;
```

### 4.2 WebView injectJavaScript パターン（なぜ必要か）

**理由**: 一部のRPC（特に `/u/0/` エンドポイント）はWebViewのCookieが必須。
native `fetch` ではCookieを送れないため403エラーになる。

**パターン（webViewApiClient.js）**:

```javascript
// 1. スクリプト文字列を生成
const script = generateCreateShareLinkScript(requestId, albumMediaKey, sessionData);

// 2. WebView に inject
webViewRef.current.injectJavaScript(script);

// 3. WebView 内でフェッチ実行 → postMessage でRNに返す
window.ReactNativeWebView.postMessage(JSON.stringify({
  type: 'API_RESPONSE',
  requestId: requestId,
  success: true,
  data: payload,
}));
```

**注意**: スクリプト文字列内でシングルクォートが衝突しないよう、
全パラメータを事前にエスケープする。

```javascript
const safeAt  = at.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const safeSid = (sid || '').replace(/'/g, "\\'");
```

**リクエスト/レスポンスのPromise化** (AlbumSelectWebScreen.js, HomeWebScreen.js):

```javascript
const promise = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    pendingRequest.current = null;
    reject(new Error('タイムアウト'));
  }, 30000);

  pendingRequest.current = {
    requestId,
    resolve: (data) => { clearTimeout(timeout); resolve(data); },
    reject: (error) => { clearTimeout(timeout); reject(error); },
  };
});

webViewRef.current.injectJavaScript(script);
const result = await promise;
```

HomeWebScreenでは複数のリクエストを同時に扱うため、`Map` を使用:

```javascript
// pendingRequests: Map<requestId, {resolve, reject}>
const pendingRequests = useRef(new Map());
```

### 4.3 レスポンスのパース方法（wrb.fr）

batchexecute のレスポンスは複数行のテキストで、各行がJSONになっている。
有効なデータは `wrb.fr` を含む行に入っている。

**レスポンス例（生テキスト）**:
```
)]}'\n
5\n
[["wrb.fr","Z5xsfc","[...]",null,null,null,"generic"],["di",10],["af.httprm",10,...]]\n
```

**パース手順**:

```javascript
const lines = responseBody.split('\n');
for (const line of lines) {
  if (!line.includes('wrb.fr')) continue;
  const parsed = JSON.parse(line);
  // parsed[0][1] = RPC ID
  // parsed[0][2] = JSON文字列（ペイロード）
  const payload = JSON.parse(parsed[0][2]);
  // payload を使う
}
```

**RPC IDで絞り込む場合（SFKp8c等）**:

```javascript
if (parsed[0][1] !== 'SFKp8c') continue;
const payload = JSON.parse(parsed[0][2]);
```

---

## 5. 機能別仕様

### 5.1 アルバム一覧取得

**RPC ID**: `Z5xsfc`

**実行方法**: WebView injectJavaScript（`generateGetAlbumsScript`）

**source-path**: `/u/0/photos`（通常パス）

**ペイロード**:
```javascript
// [pageId, null, null, null, 1, null, null, pageSize, [2], 5]
const requestData = [null, null, null, null, 1, null, null, 100, [2], 5];
```

**レスポンスパース**:
```javascript
// data[0] = アルバムの配列
// 各アルバム itemData:
{
  mediaKey:           itemData?.[0],              // WebView上のID（AF1Qip...）
  thumb:              itemData?.[1]?.[0],          // サムネイルURLベース
  ownerActorId:       itemData?.[6]?.[0],
  // 拡張データ extData = itemData?.at(-1)?.[72930366]
  title:              extData?.[1],
  itemCount:          extData?.[3],
  isShared:           extData?.[4] || false,
  creationTimestamp:  extData?.[2]?.[4],
  modifiedTimestamp:  extData?.[2]?.[9],
  timestampRange:    [extData?.[2]?.[5], extData?.[2]?.[6]],
  shareableUrl:       extData?.[10] || null,       // 共有済みなら直接URL取得可
}
// data[1] = nextPageId（ページネーション用）
```

**重要な制約**:
- `Z5xsfc` は**共有済みアルバムのみ**を返す可能性が高い
- アプリで作成した未共有アルバムはここに現れないことがある
- この制約の回避策 → [5.2 アルバム作成] の楽観的更新を参照

**ソート順**:
```javascript
const sortedAlbums = [...parsed.items]
  .filter(album => album.title !== 'TestAlbum')
  .sort((a, b) => {
    if (a.isShared && !b.isShared) return -1;   // 共有済みを優先
    if (!a.isShared && b.isShared) return 1;
    return (b.modifiedTimestamp || 0) - (a.modifiedTimestamp || 0);
  });
```

**APP_CREATED_ALBUMS との照合**:
WebViewのmediaKeyとOAuth APIのalbumIdは**異なる形式**なので、
APP_CREATED_ALBUMSに登録されたアルバムを以下の順で照合する:
1. `albumData.mediaKey === album.mediaKey`（mediaKeyが保存済みなら確実）
2. `albumData.title === album.title`（フォールバック）

### 5.2 アルバム作成

**使用API**: 公式 Google Photos Library API（OAuth必須）

**フロー**:
```
1. createAlbum(accessToken, title)
   → POST https://photoslibrary.googleapis.com/v1/albums
   → レスポンス: { id: "APIアルバムID", title: "...", ... }

2. shareAlbum(accessToken, album.id)  [失敗しても続行]
   → POST https://photoslibrary.googleapis.com/v1/albums/{id}:share
   → 目的: 共有URLを取得（失敗することがある → 非公式APIで後から取得）

3. APP_CREATED_ALBUMSに保存
   key: album.id (OAuth APIのID)
   value: { title, originalTitle, shareableUrl, createdAt }

4. 楽観的更新: setAlbums(prev => [synthetic, ...prev])
   synthetic = { mediaKey: null, title, apiAlbumId: album.id, createdByApp: true, itemCount: 0 }

5. Alert OK → リフレッシュしない（synthetic が消えないよう）
```

**mediaKey の後付け保存**:
`selectAlbum()` 実行時に、WebViewから取得したmediaKeyをAPP_CREATED_ALBUMSに追記。
次回以降の照合は mediaKey で確実に行える。

**shareAlbum が 403 PERMISSION_DENIED になる場合**:
アルバムが非共有のままになる。非公式API（SFKp8c）で共有リンクを後から作成可能。

### 5.3 写真表示（アルバム内）

**RPC ID**: `snAcKc`

**実行方法**: WebView injectJavaScript（`generateGetAlbumPageScript`）

**ペイロード**:
```javascript
// [albumMediaKey, pageId, null, authKey]
const requestData = [albumMediaKey, null, null, authKey];
```

**レスポンスパース**:
```javascript
// data[1] = メディアアイテムの配列
// data[2] = nextPageId
// data[3] = アルバム情報
{
  items: data?.[1]?.map(item => parseMediaItem(item)),
  nextPageId: data?.[2],
  mediaKey: albumInfo?.[0],
  title: albumInfo?.[1],
  itemCount: albumInfo?.[21],
  authKey: albumInfo?.[19],
  owner: {
    actorId: owner?.[0],
    gaiaId:  owner?.[1],
    name:    owner?.[11]?.[0],
    profilePhotoUrl: owner?.[12]?.[0],
  },
}
```

**メディアアイテムのパース**:
```javascript
function parseMediaItem(itemData) {
  return {
    mediaKey:          itemData?.[0],
    thumb:             itemData?.[1]?.[0],
    resWidth:          itemData?.[1]?.[1],
    resHeight:         itemData?.[1]?.[2],
    timestamp:         itemData?.[2],               // ミリ秒タイムスタンプ
    dedupKey:          itemData?.[3],               // 削除・復元に必要
    timezoneOffset:    itemData?.[4],
    creationTimestamp: itemData?.[5],
    isLivePhoto:       itemData?.at(-1)?.[146008172] ? true : false,
    livePhotoDuration: itemData?.at(-1)?.[146008172]?.[1],
    duration:          itemData?.at(-1)?.[76647426]?.[0],  // 動画のみ（秒）
    descriptionShort:  itemData?.at(-1)?.[396644657]?.[0],
    isArchived:        itemData?.[13],
    isFavorite:        itemData?.at(-1)?.[163238866]?.[0],
    geoLocation: {
      coordinates: itemData?.at(-1)?.[129168200]?.[1]?.[0],
      name:        itemData?.at(-1)?.[129168200]?.[1]?.[4]?.[0]?.[1]?.[0]?.[0],
    },
  };
}
```

**サムネイルURL生成**:
```javascript
// baseThumb = "https://lh3.googleusercontent.com/xxx=..."
const baseUrl = baseThumb.split('=')[0];
const thumbUrl = `${baseUrl}=w200-h200-c`;    // クロップあり
const fullUrl  = `${baseUrl}=w4096-h4096`;    // フルサイズ
const videoUrl = `${baseUrl}=dv`;             // 動画再生URL
const origUrl  = `${baseUrl}=d`;              // オリジナルサイズ
```

**ローカルURI（アップロード直後の楽観的更新）の扱い**:
`file://` または `ph://` で始まるURIはそのまま返す（URLビルドをスキップ）。

**動画判定**:
```javascript
export function isVideoItem(item) {
  return item?.duration != null && item.duration > 0;
}
```

**日付グループ化**:
写真を `timestamp` または `creationTimestamp` の日付でグループ化し、
`SectionList` で表示。各グループのタイトルは日本語フォーマット（例: `4月1日(火)`）。

**楽観的更新保護**:
アップロード後に `hasOptimisticUpdate.current = true` をセット。
`onRefresh` と `loadPhotosFromAlbum` がこのフラグを確認し、
楽観的更新中はリロードをスキップする。

### 5.4 写真削除・ゴミ箱

**削除（ゴミ箱移動）**:
- RPC ID: `XwAOJf`（`TRASH_OPERATIONS`）
- 実行方法: native fetch（sessionManager経由）
- source-path: `/u/0/photos`

**ペイロード（ゴミ箱移動）**:
```javascript
// [null, 1, dedupKeys, 3]
// 1 = 削除操作、3 = 固定値
const requestData = [null, 1, dedupKeys, 3];
```

**ペイロード（復元）**:
```javascript
// [null, 3, dedupKeys, 2]
const requestData = [null, 3, dedupKeys, 2];
```

**ペイロード（完全削除）**:
```javascript
// [null, 2, dedupKeys, 2]
const requestData = [null, 2, dedupKeys, 2];
```

**重要: dedupKey が必要（mediaKey ではない）**

`dedupKey` = `itemData?.[3]` でパースされる文字列。
ゴミ箱一覧（`zy0lHe`）のレスポンスも `data[3]` にdedupKeyを持つ。

**バッチ処理**: 一度に50件まで。50件超は `moveItemsToTrashBatch()` で50件ずつ分割。

**削除後の表示**:
`onRefresh()` を呼ばず、ローカルstateから直接除去する（リロードすると削除が反映される前に再取得する可能性があるため）。

**ゴミ箱一覧取得**:
- RPC ID: `zy0lHe`
- source-path: `/trash`
- ペイロード: `[]`（空配列）

**ゴミ箱アイテムのパース**:
```javascript
// レスポンス構造:
// [[["AF1Qip...", ["https://...", w, h, ...], timestamp, "dedupKey", tzOffset, deletedTimestamp, ...]]]
{
  mediaKey:        data[0],
  thumb:           data[1]?.[0],
  resWidth:        data[1]?.[1],
  resHeight:       data[1]?.[2],
  timestamp:       data[2],
  dedupKey:        data[3],
  timezoneOffset:  data[4],
  deletedTimestamp: data[5],
}
```

**mediaKeyからdedupKeyを取得**（ゴミ箱復元前の前処理）:
- RPC ID: `VrseUb`
- ペイロード: `[mediaKey, null, null, 1]`
- source-path: `/trash/{mediaKey}`
- レスポンス: `response?.[0]?.[3]` = dedupKey

### 5.5 お気に入り

お気に入りはローカルのみで管理する（`favoritesService.js`）。
`@photov_favorites` キーに mediaKey の配列を保存。
Google Photos側のお気に入りフラグ（`isFavorite: itemData?.at(-1)?.[163238866]?.[0]`）は
読み取り専用で表示に使用する。

### 5.6 共有リンク作成（最も詳細）

#### フロー全体

```
handleCopyShareLink(album)
├── album.shareableUrl あり → Clipboard.setStringAsync() で直接コピー
├── APP_CREATED_ALBUMS[album.apiAlbumId].shareableUrl あり → コピー
└── どちらもなし:
    ├── album.mediaKey なし → エラー（操作不可）
    └── WebView経由でSFKp8c実行 → payload[1] をコピー
```

#### ✅ 正解: SFKp8c（WebView経由）

**確認方法**: PC Chrome DevTools Network タブで Google Photos の「リンクを作成」ボタンを押した際の通信を解析（2026-04-01）。

**RPC ID**: `SFKp8c`

**エンドポイント**: `https://photos.google.com/u/0/_/PhotosUi/data/batchexecute`（`/u/0/` が必須）

**URLパラメータ**:
```
rpcids=SFKp8c
source-path=/u/0/albums
f.sid={sid}
bl={bl}
soc-app=165
soc-platform=1
soc-device=1
rt=c
```

**ペイロード**:
```javascript
const sfkPayload = [
  null, null,
  [null,1,null,null,1,null,[[[1,1],1],[[1,2],1],[[2,1],1],[[2,2],1],[[3,1],1]],null,null,null,null,null,null,[1,2]],
  [1,[[albumMediaKey],[1,2,3]],null,null,null,null,[1]],
  null, null, null, null,
  [1,2,3,5,6]
];
```

**albumMediaKey** = WebViewから取得したアルバムの `mediaKey`（`AF1Qip...` 形式の長いID）

**ヘッダー**（WebView内フェッチ）:
```javascript
headers: {
  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
  'x-same-domain': '1',
},
credentials: 'include',
```

**レスポンスパース**:
```javascript
// wrb.frラインを探す
for (const line of lines) {
  if (!line.includes('wrb.fr')) continue;
  const parsed = JSON.parse(line);
  if (parsed[0][1] !== 'SFKp8c') continue;
  const payload = JSON.parse(parsed[0][2]);
  // payload[0] = 共有後のアルバムID（AF1Qip...形式）
  // payload[1] = "https://photos.app.goo.gl/..." ← 欲しいURL
  // payload[4] = 別トークン
  const shareableUrl = payload[1]; // ここが重要
}
```

**実装場所**: `webViewApiClient.js` の `generateCreateShareLinkScript()`

#### 既存共有アルバムのURL取得

`Z5xsfc`（アルバム一覧）レスポンスの `extData?.[10]` に既存の共有URLが入っている。
これを `album.shareableUrl` として保持しておき、コピー時はSFKp8c不要。

#### ❌ 失敗した試みと理由

**yI1ii（v0.3.154〜157で試みた）**:
- `yI1ii` は「リンクを作成」ではなく別の用途（未特定）
- native fetch / WebView どちらで叩いても目的のURLは返らなかった
- 廃止されSFKp8cに置き換え（v0.3.158で修正）

**UJlKrf / wGF44d / CkpYK**:
- アルバム共有ページ（`/albums/{albumId}?key=XXX`）の**読み込み時**に発火するRPC
- 共有リンクを新規作成する機能ではなく、既存の共有状態を表示するためのもの
- 共有リンク作成とは無関係

**gJL1hd**:
- Service Worker が自動的に叩くUI状態同期RPC
- 「リンクを作成」ボタンとは**因果関係なし**
- SFKp8c の完了後にService Workerが自動的に発火するだけ

**native fetch で /u/0/ エンドポイントを叩く**:
- `HTTP 403 INVALID_ARGUMENT`
- WebViewのCookieがないため認証失敗
- WebView injectJavaScript パターンが必須

#### 実際のネットワークフロー（PC解析確認）

1. ユーザーが「リンクを作成」ボタンを押す
2. `SFKp8c` が発火（約0.2秒でURL生成）
3. レスポンスに `photos.app.goo.gl` URLが直接含まれる
4. URLをそのまま画面に表示（gJL1hdは後からService Workerが発火するだけ）
5. URLコピーボタンはネットワークリクエストなし（既にレスポンス済み）

### 5.7 アルバム削除

**RPC ID**: `nV6Qv`（実機Network検証済み 2026-02-25）

**実行方法**: native fetch（sessionManager経由、`makeApiRequest`）

**source-path**: `/albums`

**ペイロード**:
```javascript
// [null, null, [[apiAlbumId, null, 1]]]
// apiAlbumId = OAuth APIが返すID（"AFS..." 形式）
// 1 = アルバム一覧からの削除コンテキスト（2はアルバム内からでも動作）
const requestData = [null, null, [[apiAlbumId, null, 1]]];
```

**注意**: レスポンスにペイロードがない（空レスポンス）= 成功と判断する:
```javascript
} catch (error) {
  if (error.message.includes('ペイロードがありません') ||
      error.message.includes('wrb.fr エンベロープが見つかりません') ||
      error.message.includes('空のレスポンス')) {
    return null; // 成功
  }
  throw error;
}
```

**削除後の処理**:
1. `APP_CREATED_ALBUMS` から該当エントリを削除
2. `SELECTED_ALBUM` が同じアルバムなら削除
3. ローカルstateから除去（`setAlbums(prev => prev.filter(...))`）
4. `DELETED_ALBUMS` にmediaKeyを追加（次回リフレッシュ時に復活しないよう）
5. Alert表示後、リフレッシュ**しない**（WebViewキャッシュが古いデータを返すと削除が取り消されることがある）

### 5.8 アップロード

**フロー**（googleAuthService.js の `uploadToGooglePhotos`）:

```
Step 1: ファイルをblobとしてフェッチ
  fetch(fileUri) → blob

Step 2: Google Photos にblobをアップロード → uploadToken取得
  POST https://photoslibrary.googleapis.com/v1/uploads
  Headers:
    Authorization: Bearer {accessToken}
    Content-Type: application/octet-stream
    X-Goog-Upload-Content-Type: image/jpeg
    X-Goog-Upload-Protocol: raw
  Body: blob
  Response: uploadToken (文字列)

Step 3: mediaItemを作成（アルバムIDなし）
  POST https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate
  Body: { newMediaItems: [{ simpleMediaItem: { uploadToken } }] }
  Response: { newMediaItemResults: [{ mediaItem: { id: "..." } }] }

Step 4: アルバムに追加（albumIdがある場合）
  POST https://photoslibrary.googleapis.com/v1/albums/{albumId}:batchAddMediaItems
  Body: { mediaItemIds: [mediaItemId] }
```

**楽観的更新**（HomeWebScreen.js）:
アップロード完了後、`hasOptimisticUpdate.current = true` をセットして
ローカルstateに仮写真オブジェクトを先頭に追加。
実際のリロードは遅延させ、表示が消えないよう保護する。

---

## 6. データ管理（AsyncStorage）

| キー | 型 | 内容 |
|------|-----|------|
| `@photov_session_data` | `{ wizData, savedAt }` | WebViewセッション（30日有効） |
| `@photov_selected_album` | `{ mediaKey, title, authKey, apiAlbumId }` | 現在選択中のアルバム |
| `@photov_google_auth` | `{ accessToken, expiresAt }` | OAuthアクセストークン |
| `@photov_app_created_albums` | `{ [apiAlbumId]: AlbumData }` | アプリで作成したアルバムの管理情報 |
| `@photov_deleted_albums` | `string[]` | 削除済みアルバムのmediaKey（復活防止） |
| `@photov_favorites` | `string[]` | お気に入りのmediaKey配列 |
| `@photov_debug_log` | `LogEntry[]` | デバッグログ（最新100件） |
| `@photov_auth_mode` | `'web' \| 'oauth'` | 認証方式（デフォルト: `'web'`） |

### APP_CREATED_ALBUMS の構造

```javascript
// キー: OAuth APIのアルバムID（例: "AFS4oXXXXXXXXXX..."）
// 値:
{
  title: string,           // 現在のタイトル
  originalTitle: string,   // 作成時のタイトル（リネーム前）
  shareableUrl: string | null,  // 共有URL（取得済みなら）
  mediaKey: string | null, // WebView APIのmediaKey（selectAlbum時に追記）
  createdAt: string,       // ISO 8601 形式
}
```

**旧構造からの移行**: `migrateAppCreatedAlbums()` を参照（旧: タイトルがキー → 新: apiAlbumIdがキー）。

### apiAlbumId と mediaKey の違い

| 属性 | apiAlbumId | mediaKey |
|------|-----------|----------|
| 形式 | OAuth APIが返すID（文字列） | 非公式WebAPIのID（`AF1Qip...`） |
| 取得元 | `createAlbum()` レスポンスの `.id` | `Z5xsfc` レスポンスの `itemData[0]` |
| 用途 | アップロード・リネーム・削除（RPC nV6Qv） | snAcKc・共有リンク作成（SFKp8c） |
| 照合 | APP_CREATED_ALBUMSのキー | listAlbumsレスポンスで取得 |

### selectAlbum のフォールバックチェーン

アルバムのapiAlbumIdを特定するために以下の順で試みる:

1. `album.apiAlbumId`（既に付与されている）
2. `APP_CREATED_ALBUMS` のタイトル照合
3. OAuth API `listAlbums` で検索（Fallback 1）
4. 既存の `SELECTED_ALBUM` から同名アルバムのIDを引き継ぐ（Fallback 2）
5. apiAlbumIdが見つかれば `APP_CREATED_ALBUMS` にmediaKeyを追記

---

## 7. 既知の制限と回避策

### 7.1 Z5xsfc が未共有アルバムを返さない

**問題**: `listAlbums`（`Z5xsfc`）は共有済みアルバムのみを返す場合がある。
アプリで作成した未共有アルバムは取得できない。

**回避策**: 楽観的更新（作成直後にsynthetic albumをリスト先頭に追加）。
Alert OK後もリフレッシュしない。

### 7.2 APP_CREATED_ALBUMS が消えることがある

**問題**: 端末変更・アプリ再インストール・AsyncStorageクリアで情報が失われる。

**回避策**: Fallback 2（`SELECTED_ALBUM`から同名アルバムのIDを引き継ぐ）。

### 7.3 OAuthトークン切れ時の操作不可

**問題**: アップロード・リネーム・アルバム作成等のOAuth操作ができなくなる。

**回避策**: アクセス要求時に自動でOAuthフローを再起動する。
`getStoredAuth()` が null を返したら `promptGoogleAsync()` を呼ぶ。

### 7.4 ゴミ箱復元後の自動リロードなし

**問題**: 復元後にTrashWebScreenが自動更新されない。

**対応状況**: 未解決（v0.3.159現在）。ユーザーが手動でPull-to-Refreshする必要がある。

### 7.5 listAlbums APIが0件を返す

**発生条件**: OAuthの `listAlbums` が0件を返すことがある（スコープ不足等）。

**回避策**: Fallback 2（既存の `SELECTED_ALBUM` から引き継ぎ）で実害を回避済み。

---

## 8. 実装の注意事項（やってはいけないこと）

### ❌ native fetch で `/u/0/_/PhotosUi/` を叩く

結果: `HTTP 403 INVALID_ARGUMENT`
理由: WebViewのCookieが必要なエンドポイント
対策: WebView `injectJavaScript` で実行する

### ❌ yI1ii を共有リンク作成に使う

結果: 共有URLが返らない
理由: yI1ii は別用途のRPC（共有リンク作成ではない）
対策: SFKp8c を使う

### ❌ gJL1hd / UJlKrf / wGF44d / CkpYK を「共有リンク作成」として実装する

結果: 共有URLが得られない
理由: これらはページロード時に発火するUI同期RPCであり、リンク作成とは無関係
対策: SFKp8c のみを使う

### ❌ 削除後に onRefresh を呼ぶ

結果: 削除した写真が復活して表示される
理由: WebViewのキャッシュが古いデータを返すことがある
対策: ローカルstateから直接除去する

### ❌ アルバム削除後に onRefresh を呼ぶ

結果: 削除したアルバムが復活して表示される
理由: 上記と同様
対策: ローカルstateから直接除去し、DELETED_ALBUMSに追加

### ❌ アップロード後にすぐ onRefresh を呼ぶ

結果: 楽観的更新で表示した写真が消える
理由: Google Photos側の処理が完了する前にリフレッシュすると古い一覧が返る
対策: `hasOptimisticUpdate.current` フラグでリフレッシュをブロック

### ❌ WebViewのCookieなしでセッション抽出を試みる

結果: WIZ_global_data が取得できず、セッションが無効になる
理由: WebViewは `incognito: false`、`sharedCookiesEnabled: true` が必須
対策: WebViewの設定を正しく行う

### ❌ 動画URLに `=w4096-h4096` を付ける

結果: 動画が再生できない
理由: 動画用URLは `=dv` サフィックスが必要
対策: `isVideoItem()` で判定し、`getVideoUrl()` を使う

---

## 9. RPC一覧（ペイロード・レスポンス構造）

| RPC ID | 機能 | source-path | 実行方法 |
|--------|------|-------------|---------|
| `Z5xsfc` | アルバム一覧取得 | `/u/0/photos` | WebView inject |
| `snAcKc` | アルバム内写真取得 | `/u/0/photos` | WebView inject |
| `lcxiM` | タイムライン取得 | `/u/0/photos` | WebView inject / native |
| `EzkLib` | アップロード順取得 | `/u/0/photos` | native |
| `XwAOJf` | 削除・復元・完全削除 | `/u/0/photos` / `/trash` | native |
| `zy0lHe` | ゴミ箱一覧取得 | `/trash` | native |
| `VrseUb` | 写真詳細取得（dedupKey取得） | `/trash/{mediaKey}` | native |
| `nV6Qv` | アルバム削除 | `/albums` | native |
| `SFKp8c` | 共有リンク作成 | `/u/0/albums` | WebView inject（必須） |
| `F2A0H` | 共有リンク一覧 | `/u/0/photos` | native |

### Z5xsfc（アルバム一覧取得）

```javascript
// ペイロード
[pageId, null, null, null, 1, null, null, pageSize, [2], 5]
// 例: [null, null, null, null, 1, null, null, 100, [2], 5]

// レスポンス
data[0]  // アルバム配列
data[1]  // nextPageId

// アルバム構造
itemData[0]                      // mediaKey
itemData[1][0]                   // サムネイルURLベース
itemData[6][0]                   // ownerActorId
itemData.at(-1)[72930366][1]    // title
itemData.at(-1)[72930366][3]    // itemCount
itemData.at(-1)[72930366][4]    // isShared
itemData.at(-1)[72930366][10]   // shareableUrl（共有済みのみ）
itemData.at(-1)[72930366][2][4] // creationTimestamp
itemData.at(-1)[72930366][2][9] // modifiedTimestamp
```

### snAcKc（アルバム内写真取得）

```javascript
// ペイロード
[albumMediaKey, pageId, null, authKey]

// レスポンス
data[1]     // メディアアイテム配列
data[2]     // nextPageId
data[3][0]  // アルバムmediaKey
data[3][1]  // アルバムタイトル
data[3][19] // authKey
data[3][21] // itemCount

// メディアアイテム構造
itemData[0]                         // mediaKey
itemData[1][0]                      // サムネイルURLベース
itemData[1][1]                      // 幅
itemData[1][2]                      // 高さ
itemData[2]                         // timestamp
itemData[3]                         // dedupKey
itemData[4]                         // timezoneOffset
itemData[5]                         // creationTimestamp
itemData[13]                        // isArchived
itemData.at(-1)[76647426][0]        // duration (動画)
itemData.at(-1)[146008172]          // LivePhotoデータ
itemData.at(-1)[163238866][0]       // isFavorite
itemData.at(-1)[396644657][0]       // descriptionShort
itemData.at(-1)[129168200][1][0]    // GPS座標
```

### XwAOJf（ゴミ箱移動・復元・完全削除）

```javascript
// ゴミ箱移動（削除）
[null, 1, dedupKeys, 3]

// 復元
[null, 3, dedupKeys, 2]   // source-path: /u/0/photos

// 完全削除
[null, 2, dedupKeys, 2]   // source-path: /u/0/photos
```

### zy0lHe（ゴミ箱一覧取得）

```javascript
// ペイロード: 空配列
[]

// source-path: /trash

// レスポンス構造
// [[[item1], [item2], ...]]
// 各item:
data[0]  // mediaKey
data[1]  // [サムネイルURL, 幅, 高さ, ...]
data[2]  // timestamp
data[3]  // dedupKey
data[4]  // timezoneOffset
data[5]  // deletedTimestamp
```

### VrseUb（写真詳細取得）

```javascript
// ペイロード
[mediaKey, null, null, 1]

// source-path: /trash/{mediaKey}

// レスポンス
response[0][3]  // dedupKey
```

### nV6Qv（アルバム削除）

```javascript
// ペイロード
[null, null, [[apiAlbumId, null, 1]]]

// source-path: /albums

// レスポンス: 空（ペイロードなし = 成功）
```

### SFKp8c（共有リンク作成）

```javascript
// ペイロード（albumMediaKeyを埋め込む）
[
  null, null,
  [null,1,null,null,1,null,[[[1,1],1],[[1,2],1],[[2,1],1],[[2,2],1],[[3,1],1]],null,null,null,null,null,null,[1,2]],
  [1,[[albumMediaKey],[1,2,3]],null,null,null,null,[1]],
  null, null, null, null,
  [1,2,3,5,6]
]

// エンドポイント: /u/0/_/PhotosUi/data/batchexecute
// source-path: /u/0/albums
// 追加URLパラメータ: soc-app=165, soc-platform=1, soc-device=1

// レスポンスのペイロード
payload[0]  // 共有後アルバムID（AF1Qip...）
payload[1]  // "https://photos.app.goo.gl/..." ← 欲しいURL
payload[4]  // 別トークン
```

---

## 10. 仕様候補（未実装の改善案）

### 10.1 APP_CREATED_ALBUMS のorphan追加

手動リフレッシュ後も未共有アルバムが消えないようにする。

```javascript
// loadAlbums() 内、sortedAlbums 確定後に追加
const matchedApiAlbumIds = new Set(sortedAlbums.map(a => a.apiAlbumId).filter(Boolean));
for (const apiAlbumId of apiAlbumIds) {
  if (!matchedApiAlbumIds.has(apiAlbumId)) {
    const albumData = appCreatedAlbums[apiAlbumId];
    sortedAlbums.push({
      mediaKey: albumData.mediaKey || null,
      title: albumData.title,
      apiAlbumId,
      createdByApp: true,
      itemCount: 0,
      isShared: false,
    });
  }
}
```

**メリット**: 手動リフレッシュ後も未共有アルバムが残る  
**デメリット**: Google Photos で削除済みアルバムが残骸として表示される可能性あり（DELETED_ALBUMSで除外は可能）

### 10.2 OAuthトークンの自動リフレッシュ

現状はトークン切れ時に手動で再認証が必要。
`expo-auth-session` の refresh token flow を使えば自動更新できる。

### 10.3 ゴミ箱復元後の自動リロード

復元後に `TrashWebScreen` の写真リストを自動更新する。

### 10.4 バックグラウンドセッション更新の強化

現状は1時間ごとに非表示WebViewで更新するが、
30日間の有効期限切れ検知と再ログイン誘導のUIを追加する。
