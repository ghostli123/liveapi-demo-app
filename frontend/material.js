// Loads the Material Web components and their typescale styles. This lives in
// its own file, not inline in index.html, so the Content-Security-Policy can
// allow scripts only from this origin and the CDN (see backend/main.py).
import "https://esm.run/@material/web@2.5.0/all.js";
import { styles as typescaleStyles } from "https://esm.run/@material/web@2.5.0/typography/md-typescale-styles.js";

document.adoptedStyleSheets.push(typescaleStyles.styleSheet);
