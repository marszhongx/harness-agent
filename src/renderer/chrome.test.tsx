// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ApprovalCard from "./components/ApprovalCard";
import Sidebar from "./components/Sidebar";
import { installMockAgent } from "./test/mock-agent";
import { resetStores } from "./test/reset";

beforeEach(() => resetStores());

const sessions = [
  { id: "session-1", title: "第一个会话", updatedAt: Date.now() },
  { id: "session-2", title: "第二个会话", updatedAt: Date.now() - 3_600_000 },
];

describe("ApprovalCard", () => {
  it("answers a confirm dialog", () => {
    const onAnswer = vi.fn();
    render(
      <ApprovalCard
        dialog={{ method: "confirm", title: "Deploy?", message: "Ship it?" }}
        onAnswer={onAnswer}
      />,
    );

    expect(screen.getByText("Deploy?")).toBeTruthy();
    expect(screen.getByText("Ship it?")).toBeTruthy();
    fireEvent.click(screen.getByText("允许"));
    expect(onAnswer).toHaveBeenCalledWith({ kind: "confirm", confirmed: true });
  });

  it("sends a deny answer", () => {
    const onAnswer = vi.fn();
    render(<ApprovalCard dialog={{ method: "confirm", title: "删除?" }} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText("拒绝"));
    expect(onAnswer).toHaveBeenCalledWith({ kind: "confirm", confirmed: false });
  });

  it("renders one button per option for a select dialog", () => {
    const onAnswer = vi.fn();
    render(
      <ApprovalCard
        dialog={{ method: "select", title: "Which branch?", options: ["main", "release"] }}
        onAnswer={onAnswer}
      />,
    );
    fireEvent.click(screen.getByText("release"));
    expect(onAnswer).toHaveBeenCalledWith({ kind: "value", value: "release" });
  });

  it("collects typed input", () => {
    const onAnswer = vi.fn();
    render(
      <ApprovalCard
        dialog={{ method: "input", title: "Commit message", placeholder: "type here" }}
        onAnswer={onAnswer}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("type here"), { target: { value: "fix: thing" } });
    fireEvent.click(screen.getByText("提交"));
    expect(onAnswer).toHaveBeenCalledWith({ kind: "value", value: "fix: thing" });
  });
});

describe("Sidebar", () => {
  const mount = (props: Partial<Parameters<typeof Sidebar>[0]> = {}) => {
    installMockAgent({ sessions });
    const handlers = {
      onNavigate: vi.fn(),
      onOpenSession: vi.fn(),
      onNewConversation: vi.fn(),
      onSessionDeleted: vi.fn(),
    };
    render(<Sidebar view="chat" sessionId={null} {...handlers} {...props} />);
    return handlers;
  };

  it("lists conversations and opens one", async () => {
    const handlers = mount();

    expect(await screen.findByText("第一个会话")).toBeTruthy();
    expect(screen.getByText("1 小时前")).toBeTruthy();
    fireEvent.click(screen.getByText("第二个会话"));
    expect(handlers.onOpenSession).toHaveBeenCalledWith("session-2");
  });

  it("highlights the new-conversation page only when it is the one shown", async () => {
    const { unmount } = render(
      <Sidebar
        view="chat"
        sessionId={null}
        onNavigate={vi.fn()}
        onOpenSession={vi.fn()}
        onNewConversation={vi.fn()}
        onSessionDeleted={vi.fn()}
      />,
    );
    expect(screen.getByText("新对话").closest("button")?.getAttribute("aria-current")).toBe("page");
    unmount();

    installMockAgent({ sessions });
    render(
      <Sidebar
        view="chat"
        sessionId="session-1"
        onNavigate={vi.fn()}
        onOpenSession={vi.fn()}
        onNewConversation={vi.fn()}
        onSessionDeleted={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("第一个会话")).toBeTruthy());
    expect(screen.getByText("新对话").closest("button")?.getAttribute("aria-current")).toBeNull();
    expect(screen.getByText("第一个会话").closest("button")?.getAttribute("aria-current")).toBe("page");
  });

  it("keeps the history one click away when collapsed", async () => {
    installMockAgent({ sessions });
    const onOpenSession = vi.fn();
    render(
      <Sidebar
        view="chat"
        sessionId={null}
        onNavigate={vi.fn()}
        onOpenSession={onOpenSession}
        onNewConversation={vi.fn()}
        onSessionDeleted={vi.fn()}
      />,
    );
    await screen.findByText("第一个会话");

    fireEvent.click(screen.getByTitle("收起侧边栏"));
    // The rail hides the list (CSS-only), so the icon has to open it again.
    fireEvent.click(screen.getByLabelText("最近会话"));

    const flyout = await screen.findByRole("dialog", { name: "最近会话" });
    fireEvent.click(within(flyout).getByText("第二个会话"));
    expect(onOpenSession).toHaveBeenCalledWith("session-2");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "最近会话" })).toBeNull());
  });

  it("deletes a conversation after confirming", async () => {
    installMockAgent({ sessions });
    const onSessionDeleted = vi.fn();
    render(
      <Sidebar
        view="chat"
        sessionId="session-1"
        onNavigate={vi.fn()}
        onOpenSession={vi.fn()}
        onNewConversation={vi.fn()}
        onSessionDeleted={onSessionDeleted}
      />,
    );
    await screen.findByText("第一个会话");

    fireEvent.click(screen.getByLabelText("删除会话 第一个会话"));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/的聊天记录会一起删除/)).toBeTruthy();

    fireEvent.click(within(dialog).getByText("删除"));
    await waitFor(() => expect(onSessionDeleted).toHaveBeenCalledWith("session-1"));
  });

  it("keeps the conversation when the dialog is cancelled", async () => {
    installMockAgent({ sessions });
    const onSessionDeleted = vi.fn();
    render(
      <Sidebar
        view="chat"
        sessionId="session-1"
        onNavigate={vi.fn()}
        onOpenSession={vi.fn()}
        onNewConversation={vi.fn()}
        onSessionDeleted={onSessionDeleted}
      />,
    );
    await screen.findByText("第一个会话");

    fireEvent.click(screen.getByLabelText("删除会话 第一个会话"));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByText("取消"));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onSessionDeleted).not.toHaveBeenCalled();
  });

  it("starts a new conversation from the nav item", () => {
    const handlers = mount({ sessionId: "session-1" });
    fireEvent.click(screen.getByText("新对话"));
    expect(handlers.onNewConversation).toHaveBeenCalled();
  });

  it("navigates to the other pages and marks the current one", async () => {
    const handlers = mount({ view: "skills" });
    fireEvent.click(screen.getByText("模型"));
    expect(handlers.onNavigate).toHaveBeenCalledWith("models");
    expect(screen.getByText("技能").closest("button")?.getAttribute("aria-current")).toBe("page");
  });

  it("marks the unbuilt sections as coming soon and keeps them inert", async () => {
    mount();
    const tags = await screen.findAllByText("Coming soon");
    expect(tags).toHaveLength(2);

    const agents = screen.getByText("Agents").closest("button") as HTMLButtonElement;
    expect(agents.disabled).toBe(true);
    fireEvent.click(agents);
    expect(agents.getAttribute("aria-current")).toBeNull();
  });
});
