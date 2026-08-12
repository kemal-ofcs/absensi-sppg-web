import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { User } from "../db/schema";

export type UserSession = Omit<User, "passwordHash">;

interface AppState {
  // Session
  user: UserSession | null;
  isAuthenticated: boolean;
  login: (user: UserSession) => void;
  logout: () => void;

  // Sync Status
  isSyncing: boolean;
  lastSync: Date | null;
  setSyncStatus: (status: boolean) => void;
  setLastSync: (date: Date) => void;
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      user: null,
      isAuthenticated: false,
      login: (user) => set({ user, isAuthenticated: true }),
      logout: () => set({ user: null, isAuthenticated: false }),

      isSyncing: false,
      lastSync: null,
      setSyncStatus: (status) => set({ isSyncing: status }),
      setLastSync: (date) => set({ lastSync: date }),
    }),
    {
      name: "hybrid-starter-storage",
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        lastSync: state.lastSync,
      }),
    },
  ),
);
