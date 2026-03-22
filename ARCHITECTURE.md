# アーキテクチャ仕様書

---

## 📸 写真一覧表示の仕組み

- **非表示 WebView を裏で常駐させる理由**：Google フォトの公式 API は写真閲覧のスコープが制限されており、一覧取得に非公式 API を使う必要がある。そのためブラウザと同じログイン状態（Cookie セッション）を維持するために WebView を動かし続けている
- **非公式 Web API とは**：Google フォトをブラウザで開いたときに裏で走っている通信をそのまま再現したもの。認証トークンではなく Cookie で動く。`googlePhotosWebApi.js` が担当
- **サムネイル URL の末尾パラメータ**：Google フォトの画像 URL は末尾のパラメータで解像度や切り抜きを指定できる。一覧表示は `=w200-h200-c`（200×200 にクロップ）、動画は `=dv`（動画ファイル本体）を使用
- **サムネイルの表示には `expo-image` を使用**：React Native 標準の `Image` よりキャッシュが高性能で、`cachePolicy="memory-disk"` でメモリとディスク両方にキャッシュする

---

## 🔍 写真詳細表示（タップして開く）

- **使用ライブラリ**：`react-native-image-zoom-viewer`（ピンチズーム・スワイプ切り替え）、`react-native-gesture-handler`（ジェスチャー制御）
- **オリジナルサイズで表示**：URL 末尾を `=d`（ダウンロード品質＝制限なし）にすることでオリジナル解像度の画像を取得
- **前後の写真をプリロード**：現在表示中の写真を中心に前後2枚ずつ（計4枚）を `Image.prefetch()` で先読み
- **動画の場合**：`=dv` URL を WebView に読み込んで再生
- **下スワイプで戻る**：`react-native-gesture-handler` の Gesture API で下方向スワイプを検知

---

## ⬇️ ダウンロード（カメラロールへ保存）

- **使用ライブラリ**：`expo-file-system`（ファイルのダウンロード・一時保存）、`expo-media-library`（カメラロールへの書き込み）
- **ファイル名**：撮影日時から `PhotoDateG_2024-01-15_12-30-00.jpg` 形式で生成
- **EXIF 情報の書き込み**：`@lodev09/react-native-exify` を使用。`DateTimeOriginal` と `DateTime` を書き込む（フォーマットは `YYYY:MM:DD HH:MM:SS`）
- **動画は EXIF 書き込みをスキップ**：EXIF は静止画専用の規格
- **処理の流れ**：一時ディレクトリにダウンロード → EXIF 書き込み → カメラロールに保存 → 一時ファイル削除

---

## ⬆️ アップロードの仕組み（2ステップ構成・変更禁止）

- **写真選択には `expo-image-picker` を使用**：複数選択可、`quality: 1`（無劣化）、`exif: true`（EXIF 情報も取得）
- **なぜ2ステップに分けるか**：Google Photos API の仕様で「アップロードとアルバム追加を同時に行う方式」はエラーになる。一度ライブラリにアップロードしてから別途アルバムに追加する2段階が唯一の正解
  - Step 3：`/v1/mediaItems:batchCreate`（albumId を渡さない）
  - Step 4：`/v1/albums/${albumId}:batchAddMediaItems`（後からアルバムに追加）
- **楽観的更新**：API の完了を待たずにアップロードした写真を即座に画面の先頭に表示
- **hasOptimisticUpdate フラグ**：アップロード直後は Google Photos API に写真がまだ反映されていないため、このフラグが `true` の間は「0件で現在表示中の写真を上書きしない」保護として機能

---

## 📅 日付問題と回避策

**問題の原因**：Google Photos API の `batchCreate` でアップロードされた写真は、EXIF が欠落していたりファイルが再エンコードされて EXIF が消えると、アップロード日時を `creationTime` として設定してしまう。

**回避策（現在の実装）**：
```javascript
// Step 1: EXIF情報付きで写真を選択
const result = await ImagePicker.launchImageLibraryAsync({
  quality: 1,   // ← 無劣化
  exif: true,   // ← EXIF情報を取得
});

// Step 2: アップロード前にEXIFを書き戻す（v0.3.77で追加）
const { Exify } = require('@lodev09/react-native-exify');
await Exify.write(asset.uri, {
  DateTimeOriginal: asset.exif.DateTimeOriginal,
  DateTime: asset.exif.DateTime,
});
```

- `quality: 1` と `exif: true` だけでは不十分（iOSがファイルコピー時にEXIFを消すことがある）
- **v0.3.77で追加**：ImagePickerが取得したEXIFデータを、`@lodev09/react-native-exify`で明示的にファイルに書き戻す
- これにより Google Photos が正しい撮影日を設定できる

---

## 🗑️ 削除の仕組み（変更禁止）

- **なぜ非公式 API を使うか**：Google Photos 公式 API では「このアプリがアップロードした写真しか削除できない」という制限がある。非公式 API（`moveItemsToTrash`）はその制限がなくどの写真でもゴミ箱に移せる
- **dedupKey とは**：Google フォト内部で写真を識別するキー。表示用の `mediaKey` や公式 API の `mediaItemId` とは別物で、削除 API に渡すのはこの `dedupKey` のみ
- **削除後にリロードしない理由**：削除後すぐに `onRefresh()` を呼ぶと WebView がまだ削除前のデータを返す→写真が復活→無限ループになる。そのため state から直接取り除いて完了とし、リロードは行わない

---

## 🗂️ アルバム管理の仕組み

- **APP_CREATED_ALBUMS**：このアプリで新規作成したアルバムの `apiAlbumId` を端末の AsyncStorage に保存
- **SELECTED_ALBUM**：現在選択中のアルバム情報を端末に保存
- **なぜ listAlbums API が使えないか**：Google Photos API のスコープ制限により、アルバム一覧の取得が常に 0件返る
- **DELETED_ALBUMS**：削除済みアルバムのmediaKeyリスト。`loadAlbums`の結果からフィルタリングして復活を防止。画面遷移でstateがリセットされても、古いデータから削除済みアルバムが復活しない
- **Fallback 2 の役割**：アルバム選択画面でアルバムを選び直すと、`APP_CREATED_ALBUMS` が空の場合に `apiAlbumId` が null で上書きされるバグがある。これを防ぐため「同じ名前のアルバムを選んだとき、すでに保存済みの apiAlbumId をそのまま引き継ぐ」仕組み

---

## 🔄 リフレッシュの仕組み（2026-03-22 追加）

### WebView配置の注意点

- **メインreturn文にもWebViewが必要**：ローディング/エラー状態以外でもリフレッシュするため
- **WebViewは画面外に配置する**：レイアウトに影響させないため、`position: absolute, top: -9999, left: -9999` で画面外に配置
- **cacheEnabled={false}**：リフレッシュ時に最新データを取得するため、キャッシュを無効化
- **webViewKeyでWebViewを再作成**：リフレッシュ時に `setWebViewKey(prev => prev + 1)` でキーを変更し、WebViewを完全に再作成することでキャッシュ問題を回避

### アルバム削除後の挙動

- **削除後はonRefresh()を呼ばない**：写真削除と同様、WebViewキャッシュが古いデータを返すとアルバムが復活するため
- **stateから直接削除**：`setAlbums(prev => prev.filter(...))` で即座に画面から消す

---

## 🔑 認証・セッション（2本立て）

- **Google OAuth（accessToken）の役割**：公式 Google Photos API（アップロード・アルバム作成・アルバム名変更）を呼ぶための認証トークン。有効期限あり（通常1時間）
- **WebView セッション（Cookie）の役割**：非公式 API（写真一覧取得・削除）を使うための Google ログイン状態

---

## 📦 主要ライブラリ一覧

| ライブラリ | 役割 |
|------------|------|
| expo-image | 高性能キャッシュ付き画像表示 |
| react-native-webview | Google フォトの非表示セッション維持 |
| react-native-image-zoom-viewer | 詳細画面のピンチズーム・スワイプ切り替え |
| react-native-gesture-handler | 下スワイプで戻るなどのジェスチャー制御 |
| @lodev09/react-native-exify | ダウンロード時の EXIF 日時書き込み |
| expo-image-picker | アップロード用の写真・動画選択 |
| expo-file-system | ファイルのダウンロード・一時保存・削除 |
| expo-media-library | カメラロールへの保存・権限管理 |
| @react-native-async-storage/async-storage | アルバム情報・セッションの端末保存 |

---

## ⚠️ 絶対に変えてはいけない箇所

1. **performDelete の内部ロジック一切**（dedupKey の扱い・state の直接更新・リロードなし）
2. **batchCreate → batchAddMediaItems の2ステップ構成**（順番も分離も変えない）
3. **selectAlbum の Fallback 2 ブロック**（apiAlbumId の引き継ぎ）
4. **削除後の onRefresh コメントアウト**（外すと無限ループ）
5. **hasOptimisticUpdate の0件保護ロジック**（3箇所）
6. **quality: 1 と exif: true**（日付がアップロード日になる問題を防止）
7. **WebViewの画面外配置**（`top: -9999, left: -9999`、レイアウト崩れ防止）
8. **アルバム削除後のリロード禁止**（復活バグ防止）
9. **DELETED_ALBUMSによるフィルタリング**（画面遷移後も削除済みアルバムが復活しない）

---

---

## 📷 アップロード直後の詳細表示（2026-03-23 追加・v0.3.95確定）

### 問題の背景

Google Photos APIの`batchCreate`レスポンスには`baseUrl`が含まれないことがある。`baseUrl`がない場合、楽観的更新で追加した写真の`thumb`にはローカルURI（`file://...`）が設定される。

### 以前の問題

詳細画面（`PhotoDetailWebScreen.js`）では、`getFullSizeUrl(photo.thumb)`でURLを生成していた。この関数は`thumb.split('=')[0]`でベースURLを取得していたが、ローカルURIには`=`が含まれないため、無効なURLが生成されて真っ黒になっていた。

### 解決策（v0.3.95）

`getFullSizeUrl`と`getVideoUrl`でローカルURIを検出したら、パラメータを追加せずそのまま返すように修正：

```javascript
export function getFullSizeUrl(baseThumb, maxWidth = 4096, maxHeight = 4096) {
  if (!baseThumb) return null;
  
  // ローカルURIはそのまま返す
  if (baseThumb.startsWith('file://') || baseThumb.startsWith('content://') || baseThumb.startsWith('ph://')) {
    return baseThumb;
  }
  
  const baseUrl = baseThumb.split('=')[0];
  return `${baseUrl}=w${maxWidth}-h${maxHeight}`;
}
```

### 関連ファイル

- `src/services/googlePhotosWebApi.js` - `getFullSizeUrl`、`getVideoUrl`
- `src/screens/PhotoDetailWebScreen.js` - 詳細画面
- `src/screens/HomeWebScreen.js` - 楽観的更新でローカルURIを設定（1318行付近）

---

## 🗑️ ゴミ箱表示の仕組み（2026-03-23 追加・v0.3.94確定）

### 概要

ゴミ箱画面（`TrashWebScreen.js`）は、Google Photosのゴミ箱にある写真を一覧表示し、復元機能を提供する。

### なぜWebViewスクレイピングが必要か

- **公式APIにゴミ箱取得機能がない**：Google Photos APIにはゴミ箱の一覧を取得するエンドポイントが存在しない
- **非公式APIも不安定**：`getTrashItems`を試みたが、認証トークンの取得が困難で信頼性が低い
- **WebViewでページデータを抽出**：`https://photos.google.com/trash`をWebViewで開き、ページに埋め込まれた初期データをJavaScriptで抽出する

### データ抽出の仕組み（苦労ポイント）

Google Photosのページには`AF_initDataCallback`というスクリプトでデータが埋め込まれている。この中からゴミ箱アイテムを抽出する。

**v0.3.89〜v0.3.93で失敗した方法：**
- ❌ DOMの`img`要素から抽出 → Google Photosは遅延ロードのため、img要素が存在しない
- ❌ 背景画像から抽出 → 同様に要素が存在しない
- ❌ `AF1Qip`を雑に全部抽出 → セッションデータ等も拾って誤検出（黒い画像が表示される問題）
- ❌ 厳密なパターン`["AF1Qip...", "数字", null, "dedupKey"]` → 実際の構造と異なりマッチしない

**v0.3.94で成功した方法（パターン1）：**
```javascript
// パターン: ["AF1Qip...",["https://...
const pattern1 = /\["(AF1Qip[A-Za-z0-9_-]+)",\s*\["(https:\/\/[^"]+)"/g;
```

このパターンで、mediaKeyとサムネイルURLを同時に抽出できる。サムネイルURLはレスポンスに含まれている実際のURLを使用し、`=w256-h256-c`を付与してサイズ指定。

### データ構造

Google Photosのゴミ箱データは以下の構造：
```
["AF1QipXXXX...", ["https://lh3.googleusercontent.com/...", width, height, ...], timestamp, dedupKey, ...]
```

- `[0]`: mediaKey（AF1Qipで始まる識別子）
- `[1][0]`: サムネイルURL（lh3.googleusercontent.comドメイン）
- `[2]`: タイムスタンプ
- `[3]`: dedupKey（削除APIで使用）

### 注意点

1. **スクリプト二重実行対策**：WebViewの`onLoad`が複数回発火するため、`pendingRequest`でリクエストIDを管理し、古いレスポンスを無視
2. **サムネイルURLの形式**：URLに`=`が含まれていない場合のみ`=w256-h256-c`を付与
3. **デバッグ情報**：`af1qipCount`と`af1qipSample`でページ上のデータ量と形式を確認可能

### 画面構成

- **ヘッダー**：「← 戻る」「ゴミ箱」「選択」
- **グリッド表示**：3列、サムネイルは正方形
- **選択モード**：複数選択して一括復元可能
- **バージョン表示**：画面右下に`BUILD_VERSION`

---

## 🔧 バージョン管理の仕組み（2026-03-23 追加）

### BUILD_VERSION一括更新

各画面に`BUILD_VERSION`定数があり、OTAアップデート時に更新が必要。

**更新が必要なファイル：**
- `src/screens/HomeWebScreen.js`
- `src/screens/TrashWebScreen.js`
- `src/screens/AlbumSelectWebScreen.js`
- `src/screens/FavoritesWebScreen.js`
- `SESSION_STATE.md`

**一括更新スクリプト：**
```bash
./scripts/bump-version.sh v0.3.XX
```

このスクリプトで全ファイルのBUILD_VERSIONとSESSION_STATE.mdを一括更新できる。

---

## 📋 確定バージョン

**v0.3.67** (2026-03-22 確定)
RSさん確認済み：「アルバム一覧とか削除リロード関連は完璧っぽい」

**v0.3.94** (2026-03-23 確定)
RSさん確認済み：ゴミ箱表示機能復活、サムネイル正常表示、誤検出解消
