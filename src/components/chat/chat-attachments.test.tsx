import { act, cleanup, fireEvent, render as renderComponent, renderHook as renderReactHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput } from "@/components/ui/chat-input";
import { CHAT_ATTACHMENT_ACCEPT, MAX_CHAT_FILE_BYTES, type ChatAttachment } from "../../../shared/chat-attachments";
import { DraftAttachmentTray, MessageAttachments } from "./chat-attachment-cards";
import { useChatAttachments } from "./use-chat-attachments";
import { ChatRequestIdentity, ChatRequestsProvider, useChatRequests } from "./chat-requests";

const auth = vi.hoisted(() => ({ owner: "user-1" }));
vi.mock("@/lib/auth-client", () => ({ authClient: { useSession: () => ({ data: { user: { id: auth.owner } }, isPending: false, error: null }) } }));

function DraftProvider({ children }: { children: React.ReactNode }) {
  return <ChatRequestsProvider><ChatRequestIdentity />{children}</ChatRequestsProvider>;
}
const render = (ui: React.ReactNode) => renderComponent(ui, { wrapper: DraftProvider });
function renderHook<Result, Props>(hook: (props: Props) => Result, options?: { initialProps: Props }) {
  return renderReactHook(hook, { ...options, wrapper: DraftProvider });
}

class UploadRequest {
  static instances: UploadRequest[] = [];
  upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  headers = new Map<string, string>();
  status = 200;
  responseText = "";
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  ontimeout?: () => void;
  file?: File;
  constructor() { UploadRequest.instances.push(this); }
  open = vi.fn();
  setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
  send(file: File) { this.file = file; }
  abort() { this.onabort?.(); }
  succeed() {
    this.responseText = JSON.stringify({ attachment: { id: this.headers.get("x-attachment-id"), filename: this.file!.name, mimeType: this.file!.type, byteSize: this.file!.size, kind: "text" } });
    this.onload?.();
  }
}

beforeEach(() => {
  auth.owner = "user-1";
  UploadRequest.instances = [];
  vi.stubGlobal("XMLHttpRequest", UploadRequest);
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, init) => Promise.resolve(init?.method === "DELETE"
    ? new Response(null, { status: 204 })
    : Response.json({ attachmentId: `stored-${UploadRequest.instances.length}`, uploadUrl: "https://uploads.example.test", token: "upload-token" }))));
  URL.createObjectURL = vi.fn(() => "blob:private-preview");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function Composer({ chatId = "chat-a" }: { chatId?: string | null }) {
  const draft = useChatAttachments(chatId);
  return <ChatInput variant="editorial" query={draft.query} onQueryChange={draft.setQuery} onSearch={() => {}} onKeyDown={() => {}} isLoading={false}
    attachments={{ accept: CHAT_ATTACHMENT_ACCEPT, hasFiles: draft.files.length > 0, onFiles: draft.addFiles,
      tray: <DraftAttachmentTray files={draft.files} error={draft.error} disabled={false} onRemove={(file) => void draft.removeFile(file)} onRetry={(file) => void draft.retryFile(file)} />,
    }} />;
}

describe("chat attachment drafts", () => {
  it("supports the picker, image paste, drag/drop, removal, and files-only send", () => {
    render(<Composer />);
    expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
    const picker = screen.getByLabelText("Choose files to attach");
    expect(picker).toHaveAttribute("accept", CHAT_ATTACHMENT_ACCEPT);
    fireEvent.change(picker, { target: { files: [new File(["contract"], "agreement.pdf", { type: "application/pdf" })] } });
    expect(screen.getByRole("button", { name: "Send question" })).toBeEnabled();
    expect(screen.getByText(/Ready to upload/)).toBeVisible();
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [new File(["image"], "photo.png", { type: "image/png" })] } });
    fireEvent.drop(screen.getByRole("textbox"), { dataTransfer: { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] } });
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(3);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove photo.png" }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:private-preview");
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported, empty, oversized, excess-count and excess-total files without losing accepted files", () => {
    const { result } = renderHook(() => useChatAttachments("chat-a"));
    act(() => result.current.addFiles([new File(["hello"], "safe.txt", { type: "text/plain" }), new File(["bad"], "bad.exe"), new File([], "empty.txt")]));
    expect(result.current.files).toHaveLength(1);
    expect(result.current.error).toContain("empty");
    expect(result.current.error).toContain("bad.exe");
    const big = new File(["x"], "big.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: MAX_CHAT_FILE_BYTES + 1 });
    act(() => result.current.addFiles([big]));
    expect(result.current.error).toContain("10 MB");
    const medium = Array.from({ length: 3 }, (_, index) => {
      const file = new File(["x"], `${index}.txt`, { type: "text/plain" });
      Object.defineProperty(file, "size", { value: MAX_CHAT_FILE_BYTES });
      return file;
    });
    act(() => result.current.addFiles(medium));
    expect(result.current.files).toHaveLength(3);
    expect(result.current.error).toContain("25 MB");
    act(() => result.current.addFiles(Array.from({ length: 3 }, (_, index) => new File(["x"], `${index}.md`))));
    expect(result.current.files).toHaveLength(5);
    expect(result.current.error).toContain("5 files");
  });

  it("moves the new-chat draft to its allocated ID and isolates drafts and completions across chats", () => {
    const { result, rerender } = renderHook(({ chatId }: { chatId: string | null }) => useChatAttachments(chatId), { initialProps: { chatId: null } as { chatId: string | null } });
    act(() => {
      result.current.setQuery("Question A");
      result.current.addFiles([new File(["a"], "a.txt")]);
    });
    const sent = result.current.files;
    act(() => result.current.transferToChat("allocated-a"));
    rerender({ chatId: "allocated-a" });
    expect(result.current.query).toBe("Question A");
    expect(result.current.files[0].file.name).toBe("a.txt");
    rerender({ chatId: "chat-b" });
    expect(result.current.files).toEqual([]);
    act(() => { result.current.setQuery("Question B"); result.current.addFiles([new File(["b"], "b.txt")]); });
    act(() => result.current.clearSentDraft("allocated-a", "Question A", sent));
    expect(result.current.query).toBe("Question B");
    expect(result.current.files[0].file.name).toBe("b.txt");
    rerender({ chatId: "allocated-a" });
    expect(result.current.query).toBe("");
    expect(result.current.files).toEqual([]);
    rerender({ chatId: null });
    expect(result.current.files).toEqual([]);
  });

  it("reports progress, retains failed files and text, retries, and reuses successful uploads", async () => {
    const { result } = renderHook(() => useChatAttachments("chat-a"));
    act(() => { result.current.setQuery("Read this"); result.current.addFiles([new File(["secret"], "notes.txt", { type: "text/plain" })]); });
    let send!: Promise<ChatAttachment[]>;
    act(() => { send = result.current.uploadFiles("chat-a", result.current.files, new AbortController().signal); });
    const failure = send.catch((error: Error) => error.message);
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(1));
    act(() => UploadRequest.instances[0].upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 }));
    expect(result.current.files[0].progress).toBe(50);
    await act(async () => { UploadRequest.instances[0].onerror?.(); await failure; });
    expect(result.current.files[0].state).toBe("error");
    expect(result.current.query).toBe("Read this");
    let retry!: Promise<void>;
    act(() => { retry = result.current.retryFile(result.current.files[0]); });
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(2));
    await act(async () => { UploadRequest.instances[1].succeed(); await retry; });
    expect(result.current.files[0].state).toBe("ready");
    expect(fetch).toHaveBeenCalledWith("/api/chat/attachments/stored-0", expect.objectContaining({ method: "DELETE" }));
    let uploaded: ChatAttachment[] = [];
    await act(async () => { uploaded = await result.current.uploadFiles("chat-a", result.current.files, new AbortController().signal); });
    expect(uploaded[0].id).toBe("stored-1");
    expect(UploadRequest.instances).toHaveLength(2);
  });

  it("clears private drafts when the account identity changes", () => {
    const { result, rerender } = renderHook(() => useChatAttachments("chat-a"));
    act(() => { result.current.setQuery("Private question"); result.current.addFiles([new File(["secret"], "notes.txt")]); });
    auth.owner = "user-2";
    rerender();
    expect(result.current.files).toEqual([]);
    expect(result.current.query).toBe("");
  });

  it.each(["headers", "success body", "error body"])("times out stalled preparation %s and keeps a retryable draft", async (phase) => {
    const { result } = renderHook(() => useChatAttachments("chat-a"));
    const file = new File(["secret"], "notes.txt", { type: "text/plain" });
    act(() => { result.current.setQuery("Read this"); result.current.addFiles([file]); });
    if (phase === "headers") vi.mocked(fetch).mockReturnValueOnce(new Promise(() => {}));
    else {
      const response = Response.json({}, { status: phase === "error body" ? 500 : 200 });
      vi.spyOn(response, "json").mockReturnValue(new Promise(() => {}));
      vi.mocked(fetch).mockResolvedValueOnce(response);
    }
    vi.useFakeTimers();
    let upload!: Promise<unknown>;
    act(() => { upload = result.current.uploadFiles("chat-a", result.current.files, new AbortController().signal).catch((error: Error) => error); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); await upload; });
    expect(result.current.files[0]).toMatchObject({ file, state: "error", error: "The file request took too long. Try again." });
    expect(result.current.query).toBe("Read this");
    expect(vi.mocked(fetch).mock.calls[0][1]!.signal!.aborted).toBe(true);
    vi.useRealTimers();
    let retry!: Promise<void>;
    act(() => { retry = result.current.retryFile(result.current.files[0]); });
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(1));
    await act(async () => { UploadRequest.instances[0].succeed(); await retry; });
    expect(result.current.files[0].state).toBe("ready");
  });

  it("bounds retry cleanup and permits removing the retained file after it times out", async () => {
    const { result } = renderHook(() => useChatAttachments("chat-a"));
    act(() => result.current.addFiles([new File(["secret"], "notes.txt", { type: "text/plain" })]));
    let upload!: Promise<unknown>;
    act(() => { upload = result.current.uploadFiles("chat-a", result.current.files).catch(() => {}); });
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(1));
    await act(async () => { UploadRequest.instances[0].onerror?.(); await upload; });
    const response = Response.json({ error: "Never completed" }, { status: 500 });
    vi.spyOn(response, "json").mockReturnValue(new Promise(() => {}));
    vi.mocked(fetch).mockResolvedValueOnce(response);
    vi.useFakeTimers();
    let retry!: Promise<void>;
    act(() => { retry = result.current.retryFile(result.current.files[0]); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); await retry; });
    expect(result.current.files[0]).toMatchObject({ reservedId: "stored-0", state: "error", error: "The file request took too long. Try again." });
    expect(UploadRequest.instances).toHaveLength(1);
    await act(async () => result.current.removeFile(result.current.files[0]));
    expect(result.current.files).toEqual([]);
  });

  it.each(["headers", "success body", "error body"])("restores an uploaded card after removal %s stalls", async (phase) => {
    const { result } = renderHook(() => useChatAttachments("chat-a"));
    act(() => result.current.addFiles([new File(["secret"], "notes.txt", { type: "text/plain" })]));
    let upload!: Promise<ChatAttachment[]>;
    act(() => { upload = result.current.uploadFiles("chat-a", result.current.files); });
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(1));
    await act(async () => { UploadRequest.instances[0].succeed(); await upload; });
    if (phase === "headers") vi.mocked(fetch).mockReturnValueOnce(new Promise(() => {}));
    else {
      const response = Response.json({}, { status: phase === "error body" ? 500 : 200 });
      vi.spyOn(response, "json").mockReturnValue(new Promise(() => {}));
      vi.mocked(fetch).mockResolvedValueOnce(response);
    }
    vi.useFakeTimers();
    let removal!: Promise<void>;
    act(() => { removal = result.current.removeFile(result.current.files[0]); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); await removal; });
    expect(result.current.files[0]).toMatchObject({ state: "selected", reservedId: "stored-0" });
    expect(result.current.files[0].attachment).toBeUndefined();
    expect(result.current.error).toBe("The file request took too long. Try again.");
    expect(vi.mocked(fetch).mock.calls[1][1]!.signal!.aborted).toBe(true);
    await act(async () => result.current.removeFile(result.current.files[0]));
    expect(result.current.files).toEqual([]);
  });

  it.each(["identity", "delete"])("cancels active uploads on %s cleanup and ignores late responses", async (cleanupKind) => {
    const { result, rerender } = renderHook(() => ({ draft: useChatAttachments("chat-a"), requests: useChatRequests("chat-a") }));
    act(() => { result.current.draft.setQuery("Private question"); result.current.draft.addFiles([new File(["secret"], "notes.txt")]); });
    let upload!: Promise<unknown>;
    act(() => { upload = result.current.draft.uploadFiles("chat-a", result.current.draft.files).catch(() => {}); });
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(1));
    const abort = vi.spyOn(UploadRequest.instances[0], "abort");
    if (cleanupKind === "identity") { auth.owner = "user-2"; rerender(); }
    else act(() => {
      const deletion = result.current.requests.store.beginDelete("chat-a");
      result.current.requests.store.update("chat-a", deletion, { isDeleting: false, isDeleted: true });
    });
    await act(async () => { UploadRequest.instances[0].succeed(); await upload; });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(result.current.draft.files).toEqual([]);
    expect(result.current.draft.query).toBe("");
    expect(result.current.draft.error).toBeNull();
  });

  it("retains a retryable draft if chat deletion interrupts an upload and then fails", async () => {
    const { result } = renderHook(() => ({ draft: useChatAttachments("chat-a"), requests: useChatRequests("chat-a") }));
    act(() => result.current.draft.addFiles([new File(["secret"], "notes.txt")]));
    let upload!: Promise<unknown>;
    act(() => { upload = result.current.draft.uploadFiles("chat-a", result.current.draft.files).catch(() => {}); });
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(1));
    await act(async () => {
      const deletion = result.current.requests.store.beginDelete("chat-a");
      result.current.requests.store.update("chat-a", deletion, { isDeleting: false, deleteError: "Try again" });
      await upload;
    });
    expect(result.current.draft.files[0]).toMatchObject({ state: "error", reservedId: "stored-0" });
    let retry!: Promise<void>;
    act(() => { retry = result.current.draft.retryFile(result.current.draft.files[0]); });
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(2));
    await act(async () => { UploadRequest.instances[1].succeed(); await retry; });
    expect(result.current.draft.files[0].state).toBe("ready");
  });

  it("ignores removal responses after the account changes and keeps the new owner's draft", async () => {
    const { result, rerender } = renderHook(() => useChatAttachments("chat-a"));
    act(() => result.current.addFiles([new File(["secret"], "notes.txt")]));
    let upload!: Promise<ChatAttachment[]>;
    act(() => { upload = result.current.uploadFiles("chat-a", result.current.files); });
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(1));
    await act(async () => { UploadRequest.instances[0].succeed(); await upload; });
    let finishRemoval!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>((resolve) => { finishRemoval = resolve; }));
    let removal!: Promise<void>;
    act(() => { removal = result.current.removeFile(result.current.files[0]); });
    const removalSignal = vi.mocked(fetch).mock.calls[1][1]!.signal!;
    auth.owner = "user-2";
    rerender();
    act(() => { result.current.setQuery("Different account"); result.current.addFiles([new File(["public"], "different.txt")]); });
    await act(async () => { finishRemoval(Response.json({ error: "Late error" }, { status: 500 })); await removal; });
    expect(removalSignal.aborted).toBe(true);
    expect(result.current.query).toBe("Different account");
    expect(result.current.files).toHaveLength(1);
    expect(result.current.files[0].file.name).toBe("different.txt");
    expect(result.current.error).toBeNull();
  });

  it("reuploads an uncertain removed file if deleting its chat also fails", async () => {
    const { result } = renderHook(() => ({ draft: useChatAttachments("chat-a"), requests: useChatRequests("chat-a") }));
    const file = new File(["secret"], "notes.txt");
    act(() => result.current.draft.addFiles([file]));
    let upload!: Promise<ChatAttachment[]>;
    act(() => { upload = result.current.draft.uploadFiles("chat-a", result.current.draft.files); });
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(1));
    await act(async () => { UploadRequest.instances[0].succeed(); await upload; });
    vi.mocked(fetch).mockReturnValueOnce(new Promise(() => {}));
    let removal!: Promise<void>;
    act(() => { removal = result.current.draft.removeFile(result.current.draft.files[0]); });
    await act(async () => {
      const deletion = result.current.requests.store.beginDelete("chat-a");
      result.current.requests.store.update("chat-a", deletion, { isDeleting: false, deleteError: "Try again" });
      await removal;
    });
    expect(result.current.draft.files[0]).toMatchObject({ file, state: "selected", reservedId: "stored-0" });
    expect(result.current.draft.files[0].attachment).toBeUndefined();
    act(() => { upload = result.current.draft.uploadFiles("chat-a", result.current.draft.files); });
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(2));
    await act(async () => { UploadRequest.instances[1].succeed(); await upload; });
    expect(result.current.draft.files[0].attachment?.id).toBe("stored-1");
  });

  it("aborts active attachment work when its root request provider unmounts", async () => {
    const { result, unmount } = renderHook(() => useChatAttachments("chat-a"));
    act(() => result.current.addFiles([new File(["secret"], "notes.txt")]));
    let upload!: Promise<unknown>;
    act(() => { upload = result.current.uploadFiles("chat-a", result.current.files).catch(() => {}); });
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(1));
    const abort = vi.spyOn(UploadRequest.instances[0], "abort");
    unmount();
    await upload;
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("keeps an uploaded card while removal is pending and restores it on a deletion failure", async () => {
    const { result } = renderHook(() => useChatAttachments("chat-a"));
    act(() => result.current.addFiles([new File(["secret"], "notes.txt", { type: "text/plain" })]));
    let upload!: Promise<ChatAttachment[]>;
    act(() => { upload = result.current.uploadFiles("chat-a", result.current.files, new AbortController().signal); });
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(1));
    await act(async () => { UploadRequest.instances[0].succeed(); await upload; });
    let finishDelete!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>((resolve) => { finishDelete = resolve; }));
    let removal!: Promise<void>;
    act(() => { removal = result.current.removeFile(result.current.files[0]); });
    expect(result.current.files[0].state).toBe("removing");
    await act(async () => { finishDelete(Response.json({ error: "Could not remove the file" }, { status: 500 })); await removal; });
    expect(result.current.files[0].state).toBe("selected");
    expect(result.current.files[0].attachment).toBeUndefined();
    expect(result.current.files[0].reservedId).toBe("stored-0");
    expect(result.current.error).toBe("Could not remove the file");
    await act(async () => result.current.removeFile(result.current.files[0]));
    expect(result.current.files).toEqual([]);
  });

  it("renders saved files through private download and preview routes", () => {
    const file: ChatAttachment = { id: "attachment-1", filename: "A very long filename that should preserve its extension.png", mimeType: "image/png", byteSize: 2048, kind: "image" };
    const { container } = render(<MessageAttachments attachments={[file]} />);
    expect(screen.getByRole("region", { name: "Your files" })).toBeVisible();
    expect(screen.getByRole("link", { name: `Download ${file.filename}` })).toHaveAttribute("href", "/api/chat/attachments/attachment-1?download=1");
    expect(container.querySelector("img")).toHaveAttribute("src", "/api/chat/attachments/attachment-1");
  });

  it("keeps attachment controls opt-in for guest and widget composers", () => {
    render(<ChatInput query="Hello" onQueryChange={() => {}} onSearch={() => {}} onKeyDown={() => {}} isLoading={false} />);
    expect(screen.queryByRole("button", { name: "Attach files" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Choose files to attach")).not.toBeInTheDocument();
  });
});
