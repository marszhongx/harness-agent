// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSummary } from "./lib/agent";
import ModelsPage from "./pages/ModelsPage";
import SettingsPage from "./pages/SettingsPage";
import SkillsPage from "./pages/SkillsPage";
import { installMockAgent } from "./test/mock-agent";
import { resetStores } from "./test/reset";

beforeEach(() => resetStores());

const provider = {
  id: "hifox",
  baseUrl: "http://127.0.0.1:8090/v1",
  api: "openai-completions",
  hasKey: true,
  models: [{ id: "glm-5.3-flash", name: "glm-5.3-flash", contextWindow: 1310720 }],
};

describe("ModelsPage", () => {
  it("lists providers with their models and never shows the key", async () => {
    installMockAgent({ providers: [provider] });
    render(<ModelsPage />);

    expect(await screen.findByText("hifox")).toBeTruthy();
    expect(screen.getByText("已配置")).toBeTruthy();
    expect(screen.getByText("glm-5.3-flash")).toBeTruthy();
    expect(screen.getByText("1280k")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret");
  });

  it("adds a model to a provider", async () => {
    let current: ProviderSummary[] = [provider];
    const mock = installMockAgent({ providers: [provider] });
    // The store re-reads the file after a write; the mock has to behave like
    // main does and reflect the write in the next list.
    mock.api.modelsList = vi.fn(async () => current);
    mock.api.addModel = vi.fn(async (_providerId: string, model: { id: string }) => {
      current = [{ ...provider, models: [...provider.models, { id: model.id, name: model.id }] }];
    });
    render(<ModelsPage />);
    await screen.findByText("hifox");

    // The form is folded away until the row asks for it.
    fireEvent.click(screen.getByLabelText("给 hifox 添加模型"));
    const form = screen.getByPlaceholderText("模型 id").closest("form") as HTMLFormElement;
    fireEvent.change(within(form).getByPlaceholderText("模型 id"), { target: { value: "probe-model" } });
    fireEvent.submit(form);

    await waitFor(() =>
      expect(mock.api.addModel).toHaveBeenCalledWith("hifox", {
        id: "probe-model",
        name: undefined,
        contextWindow: undefined,
      }),
    );
    expect(await screen.findByText("probe-model")).toBeTruthy();
  });

  it("requires a second click before removing a provider", async () => {
    let current: ProviderSummary[] = [provider];
    const mock = installMockAgent({ providers: [provider] });
    mock.api.modelsList = vi.fn(async () => current);
    mock.api.removeProvider = vi.fn(async () => {
      current = [];
    });
    render(<ModelsPage />);
    await screen.findByText("hifox");

    const remove = screen.getByLabelText("删除 hifox");
    fireEvent.click(remove);
    expect(mock.api.removeProvider).not.toHaveBeenCalled();
    expect(screen.getByLabelText("确认删除 hifox")).toBeTruthy();

    fireEvent.click(remove);
    await waitFor(() => expect(mock.api.removeProvider).toHaveBeenCalledWith("hifox"));
    expect(await screen.findByText(/还没有接入模型服务/)).toBeTruthy();
  });

  it("surfaces a write error instead of crashing", async () => {
    const mock = installMockAgent({ providers: [provider] });
    mock.api.saveProvider = vi.fn(async () => {
      throw new Error("磁盘只读");
    });
    render(<ModelsPage />);
    await screen.findByText("hifox");

    fireEvent.click(screen.getByLabelText("新增 provider"));
    const form = screen.getByPlaceholderText("my-gateway").closest("form") as HTMLFormElement;
    fireEvent.change(within(form).getByPlaceholderText("my-gateway"), { target: { value: "local" } });
    fireEvent.change(within(form).getByPlaceholderText("https://host/v1"), {
      target: { value: "http://x/v1" },
    });
    fireEvent.submit(form);

    expect(await screen.findByText("磁盘只读")).toBeTruthy();
  });
});

describe("SkillsPage", () => {
  it("lists skills with scope and opens the folder", async () => {
    const mock = installMockAgent({
      skills: [
        {
          name: "pdf-tools",
          description: "Read PDFs.",
          dir: "/ws/.pi/skills/pdf-tools",
          scope: "project",
          manualOnly: true,
        },
      ],
    });
    render(<SkillsPage />);

    expect(await screen.findByText("pdf-tools")).toBeTruthy();
    expect(screen.getByText("项目")).toBeTruthy();
    expect(screen.getByText("仅手动调用")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("查看 pdf-tools 详情"));
    const dialog = await screen.findByRole("dialog");
    // The dialog shows the file itself, not a summary of it.
    expect(within(dialog).getByText(/# body/)).toBeTruthy();
    expect(within(dialog).queryByText("/ws/.pi/skills/pdf-tools")).toBeNull();
    expect(mock.api.readSkill).toHaveBeenCalledWith("/ws/.pi/skills/pdf-tools");

    fireEvent.click(within(dialog).getByLabelText("关闭"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("drops a removed skill from the shared list", async () => {
    const skill = {
      name: "pdf-tools",
      description: "Read PDFs.",
      dir: "/ws/.pi/skills/pdf-tools",
      scope: "project" as const,
      manualOnly: false,
    };
    let current = [skill];
    const mock = installMockAgent({ skills: [skill] });
    mock.api.skillsList = vi.fn(async () => current);
    mock.api.removeSkill = vi.fn(async () => {
      current = [];
    });
    render(<SkillsPage />);

    await screen.findByText("pdf-tools");
    fireEvent.click(screen.getByLabelText("删除 pdf-tools"));

    await waitFor(() => expect(mock.api.removeSkill).toHaveBeenCalledWith("/ws/.pi/skills/pdf-tools"));
    await waitFor(() => expect(screen.queryByText("pdf-tools")).toBeNull());
  });
});

describe("SettingsPage", () => {
  it("shows the workspace and versions, and changes the theme", async () => {
    const mock = installMockAgent();
    mock.api.setTheme = vi.fn(async (theme: "system" | "light" | "dark") => ({
      ...(await mock.api.settings()),
      theme,
    }));
    render(<SettingsPage />);

    expect(await screen.findByText("0.0.0")).toBeTruthy();
    expect(screen.getByText("40.0.0")).toBeTruthy();
    expect(screen.getByText("24.0.0")).toBeTruthy();
    expect(screen.getByText(/\/tmp\/workspace/)).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "dark" } });
    await waitFor(() => expect(mock.api.setTheme).toHaveBeenCalledWith("dark"));
  });
});
