/**
 * Secure credential retrieval from 1Password CLI
 *
 * Workflow:
 * 1. Start isolated tmux session
 * 2. Execute `op read` in tmux
 * 3. Capture output (credential value only)
 * 4. Kill tmux session
 * 5. Return credential in memory (never to logs)
 *
 * @module credential-handler
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Environment variables for tmux socket management
 */
const SOCKET_DIR =
  process.env.OPENCLAW_TMUX_SOCKET_DIR ||
  process.env.CLAWDBOT_TMUX_SOCKET_DIR ||
  `${process.env.TMPDIR || "/tmp"}/openclaw-tmux-sockets`;

/**
 * Timeout for op commands (5 seconds)
 */
const OP_COMMAND_TIMEOUT = 5000;

/**
 * Verify 1Password CLI is accessible and signed in
 *
 * @returns {Promise<boolean>} true if signed in, false otherwise
 * @throws {Error} if op CLI is not installed
 */
export async function verifyOPAccess(): Promise<boolean> {
  try {
    // First check if op is installed
    await execAsync("which op", { timeout: 2000 });
  } catch {
    throw new Error(
      "1Password CLI (op) is not installed. Install it with: brew install 1password-cli (macOS) or visit https://developer.1password.com/docs/cli/get-started/",
    );
  }

  try {
    // Create isolated tmux session for verification
    const timestamp = Date.now();
    const socketPath = `${SOCKET_DIR}/openclaw-op-verify-${timestamp}.sock`;
    const sessionName = `op-verify-${timestamp}`;

    // Ensure socket directory exists
    await execAsync(`mkdir -p "${SOCKET_DIR}"`, { timeout: 2000 });

    // Create tmux session
    await execAsync(
      `tmux -S "${socketPath}" new -d -s "${sessionName}" -n shell`,
      { timeout: 2000 },
    );

    // Execute op whoami
    await execAsync(
      `tmux -S "${socketPath}" send-keys -t "${sessionName}":0.0 -- "op whoami 2>&1" Enter`,
      { timeout: 2000 },
    );

    // Wait for command to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Capture output
    const { stdout } = await execAsync(
      `tmux -S "${socketPath}" capture-pane -p -J -t "${sessionName}":0.0 -S -50`,
      { timeout: 2000 },
    );

    // Kill session
    await execAsync(
      `tmux -S "${socketPath}" kill-session -t "${sessionName}"`,
      { timeout: 2000 },
    ).catch(() => {
      /* ignore kill errors */
    });

    // Check if signed in
    const output = stdout.trim();
    if (output.includes("not currently signed in") || output.includes("ERROR")) {
      return false;
    }

    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("not currently signed in")) {
      return false;
    }
    throw new Error(`Failed to verify 1Password access: ${errorMessage}`);
  }
}

/**
 * Retrieve credential from 1Password using op CLI
 *
 * @param {string} opPath - 1Password vault path (e.g., "op://vault/item/field")
 * @returns {Promise<string>} The credential value (in memory only, never logged)
 * @throws {Error} if credential cannot be retrieved
 *
 * @example
 * const password = await retrieveCredentialFromOP("op://Private/gmail/app-password");
 */
export async function retrieveCredentialFromOP(opPath: string): Promise<string> {
  // Verify op CLI is installed and accessible
  const isSignedIn = await verifyOPAccess();
  if (!isSignedIn) {
    throw new Error(
      "1Password app is locked or not signed in. Please unlock the 1Password desktop app and ensure desktop app integration is enabled, then try again.",
    );
  }

  try {
    // Create unique tmux session
    const timestamp = Date.now();
    const socketPath = `${SOCKET_DIR}/openclaw-op-${timestamp}.sock`;
    const sessionName = `op-read-${timestamp}`;

    // Ensure socket directory exists
    await execAsync(`mkdir -p "${SOCKET_DIR}"`, {
      timeout: OP_COMMAND_TIMEOUT,
    });

    // Create tmux session
    await execAsync(
      `tmux -S "${socketPath}" new -d -s "${sessionName}" -n shell`,
      { timeout: OP_COMMAND_TIMEOUT },
    );

    // Sanitize opPath to prevent command injection
    const sanitizedPath = opPath.replace(/['"`]/g, "");

    // Execute op read command
    await execAsync(
      `tmux -S "${socketPath}" send-keys -t "${sessionName}":0.0 -- "op read '${sanitizedPath}' 2>&1" Enter`,
      { timeout: OP_COMMAND_TIMEOUT },
    );

    // Wait for command to complete
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Capture output
    const { stdout } = await execAsync(
      `tmux -S "${socketPath}" capture-pane -p -J -t "${sessionName}":0.0 -S -50`,
      { timeout: OP_COMMAND_TIMEOUT },
    );

    // Kill session immediately (security: clear the credential from tmux buffer)
    await execAsync(
      `tmux -S "${socketPath}" kill-session -t "${sessionName}"`,
      { timeout: 2000 },
    ).catch(() => {
      /* ignore kill errors */
    });

    // Parse output to extract credential
    const lines = stdout.split("\n").map((line) => line.trim());

    // Find the line with the actual credential (skip the command echo)
    let credential = "";
    let foundCommand = false;

    for (const line of lines) {
      // Skip the command echo line
      if (line.includes("op read")) {
        foundCommand = true;
        continue;
      }

      // After finding the command, the next non-empty line is the credential
      if (foundCommand && line && !line.includes("$")) {
        credential = line;
        break;
      }
    }

    if (!credential) {
      // Check for error messages
      const output = stdout.toLowerCase();
      if (output.includes("not found") || output.includes("doesn't exist")) {
        throw new Error(
          `Credential not found in 1Password. Please verify the vault path is correct.`,
        );
      }
      if (output.includes("not signed in") || output.includes("unauthorized")) {
        throw new Error(
          "1Password session expired. Please unlock the 1Password app and try again.",
        );
      }
      throw new Error(
        "Failed to retrieve credential from 1Password. Please check your vault path and try again.",
      );
    }

    return credential;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Sanitize error messages (don't expose vault paths)
    if (errorMessage.includes("op://")) {
      throw new Error(
        "Failed to retrieve credential from 1Password. Please verify the vault path and ensure the 1Password app is unlocked.",
      );
    }

    throw error;
  }
}

/**
 * Verify credential handler is working properly
 * This function is useful for testing and debugging
 *
 * @returns {Promise<{ opInstalled: boolean; signedIn: boolean }>}
 */
export async function verifyCredentialHandler(): Promise<{
  opInstalled: boolean;
  signedIn: boolean;
}> {
  let opInstalled = false;
  let signedIn = false;

  try {
    await execAsync("which op", { timeout: 2000 });
    opInstalled = true;
  } catch {
    return { opInstalled, signedIn };
  }

  try {
    signedIn = await verifyOPAccess();
  } catch {
    signedIn = false;
  }

  return { opInstalled, signedIn };
}
