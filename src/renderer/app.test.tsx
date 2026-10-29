// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { ModelInfo, TranscriptItem } from "./lib/agent";
import SettingsPage from "./pages/SettingsPage";
import { installMockAgent } from "./test/mock-agent";
import { resetStores } from "./test/reset";

beforeEach(() => resetStores());

const nav = (label: string) => within(document.querySelector("aside") as HTMLElement).getByText(label);

describe("App", () => {
  it("opens on the new-conversation page and switches pages from the sidebar", async () => {
    installMockAgent({
      models: [{ provider: "hifox", id: "glm-5.3-flash", name: "glm-5.3-flash" }],
      defaultModel: { provider: "hifox", id: "glm-5.3-flash" },
      providers: [
        { id: "hifox", baseUrl: "http://x/v1", api: "openai-completions", hasKey: true, models: [] },
      ],
    });
    render(<App />);

    // The shell starts with no session at all.
    expect(await screen.findByText("我能为你做些什么？")).toBeTruthy();
    expect(document.querySelector("[data-session-id]")?.getAttribute("data-session-id")).toBe("");
    expect(nav("新对话").closest("button")?.getAttribute("aria-current")).toBe("page");

    fireEvent.click(nav("模型"));
    expect(await screen.findByRole("heading", { name: "模型" })).toBeTruthy();
    expect(await screen.findByText("hifox")).toBeTruthy();

    fireEvent.click(nav("技能"));
    expect(await screen.findByRole("heading", { name: "技能" })).toBeTruthy();

    fireEvent.click(nav("设置"));
    expect(await screen.findByRole("heading", { name: "设置" })).toBeTruthy();
  });

  it("shows the unbuilt sections as coming soon", async () => {
    installMockAgent({ models: [], defaultModel: null, sessions: [] });
    render(<App />);

    const soon = await within(document.querySelector("aside") as HTMLElement).findAllByText("Coming soon");
    expect(soon).toHaveLength(2);
    // Both are inert: no page behind them yet.
    for (const tag of soon) expect((tag.closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(nav("Agents").closest("button")?.getAttribute("aria-current")).toBeNull();
  });

  it("opens a past conversation, and the new page again", async () => {
    const mock = installMockAgent({
      sessions: [{ id: "session-1", title: "旧的会话", updatedAt: Date.now() }],
      history: [{ kind: "user", text: "发生在过去的对话" }],
      defaultModel: { provider: "hifox", id: "m" },
    });
    render(<App />);

    fireEvent.click(await screen.findByText("旧的会话"));
    expect(await screen.findByText("发生在过去的对话")).toBeTruthy();
    expect(await screen.findByText("旧的会话")).toBeTruthy();
    expect(mock.api.history).toHaveBeenCalledWith("session-1");

    fireEvent.click(nav("新对话"));
    expect(await screen.findByText("我能为你做些什么？")).toBeTruthy();
    expect(document.querySelector("[data-session-id]")?.getAttribute("data-session-id")).toBe("");
  });

  it("mints an id only when the first message is sent", async () => {
    const mock = installMockAgent({ defaultModel: { provider: "hifox", id: "m" }, sessions: [] });
    render(<App />);
    await screen.findByText("我能为你做些什么？");
    expect(mock.api.newSession).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("发消息…"), { target: { value: "第一条消息" } });
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(mock.api.newSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mock.api.prompt).toHaveBeenCalledWith("draft-1", "第一条消息", undefined));
    expect(await screen.findByText("第一条消息")).toBeTruthy();
  });

  it("keeps streaming into a conversation while another page is open", async () => {
    const mock = installMockAgent({
      sessions: [{ id: "session-1", title: "后台会话", updatedAt: Date.now() }],
    });
    render(<App />);

    fireEvent.click(await screen.findByText("后台会话"));
    await screen.findByText("我能为你做些什么？");
    fireEvent.click(nav("设置"));
    await screen.findByRole("heading", { name: "设置" });

    // The chat page is unmounted; the app-level subscription still has to fold
    // the event into the conversation store.
    act(() => mock.emitEvent({ type: "text_delta", sessionId: "session-1", delta: "在后台写完的" }));

    fireEvent.click(screen.getByText("后台会话"));
    expect(await screen.findByText("在后台写完的")).toBeTruthy();
  });

  it("keeps an approval for its own conversation across pages", async () => {
    const mock = installMockAgent({
      sessions: [
        { id: "session-1", title: "会话一", updatedAt: Date.now() },
        { id: "session-2", title: "会话二", updatedAt: Date.now() - 1_000 },
      ],
    });
    render(<App />);

    fireEvent.click(await screen.findByText("会话一"));
    await screen.findByText("我能为你做些什么？");
    fireEvent.click(nav("设置"));
    await screen.findByRole("heading", { name: "设置" });

    act(() => mock.emitDialog({ method: "confirm", title: "部署？", message: "现在发布吗？" }, "session-1"));
    fireEvent.click(screen.getByText("会话一"));
    expect(await screen.findByText("部署？")).toBeTruthy();

    fireEvent.click(screen.getByText("允许"));
    await waitFor(() =>
      expect(mock.api.answer).toHaveBeenCalledWith("dialog-1", { kind: "confirm", confirmed: true }),
    );
    expect(screen.queryByText("部署？")).toBeNull();

    // A request from another conversation waits for that conversation, it does
    // not borrow the one on screen.
    act(() => mock.emitDialog({ method: "confirm", title: "另一个会话", message: "等待确认" }, "session-2"));
    expect(screen.queryByText("另一个会话")).toBeNull();
    fireEvent.click(screen.getByText("会话二"));
    expect(await screen.findByText("另一个会话")).toBeTruthy();
  });

  it("takes a dialog down when main cancels it", async () => {
    const mock = installMockAgent({
      sessions: [{ id: "session-1", title: "会话一", updatedAt: Date.now() }],
    });
    render(<App />);

    fireEvent.click(await screen.findByText("会话一"));
    await screen.findByText("我能为你做些什么？");
    act(() => mock.emitDialog({ method: "confirm", title: "会被取消", message: "等待确认" }));
    expect(await screen.findByText("会被取消")).toBeTruthy();

    // Main owns the timeout and the worker lifetime: when it drops the request,
    // the card must not stay behind as an answerable-looking ghost.
    act(() => mock.emitEvent({ type: "dialog_cancelled", sessionId: "session-1", requestId: "dialog-1" }));
    await waitFor(() => expect(screen.queryByText("会被取消")).toBeNull());
    expect(mock.api.answer).not.toHaveBeenCalled();
  });

  it("shows a model added on the models page in the composer", async () => {
    let currentModels: ModelInfo[] = [
      { provider: "hifox", id: "glm-5.3-flash", name: "glm-5.3-flash", contextWindow: 131_072 },
    ];
    let currentProviders = [
      {
        id: "hifox",
        baseUrl: "http://x/v1",
        api: "openai-completions",
        hasKey: true,
        models: [{ id: "glm-5.3-flash", name: "glm-5.3-flash" }],
      },
    ];
    const mock = installMockAgent({
      models: currentModels,
      providers: currentProviders,
      defaultModel: { provider: "hifox", id: "glm-5.3-flash" },
    });
    mock.api.models = vi.fn(async () => currentModels);
    mock.api.modelsList = vi.fn(async () => currentProviders);
    mock.api.addModel = vi.fn(async (providerId: string, model: { id: string; name?: string }) => {
      const entry = { id: model.id, name: model.name ?? model.id };
      currentProviders = currentProviders.map((provider) =>
        provider.id === providerId ? { ...provider, models: [...provider.models, entry] } : provider,
      );
      currentModels = [...currentModels, { provider: providerId, ...entry }];
    });

    render(<App />);
    fireEvent.click(nav("模型"));
    await screen.findByText("hifox");
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("添加模型"));
    fireEvent.change(within(dialog).getByLabelText("新模型 id"), {
      target: { value: "glm-5.3-pro" },
    });
    fireEvent.click(within(dialog).getByLabelText("保存新模型"));

    expect(await within(dialog).findByText("glm-5.3-pro")).toBeTruthy();

    // Back on the composer the menu is built from the same store, so the write
    // is visible without a restart or a manual refresh.
    fireEvent.click(within(dialog).getByLabelText("关闭"));
    fireEvent.click(nav("新对话"));
    await screen.findByText("我能为你做些什么？");
    fireEvent.click(screen.getByTestId("model-chip"));
    const menu = await screen.findByTestId("model-menu");
    expect(within(menu).getByText("glm-5.3-pro")).toBeTruthy();
  });

  it("does not carry composer text into another conversation", async () => {
    installMockAgent({
      sessions: [
        { id: "session-1", title: "会话一", updatedAt: Date.now() },
        { id: "session-2", title: "会话二", updatedAt: Date.now() - 1_000 },
      ],
      models: [{ provider: "hifox", id: "m", name: "m" }],
      defaultModel: { provider: "hifox", id: "m" },
    });
    render(<App />);

    fireEvent.click(await screen.findByText("会话一"));
    const textarea = (await screen.findByPlaceholderText("发消息…")) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "只属于会话一" } });

    fireEvent.click(screen.getByText("会话二"));

    const next = (await screen.findByPlaceholderText("发消息…")) as HTMLTextAreaElement;
    expect(next.value).toBe("");
  });

  it("keeps a message sent while history is still loading", async () => {
    let resolveHistory!: (items: TranscriptItem[]) => void;
    const mock = installMockAgent({
      sessions: [{ id: "session-1", title: "旧会话", updatedAt: Date.now() }],
      models: [{ provider: "hifox", id: "m", name: "m" }],
      defaultModel: { provider: "hifox", id: "m" },
    });
    mock.api.history = vi.fn(
      () =>
        new Promise<TranscriptItem[]>((resolve) => {
          resolveHistory = resolve;
        }),
    );
    render(<App />);

    fireEvent.click(await screen.findByText("旧会话"));
    await screen.findByText("我能为你做些什么？");
    const textarea = await screen.findByPlaceholderText("发消息…");
    fireEvent.change(textarea, { target: { value: "刚发的" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(await screen.findByText("刚发的")).toBeTruthy();

    act(() => resolveHistory([{ kind: "user", text: "很久以前" }]));

    expect(await screen.findByText("很久以前")).toBeTruthy();
    expect(screen.getByText("刚发的")).toBeTruthy();
  });
});

describe("SettingsPage actions", () => {
  it("toggles launch at login", async () => {
    const mock = installMockAgent();
    render(<SettingsPage />);

    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
    fireEvent.click(checkbox);
    await waitFor(() => expect(mock.api.setLaunchAtLogin).toHaveBeenCalledWith(true));
  });

  it("opens a folder by clicking its path", async () => {
    const mock = installMockAgent();
    render(<SettingsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "/tmp/workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "/tmp/data/sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "/tmp/data/logs" }));

    await waitFor(() => expect(mock.api.revealPath).toHaveBeenCalledWith("/tmp/data/logs"));
    expect(mock.api.revealPath).toHaveBeenCalledWith("/tmp/data/sessions");
  });

  it("changes the theme", async () => {
    const mock = installMockAgent();
    render(<SettingsPage />);

    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "dark" } });
    await waitFor(() => expect(mock.api.setTheme).toHaveBeenCalledWith("dark"));
  });
});
