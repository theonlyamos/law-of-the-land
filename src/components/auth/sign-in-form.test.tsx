import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  verifyTotp: vi.fn(),
  verifyBackupCode: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { email: mocks.signInEmail, social: vi.fn() },
    signUp: { email: mocks.signUpEmail },
    sendVerificationEmail: vi.fn(),
    twoFactor: {
      verifyTotp: mocks.verifyTotp,
      verifyBackupCode: mocks.verifyBackupCode,
    },
  },
}));

import { SignInForm } from "./sign-in-form";

function submitPasswordSignIn() {
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "admin@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "correct horse battery staple" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("SignInForm Two-Factor challenge", () => {
  beforeEach(() => {
    mocks.replace.mockReset();
    mocks.signInEmail.mockReset().mockResolvedValue({
      data: { twoFactorRedirect: true, twoFactorMethods: ["totp"] },
      error: null,
    });
    mocks.verifyTotp.mockReset().mockResolvedValue({
      data: { user: { id: "admin-1" }, token: "session-token" },
      error: null,
    });
    mocks.verifyBackupCode.mockReset().mockResolvedValue({
      data: { user: { id: "admin-1" }, token: "session-token" },
      error: null,
    });
  });

  afterEach(cleanup);

  it("completes a password sign-in with the authenticator challenge", async () => {
    render(<SignInForm />);
    submitPasswordSignIn();

    const codeInput = await screen.findByLabelText("Authenticator code");
    expect(mocks.replace).not.toHaveBeenCalled();
    fireEvent.change(codeInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and sign in" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Signed in securely");
    expect(mocks.replace).toHaveBeenCalledWith("/new");
  });

  it("accepts a one-time backup code when the authenticator is unavailable", async () => {
    render(<SignInForm />);
    submitPasswordSignIn();

    await screen.findByLabelText("Authenticator code");
    fireEvent.click(screen.getByRole("button", { name: "Use a backup code" }));
    fireEvent.change(screen.getByLabelText("Backup code"), {
      target: { value: "single-use-backup" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify and sign in" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Signed in securely");
    expect(mocks.replace).toHaveBeenCalledWith("/new");
  });

  it("keeps the challenge open after an invalid authenticator code", async () => {
    mocks.verifyTotp.mockResolvedValue({
      data: null,
      error: { message: "Invalid code" },
    });
    render(<SignInForm />);
    submitPasswordSignIn();

    fireEvent.change(await screen.findByLabelText("Authenticator code"), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify and sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "code was not accepted",
    );
    expect(screen.getByLabelText("Authenticator code")).toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
