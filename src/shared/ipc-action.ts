/**
 * Every channel that crosses the preload bridge, in one place.
 *
 * Main and preload are the two ends of the same wire; a typo on either side
 * would otherwise only show up as "no handler registered" at runtime. The map
 * is grouped by the channel prefix so a call site reads `IpcAction.models.removeProvider`.
 *
 * A literal const map, not a TypeScript `enum`: main and preload run through
 * Node's type stripping, which only accepts erasable syntax, and `enum` emits
 * runtime code. `as const` gives the same single source of truth and literal
 * types without that constraint.
 */
export const IpcAction = {
  agent: {
    status: "agent:status",
    history: "agent:history",
    models: "agent:models",
    defaultModel: "agent:defaultModel",
    setDefaultModel: "agent:setDefaultModel",
    prompt: "agent:prompt",
    abort: "agent:abort",
    listSessions: "agent:listSessions",
    defaultThinkingLevel: "agent:defaultThinkingLevel",
    deleteSession: "agent:deleteSession",
    chooseDraftWorkspace: "agent:chooseDraftWorkspace",
    newSession: "agent:newSession",
    setThinkingLevel: "agent:setThinkingLevel",
    setModel: "agent:setModel",
    answer: "agent:answer",
    // main -> renderer
    event: "agent:event",
    dialog: "agent:dialog",
  },
  models: {
    list: "models:list",
    upsertProvider: "models:upsertProvider",
    removeProvider: "models:removeProvider",
    addModel: "models:addModel",
    removeModel: "models:removeModel",
    test: "models:test",
  },
  skills: {
    list: "skills:list",
    remove: "skills:remove",
    reveal: "skills:reveal",
    revealApp: "skills:revealApp",
    read: "skills:read",
  },
  settings: {
    get: "settings:get",
    setTheme: "settings:setTheme",
    setLaunchAtLogin: "settings:setLaunchAtLogin",
  },
  workspace: {
    choose: "workspace:choose",
    reset: "workspace:reset",
  },
  path: {
    reveal: "path:reveal",
  },
} as const;
