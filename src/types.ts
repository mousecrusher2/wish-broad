// 共通の型定義

export interface User {
  userId: string;
  displayName: string;
}

export type AuthState =
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: User }
  | { status: "error"; message?: string };

export interface WHEPPlayerProps {
  user: User;
}

export type Live = {
  owner: User;
};
