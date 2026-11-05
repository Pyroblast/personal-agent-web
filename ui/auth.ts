// The local app access token is separate from the server-only DeepSeek API key.
export const AUTH_KEY = "pa-mvp-token";
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function createCredentials(saved: StorageLike, legacy: StorageLike) {
  let candidate: string | null = null;
  const read = (s: StorageLike) => {
    try {
      return s.getItem(AUTH_KEY);
    } catch {
      return null;
    }
  };
  const remove = (s: StorageLike) => {
    try {
      s.removeItem(AUTH_KEY);
    } catch {}
  };
  const current = () => candidate ?? read(saved) ?? read(legacy) ?? "";
  return {
    current,
    offer(token: string) {
      candidate = token;
    },
    verified(token: string) {
      if (!token || current() !== token) return true;
      try {
        saved.setItem(AUTH_KEY, token);
        candidate = null;
        remove(legacy);
        return true;
      } catch {
        candidate = token;
        return false;
      }
    },
    rejected(token: string) {
      if (current() !== token) return;
      if (candidate === token) candidate = null;
      if (read(saved) === token) remove(saved);
      if (read(legacy) === token) remove(legacy);
    },
    forget() {
      candidate = null;
      remove(saved);
      remove(legacy);
    },
  };
}
