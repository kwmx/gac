import terminalKit from "terminal-kit";
import { chatCompletion, listModels } from "./gpt4all.js";
import { getConfigPath, loadConfig, setConfigValue } from "./config.js";
import { createMarkdownRenderer } from "./markdown.js";
import os from "os";
import process from "process";
const { terminal: term } = terminalKit;

function printHelp() {
  term(`gac - GPT4All CLI\n\n`);
  term(`Options:\n`);
  term(`  -a                Single prompt mode (alias for ask)\n`);
  term(`  suggest           Suggestion mode\n`);
  term(`  explain           Explanation mode\n`);
  term(`  ask               Ask mode\n`);
  term(`  chat              Interactive chat mode\n`);
  term(`  models            List models and set default\n`);
  term(`  config            View or edit configuration\n`);
  term(`  --no-render      Disable markdown rendering\n`);
  term(`  --debug-render   Show both rendered and raw output\n`);
  term(
    `  -d, --detailed-suggest  Provide more detailed suggestions (only in suggest mode)\n`
  );
  term(`  -h, --help        Show this help message\n`);
  term(`\n`);
  term(`Usage:\n`);
  term(`  gac -a "Hello gpt4all"\n`);
  term(`  gac suggest "How do I connect to ssh server on port 5322"\n`);
  term(`  gac explain "How do I use rsync?"\n`);
  term(`  gac ask "What is the best way to learn JavaScript?"\n`);
  term(`  gac chat\n`);
  term(`  gac models\n`);
  term(`  gac config\n`);
  term(`  gac config get <key>\n`);
  term(`  gac config set <key> <value>\n`);
  term(`  gac --no-render -a "Raw markdown output"\n`);
  term(`  gac --debug-render -a "Show rendered and raw output"\n`);
  term(`\n`);
}
function getOSVersion() {
  const platform = os.platform();
  if (platform === "win32") {
    // Which version of Windows?
    if (process.env.OS_VERSION) {
      return `${platform}: ${process.env.OS_VERSION}`;
    } else if (process.env.OS_RELEASE) {
      return `${platform}: ${process.env.OS_RELEASE}`;
    } else if (process.env.OS) {
      return `${platform}: ${process.env.OS}`;
    } else {
      return "Windows";
    }
  } else if (platform === "darwin") {
    if (process.env.OS_VERSION) {
      return `${platform}: ${process.env.OS_VERSION}`;
    }
    if (process.env.OS_RELEASE) {
      return `${platform}: ${process.env.OS_RELEASE}`;
    }
    if (process.env.OS) {
      return `${platform}: ${process.env.OS}`;
    }
    return "macOS";
  }
  if (platform === "linux") {
    // Find which distro
    if (process.env.OS_RELEASE) {
      return `${platform}: ${process.env.OS_RELEASE}`;
    } else if (process.env.OS) {
      return `${platform}: ${process.env.OS}`;
    } else if (process.env.LINUX_DISTRO) {
      return `${platform}: ${process.env.LINUX_DISTRO}`;
    }
    return `Linux`;
  }
  if (platform === "freebsd") {
    return "FreeBSD";
  }
  if (platform === "sunos") {
    return "SunOS";
  }
  if (platform === "aix") {
    return "AIX";
  }
  return "Unknown OS";
}
function buildSystemPrompt(mode, config) {
  const osInfo = getOSVersion();

  if (mode === "suggest") {
    if (config.detailedSuggest === true) {
      return `You are an expert technical assistant. The user is using a system with the following OS: ${osInfo}. When providing suggestions, give detailed, step-by-step instructions that the user can follow to achieve their goals. Include relevant commands, code snippets, or configurations as needed. Avoid unnecessary explanations or background information. Tailor your suggestions to be relevant to the user's operating system and environment.
Attempt to make it a single line response where possible. Prefer commands and code snippets over lengthy explanations. Always leave commands and codes in their own line for easy copying.`;
    } else {
      return `You are an expert technical assistant. The user is using a system with the following OS: ${osInfo}. Provide concise and practical suggestions to help the user accomplish their tasks efficiently. Focus on clarity and brevity, ensuring that your suggestions are easy to understand and implement. Tailor your suggestions to be relevant to the user's operating system and environment. Avoid lengthy explanations or unnecessary details prefer single line commands or codes if you must include explainations make sure the commands and codes are in their own line for easy copying.`;
    }
  }
  if (mode === "ask") {
    return "Provide a helpful and accurate response to the user's question.";
  }
  if (mode === "explain") {
    return "Explain step-by-step with a short example if helpful.";
  }
  return null;
}

async function runSinglePrompt(mode, prompt, config) {
  const system = buildSystemPrompt(mode, config);
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const reply = await chatCompletion(config, messages);
  if (!config.stream) {
    if (config.renderMarkdown) {
      const renderer = createMarkdownRenderer(config.markdownStyles);
      term(`${renderer.renderText(reply)}\n`);
    } else {
      term(`${reply}\n`);
    }
  }
  if (config.debugRender) {
    term(`\n--- RAW ---\n${reply}\n`);
  }
  term(`\n`);
}

async function inputLine(label) {
  term(label);
  return new Promise((resolve) => {
    term.inputField({ cancelable: true }, (error, input) => {
      term("\n");
      if (error || input === undefined || input === null) {
        resolve("");
        return;
      }
      resolve(input.trim());
    });
  });
}

async function runChat(config) {
  term('Interactive chat. Type "exit" to quit.\n\n');
  const messages = [];
  term.grabInput({ mouse: "button" });
  const cleanupChatInput = () => {
    term.grabInput(false);
    term.removeListener("key", onKey);
  };
  const onKey = (name) => {
    if (name === "CTRL_C") {
      cleanupChatInput();
      term("\nBye.\n");
      term.processExit(0);
    }
  };
  term.on("key", onKey);

  while (true) {
    const prompt = await inputLine("You> ");
    if (!prompt) continue;
    if (prompt.toLowerCase() === "exit" || prompt.toLowerCase() === "quit") {
      cleanupChatInput();
      term("Bye.\n");
      break;
    }

    messages.push({ role: "user", content: prompt });
    term("A.I> ");
    const reply = await chatCompletion(config, messages);
    if (!config.stream) {
      if (config.renderMarkdown) {
        const renderer = createMarkdownRenderer(config.markdownStyles);
        term(renderer.renderText(reply));
      } else {
        term(reply);
      }
    }
    if (config.debugRender) {
      term(`\n--- RAW ---\n${reply}\n`);
    }
    term("\n\n");
    messages.push({ role: "assistant", content: reply });
  }
}

async function runModels(config) {
  let models;
  try {
    models = await listModels(config.baseUrl);
  } catch (err) {
    term(`Error: ${err.message}\n`);
    term.processExit(1);
  }

  if (!models.length) {
    term("No models found from GPT4All server.\n");
    term.processExit(0);
  }

  term("Available models:\n");
  // Append 'Use default gpt4all model' option at the top
  models.unshift("Use default gpt4all setting");
  models.forEach((model) => term(`- ${model}\n`));
  term("\nSelect a default model (use arrows + Enter, Esc to cancel):\n");

  const currentIndex = Math.max(models.indexOf(config.model), 0);
  term.grabInput({ mouse: "button" });
  const cleanup = () => {
    term.grabInput(false);
    term.removeListener("key", onKey);
  };
  const onKey = (name) => {
    if (name === "CTRL_C") {
      cleanup();
      term("\nCanceled.\n");
      term.processExit(0);
    }
  };
  term.on("key", onKey);

  await new Promise((resolve) => {
    term.singleColumnMenu(
      models,
      { cancelable: true, selectedIndex: currentIndex },
      (error, response) => {
        term("\n");
        if (error || !response || response.canceled) {
          cleanup();
          term("Selection canceled.\n");
          term.processExit(0);
        }
        let selected = models[response.selectedIndex];
        // if user selected the default model option, set to 'gpt4all'
        if (selected === "Use default gpt4all setting") {
          selected = "gpt4all";
        }
        setConfigValue("model", selected);
        config.model = selected;
        cleanup();
        term(`Default model set to "${selected}".\n`);
        term.processExit(0);
      }
    );
  });
}

export async function runCli(argv) {
  const args = argv.slice(2);
  const config = loadConfig();
  const noRenderIndex = args.indexOf("--no-render");
  if (noRenderIndex !== -1) {
    config.renderMarkdown = false;
    args.splice(noRenderIndex, 1);
  }
  const debugRenderIndex = args.indexOf("--debug-render");
  if (debugRenderIndex !== -1) {
    config.debugRender = true;
    args.splice(debugRenderIndex, 1);
  }
  const detailedSuggestIndex = args.indexOf("--detailed-suggest");
  const shortDetailedSuggestIndex = args.indexOf("-d");

  if (detailedSuggestIndex !== -1 || shortDetailedSuggestIndex !== -1) {
    config.detailedSuggest = true;
    if (detailedSuggestIndex !== -1) {
      args.splice(detailedSuggestIndex, 1);
    }
    if (shortDetailedSuggestIndex !== -1) {
      args.splice(shortDetailedSuggestIndex, 1);
    }
  }

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printHelp();
    return;
  }

  if (args[0] === "config") {
    if (args[1] === "get" && args[2]) {
      const key = args[2];
      term(`${config[key]}\n`);
      return;
    }
    if (args[1] === "set" && args[2] && args[3] !== undefined) {
      const updated = setConfigValue(args[2], args.slice(3).join(" "));
      term(`Updated ${args[2]} in ${getConfigPath()}\n`);
      term(`${JSON.stringify(updated, null, 2)}\n`);
      return;
    }

    term(`Config file: ${getConfigPath()}\n`);
    term(`${JSON.stringify(config, null, 2)}\n`);
    return;
  }

  if (args[0] === "chat") {
    await runChat(config);
    return;
  }

  if (args[0] === "models") {
    await runModels(config);
    return;
  }

  if (args[0] === "-a") {
    const prompt = args.slice(1).join(" ").trim();
    if (!prompt) {
      term("Error: missing prompt after -a.\n");
      term.processExit(1);
    }
    await runSinglePrompt("ask", prompt, config);
    return;
  }

  if (args[0] === "suggest" || args[0] === "explain" || args[0] === "ask") {
    const prompt = args.slice(1).join(" ").trim();
    if (!prompt) {
      term(`Error: missing prompt after ${args[0]}.\n`);
      term.processExit(1);
    }
    await runSinglePrompt(args[0], prompt, config);
    return;
  }

  term("Unknown command.\n\n");
  printHelp();
}
