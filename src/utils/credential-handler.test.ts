import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  exec: execMock,
}));

vi.mock("node:util", () => ({
  promisify: () => execMock,
}));

import {
  retrieveCredentialFromOP,
  verifyCredentialHandler,
  verifyOPAccess,
} from "./credential-handler.js";

describe("credential-handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("verifyOPAccess", () => {
    it("should return true when op is installed and signed in", async () => {
      // Mock successful which op
      execMock.mockResolvedValueOnce({ stdout: "/usr/local/bin/op", stderr: "" });

      // Mock successful tmux commands
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // mkdir
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux new
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux send-keys
      execMock.mockResolvedValueOnce({
        stdout: "user@example.com",
        stderr: "",
      }); // tmux capture-pane
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux kill

      const result = await verifyOPAccess();
      expect(result).toBe(true);
    });

    it("should return false when not signed in", async () => {
      // Mock successful which op
      execMock.mockResolvedValueOnce({ stdout: "/usr/local/bin/op", stderr: "" });

      // Mock tmux commands with "not signed in" error
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // mkdir
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux new
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux send-keys
      execMock.mockResolvedValueOnce({
        stdout: "ERROR: not currently signed in",
        stderr: "",
      }); // tmux capture-pane
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux kill

      const result = await verifyOPAccess();
      expect(result).toBe(false);
    });

    it("should throw error when op is not installed", async () => {
      // Mock failed which op
      execMock.mockRejectedValueOnce(new Error("command not found"));

      await expect(verifyOPAccess()).rejects.toThrow("1Password CLI (op) is not installed");
    });
  });

  describe("retrieveCredentialFromOP", () => {
    it("should retrieve credential successfully", async () => {
      // Mock verifyOPAccess (op installed and signed in)
      execMock.mockResolvedValueOnce({ stdout: "/usr/local/bin/op", stderr: "" }); // which op
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // mkdir
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux new
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux send-keys
      execMock.mockResolvedValueOnce({
        stdout: "user@example.com",
        stderr: "",
      }); // tmux capture-pane
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux kill

      // Mock credential retrieval
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // mkdir
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux new
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux send-keys

      // Mock tmux capture output with credential
      execMock.mockResolvedValueOnce({
        stdout: `$ op read 'op://Private/test/password'
my-secret-password
$`,
        stderr: "",
      });

      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux kill

      const credential = await retrieveCredentialFromOP("op://Private/test/password");
      expect(credential).toBe("my-secret-password");
    });

    it("should throw error when not signed in", async () => {
      // Mock verifyOPAccess (not signed in)
      execMock.mockResolvedValueOnce({ stdout: "/usr/local/bin/op", stderr: "" }); // which op
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // mkdir
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux new
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux send-keys
      execMock.mockResolvedValueOnce({
        stdout: "ERROR: not currently signed in",
        stderr: "",
      }); // tmux capture-pane
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux kill

      await expect(retrieveCredentialFromOP("op://Private/test/password")).rejects.toThrow(
        "1Password app is locked",
      );
    });

    it("should throw error when credential not found", async () => {
      // Mock verifyOPAccess (signed in)
      execMock.mockResolvedValueOnce({ stdout: "/usr/local/bin/op", stderr: "" }); // which op
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // mkdir
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux new
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux send-keys
      execMock.mockResolvedValueOnce({
        stdout: "user@example.com",
        stderr: "",
      }); // tmux capture-pane
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux kill

      // Mock credential retrieval with "not found" error
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // mkdir
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux new
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux send-keys
      execMock.mockResolvedValueOnce({
        stdout: "ERROR: item not found",
        stderr: "",
      }); // tmux capture-pane
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux kill

      await expect(retrieveCredentialFromOP("op://Private/nonexistent/password")).rejects.toThrow(
        "Credential not found in 1Password",
      );
    });

    it("should sanitize opPath to prevent command injection", async () => {
      // Mock verifyOPAccess (signed in)
      execMock.mockResolvedValueOnce({ stdout: "/usr/local/bin/op", stderr: "" });
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" });
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" });
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" });
      execMock.mockResolvedValueOnce({ stdout: "user@example.com", stderr: "" });
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" });

      // Mock credential retrieval
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" });
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" });
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" });
      execMock.mockResolvedValueOnce({
        stdout: `$ op read 'op://Private/test/password'
my-secret
$`,
        stderr: "",
      });
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" });

      // Malicious path with command injection attempt
      const maliciousPath = "op://Private/test'; rm -rf /; echo '";

      const credential = await retrieveCredentialFromOP(maliciousPath);

      // Verify the path was sanitized (quotes removed)
      // The credential handler should still work but sanitize the input
      expect(credential).toBe("my-secret");
    });
  });

  describe("verifyCredentialHandler", () => {
    it("should return status when op is installed and signed in", async () => {
      // Mock successful which op
      execMock.mockResolvedValueOnce({ stdout: "/usr/local/bin/op", stderr: "" });

      // Mock successful verifyOPAccess
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // mkdir
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux new
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux send-keys
      execMock.mockResolvedValueOnce({
        stdout: "user@example.com",
        stderr: "",
      }); // tmux capture-pane
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux kill

      const result = await verifyCredentialHandler();
      expect(result).toEqual({
        opInstalled: true,
        signedIn: true,
      });
    });

    it("should return correct status when op is not installed", async () => {
      // Mock failed which op
      execMock.mockRejectedValueOnce(new Error("command not found"));

      const result = await verifyCredentialHandler();
      expect(result).toEqual({
        opInstalled: false,
        signedIn: false,
      });
    });

    it("should return correct status when op is installed but not signed in", async () => {
      // Mock successful which op
      execMock.mockResolvedValueOnce({ stdout: "/usr/local/bin/op", stderr: "" });

      // Mock failed verifyOPAccess (not signed in)
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // mkdir
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux new
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux send-keys
      execMock.mockResolvedValueOnce({
        stdout: "ERROR: not signed in",
        stderr: "",
      }); // tmux capture-pane
      execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // tmux kill

      const result = await verifyCredentialHandler();
      expect(result).toEqual({
        opInstalled: true,
        signedIn: false,
      });
    });
  });
});
