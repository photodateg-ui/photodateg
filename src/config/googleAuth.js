// Google Photos API認証設定
// Google Cloud Console: https://console.cloud.google.com/apis/credentials

export const GOOGLE_AUTH_CONFIG = {
  // ウェブ用クライアントID（Expo Go開発用）
  webClientId: '483467707926-c5hljat3427q2cn7ip8u7c7lrf39f6df.apps.googleusercontent.com',

  // iOS用クライアントID（スタンドアロンビルド用）
  iosClientId: '483467707926-haidkv7t2d0vg3pgk7ushjkovvqukdn5.apps.googleusercontent.com',

  // iOS用リダイレクトURI
  iosRedirectUri: 'com.googleusercontent.apps.483467707926-haidkv7t2d0vg3pgk7ushjkovvqukdn5:/oauth2redirect',

  // Expo Go用リダイレクトURI
  expoRedirectUri: 'https://auth.expo.io/@photodateg-ui/photodateg',

  // Google Photos Picker APIスコープ
  // Library APIは廃止方向のため、Picker APIを使用
  scopes: [
    'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
  ],
  
  // OAuth 2.0 エンドポイント
  discovery: {
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
  },
};
