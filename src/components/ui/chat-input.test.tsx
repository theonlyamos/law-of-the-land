import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatInput } from "./chat-input";

afterEach(cleanup);

const baseProps = { query: "What are my rights?", onQueryChange: vi.fn(), onKeyDown: vi.fn() };

it.each(["default", "editorial"] as const)("shows the send button when no answer can be stopped (%s)", (variant) => {
  const onSearch = vi.fn();
  render(<ChatInput {...baseProps} variant={variant} onSearch={onSearch} isLoading={false} />);
  expect(screen.queryByRole("button", { name: "Stop answer" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Send question" }));
  expect(onSearch).toHaveBeenCalledTimes(1);
});

it.each(["default", "editorial"] as const)("turns the send button into an enabled stop button while an answer is generating (%s)", (variant) => {
  const onSearch = vi.fn();
  const onStop = vi.fn();
  render(<ChatInput {...baseProps} variant={variant} onSearch={onSearch} onStop={onStop} isLoading />);
  expect(screen.queryByRole("button", { name: "Send question" })).not.toBeInTheDocument();
  const stop = screen.getByRole("button", { name: "Stop answer" });
  expect(stop).toBeEnabled();
  fireEvent.click(stop);
  expect(onStop).toHaveBeenCalledTimes(1);
  expect(onSearch).not.toHaveBeenCalled();
});
