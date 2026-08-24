/* Asserts the built page is what it claims to be: one file that needs nothing
 * from the network. A dropped <!--FONTS--> substitution or a stray external
 * link would otherwise ship silently -- the page still works, it just quietly
 * stops being self-contained.
 */
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (l, c, d) => c ? (pass++, console.log("  PASS  " + l))
                             : (fail++, console.log("  FAIL  " + l + (d ? "  -> " + d : "")));

console.log("\nThe built page must be self-contained\n");

for(const file of ["index.html", "app.html"]){
  const html = readFileSync(file, "utf8");

  check(`${file}: both typefaces are embedded`,
    (html.match(/@font-face/g) || []).length === 2,
    (html.match(/@font-face/g) || []).length + " @font-face rules");

  check(`${file}: the faces are data URIs, not links`,
    (html.match(/url\(data:font\/woff2;base64,/g) || []).length === 2);

  check(`${file}: the marker was actually substituted`, !html.includes("<!--FONTS-->"));

  check(`${file}: carries the font licence notice`,
    /SIL Open Font License/i.test(html) && /openfontlicense\.org/.test(html));

  /* Anything the browser fetches on its own: stylesheets, scripts, images,
     iframes, preloads. Links the user taps are fine. */
  const autoLoads = [...html.matchAll(/<(?:link|script|img|iframe|source|video|audio)\b[^>]*>/gi)]
    .map(m => m[0])
    .filter(tag => /\b(?:src|href)\s*=\s*["']https?:\/\//i.test(tag));
  check(`${file}: nothing loads itself from the network`,
    autoLoads.length === 0, autoLoads.join(" | "));

  /* A stylesheet link to any host would defeat the point. */
  check(`${file}: no external stylesheet`,
    !/<link[^>]+rel=["']stylesheet["'][^>]*https?:/i.test(html));
}

/* The relay baked into this build must be an http(s) URL or empty. */
const idx = readFileSync("index.html", "utf8");
const relay = (idx.match(/var RELAY_URL = "([^"]*)"/) || [])[1];
check("the baked relay is a URL or deliberately empty",
  relay === "" || /^https?:\/\//.test(relay), JSON.stringify(relay));

/* The service worker's cache name must move whenever the shell does. */
const sw = readFileSync("sw.js", "utf8");
check("the service worker carries a build stamp",
  /const BUILD = "\d+";/.test(sw), (sw.match(/const BUILD = "[^"]*";/) || [])[0]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
