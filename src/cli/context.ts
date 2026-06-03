import type { CommandOutput } from "../domain/output-contracts.js";
import type { DevboxError } from "../domain/errors.js";
import type { Result } from "../domain/result.js";

/**
 * Command return contract used by CLI dispatch.
 */
export type CommandResult = Result<CommandOutput, DevboxError>;
