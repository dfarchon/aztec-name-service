import { createRoot } from "react-dom/client";

import { App } from "./App";
import { appRouteHash } from "./app-routes";
import { watchConnection } from "./session";
import "./styles.css";
import { startVitals } from "./performance";

// Static hosts serve index.html for typed or shared app paths (/docs/pricing); show the matching hash route.
const pathRoute = appRouteHash(window.location.pathname);
if (pathRoute) window.history.replaceState(null, "", `/${pathRoute}`);

watchConnection();
startVitals();
createRoot(document.getElementById("root")!).render(<App />);
