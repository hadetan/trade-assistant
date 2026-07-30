import { createRoot } from "react-dom/client";
import { SettingsWindow } from "./SettingsWindow";
import "./ui/tokens.css";
import "./style.css";

const container = document.getElementById("root");
if (container) createRoot(container).render(<SettingsWindow />);
