import { createRoot } from "react-dom/client";

import "./styles.css";
import "./text-size";
import "./viewport";

import { gateway } from "./address";
import { Connect } from "./connect";

const root = createRoot(document.getElementById("root")!);
// The app module opens the gateway connection, so load it only when there is one to open.
if (gateway) void import("./app").then(({ App }) => root.render(<App />));
else root.render(<Connect />);
