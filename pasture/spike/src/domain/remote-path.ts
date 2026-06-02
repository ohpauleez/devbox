import { DevboxError } from "./errors.js";

export function validateRemotePath(remote: string): void {
  if (!remote.trim()) {
    throw new DevboxError("ValidationError", "Remote path must be non-empty");
  }

  for (let i = 0; i < remote.length; i += 1) {
    const code = remote.charCodeAt(i);
    if (code === 0) {
      throw new DevboxError("ValidationError", "Remote path contains null byte");
    }
    if ((code >= 0x00 && code <= 0x1f) || code === 0x7f) {
      throw new DevboxError(
        "ValidationError",
        "Remote path contains ASCII control characters",
      );
    }
  }
}
