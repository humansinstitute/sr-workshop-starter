import { initAuth } from "./auth.js";
import { initAvatarMenu } from "./avatar.js";
import { focusHeroInput } from "./dom.js";
import { initTagInputs } from "./tag-inputs.js";
import { initUI } from "./ui.js";

window.addEventListener("load", focusHeroInput);

initAvatarMenu();
initUI();
initAuth();
initTagInputs();
