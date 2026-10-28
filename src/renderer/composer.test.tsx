// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Composer from "./components/Composer";
import { installMockAgent } from "./test/mock-agent";
import { resetStores } from "./test/reset";

const models = [
  {
    provider: "hifox",
    id: "glm-5.3-flash",
    name: "glm-5.3-flash",
    contextWindow: 1310720,
    reasoning: true,
    // `minimal` is off for this model; `max` is only available because it is mapped.
    thinkingLevelMap: { minimal: null, high: "high", max: "max" },
  },
  { provider: "amdx", id: "DeepSeek-V4-Flash", name: "DeepSeek-V4-Flash", contextWindow: 1048576 },
];

const session = {
  id: "session-1",
  title: "x",
  updatedAt: Date.now(),
  model: { provider: "hifox", id: "glm-5.3-flash" },
};

beforeEach(() => resetStores());

const mount = (
  options: Parameters<typeof installMockAgent>[0] = {},
  sessionId: string | null = "session-1",
) => {
  const mock = installMockAgent(options);
  const onSend = vi.fn(async () => undefined);
  render(<Composer sessionId={sessionId} busy={false} onSend={onSend} />);
  return { mock, onSend };
};

const type = (text: string) =>
  fireEvent.change(screen.getByPlaceholderText(/发消息|先选一个模型/), { target: { value: text } });
const sendButton = () => screen.getByLabelText("发送") as HTMLButtonElement;

describe("Composer", () => {
  it("lets the new-conversation page pick its folder", async () => {
    const { mock } = mount(
      { models, sessions: [session], defaultModel: { provider: "hifox", id: "glm-5.3-flash" } },
      null,
    );
    await screen.findByText("workspace");

    fireEvent.click(screen.getByText("workspace"));
    await waitFor(() => expect(mock.api.chooseDraftWorkspace).toHaveBeenCalled());
    expect(mock.api.revealPath).not.toHaveBeenCalled();
  });

  it("only reveals the folder of an existing conversation", async () => {
    const { mock } = mount({ models, sessions: [session] });
    await screen.findByText("workspace");

    fireEvent.click(screen.getByText("workspace"));
    await waitFor(() => expect(mock.api.revealPath).toHaveBeenCalledWith("/tmp/workspace"));
    expect(mock.api.chooseDraftWorkspace).not.toHaveBeenCalled();
  });

  it("blocks sending when no model is selected", async () => {
    const { onSend } = mount({ models, defaultModel: null, sessions: [] });
    expect(await screen.findByText("未选择模型")).toBeTruthy();
    expect(screen.getByPlaceholderText("先选一个模型")).toBeTruthy();

    type("你好");
    expect(sendButton().disabled).toBe(true);
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows the conversation's model and hands the text to onSend", async () => {
    const { onSend } = mount({ models, sessions: [session] });
    expect(await screen.findByText("glm-5.3-flash")).toBeTruthy();

    type("跑一下测试");
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("跑一下测试", undefined));
    expect((screen.getByPlaceholderText("发消息…") as HTMLTextAreaElement).value).toBe("");
  });

  it("falls back to the default model for a conversation without one", async () => {
    mount({
      models,
      defaultModel: { provider: "amdx", id: "DeepSeek-V4-Flash" },
      sessions: [{ id: "session-1", title: "x", updatedAt: 0 }],
    });
    expect(await screen.findByText("DeepSeek-V4-Flash")).toBeTruthy();
  });

  it("switches model and stars a default", async () => {
    const { mock } = mount({ models, sessions: [session] });
    await screen.findByText("glm-5.3-flash");

    fireEvent.click(screen.getByTestId("model-chip"));
    const menu = await screen.findByTestId("model-menu");
    expect(within(menu).getByText("hifox")).toBeTruthy();
    expect(within(menu).getByText("amdx")).toBeTruthy();

    fireEvent.click(within(menu).getByText("DeepSeek-V4-Flash"));
    await waitFor(() =>
      expect(mock.api.setModel).toHaveBeenCalledWith("session-1", "amdx", "DeepSeek-V4-Flash"),
    );

    fireEvent.click(screen.getByTestId("model-chip"));
    const reopened = await screen.findByTestId("model-menu");
    fireEvent.click(within(reopened).getAllByTitle("设为默认模型")[0]);
    await waitFor(() => expect(mock.api.setDefaultModel).toHaveBeenCalled());
  });

  it("targets the current conversation, and no id on the new page", async () => {
    const { mock } = mount(
      { models, sessions: [session], defaultModel: { provider: "hifox", id: "glm-5.3-flash" } },
      null,
    );
    await screen.findByText("glm-5.3-flash");

    fireEvent.click(screen.getByTestId("model-chip"));
    fireEvent.click(within(await screen.findByTestId("model-menu")).getByText("DeepSeek-V4-Flash"));
    await waitFor(() => expect(mock.api.setModel).toHaveBeenCalledWith(null, "amdx", "DeepSeek-V4-Flash"));
  });

  it("shows the level a conversation will run with before any worker starts", async () => {
    // New page: nothing has run, so the level comes from pi's default.
    mount(
      {
        models,
        sessions: [session],
        defaultModel: { provider: "hifox", id: "glm-5.3-flash" },
        defaultThinkingLevel: "max",
      },
      null,
    );
    expect(await screen.findByLabelText("思考等级 max")).toBeTruthy();
  });

  it("prefers the level recorded on the conversation", async () => {
    mount({
      models,
      sessions: [{ ...session, thinkingLevel: "low" }],
      defaultThinkingLevel: "max",
    });
    expect(await screen.findByLabelText("思考等级 low")).toBeTruthy();
  });

  it("derives the levels from the catalogue: unsupported ones are disabled", async () => {
    const { mock } = mount({ models, sessions: [session] });
    await screen.findByText("glm-5.3-flash");

    mock.emitEvent({ type: "thinking", sessionId: "session-1", level: "max", levels: [] });
    expect(await screen.findByLabelText("思考等级 max")).toBeTruthy();

    fireEvent.click(screen.getByTestId("thinking-chip"));
    const menu = await screen.findByTestId("thinking-menu");
    const item = (label: string) => within(menu).getByText(label).closest("button") as HTMLButtonElement;

    expect(item("off").disabled).toBe(false);
    expect(item("minimal").disabled).toBe(true); // mapped to null
    expect(item("xhigh").disabled).toBe(true); // not mapped
    expect(item("max").disabled).toBe(false);

    fireEvent.click(item("high"));
    await waitFor(() => expect(mock.api.setThinkingLevel).toHaveBeenCalledWith("session-1", "high"));
  });

  it("offers only off for a model that does not reason", async () => {
    mount({ models, sessions: [session], defaultModel: { provider: "hifox", id: "glm-5.3-flash" } }, null);
    await screen.findByText("glm-5.3-flash");

    // Second model has no `reasoning`, so it gets the single-level list.
    fireEvent.click(screen.getByTestId("model-chip"));
    fireEvent.click(within(await screen.findByTestId("model-menu")).getByText("DeepSeek-V4-Flash"));
    fireEvent.click(screen.getByTestId("thinking-chip"));

    const menu = await screen.findByTestId("thinking-menu");
    const enabled = within(menu)
      .getAllByRole("button")
      .filter((button) => !(button as HTMLButtonElement).disabled)
      .map((button) => button.textContent);
    expect(enabled).toEqual(["off"]);
  });

  it("attaches an image and sends it along", async () => {
    const { onSend } = mount({ models, sessions: [session] });
    await screen.findByText("glm-5.3-flash");

    const file = new File([new Uint8Array([137, 80, 78, 71])], "red.png", { type: "image/png" });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });

    const thumbnail = await screen.findByAltText("待发送附件");
    expect(thumbnail.getAttribute("src")).toMatch(/^data:image\/png;base64,/);

    type("看看这张图");
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const [, images] = (onSend as unknown as { mock: { calls: [string, unknown][] } }).mock.calls[0];
    expect(images).toEqual([{ data: expect.any(String), mimeType: "image/png" }]);
    expect(screen.queryByAltText("待发送附件")).toBeNull();
  });

  it("opens the picker instead of sending without a model", async () => {
    const { onSend } = mount({ models, defaultModel: null, sessions: [] });
    await screen.findByText("未选择模型");

    type("这条发不出去");
    fireEvent.keyDown(screen.getByPlaceholderText("先选一个模型"), { key: "Enter" });

    await waitFor(() => expect(onSend).not.toHaveBeenCalled());
    expect(await screen.findByTestId("model-menu")).toBeTruthy();
  });
});
