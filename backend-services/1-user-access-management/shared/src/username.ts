const USERNAME_RE = /^(?!-)[a-z0-9-]{3,32}(?<!-)$/;

export function normalizeUsername(username: string): string {
  return username.toLowerCase();
}

export function isValidUsernameFormat(username: string): boolean {
  return USERNAME_RE.test(username);
}
