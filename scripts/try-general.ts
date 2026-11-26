// Offline tests for the general checker helpers (no network).
import { splitAttachments } from "../lib/checker/general";
import { htmlToText, siteLinks } from "../lib/checker/website";

const created = 1_000_000;
const a = (name: string, mins: number) => ({ name, date: created + mins * 60000, size: 1, url: "", ext: name.split(".").pop()!.toLowerCase() });
const r = splitAttachments(
  [a("image.png", 3), a("logo.png", 120), a("GROOM - SoMe - SpiderAds.jpg", 300), a("GROOM - SoMe - SpiderAds (1).jpg", 400), a("ad-1080x1080-old.png", 200), a("image.png", 140), a("banners.zip", 500)],
  created,
);
console.log("deliverables:", r.deliverables.map((d) => d.name));
console.log("reference:", r.reference.map((d) => d.name));

console.log(siteLinks(["verified-caller.com", "https://verified-caller.com/news ", "Se https://www.figma.com/x och https://www.facebook.com/skogma.se/ samt skogma.se/black-week/"]));
const t = htmlToText(`<html><head><title>Skogma – Black Week</title><meta name="description" content="Upp till 40% rabatt"><script>var x="no"</script></head><body><nav><a>Hem</a><a>Erbjudanden</a></nav><h1>Black Week p&aring; Skogma</h1><p>Motorsågar fr&aring;n 2&nbsp;995:-</p><footer><a>Hem</a></footer></body></html>`);
console.log(t);
