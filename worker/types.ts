export type JWTPayload = {
  iat: number;
  exp: number;
  userId: string;
  displayName: string;
};

export type Bindings = CloudflareBindings;

/** ルートとミドルウェアが共有する Hono の環境。`jwtPayload` はアプリの JWT 認証を通ったルートでのみ設定される。 */
export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    jwtPayload: JWTPayload;
  };
};
