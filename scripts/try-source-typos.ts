// Offline test: issues caused by typos in the client's own material (no network).
import { blameSource, typoIn } from "../lib/checker/source-proofread";
const typos = [{ where: "flyer p. 3 (Pizza)", text: "mellanolika", issue: "two words run together", suggestion: "mellan olika" }];
const issues: any[] = [
  // ad copied the typo, the ad reader flagged it
  { severity: "warning", message: "Text: missing space", found: "Välj mellanolika sorter", expected: "Välj mellan olika sorter" },
  // ad fixed it → "differs from the flyer"
  { severity: "error", product: "Pizza", message: "Info text differs from the flyer", expected: "Grandiosa. Välj mellanolika sorter. 350 g.", found: "Grandiosa. Välj mellan olika sorter. 350 g." },
  // unrelated
  { severity: "error", product: "Kaffe", message: "Price differs from the flyer", expected: "49:-", found: "59:-" },
];
for (const i of blameSource(issues, typos, "Coop's flyer/manus", "Pernilla")) console.log(i.severity, "|", i.message);
console.log(!!typoIn("VÄLJ MELLANOLIKA SORTER", typos));
