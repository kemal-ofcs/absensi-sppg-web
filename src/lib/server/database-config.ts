export interface ServerDatabaseEnvironment {
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  NODE_ENV?: string;
}

export interface ServerDatabaseConfig {
  url: string;
  authToken?: string;
  isRemote: boolean;
}

export function resolveServerDatabaseConfig(
  environment: ServerDatabaseEnvironment,
): ServerDatabaseConfig {
  const url = environment.TURSO_DATABASE_URL?.trim();
  const authToken = environment.TURSO_AUTH_TOKEN?.trim();

  if (url) {
    const isRemote = !url.startsWith("file:");
    if (isRemote && environment.NODE_ENV === "production" && !authToken) {
      throw new Error(
        "TURSO_AUTH_TOKEN wajib tersedia untuk database remote production.",
      );
    }
    return {
      url,
      authToken: authToken || undefined,
      isRemote,
    };
  }

  if (environment.NODE_ENV === "production") {
    throw new Error(
      "TURSO_DATABASE_URL wajib tersedia pada environment server production.",
    );
  }

  return {
    url: "file:local-app.db",
    isRemote: false,
  };
}
