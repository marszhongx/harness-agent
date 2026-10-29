// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSummary } from "./lib/agent";
import ModelPage from "./pages/ModelPage";
import SettingsPage from "./pages/SettingsPage";
import SkillsPage from "./pages/SkillsPage";
import { useModel } from "./store/model";
import { probeKey, useProbe } from "./store/probe";
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

describe("ModelPage", () => {
  it("lists providers and their models in the details dialog", async () => {
    installMockAgent({ providers: [provider] });
    render(<ModelPage />);

    expect(await screen.findByText("hifox")).toBeTruthy();
    expect(screen.queryByText("已配置")).toBeNull();
    // The provider card lists its models; the dialog is for managing them.
    expect(screen.getByText("glm-5.3-flash")).toBeTruthy();
    expect(screen.getByText("1280k")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("glm-5.3-flash")).toBeTruthy();
    expect(within(dialog).getByText("1280k")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret");
  });

  it("edits the provider baseUrl, api and key", async () => {
    let current: ProviderSummary[] = [provider];
    const mock = installMockAgent({ providers: [provider] });
    mock.api.modelsList = vi.fn(async () => current);
    mock.api.saveProvider = vi.fn(
      async (id: string, input: { baseUrl: string; api: string; apiKey?: string }) => {
        current = current.map((entry) =>
          entry.id === id
            ? { ...entry, baseUrl: input.baseUrl, api: input.api, hasKey: Boolean(input.apiKey) }
            : entry,
        );
      },
    );
    render(<ModelPage />);
    await screen.findByText("hifox");

    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("baseUrl"), {
      target: { value: "http://new/v1" },
    });
    fireEvent.change(within(dialog).getByLabelText("api"), {
      target: { value: "anthropic-messages" },
    });
    fireEvent.change(within(dialog).getByLabelText("apiKey"), {
      target: { value: "secret-2" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(mock.api.saveProvider).toHaveBeenCalledWith("hifox", {
        baseUrl: "http://new/v1",
        api: "anthropic-messages",
        apiKey: "secret-2",
      }),
    );
  });

  it("opens the details dialog for a newly created provider", async () => {
    let current: ProviderSummary[] = [];
    const mock = installMockAgent({ providers: [] });
    mock.api.modelsList = vi.fn(async () => current);
    mock.api.saveProvider = vi.fn(
      async (id: string, input: { baseUrl: string; api: string; apiKey?: string }) => {
        current = [{ id, baseUrl: input.baseUrl, api: input.api, hasKey: Boolean(input.apiKey), models: [] }];
      },
    );
    render(<ModelPage />);
    await screen.findByText(/还没有接入模型服务/);

    fireEvent.click(screen.getByLabelText("新增 provider"));
    const form = screen.getByPlaceholderText("my-gateway").closest("form") as HTMLFormElement;
    fireEvent.change(within(form).getByPlaceholderText("my-gateway"), { target: { value: "local" } });
    fireEvent.change(within(form).getByPlaceholderText("https://host/v1"), {
      target: { value: "http://127.0.0.1/v1" },
    });
    fireEvent.submit(form);

    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("baseUrl") as HTMLInputElement).value).toBe("http://127.0.0.1/v1");
    expect(within(dialog).getByText("还没有模型")).toBeTruthy();
  });

  it("adds a model from the provider details", async () => {
    let current: ProviderSummary[] = [provider];
    const mock = installMockAgent({ providers: [provider] });
    // The store re-reads the file after a write; the mock has to behave like
    // main does and reflect the write in the next list.
    mock.api.modelsList = vi.fn(async () => current);
    mock.api.addModel = vi.fn(async (_providerId: string, model: { id: string }) => {
      current = [{ ...provider, models: [...provider.models, { id: model.id, name: model.id }] }];
    });
    render(<ModelPage />);
    await screen.findByText("hifox");

    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("添加模型"));
    fireEvent.change(within(dialog).getByLabelText("新模型 id"), {
      target: { value: "probe-model" },
    });
    fireEvent.click(within(dialog).getByLabelText("保存新模型"));

    await waitFor(() =>
      expect(mock.api.addModel).toHaveBeenCalledWith("hifox", {
        id: "probe-model",
        name: undefined,
        contextWindow: undefined,
      }),
    );
    expect(await within(dialog).findByText("probe-model")).toBeTruthy();
  });

  it("keeps multiple pending rows alongside the saved models", async () => {
    let current: ProviderSummary[] = [provider];
    const mock = installMockAgent({ providers: [provider] });
    mock.api.modelsList = vi.fn(async () => current);
    mock.api.addModel = vi.fn(async (_providerId: string, model: { id: string; name?: string }) => {
      current = [
        {
          ...current[0],
          models: [...current[0].models, { id: model.id, name: model.name ?? model.id }],
        },
      ];
    });
    render(<ModelPage />);
    await screen.findByText("hifox");

    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("添加模型"));
    fireEvent.click(within(dialog).getByLabelText("添加模型"));

    const ids = within(dialog).getAllByLabelText("新模型 id");
    expect(ids).toHaveLength(2);
    // Saved rows and pending rows share the table.
    expect(within(dialog).getByText("glm-5.3-flash")).toBeTruthy();

    fireEvent.change(ids[0], { target: { value: "first" } });
    fireEvent.change(ids[1], { target: { value: "second" } });
    expect(within(dialog).getByDisplayValue("second")).toBeTruthy();

    fireEvent.click(within(dialog).getAllByLabelText("保存新模型")[0]);
    await waitFor(() =>
      expect(mock.api.addModel).toHaveBeenCalledWith("hifox", {
        id: "first",
        name: undefined,
        contextWindow: undefined,
      }),
    );
    await waitFor(() => expect(within(dialog).getAllByLabelText("新模型 id")).toHaveLength(1));
    expect(within(dialog).getByText("first")).toBeTruthy();

    fireEvent.click(within(dialog).getByLabelText("保存新模型"));
    await waitFor(() => expect(mock.api.addModel).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(dialog).queryAllByLabelText("新模型 id")).toHaveLength(0));
    expect(within(dialog).getByText("second")).toBeTruthy();
  });

  it("drops a model's probe result when the model is removed", async () => {
    let current: ProviderSummary[] = [provider];
    const mock = installMockAgent({ providers: [provider] });
    mock.api.modelsList = vi.fn(async () => current);
    mock.api.removeModel = vi.fn(async () => {
      current = [{ ...provider, models: [] }];
    });
    useProbe.setState({
      results: new Map([[probeKey("hifox", "glm-5.3-flash"), { ok: true }]]),
    });
    render(<ModelPage />);
    await screen.findByText("hifox");

    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("status", { name: "可用" })).toBeTruthy();

    fireEvent.click(within(dialog).getByLabelText("移除模型 glm-5.3-flash"));
    await waitFor(() => expect(mock.api.removeModel).toHaveBeenCalledWith("hifox", "glm-5.3-flash"));
    await waitFor(() =>
      expect(useProbe.getState().results.has(probeKey("hifox", "glm-5.3-flash"))).toBe(false),
    );
  });

  it("scrolls a newly added pending row into view", async () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;

    try {
      installMockAgent({ providers: [provider] });
      render(<ModelPage />);
      await screen.findByText("hifox");

      fireEvent.click(screen.getByRole("button", { name: "详情" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByLabelText("添加模型"));

      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("requires a second click before removing a provider", async () => {
    let current: ProviderSummary[] = [provider];
    const mock = installMockAgent({ providers: [provider] });
    mock.api.modelsList = vi.fn(async () => current);
    mock.api.removeProvider = vi.fn(async () => {
      current = [];
    });
    render(<ModelPage />);
    await screen.findByText("hifox");

    const remove = screen.getByLabelText("删除 hifox");
    fireEvent.click(remove);
    expect(mock.api.removeProvider).not.toHaveBeenCalled();
    expect(screen.getByLabelText("确认删除 hifox")).toBeTruthy();

    fireEvent.click(remove);
    await waitFor(() => expect(mock.api.removeProvider).toHaveBeenCalledWith("hifox"));
    expect(await screen.findByText(/还没有接入模型服务/)).toBeTruthy();
  });

  it("tests several selected models from one provider", async () => {
    const multi = {
      ...provider,
      models: [...provider.models, { id: "glm-5.3", name: "glm-5.3" }],
    };
    const mock = installMockAgent({ providers: [multi] });
    mock.api.testModel = vi.fn(async () => ({ ok: true, reply: "MODEL_OK" }));
    render(<ModelPage />);
    await screen.findByText("hifox");

    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("全选模型"));
    fireEvent.click(within(dialog).getByRole("button", { name: "测试选中的模型" }));

    await waitFor(() => expect(mock.api.testModel).toHaveBeenCalledTimes(2));
    expect(mock.api.testModel).toHaveBeenCalledWith("hifox", "glm-5.3-flash");
    expect(mock.api.testModel).toHaveBeenCalledWith("hifox", "glm-5.3");
    expect(await within(dialog).findAllByRole("status", { name: "可用" })).toHaveLength(2);
    // The provider card's model chips subscribe to the same probe store, so the
    // page shows the results before the dialog even closes.
    expect(screen.getAllByRole("status", { name: "可用" })).toHaveLength(4);
    expect(useProbe.getState().results.get(probeKey("hifox", "glm-5.3-flash"))?.ok).toBe(true);
    // The catalogue itself never sees availability; only the probe store does.
    expect(useModel.getState().providers).toEqual([multi]);

    // Closing the dialog leaves the results on the provider card.
    fireEvent.click(within(dialog).getByLabelText("关闭"));
    expect(screen.getAllByRole("status", { name: "可用" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    const reopened = await screen.findByRole("dialog");
    expect(await within(reopened).findAllByRole("status", { name: "可用" })).toHaveLength(2);
  });

  it("shows loading only for the model currently being tested", async () => {
    const multi = {
      ...provider,
      models: [...provider.models, { id: "glm-5.3", name: "glm-5.3" }],
    };
    const mock = installMockAgent({ providers: [multi] });
    const releases: Array<() => void> = [];
    mock.api.testModel = vi.fn(
      () =>
        new Promise<{ ok: boolean; reply: string }>((resolve) => {
          releases.push(() => resolve({ ok: true, reply: "MODEL_OK" }));
        }),
    );
    render(<ModelPage />);
    await screen.findByText("hifox");

    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("全选模型"));
    fireEvent.click(within(dialog).getByRole("button", { name: "测试选中的模型" }));

    await waitFor(() => expect(mock.api.testModel).toHaveBeenCalledTimes(1));
    const loading = within(dialog).getAllByRole("status", { name: "测试中" });
    expect(loading).toHaveLength(1);
    expect(loading[0].querySelector("svg")).toBeTruthy();
    // The chip for the same model mirrors it; the queued model has no status.
    expect(screen.getAllByRole("status", { name: "测试中" })).toHaveLength(2);
    expect(within(dialog).getByText("glm-5.3")).toBeTruthy();

    act(() => releases.shift()?.());

    await waitFor(() => expect(mock.api.testModel).toHaveBeenCalledTimes(2));
    expect(within(dialog).getAllByRole("status", { name: "测试中" })).toHaveLength(1);

    act(() => releases.shift()?.());

    await waitFor(() => expect(within(dialog).getAllByRole("status", { name: "可用" })).toHaveLength(2));
    expect(screen.queryByRole("status", { name: "测试中" })).toBeNull();
  });

  it("shows why a model test failed", async () => {
    const mock = installMockAgent({ providers: [provider] });
    mock.api.testModel = vi.fn(async () => ({ ok: false, error: "401 unauthorized" }));
    render(<ModelPage />);
    await screen.findByText("hifox");

    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("全选模型"));
    fireEvent.click(within(dialog).getByRole("button", { name: "测试选中的模型" }));

    const failed = await within(dialog).findByRole("status", { name: "失败" });
    expect(failed.getAttribute("title")).toBe("401 unauthorized");
    expect(useProbe.getState().results.get(probeKey("hifox", "glm-5.3-flash"))?.error).toBe(
      "401 unauthorized",
    );
  });

  it("surfaces a write error instead of crashing", async () => {
    const mock = installMockAgent({ providers: [provider] });
    mock.api.saveProvider = vi.fn(async () => {
      throw new Error("磁盘只读");
    });
    render(<ModelPage />);
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

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/的目录会被删除/)).toBeTruthy();
    fireEvent.click(within(dialog).getByText("删除"));

    await waitFor(() => expect(mock.api.removeSkill).toHaveBeenCalledWith("/ws/.pi/skills/pdf-tools"));
    await waitFor(() => expect(screen.queryByText("pdf-tools")).toBeNull());
  });
});

describe("SettingsPage", () => {
  it("shows the workspace and versions, and changes the theme", async () => {
    const mock = installMockAgent();
    mock.api.setTheme = vi.fn(async () => undefined);
    render(<SettingsPage />);

    expect(await screen.findByText("0.0.0")).toBeTruthy();
    expect(screen.getByText("40.0.0")).toBeTruthy();
    expect(screen.getByText("24.0.0")).toBeTruthy();
    expect(screen.getByText(/\/tmp\/workspace/)).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "dark" } });
    await waitFor(() => expect(mock.api.setTheme).toHaveBeenCalledWith("dark"));
  });

  it("changes and resets the default workspace", async () => {
    const mock = installMockAgent();
    let current = { ...(await mock.api.settings()) };
    mock.api.settings = vi.fn(async () => current);
    mock.api.chooseWorkspace = vi.fn(async () => {
      current = {
        ...current,
        workspacePath: "/tmp/picked-workspace",
        workspaceIsCustom: true,
      };
    });
    mock.api.resetWorkspace = vi.fn(async () => {
      current = { ...current, workspacePath: "/tmp/workspace", workspaceIsCustom: false };
    });
    render(<SettingsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "更改" }));
    await waitFor(() => expect(mock.api.chooseWorkspace).toHaveBeenCalled());
    expect(await screen.findByText("/tmp/picked-workspace")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    await waitFor(() => expect(mock.api.resetWorkspace).toHaveBeenCalled());
  });
});
