import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  enable: vi.fn(),
  verifyTotp: vi.fn(),
  renderTotpQr: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    getSession: mocks.getSession,
    twoFactor: {
      enable: mocks.enable,
      verifyTotp: mocks.verifyTotp,
    },
  },
}));

vi.mock("@/lib/totp-qr", () => ({
  renderTotpQr: mocks.renderTotpQr,
}));

import { TwoFactorEnrollment } from "./two-factor-enrollment";

const candidateSession = {
  data: {
    session: { id: "session-1", token: "token-1" },
    user: {
      id: "better-auth-user-123",
      email: "admin@example.com",
      emailVerified: true,
      twoFactorEnabled: false,
      role: "user",
    },
  },
  error: null,
};

describe("TwoFactorEnrollment", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.getSession.mockReset().mockResolvedValue(candidateSession);
    mocks.enable.mockReset();
    mocks.verifyTotp.mockReset();
    mocks.renderTotpQr.mockReset().mockResolvedValue("data:image/png;base64,qr");
  });

  it("enrolls a verified candidate without persisting the TOTP secret", async () => {
    mocks.enable.mockResolvedValue({
      data: {
        totpURI:
          "otpauth://totp/Law%20of%20the%20Land%20Admin:admin%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Law%20of%20the%20Land%20Admin",
        backupCodes: ["backup-one", "backup-two"],
      },
      error: null,
    });

    render(<TwoFactorEnrollment />);

    expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
    expect(screen.getByText("better-auth-user-123")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage active sessions" })).toHaveAttribute(
      "href",
      "/settings/sessions",
    );

    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));

    expect(await screen.findByAltText("Authenticator setup QR code")).toHaveAttribute(
      "src",
      "data:image/png;base64,qr",
    );
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    expect(screen.getByText("backup-one")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify and finish" })).toBeDisabled();
  });

  it("finishes enrollment only after the candidate acknowledges the backup codes", async () => {
    mocks.enable.mockResolvedValue({
      data: {
        totpURI: "otpauth://totp/Account?secret=ABCDEFGHIJKLMNOP",
        backupCodes: ["backup-one"],
      },
      error: null,
    });
    mocks.verifyTotp.mockResolvedValue({
      data: { user: { id: "better-auth-user-123" }, token: "replacement-session" },
      error: null,
    });
    mocks.getSession
      .mockResolvedValueOnce(candidateSession)
      .mockResolvedValueOnce({
        ...candidateSession,
        data: {
          ...candidateSession.data,
          user: { ...candidateSession.data.user, twoFactorEnabled: true },
        },
      });

    render(<TwoFactorEnrollment />);
    await screen.findByText("admin@example.com");
    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));

    await screen.findByText("backup-one");
    fireEvent.change(screen.getByLabelText("6-digit verification code"), {
      target: { value: "123456" },
    });
    fireEvent.click(
      screen.getByLabelText("I saved these backup codes in a secure place"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Verify and finish" }));

    expect(await screen.findByText("Two-Factor is active")).toBeInTheDocument();
    expect(screen.queryByText("backup-one")).not.toBeInTheDocument();
  });

  it("shows a safe retryable error when password confirmation fails", async () => {
    mocks.enable.mockResolvedValue({
      data: null,
      error: { message: "Invalid password", status: 400, statusText: "Bad Request" },
    });

    render(<TwoFactorEnrollment />);
    await screen.findByText("admin@example.com");
    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "wrong password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Check your password and try again",
    );
    expect(screen.getByLabelText("Current password")).toHaveValue("");
  });

  it("shows the promotion handoff after Two-Factor has already been enrolled", async () => {
    mocks.getSession.mockResolvedValue({
      ...candidateSession,
      data: {
        ...candidateSession.data,
        user: { ...candidateSession.data.user, twoFactorEnabled: true },
      },
    });

    render(<TwoFactorEnrollment />);

    expect(await screen.findByText("Two-Factor is active")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Administrator bootstrap handoff" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("better-auth-user-123")).toHaveLength(2);
  });
});
