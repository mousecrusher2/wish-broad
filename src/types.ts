// 共通の型定義

export interface User {
  userId: string;
  displayName: string;
}

export interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

export interface WHEPPlayerProps {
  user: User;
}

export type Live = {
  owner: User;
};
