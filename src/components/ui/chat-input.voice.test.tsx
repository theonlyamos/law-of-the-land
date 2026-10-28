import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatInput } from "./chat-input";

class FakeRecorder {
  static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";
  static last: FakeRecorder | null = null;
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor() { FakeRecorder.last = this; }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const track = { stop: vi.fn() };
const getUserMedia = vi.fn();

beforeEach(() => {
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  getUserMedia.mockResolvedValue({ getTracks: () => [track] });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); FakeRecorder.last = null; });

function setup(query = "") {
  const onQueryChange = vi.fn();
  const transcribe = vi.fn(async () => "What notice must my landlord give?");
  render(<ChatInput variant="editorial" query={query} onQueryChange={onQueryChange} onSearch={vi.fn()} onKeyDown={vi.fn()} isLoading={false} transcribe={transcribe} />);
  return { onQueryChange, transcribe };
}

async function recordFor(ms: number) {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  fireEvent.click(screen.getByRole("button", { name: "Dictate your question" }));
  await screen.findByRole("button", { name: "Stop recording and transcribe" });
  clock.mockReturnValue(now + ms);
}

it("records, shows the waveform, and puts the transcript in the input", async () => {
  const { onQueryChange, transcribe } = setup("Under the Rent Act,");
  await recordFor(3_000);
  expect(screen.getByTestId("voice-waveform")).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Stop recording and transcribe" }));
  await waitFor(() => expect(onQueryChange).toHaveBeenCalledWith("Under the Rent Act, What notice must my landlord give?"));
  expect(transcribe).toHaveBeenCalledWith(expect.any(Blob), expect.any(AbortSignal));
  expect(track.stop).toHaveBeenCalled();
  expect(await screen.findByRole("textbox")).toBeInTheDocument();
});

it("discards the recording with the discard button without transcribing", async () => {
  const { onQueryChange, transcribe } = setup();
  await recordFor(3_000);
  fireEvent.click(screen.getByRole("button", { name: "Discard recording" }));
  await screen.findByRole("button", { name: "Dictate your question" });
  expect(transcribe).not.toHaveBeenCalled();
  expect(onQueryChange).not.toHaveBeenCalled();
});

it("discards the recording on Escape", async () => {
  const { transcribe } = setup();
  await recordFor(3_000);
  act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
  await screen.findByRole("button", { name: "Dictate your question" });
  expect(transcribe).not.toHaveBeenCalled();
});

it("explains a blocked microphone calmly", async () => {
  getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Dictate your question" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Microphone access is blocked");
});

it("shows transcription errors and keeps what was typed", async () => {
  const onQueryChange = vi.fn();
  const transcribe = vi.fn(async () => { throw new Error("We couldn't transcribe that recording. Try again, or type your question."); });
  render(<ChatInput variant="editorial" query="typed" onQueryChange={onQueryChange} onSearch={vi.fn()} onKeyDown={vi.fn()} isLoading={false} transcribe={transcribe} />);
  await recordFor(2_000);
  fireEvent.click(screen.getByRole("button", { name: "Stop recording and transcribe" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("couldn't transcribe");
  expect(onQueryChange).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox")).toHaveValue("typed");
});

it("hides the microphone when no transcriber is provided", () => {
  render(<ChatInput variant="editorial" query="" onQueryChange={vi.fn()} onSearch={vi.fn()} onKeyDown={vi.fn()} isLoading={false} />);
  expect(screen.queryByRole("button", { name: "Dictate your question" })).not.toBeInTheDocument();
});
