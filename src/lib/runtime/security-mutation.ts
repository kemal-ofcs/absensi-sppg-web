interface RuntimeNetworkState {
  isBrowser: boolean;
  isOnline: boolean;
}

function getRuntimeNetworkState(): RuntimeNetworkState {
  const isBrowser = typeof window !== "undefined";
  return {
    isBrowser,
    isOnline: !isBrowser || navigator.onLine !== false,
  };
}

export function assertOnlineSecurityMutation(
  message: string,
  runtime = getRuntimeNetworkState(),
) {
  if (runtime.isBrowser && !runtime.isOnline) {
    throw new Error(message);
  }
}
