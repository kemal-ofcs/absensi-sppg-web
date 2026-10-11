interface LogoutLocation {
  replace(url: string): void;
}

export function redirectAfterLogout(
  location: LogoutLocation = window.location,
) {
  location.replace("/login");
}
