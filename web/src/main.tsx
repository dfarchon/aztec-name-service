import { createRoot } from "react-dom/client";

import { App } from "./App";
import { watchConnection } from "./session";
import "./styles.css";
import { startVitals } from "./performance";

watchConnection();
startVitals();
createRoot(document.getElementById("root")!).render(<App />);
