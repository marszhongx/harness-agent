// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "./App";
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
