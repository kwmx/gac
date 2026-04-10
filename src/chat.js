import terminalKit from "terminal-kit";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { chatCompletion } from "./gpt4all.js";
import { createMarkdownRenderer } from "./markdown.js";

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

function createSession(name) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: name || "New chat",
    createdAt: now,
    updatedAt: now,
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

function printChatHeader(session, config) {
  const title = ` Chat: ${session.name} `;
  const model = ` model: ${config.model} `;
  const fill = hr("─", Math.max(0, tw() - title.length - model.length));
  term.bold.brightCyan(title);
  term.dim(`${fill}${model}\n`);
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
// TUI primitives
// ─────────────────────────────────────────────────────────────────

function inputLine(label) {
  return new Promise((resolve) => {
    term(label);
    term.inputField({ cancelable: true }, (error, val) => {
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
    term.dim(` model: ${config.model}\n`);
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

    if (action === "open") {
      return { action: "open", session };
    }

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
async function runChatSession(session, config, systemPrompt) {
  term.clear();
  printChatHeader(session, config);
  term(`${hr()}\n`);

  const isResume = session.messages.filter((m) => m.role !== "system").length > 0;
  if (isResume) {
    term.dim(" Resuming conversation\n\n");
    printHistory(session, config);
    term(`${hr()}\n\n`);
  } else {
    term.dim(' Type "/help" for commands · Ctrl+C to exit\n\n');
  }

  // Build the live messages array from stored session
  const messages = session.messages.length
    ? [...session.messages]
    : systemPrompt
    ? [{ role: "system", content: systemPrompt }]
    : [];

  if (!messages.find((m) => m.role === "system") && systemPrompt) {
    messages.unshift({ role: "system", content: systemPrompt });
    session.messages = [...messages];
  }

  const renderer = config.renderMarkdown
    ? createMarkdownRenderer(config.markdownStyles)
    : null;

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
    term.bold.brightBlue("You ▶ ");
    const input = await new Promise((resolve) => {
      term.inputField({ cancelable: true }, (error, val) => {
        term("\n");
        resolve(error || val === undefined || val === null ? "" : val.trim());
      });
    });

    if (!input) continue;

    // ── Built-in commands ──────────────────────────────────────
    if (input === "/help") {
      term.dim(`\n  Commands:\n`);
      term.dim(`    /new           Start a new chat\n`);
      term.dim(`    /sessions      Return to session picker\n`);
      term.dim(`    /rename        Rename this chat\n`);
      term.dim(`    /delete        Delete this chat and return to picker\n`);
      term.dim(`    /clear         Clear history in this chat\n`);
      term.dim(`    exit / quit    Exit gac chat\n\n`);
      continue;
    }

    if (input === "exit" || input === "quit") {
      cleanupInput();
      term("Bye.\n");
      return { action: "exit" };
    }

    if (input === "/sessions") {
      cleanupInput();
      return { action: "picker" };
    }

    if (input === "/new") {
      cleanupInput();
      return { action: "new" };
    }

    if (input === "/rename" || input.startsWith("/rename ")) {
      const inline = input.startsWith("/rename ") ? input.slice(8).trim() : "";
      const newName = inline || (await inputLine(`  New name [${session.name}]: `));
      if (newName) {
        session.name = newName;
        saveSession(session);
        term(`\n`);
        printChatHeader(session, config);
        term(`${hr()}\n\n`);
      }
      continue;
    }

    if (input === "/delete") {
      cleanupInput();
      deleteSession(session.id);
      term.dim("  Chat deleted.\n");
      return { action: "picker" };
    }

    if (input === "/clear") {
      const sysMsg = messages.find((m) => m.role === "system");
      messages.length = 0;
      if (sysMsg) messages.push(sysMsg);
      session.messages = [...messages];
      saveSession(session);
      term.dim("  History cleared.\n\n");
      continue;
    }

    // ── Regular message ────────────────────────────────────────
    messages.push({ role: "user", content: input });

    // Auto-name from first user message
    if (
      messages.filter((m) => m.role === "user").length === 1 &&
      session.name === "New chat"
    ) {
      session.name = input.length > 42 ? `${input.slice(0, 39)}...` : input;
      printChatHeader(session, config);
      term(`${hr()}\n\n`);
    }

    term.bold.brightGreen("AI  ◀ ");

    let reply;
    try {
      reply = await chatCompletion(config, messages);
    } catch (err) {
      term.red(`\nError: ${err.message}\n\n`);
      messages.pop();
      continue;
    }

    if (!config.stream) {
      if (renderer) {
        term(renderer.renderText(reply));
      } else {
        term(reply);
      }
    }

    if (config.debugRender) {
      term(`\n--- RAW ---\n${reply}\n`);
    }

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
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────

export async function runChat(config, systemPrompt) {
  let state = "picker";
  let session = null;

  while (true) {
    if (state === "picker") {
      const result = await sessionPicker(config);
      if (result.action === "exit") {
        term.processExit(0);
      }
      if (result.action === "new") {
        session = createSession("New chat");
        saveSession(session);
        state = "chat";
      } else {
        session = result.session;
        state = "chat";
      }
    } else {
      const result = await runChatSession(session, config, systemPrompt);
      if (result.action === "exit") {
        term.processExit(0);
      }
      if (result.action === "new") {
        session = createSession("New chat");
        saveSession(session);
        // stay in "chat" state
      } else {
        state = "picker";
      }
    }
  }
}
