/** Minimal extension host: enough ExtensionAPI/ExtensionCommandContext for unit tests. */

export function fakePi({ exec } = {}) {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();

  return {
    commands,
    tools,
    handlers,
    registerCommand(name, definition) {
      commands.set(name, definition);
      return definition;
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
      return definition;
    },
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    async exec(command, args, options) {
      if (exec) return exec.exec(command, args, options);
      return { code: 1, stdout: "", stderr: "not a git repository", killed: false, truncated: false };
    },
  };
}

export function fakeCommandContext({ cwd = process.cwd() } = {}) {
  const notifications = [];
  return {
    notifications,
    ctx: {
      cwd,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    },
  };
}
