import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource-variable/jetbrains-mono";
import "@xterm/xterm/css/xterm.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/panels.css";
import "./styles/views.css";
import "./styles/chat.css";
import "./styles/rules.css";
import "./styles/skills.css";
import "./styles/slack.css";
import "./styles/multi.css";
import { App } from "./App";
import { get, set } from "./store";

if (import.meta.env.DEV) Object.assign(window, { __mavix: { get, set } });

createRoot(document.getElementById("root")!).render(<App />);
