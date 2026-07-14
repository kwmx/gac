import terminalKit from "terminal-kit";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { chatCompletion, listModels, getActiveModel, getActiveModelKey } from "./gpt4all.js";
import { createMarkdownRenderer } from "./markdown.js";
import { copyToClipboard, extractLastCodeBlock } from "./tui.js";
import {
  resolveContextWindow,
  resolveMaxTokens,
  contextBudget,
  trimMessagesToBudget,
} from "./contextwindow.js";
import { countBucket } from "./telemetry/buckets.js";

const { terminal: term } = terminalKit;

// ─────────────────────────────────────────────────────────────────
// Session persistence  (~/.gac/chats/<id>.json)
// ─────────────────────────────────────────────────────────────────

function getChatsDir() {
  const dir = path.join(os.homedir(), ".gac", "chats");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function sessionPath(id) {
  return path.join(getChatsDir(), `${id}.json`);
}

function createSession(name, customSystemPrompt) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: name || "New chat",
    createdAt: now,
    updatedAt: now,
    customSystemPrompt: customSystemPrompt || null,
    autoNamed: false,
    messages: [],
  };
}

function saveSession(session) {
  session.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
  } catch {}
}

function deleteSession(id) {
  try {
    fs.unlinkSync(sessionPath(id));
  } catch {}
}

function listSessions() {
  try {
    const dir = getChatsDir();
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────
// Display helpers
// ─────────────────────────────────────────────────────────────────

function tw() {
  return Math.max(40, term.width || 80);
}

function hr(char = "─", width) {
  return char.repeat(width ?? tw());
}

function relativeTime(isoStr) {
  const s = Math.round((Date.now() - new Date(isoStr).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(isoStr).toLocaleDateString();
}

function userMsgCount(session) {
  const n = session.messages.filter((m) => m.role === "user").length;
  return `${n} msg${n === 1 ? "" : "s"}`;
}

function formatSessionLabel(s) {
  const maxName = 38;
  const name = s.name.length > maxName ? `${s.name.slice(0, maxName - 3)}...` : s.name;
  const info = `${relativeTime(s.updatedAt)} · ${userMsgCount(s)}`;
  return `${name.padEnd(maxName + 2)}${info}`;
}

function printChatHeader(session, config, contextWindow) {
  const title = ` Chat: ${session.name} `;
  const ctx = contextWindow ? ` · ctx ${contextWindow}` : "";
  const model = ` model: ${getActiveModel(config)}${ctx} `;
  const fill = hr("─", Math.max(0, tw() - title.length - model.length));
  term.bold.brightCyan(title);
  term.dim(`${fill}${model}\n`);
}

function printCommandsHint() {
  const commands = ["/help", "/new", "/sessions", "/model", "/copy", "/retry", "/export", "exit"];
  const line = commands.join("  ");
  if (line.length + 1 <= tw()) {
    term.dim(` ${line}\n`);
  } else {
    term.dim(` /help for all commands\n`);
  }
}

function printHistory(session, config) {
  const msgs = session.messages.filter((m) => m.role !== "system");
  if (!msgs.length) return;

  const LIMIT = 20;
  if (msgs.length > LIMIT) {
    term.dim(`  … ${msgs.length - LIMIT} earlier messages not shown\n\n`);
  }
  const shown = msgs.slice(-LIMIT);
  const renderer = config.renderMarkdown
    ? createMarkdownRenderer(config.markdownStyles)
    : null;

  for (const msg of shown) {
    if (msg.role === "user") {
      term.bold.brightBlue("You ▶ ");
      term(`${msg.content}\n\n`);
    } else {
      term.bold.brightGreen("AI  ◀ ");
      if (renderer) {
        term(renderer.renderText(msg.content));
      } else {
        term(msg.content);
      }
      term("\n\n");
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// AI title generation
// ─────────────────────────────────────────────────────────────────

async function generateAiTitle(userMsg, aiMsg, config, contextWindow, telemetry) {
  try {
    const titleConfig = { ...config, stream: false, renderMarkdown: false, maxTokens: 12 };
    const msgs = [
      {
        role: "system",
        content:
          "You generate extremely short chat titles (2–5 words). Reply with ONLY the title — no punctuation at the end, no quotes, no explanation.",
      },
      {
        role: "user",
        content: `User: "${userMsg.slice(0, 300)}"\nAI: "${aiMsg.slice(0, 300)}"`,
      },
    ];
    const raw = await chatCompletion(titleConfig, msgs, {
      contextWindow,
      telemetry,
      telemetryAction: "chat_title",
    });
    const title = (raw || "")
      .trim()
      .replace(/^["']|["'.,!?]$/g, "")
      .trim();
    return title.length >= 2 ? title : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Chat export
// ─────────────────────────────────────────────────────────────────

function exportChat(session) {
  const msgs = session.messages.filter((m) => m.role !== "system");
  const lines = [
    `# ${session.name}`,
    ``,
    `**Model:** ${session.model || "unknown"}  `,
    `**Created:** ${new Date(session.createdAt).toLocaleString()}  `,
    `**Exported:** ${new Date().toLocaleString()}`,
    ``,
    `---`,
    ``,
  ];
  for (const msg of msgs) {
    if (msg.role === "user") {
      lines.push(`**You:** ${msg.content}`, ``);
    } else {
      lines.push(`**AI:** ${msg.content}`, ``);
    }
    lines.push(`---`, ``);
  }
  const slug = session.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `gac-export-${slug}-${ts}.md`;
  const outPath = path.join(os.homedir(), filename);
  fs.writeFileSync(outPath, lines.join("\n"));
  return outPath;
}

// ─────────────────────────────────────────────────────────────────
// TUI primitives
// ─────────────────────────────────────────────────────────────────

function inputLine(label, defaultVal) {
  return new Promise((resolve) => {
    term(label);
    const opts = { cancelable: true };
    if (defaultVal !== undefined) opts.default = String(defaultVal);
    term.inputField(opts, (error, val) => {
      term("\n");
      resolve(error || val === undefined || val === null ? "" : val.trim());
    });
  });
}

function menuSelect(items, opts = {}) {
  return new Promise((resolve) => {
    term.grabInput({ mouse: "button" });
    const cleanup = () => {
      term.grabInput(false);
      term.removeListener("key", onKey);
    };
    const onKey = (name) => {
      if (name === "CTRL_C") {
        cleanup();
        term("\n");
        term.processExit(0);
      }
    };
    term.on("key", onKey);
    term.singleColumnMenu(
      items,
      {
        cancelable: true,
        style: term.white,
        selectedStyle: term.bold.brightCyan,
        ...opts,
      },
      (error, response) => {
        term("\n");
        cleanup();
        resolve(error || !response || response.canceled ? null : response.selectedIndex);
      }
    );
  });
}

// ─────────────────────────────────────────────────────────────────
// New-chat setup  (custom system prompt)
// ─────────────────────────────────────────────────────────────────

async function promptNewChatSetup(defaultSystemPrompt) {
  term.clear();
  term.bold.cyan("\n New chat\n");
  term(`${hr()}\n\n`);

  term.dim(" Default system prompt:\n");
  const preview =
    defaultSystemPrompt && defaultSystemPrompt.length > 200
      ? `${defaultSystemPrompt.slice(0, 197)}…`
      : defaultSystemPrompt || "(none)";
  term.dim(`   ${preview}\n\n`);

  term(" Enter a custom system prompt, or press Enter to use the default:\n");
  const custom = await inputLine(" > ");

  return custom || null;
}

// ─────────────────────────────────────────────────────────────────
// Session picker
// ─────────────────────────────────────────────────────────────────

async function sessionActionMenu(session) {
  term.dim(`\n  Session: `);
  term.bold(`${session.name}\n`);
  const items = ["  Continue", "  Rename", "  Delete", "  Back"];
  const idx = await menuSelect(items);
  if (idx === null || idx === 3) return "back";
  return ["open", "rename", "delete", "back"][idx];
}

// Returns { action: "open"|"new"|"exit", session? }
async function sessionPicker(config) {
  while (true) {
    term.clear();
    const sessions = listSessions();

    term.bold.cyan("\n gac chat\n");
    term.dim(` model: ${getActiveModel(config)}\n`);
    term(`${hr()}\n`);

    const NEW_ITEM = "  + New chat";
    const EXIT_ITEM = "  Exit";
    const items = [
      NEW_ITEM,
      ...sessions.map((s) => `  ${formatSessionLabel(s)}`),
      EXIT_ITEM,
    ];

    term.dim(
      sessions.length
        ? " Select a conversation or start a new one:\n\n"
        : " No chats yet — start a new conversation:\n\n"
    );

    const idx = await menuSelect(items);

    if (idx === null || idx === items.length - 1) {
      return { action: "exit" };
    }

    if (idx === 0) {
      return { action: "new" };
    }

    const session = sessions[idx - 1];
    const action = await sessionActionMenu(session);

    if (action === "open") return { action: "open", session };

    if (action === "rename") {
      const newName = await inputLine(`  New name [${session.name}]: `);
      if (newName) {
        session.name = newName;
        saveSession(session);
      }
      continue;
    }

    if (action === "delete") {
      deleteSession(session.id);
      continue;
    }
    // "back" → loop to picker
  }
}

// ─────────────────────────────────────────────────────────────────
// Chat session loop
// ─────────────────────────────────────────────────────────────────

// Returns { action: "exit"|"picker"|"new" }
async function runChatSession(session, config, defaultSystemPrompt, telemetry) {
  // Resolved once per session (and again on /model switches); detection
  // results are cached per model, so this is at most one cheap probe.
  let contextWindow = await resolveContextWindow(config);
  let maxTokens = await resolveMaxTokens(config);
  const effectiveSystemPrompt = session.customSystemPrompt ?? defaultSystemPrompt;

  // Build the live messages array
  const messages = session.messages.length
    ? [...session.messages]
    : effectiveSystemPrompt
    ? [{ role: "system", content: effectiveSystemPrompt }]
    : [];

  if (!messages.find((m) => m.role === "system") && effectiveSystemPrompt) {
    messages.unshift({ role: "system", content: effectiveSystemPrompt });
    session.messages = [...messages];
  }

  const renderer = config.renderMarkdown
    ? createMarkdownRenderer(config.markdownStyles)
    : null;

  const isResume = session.messages.filter((m) => m.role !== "system").length > 0;
  const sessionKind = isResume ? "resumed" : "new";

  // Sanitized chat_action_completed telemetry. Never chat id/name, model,
  // system prompt, message content, or export path — only coarse buckets.
  const userCount = () => session.messages.filter((m) => m.role === "user").length;
  const trackChat = (action, outcome, extra = {}) => {
    if (!telemetry) return;
    const properties = { session_kind: sessionKind };
    if (extra.multiline !== undefined) properties.multiline = extra.multiline;
    if (extra.history_size_bucket !== undefined) {
      properties.history_size_bucket = extra.history_size_bucket;
    }
    if (extra.trimmed_message_count_bucket !== undefined) {
      properties.trimmed_message_count_bucket = extra.trimmed_message_count_bucket;
    }
    if (extra.copy_kind !== undefined) properties.copy_kind = extra.copy_kind;
    telemetry.track({
      event_name: "chat_action_completed",
      action,
      outcome,
      duration_ms: null,
      error_category: null,
      properties,
    });
  };
  const backgroundFlush = () => {
    if (telemetry) telemetry.flush({ timeoutMs: 1500 }).catch(() => {});
  };
  trackChat(isResume ? "session_resume" : "session_new", "success");

  const drawScreen = () => {
    term.clear();
    printChatHeader(session, config, contextWindow);
    term(`${hr()}\n`);
    printCommandsHint();
    term("\n");
  };

  drawScreen();

  if (isResume) {
    term.dim(" Resuming conversation\n\n");
    printHistory(session, config);
    term(`${hr("─")}\n\n`);
  }

  // Per-session input history (up/down arrow recall)
  const inputHistory = session.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content);

  term.grabInput({ mouse: "button" });
  const cleanupInput = () => {
    term.grabInput(false);
    term.removeListener("key", onKey);
  };
  const onKey = (name) => {
    if (name === "CTRL_C") {
      cleanupInput();
      term("\nBye.\n");
      term.processExit(0);
    }
  };
  term.on("key", onKey);

  while (true) {
    let wasMultiline = false;
    term.bold.brightBlue("You ▶ ");
    let input = await new Promise((resolve) => {
      term.inputField(
        { cancelable: true, history: [...inputHistory] },
        (error, val) => {
          term("\n");
          resolve(error || val === undefined || val === null ? "" : val.trim());
        }
      );
    });

    // Multi-line input: a line starting with """ collects lines verbatim
    // until a closing """ on its own line. A line that already contains its
    // own closing """ is an ordinary message and is sent as-is.
    if (input.startsWith('"""') && !input.slice(3).includes('"""')) {
      wasMultiline = true;
      const first = input.slice(3).trim();
      const collected = first ? [first] : [];
      term.dim('  Multi-line input — finish with """ on its own line.\n');
      while (true) {
        term.dim("... ");
        const line = await new Promise((resolve) => {
          term.inputField({ cancelable: true }, (error, val) => {
            term("\n");
            resolve(error || val === undefined || val === null ? '"""' : val);
          });
        });
        if (line.trim() === '"""') break;
        collected.push(line);
      }
      input = collected.join("\n").trim();
    }

    if (!input) continue;

    // ── Built-in commands ──────────────────────────────────────
    if (input === "/help") {
      term(`\n`);
      term.bold("  Commands\n");
      term.dim(`  ${"─".repeat(38)}\n`);
      const cmds = [
        ["/help",          "Show this list"],
        ["/new",           "Start a new chat"],
        ["/sessions",      "Return to session picker"],
        ["/rename [name]", "Rename this chat"],
        ["/system",        "View or set the system prompt"],
        ["/model",         "Switch models for this session"],
        ["/copy",          "Copy the last code block to the clipboard"],
        ["/clear",         "Wipe history in this chat"],
        ["/retry",         "Regenerate the last AI response"],
        ["/export",        "Save conversation to a Markdown file"],
        ['"""',            "Start multi-line input (end with \"\"\" on its own line)"],
        ["exit / quit",    "Exit gac chat"],
      ];
      for (const [cmd, desc] of cmds) {
        term.brightCyan(`    ${cmd.padEnd(22)}`);
        term.dim(`${desc}\n`);
      }
      term("\n");
      trackChat("help", "success");
      continue;
    }

    if (input === "exit" || input === "quit") {
      cleanupInput();
      term("Bye.\n");
      trackChat("session_exit", "success");
      return { action: "exit" };
    }

    if (input === "/sessions") {
      cleanupInput();
      trackChat("sessions", "success");
      return { action: "picker" };
    }

    if (input === "/new") {
      cleanupInput();
      trackChat("new", "success");
      return { action: "new" };
    }

    if (input === "/rename" || input.startsWith("/rename ")) {
      const inline = input.startsWith("/rename ") ? input.slice(8).trim() : "";
      const newName = inline || (await inputLine(`  New name [${session.name}]: `));
      if (newName) {
        session.name = newName;
        session.autoNamed = true;
        saveSession(session);
        term("\n");
        printChatHeader(session, config, contextWindow);
        term(`${hr()}\n`);
        printCommandsHint();
        term("\n");
        trackChat("rename", "success");
      } else {
        trackChat("rename", "no_op");
      }
      continue;
    }

    if (input === "/system" || input.startsWith("/system ")) {
      const arg = input.startsWith("/system ") ? input.slice(8).trim() : "";
      if (arg === "reset") {
        session.customSystemPrompt = null;
        // Rebuild messages with default prompt
        const sysIdx = messages.findIndex((m) => m.role === "system");
        if (defaultSystemPrompt) {
          if (sysIdx >= 0) messages[sysIdx] = { role: "system", content: defaultSystemPrompt };
          else messages.unshift({ role: "system", content: defaultSystemPrompt });
        } else if (sysIdx >= 0) {
          messages.splice(sysIdx, 1);
        }
        session.messages = [...messages];
        saveSession(session);
        term.dim("  System prompt reset to default.\n\n");
        trackChat("system_reset", "success");
      } else if (arg) {
        session.customSystemPrompt = arg;
        const sysIdx = messages.findIndex((m) => m.role === "system");
        if (sysIdx >= 0) messages[sysIdx] = { role: "system", content: arg };
        else messages.unshift({ role: "system", content: arg });
        session.messages = [...messages];
        saveSession(session);
        term.dim("  System prompt updated.\n\n");
        trackChat("system_set", "success");
      } else {
        // Show current
        const current =
          session.customSystemPrompt ?? defaultSystemPrompt ?? "(none)";
        term(`\n`);
        term.bold("  System prompt\n");
        term.dim(`  ${"─".repeat(38)}\n`);
        term.dim(`  ${current.replace(/\n/g, "\n  ")}\n\n`);
        term.dim('  To change: /system <new prompt>   To reset: /system reset\n\n');
        trackChat("system_view", "success");
      }
      continue;
    }

    if (input === "/model") {
      let models;
      try {
        models = await listModels(config);
      } catch (err) {
        term.red(`  Could not list models: ${err.message}\n\n`);
        continue;
      }
      if (!models.length) {
        term.dim("  No models found from the configured provider.\n\n");
        continue;
      }
      term.dim("\n  Select a model for this session:\n");
      const idx = await menuSelect(
        models.map((m) => `  ${m}`),
        { selectedIndex: Math.max(models.indexOf(getActiveModel(config)), 0) }
      );
      if (idx === null) {
        trackChat("model_switch", "cancelled");
        continue;
      }
      // Codex keeps its own model key so provider switches stay independent.
      config[getActiveModelKey(config)] = models[idx];
      // The new model may have a different context window and response cap.
      contextWindow = await resolveContextWindow(config);
      maxTokens = await resolveMaxTokens(config);
      term.dim(
        `  Model set to ${getActiveModel(config)} for this session. Use \`gac models\` to change the default.\n\n`
      );
      printChatHeader(session, config, contextWindow);
      term(`${hr()}\n`);
      printCommandsHint();
      term("\n");
      trackChat("model_switch", "success");
      continue;
    }

    if (input === "/copy") {
      const lastAi = [...messages].reverse().find((m) => m.role === "assistant");
      if (!lastAi) {
        term.dim("  Nothing to copy yet.\n\n");
        trackChat("copy", "no_op", { copy_kind: "none" });
        continue;
      }
      const block = extractLastCodeBlock(lastAi.content);
      copyToClipboard(block ?? lastAi.content.trim());
      term.dim(
        block
          ? "  Copied the last code block to the clipboard.\n\n"
          : "  No code block found — copied the whole reply.\n\n"
      );
      trackChat("copy", "success", { copy_kind: block ? "code_block" : "whole_reply" });
      continue;
    }

    if (input === "/delete") {
      cleanupInput();
      deleteSession(session.id);
      term.dim("  Chat deleted.\n");
      trackChat("delete", "success");
      return { action: "picker" };
    }

    if (input === "/clear") {
      const sysMsg = messages.find((m) => m.role === "system");
      messages.length = 0;
      if (sysMsg) messages.push(sysMsg);
      session.messages = [...messages];
      session.autoNamed = false;
      saveSession(session);
      inputHistory.length = 0;
      term.dim("  History cleared.\n\n");
      trackChat("clear", "success");
      continue;
    }

    if (input === "/retry") {
      const lastAiIdx = messages.map((m) => m.role).lastIndexOf("assistant");
      if (lastAiIdx === -1) {
        term.dim("  Nothing to retry.\n\n");
        trackChat("retry", "no_op");
        continue;
      }
      // Remove the last assistant reply so we can regenerate, but keep it so
      // we can restore it if regeneration fails.
      const [previousReply] = messages.splice(lastAiIdx, 1);
      session.messages = [...messages];
      term.dim("  Retrying…\n");
      const retryTrim = trimMessagesToBudget(
        messages,
        contextBudget(contextWindow, maxTokens)
      );
      if (retryTrim.dropped > 0) {
        term.dim(
          `  (trimmed ${retryTrim.dropped} earlier message${retryTrim.dropped === 1 ? "" : "s"} to fit the context window)\n`
        );
      }
      term.bold.brightGreen("AI  ◀ ");
      let retryReply;
      try {
        retryReply = await chatCompletion(config, retryTrim.messages, {
          contextWindow,
          telemetry,
          telemetryAction: "chat_retry",
        });
      } catch (err) {
        // Restore the previous reply so a failed retry doesn't lose it.
        messages.splice(lastAiIdx, 0, previousReply);
        session.messages = [...messages];
        term.red(`\nError: ${err.message}\n\n`);
        trackChat("retry", "failure", {
          trimmed_message_count_bucket: countBucket(retryTrim.dropped),
        });
        continue;
      }
      if (!config.stream) {
        if (renderer) {
          term(renderer.renderText(retryReply));
        } else {
          term(retryReply);
        }
      }
      if (config.debugRender) term(`\n--- RAW ---\n${retryReply}\n`);
      term("\n\n");
      if (retryReply && retryReply.trim()) {
        messages.push({ role: "assistant", content: retryReply });
        session.messages = [...messages];
        saveSession(session);
        trackChat("retry", "success", {
          trimmed_message_count_bucket: countBucket(retryTrim.dropped),
        });
      } else {
        // An empty regeneration must not destroy the answer it was meant to
        // replace — put the previous reply back.
        messages.splice(lastAiIdx, 0, previousReply);
        session.messages = [...messages];
        saveSession(session);
        term.dim("  Retry returned nothing; keeping the previous reply.\n\n");
        trackChat("retry", "no_op", {
          trimmed_message_count_bucket: countBucket(retryTrim.dropped),
        });
      }
      backgroundFlush();
      continue;
    }

    if (input === "/export") {
      try {
        // Attach model name for export metadata
        session.model = getActiveModel(config);
        const outPath = exportChat(session);
        term.dim(`  Exported to: `);
        term.brightCyan(`${outPath}\n\n`);
        trackChat("export", "success");
      } catch (err) {
        term.red(`  Export failed: ${err.message}\n\n`);
        trackChat("export", "failure", {});
      }
      continue;
    }

    // ── Regular message ────────────────────────────────────────
    messages.push({ role: "user", content: input });
    inputHistory.push(input);

    // The full history stays in the session; only the request is trimmed to
    // fit the model's context window.
    const trimmed = trimMessagesToBudget(
      messages,
      contextBudget(contextWindow, maxTokens)
    );
    if (trimmed.dropped > 0) {
      term.dim(
        `  (trimmed ${trimmed.dropped} earlier message${trimmed.dropped === 1 ? "" : "s"} to fit the context window)\n`
      );
    }

    term.bold.brightGreen("AI  ◀ ");

    const messageProps = {
      multiline: wasMultiline,
      history_size_bucket: countBucket(userCount()),
      trimmed_message_count_bucket: countBucket(trimmed.dropped),
    };

    let reply;
    try {
      reply = await chatCompletion(config, trimmed.messages, {
        contextWindow,
        telemetry,
        telemetryAction: "chat_message",
      });
    } catch (err) {
      term.red(`\nError: ${err.message}\n\n`);
      messages.pop();
      inputHistory.pop();
      trackChat("message", "failure", messageProps);
      continue;
    }

    if (!config.stream) {
      if (renderer) {
        term(renderer.renderText(reply));
      } else {
        term(reply);
      }
    }

    if (config.debugRender) term(`\n--- RAW ---\n${reply}\n`);

    if (!reply || !reply.trim()) {
      term.dim(
        "\nNo response from the model. The request may have timed out or returned empty content.\n"
      );
    }

    term("\n\n");

    if (reply && reply.trim()) {
      messages.push({ role: "assistant", content: reply });
      session.messages = [...messages];
      saveSession(session);
      trackChat("message", "success", messageProps);

      // Generate and apply title after the first exchange (awaited to avoid
      // concurrent requests to the LLM server, which often handles only one at a time)
      if (!session.autoNamed && messages.filter((m) => m.role === "user").length === 1) {
        const title = await generateAiTitle(input, reply, config, contextWindow, telemetry);
        if (title) {
          session.name = title;
          session.autoNamed = true;
          saveSession(session);
          term("\n");
          printChatHeader(session, config, contextWindow);
          term(`${hr()}\n`);
          printCommandsHint();
          term("\n");
        }
      }
    } else {
      trackChat("message", "no_op", messageProps);
    }
    backgroundFlush();
  }
}

// ─────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────

export async function runChat(config, defaultSystemPrompt, opts = {}) {
  const telemetry = opts.telemetry;
  // chat exits via term.processExit(), so the top-level command_completed event
  // and final flush are emitted here rather than back in cli.js.
  const finalizeChat = async () => {
    if (!telemetry) return;
    telemetry.track({
      event_name: "command_completed",
      action: "chat",
      outcome: "success",
      duration_ms: null,
      error_category: null,
      properties: {},
    });
    await telemetry.flush({ timeoutMs: 300 });
  };

  let state = "picker";
  let session = null;

  while (true) {
    if (state === "picker") {
      const result = await sessionPicker(config);
      if (result.action === "exit") {
        await finalizeChat();
        term.processExit(0);
        return;
      }

      if (result.action === "new") {
        const customPrompt = await promptNewChatSetup(defaultSystemPrompt);
        session = createSession("New chat", customPrompt);
        saveSession(session);
        state = "chat";
      } else {
        session = result.session;
        state = "chat";
      }
    } else {
      const result = await runChatSession(session, config, defaultSystemPrompt, telemetry);
      if (result.action === "exit") {
        await finalizeChat();
        term.processExit(0);
        return;
      }

      if (result.action === "new") {
        const customPrompt = await promptNewChatSetup(defaultSystemPrompt);
        session = createSession("New chat", customPrompt);
        saveSession(session);
        // stay in "chat" state
      } else {
        state = "picker";
      }
    }
  }
}
