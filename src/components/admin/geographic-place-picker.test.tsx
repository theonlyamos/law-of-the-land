import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeographicPlacePicker } from "./geographic-place-picker";

const TOKENS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  let token = 0;
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => TOKENS[token++] ?? TOKENS[1]) });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GeographicPlacePicker", () => {
  it("waits for three trimmed characters and debounces autocomplete once", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => response({ suggestions: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<GeographicPlacePicker value={null} onChange={vi.fn()} />);

    const input = screen.getByRole("combobox", { name: "Find place" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: " Ac " } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: " Acc " } });
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      input: "Acc",
      sessionToken: TOKENS[0],
    });
  });

  it("ignores a stale response after a newer autocomplete completes", async () => {
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(first)
      .mockImplementationOnce(() => response({ suggestions: [{ placeId: "new", primaryText: "Accra", secondaryText: "Ghana", types: ["locality"] }] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<GeographicPlacePicker value={null} onChange={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Find place" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Old" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    fireEvent.change(input, { target: { value: "Accra" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText("Accra")).toBeVisible();
    await act(async () => { resolveFirst(new Response(JSON.stringify({ suggestions: [{ placeId: "old", primaryText: "Old result", secondaryText: "", types: [] }] }))); });
    expect(screen.queryByText("Old result")).toBeNull();
  });

  it("supports keyboard selection, attribution, and keeps one token through details", async () => {
    const onChange = vi.fn();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => response({ suggestions: [{ placeId: "accra", primaryText: "Accra", secondaryText: "Ghana", types: ["locality"] }] }))
      .mockImplementationOnce(() => response({
        place: { placeId: "accra", displayName: "Accra", formattedAddress: "Accra, Ghana", latitude: 5.6, longitude: -0.2, types: ["locality"], countryCode: "GH", addressComponents: [] },
        verifiedPlaceClaim: "signed-secret",
        expiresAt: Date.now() + 60_000,
      }));
    vi.stubGlobal("fetch", fetchMock);
    render(<GeographicPlacePicker value={null} onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: "Find place" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Accra" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText("Powered by Google")).toBeVisible();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(onChange).toHaveBeenCalledTimes(1);

    const details = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(details).toEqual({ placeId: "accra", sessionToken: TOKENS[0] });
    expect(screen.queryByText("signed-secret")).toBeNull();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Kumasi" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body)).sessionToken).toBe(TOKENS[1]);
  });

  it("does not autocomplete the programmatic selected display name", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => response({ suggestions: [{ placeId: "accra", primaryText: "Acc", secondaryText: "Ghana", types: [] }] }))
      .mockImplementationOnce(() => response({
        place: { placeId: "accra", displayName: "Accra", formattedAddress: "Accra, Ghana", latitude: 5.6, longitude: -0.2, types: [], addressComponents: [] },
        verifiedPlaceClaim: "signed",
        expiresAt: Date.now() + 60_000,
      }));
    vi.stubGlobal("fetch", fetchMock);
    render(<GeographicPlacePicker value={null} onChange={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Find place" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Acc" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); await Promise.resolve(); });
    fireEvent.click(screen.getByRole("option", { name: /Acc/ }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears a verified selection when its claim expires", async () => {
    const onChange = vi.fn();
    vi.stubGlobal("fetch", vi.fn());
    render(<GeographicPlacePicker value={{
      place: { placeId: "accra", displayName: "Accra", formattedAddress: "Accra, Ghana", latitude: 5.6, longitude: -0.2, types: [], addressComponents: [] },
      verifiedPlaceClaim: "signed",
      expiresAt: Date.now() + 1_000,
    }} onChange={onChange} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(onChange).toHaveBeenCalledWith(null);
    expect(screen.getByText(/selection expired/i)).toBeVisible();
  });

  it("clears protected state on an authorization failure", async () => {
    const onChange = vi.fn();
    vi.stubGlobal("fetch", vi.fn(() => response({ error: "Forbidden" }, 403)));
    render(<GeographicPlacePicker value={{
      place: { placeId: "old", displayName: "Old", formattedAddress: "Old", latitude: 0, longitude: 0, types: [], addressComponents: [] },
      verifiedPlaceClaim: "secret",
      expiresAt: Date.now() + 60_000,
    }} onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: "Find place" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Accra" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole("alert")).toBeVisible();
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("does not let stale details overwrite a newer query", async () => {
    const onChange = vi.fn();
    let resolveDetails!: (value: Response) => void;
    const details = new Promise<Response>((resolve) => { resolveDetails = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => response({ suggestions: [{ placeId: "accra", primaryText: "Accra", secondaryText: "Ghana", types: [] }] }))
      .mockReturnValueOnce(details)
      .mockImplementationOnce(() => response({ suggestions: [{ placeId: "kumasi", primaryText: "Kumasi", secondaryText: "Ghana", types: [] }] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<GeographicPlacePicker value={null} onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: "Find place" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Accra" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); await Promise.resolve(); });
    fireEvent.click(screen.getByRole("option", { name: /Accra/ }));
    fireEvent.change(input, { target: { value: "Kumasi" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); await Promise.resolve(); });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body)).sessionToken).toBe(TOKENS[1]);
    await act(async () => {
      resolveDetails(new Response(JSON.stringify({
        place: { displayName: "Accra" },
        verifiedPlaceClaim: "stale",
        expiresAt: Date.now() + 10_000,
      })));
      await Promise.resolve();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("Kumasi")).toBeVisible();
  });
});
