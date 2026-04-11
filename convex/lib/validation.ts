// DEPRECATED: greytrace-backend is retired; do not use.

export const USERNAME_REGEX = /^[A-Za-z0-9_]{3,20}$/;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

export function normalizeUsername(value: string) {
  return value.trim().toLowerCase();
}

export function normalizeLobbyCode(code: string) {
  return code.trim().toUpperCase();
}

export function validateCredentials(username: string, password: string) {
  if (!USERNAME_REGEX.test(username)) {
    throw new Error(
      "Username must be 3-20 characters and use only letters, numbers, or underscores.",
    );
  }

  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new Error("Password must be between 8 and 72 characters.");
  }
}
