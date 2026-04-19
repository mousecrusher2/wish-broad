export type JWTPayload = {
  iat: number;
  exp: number;
  userId: string;
  displayName: string;
};

export type Bindings = CloudflareBindings;
